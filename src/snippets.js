/**
 * Emitters for client configuration.
 *
 * The important one is dshPatch(): a pasteable fragment for
 * ~/.dsh/profiles/<profile>/cordis.patch.yml. It mirrors the shape dsh's
 * @deepseek-ai/dsh-llm-pi-ai provider loader already uses in this machine's
 * working profile (api: openai-completions, baseURL, models[] with
 * contextWindow / maxTokens / input), so it loads without further editing.
 */

export const DSH_PROVIDER_ID = 'freepi';

function yamlValue(v) {
  // Model ids are plain tokens, but quote anything that could parse oddly.
  return /^[A-Za-z0-9._-]+$/.test(v) ? v : JSON.stringify(v);
}

/**
 * A dsh profile patch that registers free-pi as a provider and makes it the
 * default model.
 *
 * opts: { models, port, model, providerId, contextWindow, maxTokens, apiKeyEnv }
 */
export function dshPatch({
  models = [],
  port = 8791,
  model = null,
  providerId = DSH_PROVIDER_ID,
  contextWindow = 200000,
  maxTokens = 32768,
  // Pass a name (e.g. FREEPI_BRIDGE_API_KEY) only when the bridge is started
  // with --api-key. dsh resolves a named credential at call time and fails
  // auth when it is missing, so a keyless bridge must omit apiKeyEnv.
  apiKeyEnv = null,
  // Literal key written into the patch; dsh sends it as the bearer token.
  apiKey = null,
  includeDefault = true,
} = {}) {
  const list = (Array.isArray(models) ? models : []).filter((m) => m && m.id);
  const out = [];

  out.push('- id: llm-pi-ai');
  out.push('  name: "@deepseek-ai/dsh-llm-pi-ai"');
  out.push('  config:');
  out.push('    providers:');
  out.push(`      ${providerId}:`);
  out.push('        displayName: freepi');
  if (apiKeyEnv) out.push(`        apiKeyEnv: ${apiKeyEnv}`);
  if (apiKey) out.push(`        apiKey: ${JSON.stringify(String(apiKey))}`);
  out.push('        api: openai-completions');
  out.push(`        baseURL: http://127.0.0.1:${port}/v1`);
  out.push('        models:');
  for (const m of list) {
    const name = cleanModelName(m.name || m.id, m.id).replace(/\s+/g, ' ').trim();
    out.push(`          - id: ${yamlValue(m.id)}`);
    out.push(`            name: ${JSON.stringify(name)}`);
    out.push(`            contextWindow: ${contextWindow}`);
    out.push(`            maxTokens: ${maxTokens}`);
    out.push('            input:');
    out.push('              - text');
  }

  if (includeDefault && model) {
    out.push('- id: agent-default-model');
    out.push('  name: "@deepseek-ai/dsh-agent-default-model"');
    out.push('  config:');
    out.push(`    provider: ${providerId}`);
    out.push(`    model: ${yamlValue(model)}`);
  }

  return out.join('\n') + '\n';
}

/** A free-pi model name for display, stripping the "🔥 Free Unlimited" noise. */
export function cleanModelName(name, id) {
  const base = String(name ?? id ?? '');
  const cut = base.split('·')[0].trim();
  return cut || String(id ?? '');
}

/** One-line-per-model table for `freepi-bridge models`. */
export function renderModelTable(models, { defaultModel = null, width = 100 } = {}) {
  const clean = models.map((m) => ({ ...m, display: cleanModelName(m.name, m.id) }));
  const idCol = Math.min(34, Math.max(10, ...clean.map((m) => m.id.length)));
  const nameCol = Math.max(10, Math.min(44, width - idCol - 22));
  const rows = clean.map((m) => {
    const marker = m.id === defaultModel ? '*' : ' ';
    const flags = [];
    if (m.section === 'defense') flags.push('defense');
    if (m.unavailable) flags.push('unavailable');
    if (/\d+x usage/i.test(m.name)) {
      const mult = /(~[\d.]+\s*x usage)/i.exec(m.name);
      if (mult) flags.push(mult[1].replace(/\s+/g, ' '));
    }
    return [
      `${marker} ${m.id.padEnd(idCol)}`,
      m.display.slice(0, nameCol).padEnd(nameCol),
      flags.join(' '),
    ]
      .join(' ')
      .trimEnd();
  });
  return rows.join('\n');
}

/** Env snippet for a plain OpenAI client (curl, python, another harness). */
export function openaiEnvSnippet({ port = 8791, model = null, apiKey = '' } = {}) {
  return JSON.stringify(
    {
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_API_KEY: apiKey || 'not-needed',
      ...(model ? { OPENAI_MODEL: model } : {}),
    },
    null,
    2,
  );
}
