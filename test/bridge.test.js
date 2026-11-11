import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, errorFromUpstream, upstreamHeaders } from '../src/upstream.js';
import { resolveModelId, FALLBACK_MODELS } from '../src/catalog.js';
import { dshPatch, cleanModelName, openaiEnvSnippet, DSH_PROVIDER_ID } from '../src/snippets.js';
import { splitEntries } from '../src/patchfile.js';
import { defaultSessionId, decodeJwt, loadConfig } from '../src/config.js';

const catalog = {
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash · 🔥 Free Unlimited: limited time' },
    { id: 'abliterated-large-v2', name: 'Abliterated Large V2', section: 'defense' },
  ],
};

// ------------------------------------------------------------------ catalog

test('resolveModelId accepts a catalog id', () => {
  assert.equal(resolveModelId('deepseek-v4-flash', catalog), 'deepseek-v4-flash');
});

test('resolveModelId accepts a namespaced id', () => {
  assert.equal(resolveModelId('deepseek/deepseek-v4-flash', catalog), 'deepseek-v4-flash');
});

test('resolveModelId passes through unknown but well-formed ids', () => {
  assert.equal(resolveModelId('some-new-model-2', catalog), 'some-new-model-2');
});

test('resolveModelId rejects junk and empty input', () => {
  assert.equal(resolveModelId('', catalog), null);
  assert.equal(resolveModelId('has spaces in it', catalog), null);
  assert.equal(resolveModelId(null, catalog), null);
});

test('fallback catalog is non-empty and well formed', () => {
  assert.ok(FALLBACK_MODELS.length > 0);
  for (const m of FALLBACK_MODELS) assert.match(m.id, /^[a-z0-9][a-z0-9.-]*$/);
});

// ------------------------------------------------------------------ headers

test('upstreamHeaders always sets the bridge-owned auth and never leaks client auth', () => {
  const h = upstreamHeaders({
    token: 'abc',
    sessionId: 'sid-1',
    clientVersion: '0.6.18',
    requestHeaders: { authorization: 'Bearer client-key', 'x-session-id': 'other', 'x-custom': 'keep' },
  });
  assert.equal(h.authorization, 'Bearer abc');
  assert.equal(h['x-session-id'], 'sid-1');
  assert.equal(h['x-client-version'], '0.6.18');
  assert.equal(h['x-custom'], 'keep');
});

// -------------------------------------------------------------------- queue

test('queue serialises beyond max and releases in order', async () => {
  const q = createQueue({ max: 1, timeoutMs: 5000 });
  const order = [];
  const task = async (name, ms) => {
    await q.acquire();
    try {
      order.push(`start-${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end-${name}`);
    } finally {
      q.release();
    }
  };
  await Promise.all([task('a', 30), task('b', 10), task('c', 10)]);
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
  assert.equal(q.state.active, 0);
});

test('queue frees a slot when the task throws', async () => {
  const q = createQueue({ max: 1, timeoutMs: 5000 });
  await q.acquire();
  q.release();
  await assert.doesNotReject(q.acquire());
  assert.equal(q.state.active, 1);
});

test('queue gives up after the timeout instead of hanging forever', async () => {
  const q = createQueue({ max: 1, timeoutMs: 30 });
  await q.acquire();
  await assert.rejects(() => q.acquire(), /Timed out waiting/);
  q.release();
});

// ------------------------------------------------------------------- errors

test('errorFromUpstream explains a 429 allowance refusal', () => {
  const err = errorFromUpstream(
    429,
    JSON.stringify({ code: 'daily_cap', message: 'You are out of credits', remaining_credits_today: 0 }),
  );
  assert.equal(err.status, 429);
  assert.match(err.message, /out of credits/);
  assert.match(err.message, /0 credits left today/);
});

test('errorFromUpstream explains a 409 session conflict', () => {
  const err = errorFromUpstream(409, JSON.stringify({ code: 'concurrent_session', message: 'too many sessions' }));
  assert.equal(err.code, 'concurrent_session');
  assert.match(err.message, /freepi-bridge takeover/);
});

test('errorFromUpstream turns a 401 into a sign-in hint', () => {
  const err = errorFromUpstream(401, 'nope');
  assert.match(err.message, /sign in again/);
});

test('errorFromUpstream copes with a non-JSON body', () => {
  const err = errorFromUpstream(500, '<html>oops</html>');
  assert.equal(err.status, 500);
  assert.match(err.message, /oops/);
});

// ----------------------------------------------------------------- snippets

test('cleanModelName strips the marketing suffix', () => {
  assert.equal(cleanModelName('DeepSeek V4 Flash · 🔥 Free Unlimited: limited time', 'x'), 'DeepSeek V4 Flash');
  assert.equal(cleanModelName('MiMo V2.6 Flash (Xiaomi) · ~2.8x usage', 'x'), 'MiMo V2.6 Flash (Xiaomi)');
});

test('dshPatch emits schema-valid provider fields', () => {
  const y = dshPatch({ models: [{ id: 'a-model', name: 'A Model' }], port: 9001, model: 'a-model' });
  assert.match(y, /- id: llm-pi-ai/);
  assert.match(y, /api: openai-completions/);
  assert.match(y, /baseURL: http:\/\/127\.0\.0\.1:9001\/v1/);
  assert.match(y, /- id: a-model/);
  assert.match(y, /contextWindow: 200000/);
  assert.match(y, /maxTokens: 32768/);
  assert.match(y, /provider: freepi/);
  assert.match(y, /model: a-model/);
});

test('dshPatch omits apiKeyEnv for a keyless bridge', () => {
  assert.doesNotMatch(dshPatch({ models: [{ id: 'm' }] }), /apiKeyEnv/);
  assert.match(dshPatch({ models: [{ id: 'm' }], apiKeyEnv: 'K' }), /apiKeyEnv: K/);
});

test('dshPatch can omit the default-model entry', () => {
  const y = dshPatch({ models: [{ id: 'm' }], model: 'm', includeDefault: false });
  assert.doesNotMatch(y, /agent-default-model/);
});

test('openaiEnvSnippet points at the bridge', () => {
  const env = JSON.parse(openaiEnvSnippet({ port: 8791, model: 'm1' }));
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:8791/v1');
  assert.equal(env.OPENAI_MODEL, 'm1');
});

// --------------------------------------------------------------- patch file

test('splitEntries reads ids and keeps bodies intact', () => {
  const entries = splitEntries(`# comment\n- id: one\n  config:\n    a: 1\n- id: two\n  config:\n    b: 2\n`);
  assert.deepEqual(entries.map((e) => e.id), ['one', 'two']);
  assert.match(entries[0].text, /a: 1/);
  assert.match(entries[1].text, /b: 2/);
});

// ------------------------------------------------------------------- config

test('defaultSessionId is stable, distinct per base URL, and one slot wide', () => {
  const a = defaultSessionId({ FREEPI_BASE_URL: 'https://x.test', HOME: '/h' });
  const b = defaultSessionId({ FREEPI_BASE_URL: 'https://x.test', HOME: '/h' });
  const c = defaultSessionId({ FREEPI_BASE_URL: 'https://y.test', HOME: '/h' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^fpb-[0-9a-f]{24}$/);
});

test('loadConfig defaults to loopback, serialised upstream, and 8791', () => {
  const cfg = loadConfig({}, {});
  assert.equal(cfg.port, 8791);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.maxUpstream, 1);
  assert.equal(cfg.takeover, false);
});

test('decodeJwt reads claims and tolerates junk', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp: 123 })).toString('base64url');
  assert.equal(decodeJwt(`h.${payload}.s`).sub, 'u1');
  assert.equal(decodeJwt('not-a-jwt'), null);
});

// ------------------------------------------------- provider details / fpb UX

test('dshPatch writes a literal apiKey when the bridge requires one', () => {
  const y = dshPatch({ models: [{ id: 'm' }], apiKey: 'sekrit' });
  assert.match(y, /apiKey: "sekrit"/);
  assert.doesNotMatch(y, /apiKeyEnv/);
});

test('dshPatch provider uses the lower-case id dsh requires', () => {
  const y = dshPatch({ models: [{ id: 'm' }], model: 'm' });
  assert.match(y, /^ {6}freepi:$/m);
  assert.match(y, /provider: freepi/);
  assert.equal(DSH_PROVIDER_ID, 'freepi');
  assert.equal(DSH_PROVIDER_ID, DSH_PROVIDER_ID.toLowerCase());
});
