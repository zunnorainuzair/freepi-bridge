/**
 * Model catalog for the bridge.
 *
 * free-pi does not expose a public /v1/models. The CLI learns its model list
 * from GET /client-version, which returns `latest`, `min`, a default `model`
 * name and a `models` array of { id, name, section?, tier? }. We use the same
 * call, so the bridge always advertises exactly what the CLI would offer, and
 * fall back to a small static list when offline.
 */

/** Static fallback: the ids observed in the catalog on 2026-11, minus the
 *  "unavailable" entries and the Defense-only ones. */
export const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
  { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash' },
  { id: 'qwen3.5-35b-darkbloom', name: 'Qwen3.5 35B' },
  { id: 'solar-pro-4', name: 'Solar Pro 4' },
  { id: 'particle', name: 'Particle' },
];

/** The default model the CLI pins when nothing else is configured. */
export const DEFAULT_MODEL_ID = 'deepseek-v4.1-flash';

const CACHE_TTL_MS = 10 * 60 * 1000;

export function createCatalog({ baseUrl, getToken, fetchImpl = fetch, timeoutMs = 8000, log = () => {} } = {}) {
  let cache = { at: 0, models: [], latest: null, min: null, defaultModel: null };

  async function fetchRemote() {
    const token = await getToken();
    const res = await fetchImpl(new URL('/client-version', baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new Error(`client-version HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Returns { models, latest, min, defaultModel, source }.
   * `models` entries are { id, name, section, tier, premium, unavailable }.
   */
  async function load({ force = false } = {}) {
    const fresh = Date.now() - cache.at < CACHE_TTL_MS;
    if (!force && fresh && cache.models.length) return { ...cache };

    try {
      const data = await fetchRemote();
      const raw = Array.isArray(data?.models) ? data.models : [];
      const models = raw
        .filter((m) => m && typeof m.id === 'string' && m.id.length > 0)
        .map((m) => {
          const name = String(m.name ?? m.id);
          return {
            id: m.id,
            name,
            section: m.section ?? null,
            tier: m.tier ?? null,
            // The catalog marks models unusable by suffixing the display name.
            unavailable: /unavailable/i.test(name),
          };
        });

      if (!models.length) throw new Error('catalog had no models');

      cache = {
        at: Date.now(),
        models,
        latest: typeof data.latest === 'string' ? data.latest : null,
        min: typeof data.min === 'string' ? data.min : null,
        defaultModel: typeof data.model === 'string' ? data.model : null,
        source: 'upstream',
      };
      log(`catalog: ${models.length} models from ${baseUrl}/client-version (latest ${cache.latest ?? '?'})`);
      return { ...cache };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (cache.models.length) {
        log(`catalog: refresh failed (${reason}); keeping cached list`);
        return { ...cache };
      }
      log(`catalog: fetch failed (${reason}); using the built-in list`);
      cache = {
        at: Date.now(),
        models: FALLBACK_MODELS.map((m) => ({ ...m, section: null, tier: null, unavailable: false })),
        latest: null,
        min: null,
        defaultModel: null,
        source: 'fallback',
      };
      return { ...cache };
    }
  }

  return { load };
}

/**
 * Upstream accepts the bare catalog id ("deepseek-v4-flash") and the
 * namespaced form ("deepseek/deepseek-v4-flash"). The bridge advertises bare
 * ids, but clients sometimes send a provider/id pair, so pass both through.
 */
export function catalogIds(catalog) {
  return new Set((catalog.models ?? []).map((m) => m.id));
}

/** Map a requested model onto a catalog id, or null if it is unknown. */
export function resolveModelId(requested, catalog) {
  const want = String(requested ?? '').trim();
  if (!want) return null;
  const ids = catalogIds(catalog);
  if (ids.has(want)) return want;

  const bare = want.includes('/') ? want.slice(want.lastIndexOf('/') + 1) : want;
  if (ids.has(bare)) return bare;

  // Models change often; an id we do not know may still be valid upstream.
  // Accept anything that looks like a model id rather than failing the turn.
  return /^[A-Za-z0-9][A-Za-z0-9./_:@-]{0,127}$/.test(want) ? want : null;
}
