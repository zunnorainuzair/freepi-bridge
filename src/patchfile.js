import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Write (or replace) the bridge's entries in a dsh profile patch file.
 *
 * dsh composes its loader tree from patches: the file is a YAML array where
 * each entry is targeted by `id`. Re-running the emitter must not append a
 * second llm-pi-ai block, so we parse the existing array coarsely, drop the
 * entries we own, and append ours.
 *
 * The subtlety is `llm-pi-ai`: every provider lives inside that one entry's
 * `config.providers` map, so replacing the entry wholesale would delete the
 * user's other providers (a working deepseek-bridge route, for example). We
 * therefore merge at the provider level: keep their providers untouched, and
 * replace only the ones the bridge manages.
 */
export function backupAndWritePatch(path, patchText, { managedProviders = ['freepi'] } = {}) {
  const original = readFileSync(path, 'utf8');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${path}.${stamp}.bak`;
  copyFileSync(path, backup);

  const ours = splitEntries(patchText);
  const ourIds = new Set(ours.map((e) => e.id));
  const existing = splitEntries(original);
  const out = [];
  const preservedProviders = [];

  for (const entry of existing) {
    if (!ourIds.has(entry.id)) {
      out.push(entry.text.trimEnd());
      continue;
    }
    const ourEntry = ours.find((e) => e.id === entry.id);
    if (entry.id === 'llm-pi-ai') {
      const merged = mergeProviderEntry(entry.text, ourEntry.text, managedProviders);
      preservedProviders.push(...merged.preserved);
      out.push(merged.text.trimEnd());
    }
    // Other managed ids (agent-default-model) are simply replaced below.
  }

  // Append any managed entry the file did not already have.
  for (const entry of ours) {
    const alreadyEmitted = out.some((t) => new RegExp(`^-\\s+id:\\s*["']?${entry.id}["']?\\s*$`, 'm').test(t));
    if (!alreadyEmitted) out.push(entry.text.trimEnd());
  }

  const body = out.join('\n');
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`);
  return {
    backup,
    replaced: [...ourIds],
    kept: existing.filter((e) => !ourIds.has(e.id)).length,
    preservedProviders,
  };
}

/**
 * Merge our `llm-pi-ai` entry into an existing one, keeping providers we do not
 * manage. Indentation-based, which is enough for the shape dsh writes:
 *
 *   - id: llm-pi-ai
 *     config:
 *       providers:
 *         <name>:        <- 6 spaces
 *           ...
 */
export function mergeProviderEntry(existingText, ourText, managedProviders = ['freepi']) {
  const managed = new Set(managedProviders);
  const existingProviders = readProviders(existingText);
  const ourProviders = readProviders(ourText);

  const preserved = existingProviders
    .filter((p) => !managed.has(p.name))
    .map((p) => p.name);

  if (preserved.length === 0) return { text: ourText, preserved };

  // Rebuild our entry's providers map with their providers first, then ours.
  const lines = ourText.split('\n');
  const insertAt = lines.findIndex((l) => /^\s{4}providers:\s*$/.test(l));
  if (insertAt === -1) return { text: ourText, preserved: [] };

  const theirs = existingProviders
    .filter((p) => !managed.has(p.name))
    .flatMap((p) => p.lines);

  const rebuilt = [...lines.slice(0, insertAt + 1), ...theirs, ...lines.slice(insertAt + 1)];
  return { text: rebuilt.join('\n'), preserved };
}

/** Read the `config.providers.*` blocks of an entry as { name, lines }. */
export function readProviders(entryText) {
  const lines = String(entryText).split('\n');
  const start = lines.findIndex((l) => /^\s{4}providers:\s*$/.test(l));
  if (start === -1) return [];

  const providers = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A provider key sits at 6 spaces; anything shallower ends the map.
    const key = /^ {6}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (key) {
      if (current) providers.push(current);
      current = { name: key[1], lines: [line] };
      continue;
    }
    if (current) {
      // Stop at the next top-level entry or a shallower key.
      if (/^-\s/.test(line) || /^\s{0,5}\S/.test(line)) break;
      current.lines.push(line);
    } else if (line.trim() && !/^\s*#/.test(line)) {
      break;
    }
  }
  if (current) providers.push(current);
  return providers;
}

/** Split a top-level YAML array of `- id: ...` entries into { id, text }. */
export function splitEntries(text) {
  const lines = String(text).split('\n');
  const entries = [];
  let current = null;

  for (const line of lines) {
    const isEntryStart = /^-\s+/.test(line);
    if (isEntryStart) {
      if (current) entries.push(current);
      current = { id: null, text: line };
      const m = /^-\s+id:\s*(\S+)\s*$/.exec(line);
      if (m) current.id = m[1].replace(/^["']|["']$/g, '');
      continue;
    }
    if (current) current.text += `\n${line}`;
    // Lines before the first entry (comments, `[]`) are dropped on rewrite;
    // backupAndWritePatch keeps a .bak of the original.
  }
  if (current) entries.push(current);
  return entries;
}
