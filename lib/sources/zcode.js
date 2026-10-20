'use strict';

const { readJson, tryReadJson } = require('../util');
const {
  detectRuntimeModel,
  loadCliSidecars,
  loadAgents,
  loadSettings,
  summarizeSkills,
} = require('./common');

function normalizeModel(modelId, model) {
  const value = model && typeof model === 'object' ? model : {};
  const limit = value.limit && typeof value.limit === 'object' ? value.limit : {};
  const modalities = value.modalities && typeof value.modalities === 'object' ? value.modalities : {};
  const reasoning = value.reasoning && typeof value.reasoning === 'object' ? value.reasoning : null;
  // ZCode logs show that a model's "name" field, when present, is the wire
  // model id sent to the provider; the object key is the catalog/display key.
  const wireId = typeof value.name === 'string' && value.name ? value.name : modelId;

  return {
    id: wireId,
    name: modelId,
    sourceKey: modelId,
    wireId,
    contextWindow: Number.isFinite(limit.context) ? limit.context : null,
    maxTokens: Number.isFinite(limit.output) ? limit.output : null,
    input: Array.isArray(modalities.input) ? [...modalities.input] : ['text'],
    reasoning: reasoning
      ? {
          enabled: reasoning.enabled !== false,
          variants: Array.isArray(reasoning.variants) ? [...reasoning.variants] : [],
          defaultVariant: reasoning.defaultVariant || null,
        }
      : null,
    raw: value,
  };
}

function loadZcodeSource(source, opts = {}) {
  const config = readJson(source.providerConfigPath, 'ZCode config');
  if (!config || !config.provider || typeof config.provider !== 'object') {
    throw new Error(`ZCode config has no "provider" object: ${source.providerConfigPath}`);
  }

  const order = tryReadJson(source.orderPath);
  const providerOrder = order && Array.isArray(order.providerIds) ? [...order.providerIds] : [];
  const cli = loadCliSidecars(source.cliConfigPath);
  const settings = loadSettings(source.settingPath);
  const agents = loadAgents(source.agentsPath);
  const currentModel = detectRuntimeModel(source.providerConfigPath);
  const warnings = [];

  if (!cli.exists) warnings.push(`MCP/skills config not found: ${source.cliConfigPath}`);
  if (!agents.exists) warnings.push(`Global AGENTS.md not found: ${source.agentsPath}`);
  if (!currentModel) warnings.push('Could not detect the current ZCode model from logs.');

  const providers = Object.entries(config.provider).map(([providerId, provider]) => {
    const value = provider && typeof provider === 'object' ? provider : {};
    const options = value.options && typeof value.options === 'object' ? value.options : {};
    const deleted = value.zcode && Array.isArray(value.zcode.deletedModels)
      ? new Set(value.zcode.deletedModels)
      : new Set();

    const models = Object.entries(value.models && typeof value.models === 'object' ? value.models : {})
      .filter(([modelId]) => !deleted.has(modelId))
      .map(([modelId, model]) => normalizeModel(modelId, model));

    return {
      source: 'zcode',
      sourceId: providerId,
      name: typeof value.name === 'string' && value.name ? value.name : providerId,
      kind: typeof value.kind === 'string' ? value.kind : null,
      enabled: value.enabled !== false && !value.systemDisabledReason,
      systemDisabledReason: value.systemDisabledReason || null,
      baseURL: typeof options.baseURL === 'string' ? options.baseURL : null,
      apiKey: typeof options.apiKey === 'string' ? options.apiKey : '',
      apiKeyRequired: options.apiKeyRequired !== false,
      headers: options.headers && typeof options.headers === 'object' ? { ...options.headers } : null,
      models,
      meta: {
        source: value.source || null,
        deletedModels: [...deleted],
        zcode: value.zcode || null,
      },
    };
  });

  const orderIndex = new Map(providerOrder.map((id, index) => [id, index]));
  providers.sort((a, b) => {
    const ai = orderIndex.has(a.sourceId) ? orderIndex.get(a.sourceId) : Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.has(b.sourceId) ? orderIndex.get(b.sourceId) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.sourceId.localeCompare(b.sourceId);
  });

  return {
    kind: 'zcode',
    label: 'official ZCode',
    paths: source,
    providerConfigPath: source.providerConfigPath,
    providers,
    providerOrder,
    mcpServers: cli.mcpServers,
    skills: summarizeSkills(cli.skillEntries, opts.sharedSkillsDir),
    settings,
    agents,
    currentModel,
    warnings,
    sidecars: cli,
  };
}

module.exports = {
  loadZcodeSource,
  normalizeModel,
};
