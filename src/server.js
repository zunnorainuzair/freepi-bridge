import http from 'node:http';
import {
  BridgeError,
  createQueue,
  errorFromUpstream,
  fetchMe,
  postChatCompletions,
} from './upstream.js';
import { createCatalog, resolveModelId } from './catalog.js';

/**
 * Reasoning knobs an OpenAI-compatible client may send. free-pi's CLI never
 * sends any of them (zero occurrences of reasoning_effort in main-m86v4egg.js):
 * reasoning is simply always on, and the backend returns reasoning_content on
 * every response.
 *
 * The backend ignores reasoning_effort (measured: reasoning_tokens stayed at
 * 11-18 whether the level was minimal, low, medium, high or xhigh). Worse, the
 * disable-shaped ones do real damage: pi-ai's openai-completions adapter turns
 * a declared level into `reasoning_effort`, or into `thinking: {type:
 * "disabled"}` / `enable_thinking: false` for the zai and qwen formats. With
 * reasoning suppressed, DeepSeek returns empty content and malformed
 * tool_calls. So the bridge strips them and forwards exactly what free-pi's own
 * CLI would send, which is what keeps tool calls working.
 */
const REASONING_KNOBS = [
  'reasoning',
  'reasoning_effort',
  'reasoningEffort',
  'thinking',
  'thinking_budget',
  'thinkingBudget',
  'enable_thinking',
  'chat_template_kwargs',
  'chat_template_args',
];

export function stripReasoningKnobs(body) {
  if (!body || typeof body !== 'object') return { body, stripped: [] };
  const out = { ...body };
  const stripped = [];
  for (const key of REASONING_KNOBS) {
    if (Object.hasOwn(out, key)) {
      delete out[key];
      stripped.push(key);
    }
  }
  return { body: out, stripped };
}

const MAX_BODY = 40 * 1024 * 1024;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, err) {
  const e = err instanceof BridgeError ? err : new BridgeError(String(err?.message ?? err));
  if (res.headersSent) {
    // Mid-stream failure: the SSE connection is open, so emit an error event
    // and close, rather than writing HTTP headers twice.
    try {
      res.write(`data: ${JSON.stringify({ error: { message: e.message, code: e.code, type: e.type } })}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch {
      /* socket already gone */
    }
    res.end();
    return;
  }
  const headers = {};
  if (e.retryAfter) headers['retry-after'] = String(e.retryAfter);
  const body = JSON.stringify({
    error: { message: e.message, code: e.code, type: e.type },
  });
  res.writeHead(e.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BridgeError('Request body too large', { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  const text = raw.toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError('Body is not valid JSON', { status: 400, code: 'invalid_json' });
  }
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * Start the bridge.
 *
 * deps: { config, getToken, fetchImpl, log }
 * Returns { server, url, close, stats }.
 */
export function createServer({ config, getToken, fetchImpl = fetch, log = () => {} }) {
  const queue = createQueue({ max: config.maxUpstream, timeoutMs: config.queueTimeoutMs });
  const catalog = createCatalog({ baseUrl: config.baseUrl, getToken, fetchImpl, log });
  const stats = { requests: 0, ok: 0, failed: 0, takeovers: 0, startedAt: new Date().toISOString() };

  /**
   * free-pi caps an account at 4 concurrent sessions and identifies a session
   * by x-session-id. The bridge deliberately reuses one id for every
   * conversation, so it occupies a single slot and can never lock the user
   * (or their running CLI sessions) out of their own allowance.
   */
  function sessionIdFor() {
    return config.sessionId;
  }

  /** POST /session/reset — the server-side equivalent of /close-other-session. */
  async function resetOtherSessions(token) {
    const res = await fetchImpl(new URL('/session/reset', config.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return Boolean(data?.released);
  }

  async function handleModels(req, res) {
    const { models, source, latest } = await catalog.load();
    json(res, 200, {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.section === 'defense' ? 'free-pi-defense' : 'free-pi',
        name: m.name,
        description: m.name,
        context_window: 200000,
        max_output_tokens: 32768,
        premium: /\d+x usage/i.test(m.name),
        unavailable: m.unavailable || undefined,
      })),
      bridge: { source, upstream_latest: latest },
    });
  }

  /**
   * Write an upstream success response back to the client: JSON as-is, or the
   * SSE byte stream relayed chunk by chunk (free-pi already speaks OpenAI
   * SSE, including tool_calls deltas and reasoning_content).
   */
  async function relay(upstream, res, model, started, wantsStream) {
    if (!wantsStream) {
      const text = await upstream.text();
      const ms = Date.now() - started;
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'x-bridge-model': model,
        'x-bridge-upstream-ms': String(ms),
      });
      res.end(text);
      stats.ok += 1;
      if (config.logRequests) log(`POST /v1/chat/completions ${model} ${ms}ms (non-stream)`);
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-bridge-model': model,
    });
    res.flushHeaders?.();

    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
    }
    res.end();
    stats.ok += 1;
    if (config.logRequests) log(`POST /v1/chat/completions ${model} ${Date.now() - started}ms (stream)`);
  }

  async function handleChat(req, res) {
    const body = await readJsonBody(req);
    const token = await getToken();
    if (!token) {
      throw new BridgeError(
        'No free-pi sign-in token. Run `npx free-pi-cli@latest` once (or `freepi-bridge login`) to sign in, then retry.',
        { status: 401, code: 'not_signed_in' },
      );
    }

    const loaded = await catalog.load();
    const model = resolveModelId(body?.model, loaded);
    if (!model) {
      throw new BridgeError(`Unknown or malformed model: ${JSON.stringify(body?.model)}`, {
        status: 400,
        code: 'invalid_model',
      });
    }

    const upstreamBody = { ...body, model };
    const wantsStream = body?.stream === true;
    upstreamBody.stream = wantsStream;

    // Keep the request on the one path the backend is proven to handle.
    const cleaned = stripReasoningKnobs(upstreamBody);
    const outbound = cleaned.body;
    if (cleaned.stripped.length && config.logRequests) {
      log(`stripped reasoning knob(s): ${cleaned.stripped.join(', ')}`);
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), config.requestTimeoutMs);
    timeout.unref?.();

    let slotHeld = false;
    stats.requests += 1;
    const started = Date.now();
    try {
      await queue.acquire(controller.signal);
      slotHeld = true;

      const upstream = await postChatCompletions({
        baseUrl: config.baseUrl,
        token,
        sessionId: sessionIdFor(),
        clientVersion: loaded.latest || config.clientVersion,
        body: outbound,
        headers: req.headers,
        signal: controller.signal,
        fetchImpl,
      });

      if (upstream.status === 409 && config.takeover) {
        const text = await upstream.text().catch(() => '');
        const err = errorFromUpstream(409, text);
        if (err.code === 'concurrent_session' && (await resetOtherSessions(token))) {
          stats.takeovers += 1;
          log('takeover: cleared the account\'s other free-pi sessions');
          const retry = await postChatCompletions({
            baseUrl: config.baseUrl,
            token,
            sessionId: sessionIdFor(),
            clientVersion: loaded.latest || config.clientVersion,
            body: outbound,
            headers: req.headers,
            signal: controller.signal,
            fetchImpl,
          });
          if (retry.ok) return await relay(retry, res, model, started, wantsStream);
          throw errorFromUpstream(retry.status, await retry.text().catch(() => ''));
        }
        throw err;
      }

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        throw errorFromUpstream(upstream.status, text);
      }

      return await relay(upstream, res, model, started, wantsStream);
    } finally {
      clearTimeout(timeout);
      if (slotHeld) queue.release();
    }
  }

  async function handleUsage(req, res) {
    const token = await getToken();
    if (!token) throw new BridgeError('Not signed in to free-pi.', { status: 401, code: 'not_signed_in' });
    const me = await fetchMe({ baseUrl: config.baseUrl, token, fetchImpl });
    json(res, 200, {
      user_id: me.user_id,
      handle: me.handle,
      tier: me.tier,
      remaining_usd_today: me.remaining_usd_today,
      cap_usd_today: me.cap_usd_today,
      credit_usd: me.credit_usd,
      buy_url: me.buy_url,
    });
  }

  const server = http.createServer((req, res) => {
    cors(res);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Optional local auth: if FPB_API_KEY is set, require it. Off by default so
    // a loopback bridge just works.
    const expected = config.apiKey;
    if (expected) {
      const given = bearer(req);
      if (given !== expected) {
        sendError(res, new BridgeError('Invalid bridge API key', { status: 401, code: 'unauthorized' }));
        return;
      }
    }

    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    const run = async () => {
      switch (route) {
        case 'GET /':
        case 'GET /health':
          json(res, 200, {
            ok: true,
            bridge: 'freepi-bridge',
            upstream: config.baseUrl,
            models_cached: (await catalog.load()).models.length,
            queue: { active: queue.state.active, queued: queue.state.queued, max: queue.state.max },
            stats,
          });
          return;
        case 'GET /v1/models':
        case 'GET /models':
          await handleModels(req, res);
          return;
        case 'POST /v1/chat/completions':
        case 'POST /chat/completions':
        case 'POST /v1/messages':
          await handleChat(req, res);
          return;
        case 'GET /v1/usage':
        case 'GET /usage':
          await handleUsage(req, res);
          return;
        default:
          json(res, 404, { error: { message: `No route for ${route}`, code: 'not_found', type: 'free_pi_error' } });
      }
    };

    run().catch((err) => {
      stats.failed += 1;
      sendError(res, err);
    });
  });

  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;

  return {
    server,
    stats,
    queue,
    catalog,
    get url() {
      return `http://${config.host}:${config.port}/v1`;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => resolve());
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
