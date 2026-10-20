'use strict';

const { isPlainObject } = require('./util');

function assertPatchDocument(doc, label) {
  if (!doc.contents || !Array.isArray(doc.contents.items)) {
    throw new Error(`${label}: expected a top-level YAML array.`);
  }
}

function findEntryIndex(doc, id) {
  assertPatchDocument(doc, 'cordis.patch.yml');
  return doc.contents.items.findIndex((entry) => {
    if (!entry || typeof entry.get !== 'function') return false;
    return entry.get('id') === id;
  });
}

function findEntryIndexByName(doc, name) {
  assertPatchDocument(doc, 'cordis.patch.yml');
  return doc.contents.items.findIndex((entry) => {
    if (!entry || typeof entry.get !== 'function') return false;
    return entry.get('name') === name;
  });
}

function getEntry(doc, index) {
  const entry = doc.contents.items[index];
  return entry && typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
}

function appendEntry(doc, value) {
  assertPatchDocument(doc, 'cordis.patch.yml');
  doc.contents.items.push(doc.createNode(value));
}

function setEntryAt(doc, index, value) {
  assertPatchDocument(doc, 'cordis.patch.yml');
  if (index < 0 || index >= doc.contents.items.length) {
    throw new Error(`Cannot replace entry at index ${index}.`);
  }
  doc.contents.items[index] = doc.createNode(value);
}

function ensureLlmEntry(doc) {
  let index = findEntryIndex(doc, 'llm-pi-ai');
  if (index === -1) index = findEntryIndexByName(doc, '@deepseek-ai/dsh-llm-pi-ai');
  if (index === -1) {
    appendEntry(doc, {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: {} },
    });
    index = doc.contents.items.length - 1;
  }

  const entry = getEntry(doc, index);
  if (!isPlainObject(entry)) throw new Error('llm-pi-ai entry is not a mapping.');
  if (entry.config !== undefined && !isPlainObject(entry.config)) {
    throw new Error('llm-pi-ai.config is not a mapping.');
  }
  if (!doc.hasIn([index, 'config'])) doc.setIn([index, 'config'], {});
  if (!doc.hasIn([index, 'config', 'providers'])) doc.setIn([index, 'config', 'providers'], {});
  return index;
}

function getLlmProviders(doc) {
  const index = findEntryIndex(doc, 'llm-pi-ai');
  if (index === -1) return {};
  const entry = getEntry(doc, index);
  const providers = entry && entry.config && entry.config.providers;
  return isPlainObject(providers) ? providers : {};
}

function getLlmEntryIndex(doc) {
  return findEntryIndex(doc, 'llm-pi-ai');
}

function setProvider(doc, index, providerKey, providerConfig) {
  doc.setIn([index, 'config', 'providers', providerKey], providerConfig);
}

function getMcpEntries(doc) {
  assertPatchDocument(doc, 'cordis.patch.yml');
  return doc.contents.items
    .map((entry, index) => {
      const value = getEntry(doc, index);
      if (!isPlainObject(value)) return null;
      if (value.name !== '@deepseek-ai/dsh-mcp-client') return null;
      return {
        index,
        id: value.id || null,
        serverName: value.config && value.config.serverName ? value.config.serverName : null,
        config: value.config || {},
      };
    })
    .filter(Boolean);
}

function findMcpEntry(doc, serverName) {
  return getMcpEntries(doc).find((entry) => entry.serverName === serverName) || null;
}

function appendMcpEntry(doc, entry) {
  appendEntry(doc, entry);
}

function getDefaultModelEntry(doc) {
  const index = findEntryIndex(doc, 'agent-default-model');
  if (index === -1) return null;
  return { index, value: getEntry(doc, index) };
}

function ensureDefaultModelEntry(doc) {
  let found = findEntryIndex(doc, 'agent-default-model');
  if (found === -1) {
    appendEntry(doc, {
      id: 'agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      config: {},
    });
    found = doc.contents.items.length - 1;
  }
  return found;
}

function setDefaultModel(doc, provider, model) {
  const index = ensureDefaultModelEntry(doc);
  if (!doc.hasIn([index, 'config'])) doc.setIn([index, 'config'], {});
  doc.setIn([index, 'config', 'provider'], provider);
  doc.setIn([index, 'config', 'model'], model);
}

function validatePatch(doc, label = 'cordis.patch.yml') {
  const value = doc.toJSON();
  if (!Array.isArray(value)) throw new Error(`${label}: expected a top-level array.`);
  const seen = new Set();
  for (const entry of value) {
    if (!isPlainObject(entry)) throw new Error(`${label}: every entry must be a mapping.`);
    if (!entry.id || typeof entry.id !== 'string') throw new Error(`${label}: every entry needs a string id.`);
    if (!entry.name || typeof entry.name !== 'string') throw new Error(`${label}: entry "${entry.id}" needs a string name.`);
    if (seen.has(entry.id)) throw new Error(`${label}: duplicate entry id "${entry.id}".`);
    seen.add(entry.id);
    if (entry.config !== undefined && !isPlainObject(entry.config)) {
      throw new Error(`${label}: entry "${entry.id}" config must be a mapping.`);
    }
  }
  const llm = value.find((entry) => entry.id === 'llm-pi-ai');
  if (llm && llm.config && llm.config.providers !== undefined && !isPlainObject(llm.config.providers)) {
    throw new Error(`${label}: llm-pi-ai.config.providers must be a mapping.`);
  }
  return value;
}

module.exports = {
  assertPatchDocument,
  findEntryIndex,
  findEntryIndexByName,
  getEntry,
  appendEntry,
  setEntryAt,
  ensureLlmEntry,
  getLlmProviders,
  getLlmEntryIndex,
  setProvider,
  getMcpEntries,
  findMcpEntry,
  appendMcpEntry,
  getDefaultModelEntry,
  ensureDefaultModelEntry,
  setDefaultModel,
  validatePatch,
};
