import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  decodeJwt,
  freePiAgentDir,
  credentialsPath,
  loadConfig,
  readFreePiToken,
} from './config.js';
import { createCatalog } from './catalog.js';
import { BridgeError, fetchMe } from './upstream.js';
import { createServer as createBridge } from './server.js';
import { cleanModelName, dshPatch, openaiEnvSnippet, renderModelTable, DSH_PROVIDER_ID } from './snippets.js';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * dsh's provider loader reads its model catalog from the patch file, but every
 * OpenAI-compatible route still needs a served GET /v1/models, so the banner
 * points at the live one rather than at the patch.
 */
const DSH_MODELS_URL = '/v1/models';

/** Placeholder dsh sends as the bearer token when a route needs no real key. */
const DEFAULT_API_KEY = 'freepi-bridge';

const HELP = `freepi-bridge ${PKG.version} — use free-pi (freepi.ai) models from dsh and any OpenAI client.

It reuses the sign-in token the free-pi CLI already stores, so there is no API
key to copy: sign in once with \`npx free-pi-cli@latest\` and the bridge works.

Usage:
  freepi-bridge                              start the server (same as \`serve\`)
  freepi-bridge serve [--port N] [--host H]   start the OpenAI-compatible server
  freepi-bridge models [--json]               list the models free-pi offers now
  freepi-bridge dsh [--port N] [--model ID]   print a dsh cordis.patch.yml block
  freepi-bridge env [--port N]                print OPENAI_* values for any client
  freepi-bridge status                        show the free-pi account and allowance
  freepi-bridge takeover                      release this account's other free-pi sessions
  freepi-bridge doctor                        check sign-in, token expiry, upstream

The command is installed as \`freep\` (and \`fpb\`); \`freep\` alone starts the server
and prints the provider ID, base URL and API key that dsh needs.
  freepi-bridge login                         run the free-pi CLI to sign in
  freepi-bridge version                       print the version

Serve options:
  --port N                 listen port (default 8791, env FPB_PORT)
  --host H                 bind address (default 127.0.0.1, env FPB_HOST)
  --max-upstream N         concurrent upstream requests (default 1; free-pi
                           allows one at a time and returns 429 otherwise)
  --api-key KEY            require this key from clients (env FPB_API_KEY)
  --log                    log each request

dsh options:
  --port N                 port the bridge will listen on (default 8791)
  --model ID               model to set as dsh's default
  --all                    include every model, not just the main ones
  --write                  write the block into the profile patch (backs up)
  --profile NAME           dsh profile to write to (default desktop)

Environment:
  FREEPI_BASE_URL          override the upstream backend (default https://api.freepi.ai)
  FREEPI_AGENT_DIR         override the free-pi state directory (~/.free-pi/agent)
  FPB_PORT / FPB_HOST / FPB_API_KEY / FPB_MAX_UPSTREAM / FPB_LOG
`.trim();

// ------------------------------------------------------------------ args

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command: positional[0] ?? null, positional: positional.slice(1), flags };
}

function intFlag(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const log = (msg) => console.log(msg);
const logErr = (msg) => console.error(msg);

function bold(s) {
  return process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s;
}
function dim(s) {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

// -------------------------------------------------------------- helpers

function tokenOrExplain(env) {
  const token = readFreePiToken(env);
  if (!token) {
    throw new BridgeError(
      [
        'No free-pi sign-in found.',
        `  looked in: ${credentialsPath(env)}`,
        '  fix:       npx free-pi-cli@latest    (sign in with GitHub once)',
        '             then re-run this command.',
      ].join('\n'),
      { status: 401, code: 'not_signed_in' },
    );
  }
  return token;
}

async function loadCatalogFor(config, token) {
  const catalog = createCatalog({
    baseUrl: config.baseUrl,
    getToken: async () => token,
    log: config.logRequests ? log : () => {},
  });
  return catalog.load();
}

function pickDefaultModel(catalog) {
  const usable = (catalog.models ?? []).filter((m) => !m.unavailable && m.section !== 'defense');
  const list = usable.length ? usable : catalog.models ?? [];
  const byName = catalog.defaultModel
    ? list.find((m) => cleanModelName(m.name, m.id).toLowerCase() === String(catalog.defaultModel).toLowerCase())
    : null;
  if (byName) return byName.id;
  const flash = list.find((m) => /flash/i.test(m.id));
  return (flash ?? list[0])?.id ?? null;
}

// ------------------------------------------------------------- commands

async function cmdServe(flags) {
  const config = loadConfig(process.env, {
    port: intFlag(flags.port, undefined),
    host: typeof flags.host === 'string' ? flags.host : undefined,
    maxUpstream: intFlag(flags['max-upstream'], undefined),
    apiKey: typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined,
  });
  if (flags.log) config.logRequests = true;

  const token = tokenOrExplain(process.env);
  const claims = decodeJwt(token);
  const bridge = createBridge({
    config,
    getToken: async () => readFreePiToken(process.env) ?? token,
    log: (m) => logErr(dim(m)),
  });

  await bridge.listen();

  // Warm the catalog so the first dsh turn is not slowed by it.
  let catalog = { models: [], source: 'pending', latest: null };
  try {
    catalog = await bridge.catalog.load();
  } catch {
    /* serve anyway; the request path retries */
  }

  const def = pickDefaultModel(catalog);
  const expiry = claims?.exp ? new Date(claims.exp * 1000) : null;
  const baseUrl = `http://${config.host}:${config.port}/v1`;
  const apiKey = config.apiKey || DEFAULT_API_KEY;

  log(bold('freepi-bridge') + ` is running — press Ctrl-C to stop`);
  log('');
  log(bold('  Provider details for dsh (copy these into cordis.patch.yml):'));
  log(`    provider ID   ${DSH_PROVIDER_ID}`);
  log(`    base URL      ${baseUrl}`);
  log(`    API key       ${apiKey}${config.apiKey ? '' : dim('  (any non-empty value works; the bridge holds your free-pi sign-in)')}`);
  log(`    api           openai-completions`);
  log(`    models        ${DSH_MODELS_URL}${dim('  (GET, OpenAI format — required by dsh)')}`);
  if (def) log(`    default model ${def}`);
  log('');
  log(bold('  Status:'));
  log(`    upstream      ${config.baseUrl}`);
  log(`    models        ${catalog.models.length} from ${catalog.source}${catalog.latest ? `, client ${catalog.latest}` : ''}`);
  if (expiry) {
    const days = Math.round((expiry.getTime() - Date.now()) / 86400000);
    log(`    sign-in       ${days > 0 ? `valid for ${days} more day(s)` : 'expired'} (${expiry.toISOString().slice(0, 10)})`);
  }
  log(`    concurrency   ${config.maxUpstream} upstream request(s); extra requests queue`);
  log(`    endpoints     GET ${DSH_MODELS_URL} · POST /v1/chat/completions · GET /v1/usage · GET /health`);
  log('');
  log(`Apply the dsh provider automatically:  ${bold('fpb dsh --write')}   ${dim('(then restart dsh)')}`);
  log(dim(`Only the model list, without the server: fpb dsh`));

  const shutdown = async () => {
    log('\nshutting down…');
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive and expose a tiny liveness hint.
  process.stdin.resume?.();
  return new Promise(() => {});
}

async function cmdModels(flags) {
  const config = loadConfig(process.env);
  const token = tokenOrExplain(process.env);
  const catalog = await loadCatalogFor(config, token);
  if (flags.json) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }
  const def = pickDefaultModel(catalog);
  log(bold(`${catalog.models.length} free-pi models`) + dim(` (${catalog.source})`));
  log('');
  log(renderModelTable(catalog.models, { defaultModel: def }));
  log('');
  log(dim('* = default. Models marked with a usage multiplier spend your daily allowance faster.'));
}

function dshRunning() {
  try {
    const out = execSync(
      process.platform === 'win32' ? 'tasklist' : 'ps -eo comm',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return process.platform === 'win32'
      ? /DeepSeek Harness\.exe/i.test(out)
      : /deepseek-harness|dsh/i.test(out);
  } catch {
    return false;
  }
}

async function cmdDsh(flags) {
  const config = loadConfig(process.env, { port: intFlag(flags.port, undefined) });
  const token = readFreePiToken(process.env);
  let catalog = { models: [], source: 'fallback', defaultModel: null };
  if (token) {
    try {
      catalog = await loadCatalogFor(config, token);
    } catch (err) {
      logErr(dim(`could not reach free-pi (${err.message}); using the built-in model list`));
    }
  } else {
    logErr(dim('not signed in; using the built-in model list. Run `freepi-bridge login` first.'));
  }

  let models = catalog.models.filter((m) => !m.unavailable);
  if (!flags.all) models = models.filter((m) => m.section !== 'defense');
  const requested = typeof flags.model === 'string' ? flags.model : null;
  const model = requested ?? pickDefaultModel(catalog) ?? models[0]?.id ?? null;
  if (requested && !models.some((m) => m.id === requested)) {
    logErr(dim(`note: ${requested} is not in the current catalog; emitting it anyway`));
  }

  // When the bridge requires a key, write that exact key into the patch so dsh
  // sends it; a keyless bridge omits the field entirely.
  const patch = dshPatch({ models, port: config.port, model, apiKey: config.apiKey || null });

  if (flags.write) {
    const profile = typeof flags.profile === 'string' ? flags.profile : 'desktop';
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const target = join(home, '.dsh', 'profiles', profile, 'cordis.patch.yml');
    if (!existsSync(dirname(target))) {
      throw new BridgeError(`dsh profile not found: ${dirname(target)}`, { status: 404, code: 'no_profile' });
    }
    // dsh treats cordis.patch.yml as its own projection of internal config and
    // rewrites it on save/exit. Writing while it runs silently loses the edit
    // (observed: the freepi provider vanished ~3 min later, leaving the default
    // model pointing at a provider that no longer existed).
    if (dshRunning() && !flags.force) {
      throw new BridgeError(
        [
          'dsh is running, and it rewrites cordis.patch.yml itself.',
          'Writing now would be silently discarded (and can leave your default',
          'model pointing at a provider that no longer exists).',
          '',
          '  1. Quit DeepSeek Harness completely.',
          '  2. Re-run: freep dsh --write',
          '  3. Start dsh again.',
          '',
          'Use --force to write anyway.',
        ].join('\n'),
        { status: 409, code: 'dsh_running' },
      );
    }
    const { backupAndWritePatch } = await import('./patchfile.js');
    const result = backupAndWritePatch(target, patch);
    log(bold('wrote ') + target);
    log(dim(`  backup: ${result.backup}`));
    if (result.preservedProviders?.length) {
      log(dim(`  kept your other providers: ${result.preservedProviders.join(', ')}`));
    }
    log('');
    log('Restart dsh to pick it up. Then: freepi-bridge serve');
    return;
  }

  log(dim(`# paste into ~/.dsh/profiles/<profile>/cordis.patch.yml`) + dim(` (or run: freepi-bridge dsh --write)`));
  log('');
  process.stdout.write(patch);
}

async function cmdEnv(flags) {
  const config = loadConfig(process.env, { port: intFlag(flags.port, undefined) });
  const token = readFreePiToken(process.env);
  let model = null;
  if (token) {
    try {
      model = pickDefaultModel(await loadCatalogFor(config, token));
    } catch {
      /* optional */
    }
  }
  log(openaiEnvSnippet({ port: config.port, model, apiKey: config.apiKey }));
}

async function cmdStatus() {
  const config = loadConfig(process.env);
  const token = tokenOrExplain(process.env);
  const me = await fetchMe({ baseUrl: config.baseUrl, token });
  const claims = decodeJwt(token);
  const lines = [
    `${bold('free-pi account')}  ${me.handle ?? '(unknown)'}`,
    `  user id     ${me.user_id ?? '-'}`,
    `  tier        ${me.tier ?? '-'}`,
    `  allowance   $${Number(me.remaining_usd_today ?? 0).toFixed(3)} left of $${Number(me.cap_usd_today ?? 0).toFixed(3)} today`,
    `  credits     $${Number(me.credit_usd ?? 0).toFixed(3)}`,
  ];
  if (claims?.exp) {
    const at = new Date(claims.exp * 1000);
    lines.push(`  sign-in     expires ${at.toISOString().slice(0, 10)}`);
  }
  if (me.buy_url) lines.push(`  top up      ${me.buy_url}`);
  log(lines.join('\n'));
}

async function cmdTakeover() {
  const config = loadConfig(process.env);
  const token = tokenOrExplain(process.env);
  const res = await fetch(new URL('/session/reset', config.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new BridgeError(`Could not reset sessions (HTTP ${res.status})`, { status: res.status, code: 'reset_failed' });
  }
  const data = await res.json().catch(() => ({}));
  log(data?.released ? 'Released your other free-pi sessions.' : 'No other session was running — nothing to release.');
  log(dim('Note: this frees sessions held by the free-pi CLI too, so close it first if you want it to keep running.'));
}

async function cmdDoctor() {
  const env = process.env;
  const config = loadConfig(env);
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });

  add(true, 'node', process.version);
  add(existsSync(freePiAgentDir(env)), 'free-pi state dir', freePiAgentDir(env));

  const token = readFreePiToken(env);
  add(Boolean(token), 'free-pi sign-in', token ? `${credentialsPath(env)} (${token.length} chars)` : 'missing — run `freepi-bridge login`');

  if (token) {
    const claims = decodeJwt(token);
    if (claims?.exp) {
      const left = claims.exp * 1000 - Date.now();
      const days = Math.floor(left / 86400000);
      add(left > 0, 'token expiry', left > 0 ? `${days} day(s) left` : 'expired — sign in again');
    }
    add(true, 'upstream base', config.baseUrl);
    try {
      const me = await fetchMe({ baseUrl: config.baseUrl, token });
      add(true, 'upstream /me', `${me.handle ?? 'ok'} · $${Number(me.remaining_usd_today ?? 0).toFixed(3)} left today`);
    } catch (err) {
      add(false, 'upstream /me', err.message);
    }
    try {
      const catalog = await loadCatalogFor(config, token);
      add(catalog.models.length > 0, 'model catalog', `${catalog.models.length} models (${catalog.source})`);
    } catch (err) {
      add(false, 'model catalog', err.message);
    }
  }

  for (const c of checks) log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.label.padEnd(18)} ${dim(c.detail)}`);
  const failed = checks.filter((c) => !c.ok).length;
  log('');
  log(failed === 0 ? bold('all checks passed') : bold(`${failed} check(s) need attention`));
  if (failed) process.exitCode = 1;
}

async function cmdLogin() {
  log('Starting the free-pi CLI. Sign in with GitHub, then exit (Ctrl-C) — the token is saved for the bridge.');
  log(dim('If it is already signed in, there is nothing to do.'));
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'free-pi-cli@latest', '--help'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  await new Promise((resolve) => child.on('exit', resolve));
  const token = readFreePiToken(process.env);
  log(token ? bold('\nsigned in — run `freepi-bridge serve`') : '\nstill not signed in; run `npx free-pi-cli@latest` directly.');
}

// ------------------------------------------------------------------ main

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  if (flags.help || command === 'help') {
    log(HELP);
    return;
  }
  if (flags.version || command === 'version') {
    log(PKG.version);
    return;
  }

  switch (command) {
    case 'serve':
    case 'start':
      return cmdServe(flags);
    case 'models':
      return cmdModels(flags);
    case 'dsh':
    case 'patch':
      return cmdDsh(flags);
    case 'env':
      return cmdEnv(flags);
    case 'status':
    case 'usage':
      return cmdStatus();
    case 'takeover':
      return cmdTakeover();
    case 'doctor':
      return cmdDoctor();
    case 'login':
      return cmdLogin();
    case null:
      // Bare `freep` is the common case: start serving immediately.
      return cmdServe(flags);
    default:
      logErr(`Unknown command: ${command}`);
      logErr('Run `freepi-bridge --help`.');
      process.exitCode = 1;
  }
}
