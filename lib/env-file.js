'use strict';

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function unquote(value) {
  const trimmed = String(value).trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnv(text) {
  const lines = splitLines(text);
  const entries = new Map();
  lines.forEach((line, index) => {
    const match = ENV_LINE.exec(line);
    if (!match) return;
    entries.set(match[1], { key: match[1], value: unquote(match[2]), line: index });
  });
  return { lines, entries };
}

function findCaseInsensitive(entries, key) {
  const lower = key.toLowerCase();
  for (const [name, entry] of entries) {
    if (name.toLowerCase() === lower) return entry;
  }
  return null;
}

function mergeEnvText(text, updates, policy = 'keep') {
  const newline = detectNewline(text || '');
  const parsed = parseEnv(text || '');
  const lines = [...parsed.lines];
  const actions = [];
  const conflicts = [];
  let changed = false;

  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) continue;
    const existing = findCaseInsensitive(parsed.entries, key);

    if (existing) {
      if (existing.value === value) {
        actions.push({ key: existing.key, action: 'unchanged', value });
        continue;
      }
      if (policy === 'fail') {
        conflicts.push({ type: 'env', key: existing.key, reason: 'existing-value-differs' });
        actions.push({ key: existing.key, action: 'conflict', value });
        continue;
      }
      if (policy === 'keep') {
        conflicts.push({ type: 'env', key: existing.key, reason: 'existing-value-differs' });
        actions.push({ key: existing.key, action: 'kept-existing', value });
        continue;
      }
      lines[existing.line] = `${existing.key}=${value}`;
      actions.push({ key: existing.key, action: 'updated', value });
      changed = true;
      continue;
    }

    lines.push(`${key}=${value}`);
    actions.push({ key, action: 'created', value });
    changed = true;
  }

  let output = lines.join(newline);
  if (changed && !output.endsWith(newline)) output += newline;
  return { text: output, actions, conflicts, changed };
}

module.exports = {
  parseEnv,
  mergeEnvText,
};
