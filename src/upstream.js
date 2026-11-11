/**
 * Upstream client for api.freepi.ai.
 *
 * The free-pi backend is already OpenAI-compatible (verified: streaming SSE,
 * native tool_calls, reasoning_content), so the bridge forwards the request
 * almost verbatim. What it adds:
 *   - the free-pi sign-in JWT, which the client never has to know about;
 *   - the x-session-id / x-client-version headers the backend expects;
 *   - serialisation, because free-pi answers concurrent requests with
 *     HTTP 429 {"code":"concurrent"};
 *   - normalised errors and a retry for that specific contention case.
 */

export class BridgeError extends Error {
  constructor(message, { status = 500, code = 'bridge_error', type = 'free_pi_error', retryAfter } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.retryAfter = retryAfter;
  }
}

/** Headers the bridge owns; a client must not be able to override them. */
const OWNED_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'x-session-id',
  'x-client-version',
  'x-freepi-subagent',
]);

export function upstreamHeaders({ token, sessionId, clientVersion, requestHeaders = {} }) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  for (const [k, v] of Object.entries(requestHeaders)) {
    const key = k.toLowerCase();
    if (OWNED_HEADERS.has(key)) continue;
    if (typeof v !== 'string') continue;
    headers[key] = v;
  }
  headers.authorization = `Bearer ${token}`;
  if (sessionId) headers['x-session-id'] = sessionId;
  headers['x-client-version'] = clientVersion;
  return headers;
}

/**
 * Process-global upstream concurrency limiter. free-pi allows one in-flight
 * request per account, so extra requests queue FIFO and take the first freed
 * slot. Release hands the slot straight to the next waiter.
 */
export function createQueue({ max = 1, timeoutMs = 180000 } = {}) {
  const state = { active: 0, queued: 0, max };
  const waiters = [];

  function pump() {
    while (state.active < state.max && waiters.length > 0) {
      const waiter = waiters.shift();
      state.queued -= 1;
      if (waiter.cancelled) continue;
      clearTimeout(waiter.timer);
      state.active += 1;
      waiter.resolve(state.active);
    }
  }

  function acquire(signal) {
    if (signal?.aborted) {
      return Promise.reject(new BridgeError('Request aborted', { status: 499, code: 'aborted' }));
    }
    if (state.active < state.max) {
      state.active += 1;
      return Promise.resolve(state.active);
    }
    state.queued += 1;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, cancelled: false, timer: null };
      // Deliberately not unref'd: this timer is what settles the promise when
      // the queue never frees up. Unref'ing it lets the process exit with the
      // rejection still pending ("event loop has already resolved"), which
      // turns a clean timeout into a cancelled test/hang.
      waiter.timer = setTimeout(() => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        state.queued = Math.max(0, state.queued - 1);
        reject(
          new BridgeError('Timed out waiting for a free upstream slot (free-pi allows one request at a time).', {
            status: 503,
            code: 'queue_timeout',
          }),
        );
      }, timeoutMs);

      if (signal) {
        const onAbort = () => {
          if (waiter.cancelled) return;
          waiter.cancelled = true;
          clearTimeout(waiter.timer);
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          state.queued = Math.max(0, state.queued - 1);
          reject(new BridgeError('Request aborted while queued', { status: 499, code: 'aborted' }));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      waiters.push(waiter);
    });
  }

  function release() {
    state.active = Math.max(0, state.active - 1);
    pump();
  }

  return { state, acquire, release };
}

/** Turn an upstream non-2xx body into a readable BridgeError. */
export function errorFromUpstream(status, text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const inner = parsed?.error ?? parsed;
  const message =
    (typeof inner?.message === 'string' && inner.message) ||
    (typeof parsed?.message === 'string' && parsed.message) ||
    text?.slice(0, 300) ||
    `upstream HTTP ${status}`;
  const code = parsed?.code || inner?.code || `http_${status}`;

  let retryAfter;
  if (typeof parsed?.refill_at === 'string') {
    const ms = Date.parse(parsed.refill_at) - Date.now();
    if (Number.isFinite(ms) && ms > 0) retryAfter = Math.ceil(ms / 1000);
  }

  // Give the operator the actionable version of the common failures.
  let friendly = message;
  if (code === 'concurrent') friendly = `${message} (the bridge queues requests; this means another client shared the account)`;
  if (status === 401) friendly = 'free-pi rejected the stored sign-in token. Run the free-pi CLI once to sign in again.';
  if (status === 403) friendly = `free-pi refused the request: ${message}`;
  if (status === 429 && code !== 'concurrent') {
    friendly = `${message}${parsed?.remaining_credits_today !== undefined ? ` (${parsed.remaining_credits_today} credits left today)` : ''}`;
  }
  if (code === 'concurrent_session') {
    friendly = `${message}\n  The bridge reuses one session id for every conversation, so this means the free-pi CLI (or another tool) is holding your 4 session slots. Close it, then retry; or run \`freepi-bridge takeover\` (or serve with FPB_TAKEOVER=1) to release them.`;
  }

  return new BridgeError(friendly, {
    status,
    code,
    type: inner?.type || 'free_pi_error',
    retryAfter,
  });
}

/**
 * POST /v1/chat/completions upstream. Returns the raw Response so the caller
 * can either relay the SSE stream or parse JSON.
 */
export async function postChatCompletions({
  baseUrl,
  token,
  sessionId,
  clientVersion,
  body,
  headers,
  signal,
  fetchImpl = fetch,
}) {
  return fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: upstreamHeaders({ token, sessionId, clientVersion, requestHeaders: headers }),
    body: JSON.stringify(body),
    signal,
  });
}

/** GET /me — the CLI's account/usage endpoint. */
export async function fetchMe({ baseUrl, token, fetchImpl = fetch, timeoutMs = 8000 }) {
  const res = await fetchImpl(new URL('/me', baseUrl), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw errorFromUpstream(res.status, await res.text().catch(() => ''));
  return res.json();
}
