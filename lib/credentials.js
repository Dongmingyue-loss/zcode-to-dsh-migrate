'use strict';

const { isPlainObject } = require('./util');

const ALLOWED_ROOT_KEYS = new Set(['version', 'refs', 'records']);

function createEmptyCredentialsDoc(yaml) {
  return yaml.parseDocument('version: 1\nrefs: {}\nrecords: {}\n');
}

function loadCredentialsDoc(yaml, text, label = '.credentials.yaml') {
  if (!text || text.trim() === '') return createEmptyCredentialsDoc(yaml);

  const doc = yaml.parseDocument(text, { prettyErrors: true });
  if (doc.errors && doc.errors.length > 0) {
    throw new Error(`${label}: invalid YAML: ${doc.errors.map((error) => error.message).join('; ')}`);
  }

  const value = doc.toJSON();
  if (!isPlainObject(value)) throw new Error(`${label}: root must be a mapping.`);
  if (value.version !== 1) {
    throw new Error(`${label}: unsupported version ${JSON.stringify(value.version)}; expected 1.`);
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      throw new Error(`${label}: unknown top-level key "${key}".`);
    }
  }
  if (value.refs !== undefined && !isPlainObject(value.refs)) {
    throw new Error(`${label}: refs must be a mapping.`);
  }
  if (value.records !== undefined && !isPlainObject(value.records)) {
    throw new Error(`${label}: records must be a mapping.`);
  }
  if (value.refs) {
    for (const [name, secret] of Object.entries(value.refs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`${label}: invalid credential ref name "${name}".`);
      }
      if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error(`${label}: credential ref "${name}" must be a non-empty string.`);
      }
    }
  }
  if (value.records) {
    for (const [key, record] of Object.entries(value.records)) {
      if (!isPlainObject(record) || !['api-key', 'grant'].includes(record.kind)) {
        throw new Error(`${label}: record "${key}" must have kind "api-key" or "grant".`);
      }
    }
  }
  return doc;
}

function getRefs(doc) {
  const value = doc.toJSON();
  return isPlainObject(value.refs) ? value.refs : {};
}

function freeRefName(base, used) {
  let index = 2;
  let candidate = `${base}_${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  return candidate;
}

function assignCredentialRefs(providers, doc, policy) {
  const refs = getRefs(doc);
  const used = new Set(Object.keys(refs));
  const updates = [];
  const conflicts = [];
  const decisions = [];

  for (const provider of providers) {
    provider.apiKeyEnv = null;
    if (!provider.apiKey) {
      decisions.push({
        providerKey: provider.providerKey,
        action: 'none',
        reason: 'keyless',
      });
      continue;
    }

    const base = provider.refBase;
    const existing = refs[base];

    if (existing === undefined) {
      provider.apiKeyEnv = base;
      used.add(base);
      updates.push({ ref: base, value: provider.apiKey, action: 'create' });
      decisions.push({ providerKey: provider.providerKey, ref: base, action: 'create' });
      continue;
    }

    if (String(existing) === provider.apiKey) {
      provider.apiKeyEnv = base;
      decisions.push({ providerKey: provider.providerKey, ref: base, action: 'reuse' });
      continue;
    }

    if (policy === 'fail') {
      conflicts.push({
        type: 'credential',
        providerKey: provider.providerKey,
        ref: base,
        reason: 'existing-ref-has-different-value',
      });
      decisions.push({ providerKey: provider.providerKey, ref: base, action: 'conflict' });
      continue;
    }

    if (policy === 'prefer-zcode') {
      provider.apiKeyEnv = base;
      updates.push({ ref: base, value: provider.apiKey, action: 'overwrite' });
      conflicts.push({
        type: 'credential',
        providerKey: provider.providerKey,
        ref: base,
        reason: 'overwritten-by-policy',
      });
      decisions.push({ providerKey: provider.providerKey, ref: base, action: 'overwrite' });
      continue;
    }

    const fallback = freeRefName(base, used);
    provider.apiKeyEnv = fallback;
    used.add(fallback);
    updates.push({ ref: fallback, value: provider.apiKey, action: 'create-alternate' });
    conflicts.push({
      type: 'credential',
      providerKey: provider.providerKey,
      ref: base,
      alternateRef: fallback,
      reason: 'existing-ref-has-different-value',
    });
    decisions.push({ providerKey: provider.providerKey, ref: fallback, action: 'create-alternate' });
  }

  return { updates, conflicts, decisions, refs };
}

function applyRefUpdates(doc, updates) {
  if (!doc.hasIn(['version'])) doc.setIn(['version'], 1);
  if (!doc.hasIn(['refs'])) doc.setIn(['refs'], {});
  if (!doc.hasIn(['records'])) doc.setIn(['records'], {});
  for (const update of updates) {
    doc.setIn(['refs', update.ref], update.value);
  }
}

function validateCredentialsDoc(doc, label = '.credentials.yaml') {
  const value = doc.toJSON();
  if (!isPlainObject(value)) throw new Error(`${label}: root must be a mapping.`);
  if (value.version !== 1) throw new Error(`${label}: version must be 1.`);
  if (!isPlainObject(value.refs)) throw new Error(`${label}: refs must be a mapping.`);
  for (const [name, secret] of Object.entries(value.refs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`${label}: invalid ref name "${name}".`);
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error(`${label}: ref "${name}" must be a non-empty string.`);
    }
  }
  return value;
}

module.exports = {
  createEmptyCredentialsDoc,
  loadCredentialsDoc,
  getRefs,
  assignCredentialRefs,
  applyRefUpdates,
  validateCredentialsDoc,
};
