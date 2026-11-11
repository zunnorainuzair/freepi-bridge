import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Write (or replace) the bridge's entries in a dsh profile patch file.
 *
 * dsh composes its loader tree from patches: the file is a YAML array where
 * each entry is targeted by `id`. Re-running the emitter must not append a
 * second llm-pi-ai block, so we parse the existing array coarsely, drop any
 * entry that targets the same component id, and append ours.
 */
export function backupAndWritePatch(path, patchText) {
  const original = readFileSync(path, 'utf8');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${path}.${stamp}.bak`;
  copyFileSync(path, backup);

  const ours = splitEntries(patchText);
  const ourIds = new Set(ours.map((e) => e.id));
  const kept = splitEntries(original).filter((e) => !ourIds.has(e.id));

  const body = [...kept.map((e) => e.text.trimEnd()), ...ours.map((e) => e.text.trimEnd())].join('\n');
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`);
  return { backup, replaced: [...ourIds], kept: kept.length };
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
