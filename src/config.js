import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Upstream free-pi backend. Same default the CLI uses (src/env.ts). */
export const DEFAULT_BASE_URL = 'https://api.freepi.ai';

/**
 * free-pi keeps its state in ~/.free-pi/agent (PI_CODING_AGENT_DIR when it has
 * been overridden), deliberately separate from a plain ~/.pi/agent.
 */
export function freePiAgentDir(env = process.env) {
  if (env.FREEPI_AGENT_DIR) return env.FREEPI_AGENT_DIR;
  return join(env.HOME || env.USERPROFILE || homedir(), '.free-pi', 'agent');
}

export function credentialsPath(env = process.env) {
  return join(freePiAgentDir(env), 'credentials.json');
}

/** The free-pi sign-in token, or null when the user is not signed in. */
export function readFreePiToken(env = process.env) {
  try {
    const raw = readFileSync(credentialsPath(env), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
}

/** Decode JWT claims without verifying — used only to show expiry/account. */
export function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function envInt(env, name, fallback) {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env = process.env, overrides = {}) {
  const baseUrl = (env.FREEPI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    baseUrl,
    host: overrides.host ?? env.FPB_HOST ?? '127.0.0.1',
    port: overrides.port ?? envInt(env, 'FPB_PORT', 8791),
    // free-pi rejects concurrent requests with a 429 ("one request at a time"),
    // so the bridge serialises upstream calls by default.
    maxUpstream: Math.max(1, overrides.maxUpstream ?? envInt(env, 'FPB_MAX_UPSTREAM', 1)),
    // How long a queued request may wait for a slot before giving up.
    queueTimeoutMs: overrides.queueTimeoutMs ?? envInt(env, 'FPB_QUEUE_TIMEOUT_MS', 180000),
    requestTimeoutMs: overrides.requestTimeoutMs ?? envInt(env, 'FPB_REQUEST_TIMEOUT_MS', 600000),
    // Advertised to DSH but not sent upstream unless FPB_FORWARD_MODE=1.
    apiKey: overrides.apiKey ?? env.FPB_API_KEY ?? '',
    clientVersion: env.FPB_CLIENT_VERSION || CLI_VERSION_FALLBACK,
    // free-pi counts sessions per account (4 signed-in, keyed by x-session-id).
    // The bridge claims exactly one slot so it can never exhaust them, no
    // matter how many conversations pass through it.
    sessionId: overrides.sessionId ?? env.FPB_SESSION_ID ?? defaultSessionId(env),
    // Whether a 409 concurrent_session may be cleared automatically by calling
    // POST /session/reset (frees the account's *other* sessions).
    takeover: overrides.takeover ?? (env.FPB_TAKEOVER === '1' || env.FPB_TAKEOVER === 'true'),
    logRequests: env.FPB_LOG === '1' || env.FPB_LOG === 'true',
  };
}

/**
 * One stable session id per installation. Stable across restarts so the server
 * reuses the same slot instead of leaking a new one on every launch, and
 * distinct per backend so two accounts do not collide.
 */
export function defaultSessionId(env = process.env) {
  const seed = `${env.FREEPI_BASE_URL || DEFAULT_BASE_URL}|${freePiAgentDir(env)}`;
  return `fpb-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

/**
 * free-pi's backend checks x-client-version against a minimum it publishes on
 * /client-version. If the installed CLI is newer we prefer that value (see
 * src/catalog.js); this is only the bootstrap fallback.
 */
export const CLI_VERSION_FALLBACK = '0.6.18';
