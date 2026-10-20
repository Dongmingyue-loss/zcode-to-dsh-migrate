'use strict';

const { readJson } = require('../util');
const {
  loadCliSidecars,
  loadAgents,
  loadSettings,
  summarizeSkills,
} = require('./common');

const API_KIND_MAP = {
  'openai-chat-completions': 'openai-compatible',
  'openai-completions': 'openai-compatible',
  'openai-responses': 'openai',
  'anthropic-messages': 'anthropic',
};

function modelRuleMap(rules) {
  const map = new Map();
  for (const rule of rules) {
    if (!rule || !rule.providerId || !rule.modelId) continue;
    map.set(`${rule.providerId}\u0000${rule.modelId}`, rule);
  }
  return map;
}

function normalizeModelFromRule(modelId, rule) {
  const config = rule && rule.config && typeof rule.config === 'object' ? rule.config : {};
  const properties = config.properties && typeof config.properties === 'object' ? config.properties : {};
  const optionSpecs = config.optionSpecs && typeof config.optionSpecs === 'object' ? config.optionSpecs : {};
  const inputFormat = properties.inputFormat && typeof properties.inputFormat === 'object'
    ? properties.inputFormat
    : {};
  const reasoningLevel = optionSpecs.reasoningLevel && typeof optionSpecs.reasoningLevel === 'object'
    ? optionSpecs.reasoningLevel
    : null;

  const input = ['text'];
  if (inputFormat.supportsImage) input.push('image');

  return {
    id: modelId,
    name: modelId,
    sourceKey: modelId,
    wireId: modelId,
    contextWindow: Number.isFinite(properties.contextWindow) ? properties.contextWindow : null,
    maxTokens: Number.isFinite(optionSpecs.maxOutputTokens?.max) ? optionSpecs.maxOutputTokens.max : null,
    input,
    reasoning: reasoningLevel
      ? {
          enabled: true,
          variants: Array.isArray(reasoningLevel.values) ? [...reasoningLevel.values] : [],
          defaultVariant: Array.isArray(reasoningLevel.values) ? reasoningLevel.values[0] || null : null,
        }
      : null,
    raw: rule || null,
  };
}

function loadZcodiumSource(source, opts = {}) {
  const config = readJson(source.providerConfigPath, 'ZCodium provider config');
  const root = config && config.config && typeof config.config === 'object' ? config.config : config;
  const providerRules = root?.providerConfigRules?.providerRules;
  const manualRules = root?.modelConfigRules?.manualProviderModelRules;
  const providerModelRules = root?.modelConfigRules?.providerModelRules;
  const rules = [
    ...(Array.isArray(providerModelRules) ? providerModelRules : []),
    ...(Array.isArray(manualRules) ? manualRules : []),
  ];
  const ruleMap = modelRuleMap(rules);

  if (!Array.isArray(providerRules)) {
    throw new Error(`ZCodium config has no providerConfigRules.providerRules: ${source.providerConfigPath}`);
  }

  const cli = loadCliSidecars(source.cliConfigPath);
  const settings = loadSettings(source.settingPath);
  const agents = loadAgents(source.agentsPath);
  const warnings = [];

  if (!cli.exists) warnings.push(`MCP/skills config not found: ${source.cliConfigPath}`);
  if (!agents.exists) warnings.push(`Global AGENTS.md not found: ${source.agentsPath}`);
  warnings.push('ZCodium does not persist the currently selected model in a readable config file.');

  const providers = providerRules.map((rule) => {
    const value = rule && typeof rule === 'object' ? rule : {};
    const providerId = String(value.providerId || 'unknown');
    const providerName = typeof value.providerName === 'string' && value.providerName
      ? value.providerName
      : providerId;
    const providerConfig = value.config && typeof value.config === 'object' ? value.config : {};
    const access = providerConfig.access && typeof providerConfig.access === 'object' ? providerConfig.access : {};
    const api = providerConfig.api && typeof providerConfig.api === 'object' ? providerConfig.api : {};
    const apiType = typeof api.type === 'string' ? api.type : null;
    const modelIds = Array.isArray(providerConfig.personalModelIds) && providerConfig.personalModelIds.length > 0
      ? providerConfig.personalModelIds
      : Array.isArray(providerConfig.modelOrder) && providerConfig.modelOrder.length > 0
        ? providerConfig.modelOrder
        : rules.filter((item) => item.providerId === providerId).map((item) => item.modelId);

    const models = [...new Set(modelIds)]
      .map((modelId) => normalizeModelFromRule(modelId, ruleMap.get(`${providerId}\u0000${modelId}`)));

    return {
      source: 'zcodium',
      sourceId: providerId,
      name: providerName,
      kind: API_KIND_MAP[apiType] || (apiType ? apiType : null),
      enabled: true,
      systemDisabledReason: null,
      baseURL: typeof api.baseUrl === 'string' ? api.baseUrl : null,
      apiKey: typeof access.apiKey === 'string' ? access.apiKey : '',
      apiKeyRequired: true,
      headers: providerConfig.headers && typeof providerConfig.headers === 'object'
        ? { ...providerConfig.headers }
        : null,
      models,
      meta: {
        source: 'zcodium',
        apiType,
        group: providerConfig.group || null,
      },
    };
  });

  const order = Array.isArray(root.providerOrder) ? root.providerOrder : [];
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  providers.sort((a, b) => {
    const ai = orderIndex.has(a.sourceId) ? orderIndex.get(a.sourceId) : Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.has(b.sourceId) ? orderIndex.get(b.sourceId) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.sourceId.localeCompare(b.sourceId);
  });

  return {
    kind: 'zcodium',
    label: 'ZCodium',
    paths: source,
    providerConfigPath: source.providerConfigPath,
    providers,
    providerOrder: order,
    mcpServers: cli.mcpServers,
    skills: summarizeSkills(cli.skillEntries, opts.sharedSkillsDir),
    settings,
    agents,
    currentModel: null,
    warnings,
    sidecars: cli,
  };
}

module.exports = {
  loadZcodiumSource,
};
