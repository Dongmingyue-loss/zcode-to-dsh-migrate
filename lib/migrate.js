'use strict';

const fs = require('fs');

const { discoverSources, discoverTarget } = require('./discover');
const { loadYamlModule, parseDocument } = require('./yaml');
const { readText, readTextOrEmpty, isPlainObject, uniqueName } = require('./util');
const dsh = require('./dsh-config');
const credentials = require('./credentials');
const { mergeEnvText } = require('./env-file');
const { normalizeProviders } = require('./normalize');
const { loadZcodeSource } = require('./sources/zcode');
const { loadZcodiumSource } = require('./sources/zcodium');

const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client';

function loadSources(opts = {}) {
  const target = discoverTarget(opts);
  const sourcePaths = discoverSources(opts);
  const sources = [];
  const warnings = [];

  for (const sourcePath of sourcePaths) {
    if (!sourcePath.exists) {
      warnings.push(`${sourcePath.label} provider config not found: ${sourcePath.providerConfigPath || '(no path)'}`);
      continue;
    }
    const loader = sourcePath.kind === 'zcode' ? loadZcodeSource : loadZcodiumSource;
    const data = loader(sourcePath, { sharedSkillsDir: target.sharedSkillsDir });
    sources.push(data);
    warnings.push(...data.warnings);
  }

  if (sources.length === 0) {
    throw new Error('No readable source config was found. Use --source zcode|zcodium|all and check the paths.');
  }

  return { target, sourcePaths, sources, warnings };
}

function safeUrlDisplay(value) {
  if (!value) return value;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value)) ? String(value) : `http://${value}`;
    const url = new URL(withScheme);
    const pathname = url.pathname && url.pathname !== '/' ? url.pathname : '';
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return '[unparseable-url]';
  }
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return text;
  try {
    const url = new URL(text);
    const pathname = url.pathname.replace(/\/+/g, '/').replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return text.replace(/\/+$/, '');
  }
}

function providerIdentity(config) {
  const models = Array.isArray(config.models) ? config.models.map((model) => model.id).sort() : [];
  return `${config.api || ''}|${normalizeBaseUrl(config.baseURL || '')}|${models.join(',')}`;
}

function findEquivalentProvider(existingProviders, config) {
  const wanted = providerIdentity(config);
  for (const [key, existing] of Object.entries(existingProviders || {})) {
    if (!isPlainObject(existing)) continue;
    if (providerIdentity(existing) === wanted) return key;
  }
  return null;
}

function buildProviderConfig(provider) {
  const config = {};
  if (provider.dsh.displayName) config.displayName = provider.dsh.displayName;
  if (provider.apiKeyEnv) config.apiKeyEnv = provider.apiKeyEnv;
  config.api = provider.dsh.api;
  config.baseURL = provider.dsh.baseURL;
  config.models = provider.dsh.models;
  return config;
}

function buildDshProviders(providers) {
  return providers.map((provider) => ({
    ...provider,
    config: buildProviderConfig(provider),
  }));
}

function decideProviders(existingProviders, providers, policy) {
  const decisions = [];
  const usedKeys = new Set(Object.keys(existingProviders || {}));

  for (const provider of providers) {
    const equivalentKey = findEquivalentProvider(existingProviders, provider.config);

    if (equivalentKey) {
      const ours = equivalentKey.startsWith('zcode-') || equivalentKey.startsWith('zcodium-');
      if (policy === 'prefer-zcode' && ours) {
        decisions.push({
          action: 'update',
          key: equivalentKey,
          provider,
          config: provider.config,
          reason: 'equivalent-existing',
        });
      } else if (policy === 'fail') {
        decisions.push({
          action: 'conflict',
          key: equivalentKey,
          provider,
          config: provider.config,
          reason: 'equivalent-existing',
        });
      } else {
        decisions.push({
          action: 'skip',
          key: equivalentKey,
          provider,
          config: provider.config,
          reason: ours ? 'already-present' : 'equivalent-existing-protected',
        });
      }
      continue;
    }

    let key = provider.providerKey;
    if (usedKeys.has(key)) {
      if (policy === 'prefer-zcode') {
        decisions.push({
          action: 'update',
          key,
          provider,
          config: provider.config,
          reason: 'key-collision',
        });
        continue;
      }
      if (policy === 'fail') {
        decisions.push({
          action: 'conflict',
          key,
          provider,
          config: provider.config,
          reason: 'key-collision',
        });
        continue;
      }
      let suffix = 2;
      while (usedKeys.has(`${key}-${suffix}`)) suffix += 1;
      const alternate = `${key}-${suffix}`;
      usedKeys.add(alternate);
      decisions.push({
        action: 'add',
        key: alternate,
        provider,
        config: provider.config,
        reason: 'key-collision',
      });
      continue;
    }

    usedKeys.add(key);
    decisions.push({ action: 'add', key, provider, config: provider.config, reason: 'new' });
  }

  return decisions;
}

function applyProviderDecisions(doc, decisions) {
  if (!decisions.some((decision) => decision.action === 'add' || decision.action === 'update')) {
    return;
  }
  const index = dsh.ensureLlmEntry(doc);
  for (const decision of decisions) {
    if (decision.action === 'add' || decision.action === 'update') {
      dsh.setProvider(doc, index, decision.key, decision.config);
    }
  }
}

function sanitizeServerName(name) {
  let value = String(name || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  if (!value) value = 'server';
  return value;
}

function mcpConfigFor(server) {
  if (server.type === 'http') {
    if (!server.url) return null;
    const config = {
      serverName: null,
      transport: 'streamable-http',
      url: server.url,
    };
    if (server.headers && Object.keys(server.headers).length > 0) config.headers = server.headers;
    if (Number.isFinite(server.timeoutMs)) config.toolCallTimeoutMs = server.timeoutMs;
    return config;
  }

  if (server.type === 'stdio') {
    if (!server.command) return null;
    const config = {
      serverName: null,
      transport: 'stdio',
      command: server.command,
    };
    if (Array.isArray(server.args) && server.args.length > 0) config.args = server.args;
    if (server.env && Object.keys(server.env).length > 0) config.env = server.env;
    if (server.cwd) config.cwd = server.cwd;
    if (Number.isFinite(server.timeoutMs)) config.toolCallTimeoutMs = server.timeoutMs;
    return config;
  }

  return null;
}

function mcpCore(config) {
  return JSON.stringify({
    transport: config.transport,
    url: config.url || null,
    command: config.command || null,
    args: config.args || null,
    env: config.env || null,
    headers: config.headers || null,
    toolCallTimeoutMs: config.toolCallTimeoutMs || null,
  });
}

function collectMcpServers(sourceData, policy) {
  const servers = [];
  const skipped = [];
  const conflicts = [];
  const byName = new Map();
  const usedNames = new Set();
  const usedIds = new Set();

  for (const source of sourceData) {
    for (const server of source.mcpServers || []) {
      const config = mcpConfigFor(server);
      if (!config) {
        skipped.push({
          source: source.kind,
          name: server.name,
          reason: server.type === 'sse' ? 'sse-not-supported' : 'invalid-mcp-server',
        });
        continue;
      }

      let serverName = sanitizeServerName(server.name);
      if (byName.has(serverName)) {
        const existing = byName.get(serverName);
        if (mcpCore(existing.config) === mcpCore(config)) {
          skipped.push({ source: source.kind, name: server.name, reason: 'duplicate-server' });
          continue;
        }
        if (policy === 'fail') {
          conflicts.push({ type: 'mcp', serverName, reason: 'same-name-different-config' });
          continue;
        }
        conflicts.push({ type: 'mcp', serverName, reason: 'same-name-different-config-renamed' });
        serverName = uniqueName(serverName, usedNames);
      }
      usedNames.add(serverName);
      config.serverName = serverName;

      let entryId = `mcp-${source.kind}-${serverName}`.replace(/[^A-Za-z0-9_-]+/g, '-');
      entryId = uniqueName(entryId, usedIds);
      usedIds.add(entryId);

      const item = {
        source: source.kind,
        originalName: server.name,
        serverName,
        entryId,
        config,
      };
      servers.push(item);
      byName.set(serverName, item);
    }
  }

  return { servers, skipped, conflicts };
}

function decideMcp(doc, collected, policy) {
  const existingEntries = dsh.getMcpEntries(doc);
  const decisions = [];
  const existingByName = new Map();
  const usedIds = new Set(existingEntries.map((entry) => entry.id).filter(Boolean));

  for (const entry of existingEntries) {
    if (entry.serverName) existingByName.set(entry.serverName, entry);
  }

  for (const item of collected.servers) {
    const existing = existingByName.get(item.serverName);
    if (existing) {
      if (mcpCore(existing.config) === mcpCore(item.config)) {
        decisions.push({ action: 'skip', item, existing, reason: 'already-present' });
      } else if (policy === 'prefer-zcode') {
        decisions.push({ action: 'update', item, existing, reason: 'different-config' });
      } else if (policy === 'fail') {
        decisions.push({ action: 'conflict', item, existing, reason: 'different-config' });
      } else {
        decisions.push({ action: 'skip', item, existing, reason: 'kept-existing' });
      }
      continue;
    }

    let entryId = item.entryId;
    if (usedIds.has(entryId)) {
      let suffix = 2;
      while (usedIds.has(`${entryId}-${suffix}`)) suffix += 1;
      entryId = `${entryId}-${suffix}`;
    }
    usedIds.add(entryId);
    decisions.push({ action: 'add', item, entryId, reason: 'new' });
  }

  return decisions;
}

function applyMcpDecisions(doc, decisions) {
  for (const decision of decisions) {
    if (decision.action === 'add') {
      dsh.appendMcpEntry(doc, {
        id: decision.entryId,
        name: MCP_PLUGIN,
        config: decision.item.config,
      });
    } else if (decision.action === 'update') {
      dsh.setEntryAt(doc, decision.existing.index, {
        id: decision.existing.id || decision.item.entryId,
        name: MCP_PLUGIN,
        config: decision.item.config,
      });
    }
  }
}

function collectAgents(sourceData) {
  const entries = [];
  const warnings = [];
  for (const source of sourceData) {
    if (!source.agents || !source.agents.exists || !source.agents.content.trim()) continue;
    const existing = entries.find((entry) => entry.content === source.agents.content);
    if (existing) continue;
    entries.push({
      source: source.kind,
      path: source.agents.path,
      content: source.agents.content,
    });
  }
  if (entries.length > 1) {
    warnings.push('Multiple distinct global AGENTS.md files were found; the first source wins.');
  }
  return { selected: entries[0] || null, entries, warnings };
}

function decideAgents(target, collected, policy) {
  if (!collected.selected) {
    return { action: 'none', reason: 'no-source-agents' };
  }

  const exists = fs.existsSync(target.agentsPath);
  const current = exists ? readText(target.agentsPath) : '';
  const desired = collected.selected.content;

  if (exists && current === desired) {
    return { action: 'unchanged', content: current, source: collected.selected.source };
  }
  if (!exists) {
    return { action: 'create', content: desired, source: collected.selected.source };
  }
  if (policy === 'prefer-zcode') {
    return { action: 'overwrite', content: desired, source: collected.selected.source };
  }
  if (policy === 'fail') {
    return { action: 'conflict', content: current, source: collected.selected.source };
  }
  return { action: 'skip', content: current, source: collected.selected.source, reason: 'kept-existing' };
}

function normalizeProxy(value) {
  const text = String(value || '').trim();
  if (!text) return { supported: false, reason: 'empty' };
  if (/^socks/i.test(text)) return { supported: false, reason: 'socks-not-supported' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { supported: false, reason: 'invalid-url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { supported: false, reason: `unsupported-protocol:${url.protocol}` };
  }
  const pathname = url.pathname && url.pathname !== '/' ? url.pathname : '';
  return { supported: true, url: `${url.protocol}//${url.host}${pathname}` };
}

function collectProxy(sourceData) {
  const entries = [];
  for (const source of sourceData) {
    const value = source.settings && source.settings.httpProxy;
    if (typeof value !== 'string' || !value.trim()) continue;
    const normalized = normalizeProxy(value);
    entries.push({
      source: source.kind,
      raw: value,
      normalized,
    });
  }
  const supported = entries.filter((entry) => entry.normalized.supported);
  const warnings = [];
  if (supported.length > 1) {
    const unique = new Set(supported.map((entry) => entry.normalized.url));
    if (unique.size > 1) warnings.push('Multiple different ZCode proxy values were found; the first source wins.');
  }
  return {
    entries,
    selected: supported[0] || null,
    unsupported: entries.filter((entry) => !entry.normalized.supported),
    warnings,
  };
}

function buildProxyPlan(target, collected, policy, disabled) {
  if (disabled) {
    return {
      action: 'disabled',
      proxy: null,
      originalText: readTextOrEmpty(target.envPath),
      proposedText: readTextOrEmpty(target.envPath),
      changed: false,
      actions: [],
      conflicts: [],
    };
  }

  const originalText = readTextOrEmpty(target.envPath);
  if (!collected.selected) {
    return {
      action: 'none',
      proxy: null,
      originalText,
      proposedText: originalText,
      changed: false,
      actions: [],
      conflicts: [],
    };
  }

  const proxy = collected.selected.normalized.url;
  const header = originalText.trim() === ''
    ? '# DSH proxy configuration (generated by zcode2dsh)\n'
    : originalText;
  const merged = mergeEnvText(header, { http_proxy: proxy, https_proxy: proxy }, policy);

  return {
    action: merged.changed ? 'update' : 'unchanged',
    proxy,
    source: collected.selected.source,
    originalText,
    proposedText: merged.text,
    changed: merged.changed,
    actions: merged.actions,
    conflicts: merged.conflicts,
  };
}

function resolveDefaultModel(sourceData, providers, opts) {
  if (opts.defaultModel) {
    const slash = opts.defaultModel.indexOf('/');
    if (slash === -1) {
      throw new Error('--default must be formatted as <provider>/<model>.');
    }
    const providerRef = opts.defaultModel.slice(0, slash);
    const modelId = opts.defaultModel.slice(slash + 1);
    const provider = providers.find((item) =>
      item.providerKey === providerRef ||
      item.sourceId === providerRef ||
      item.sourceName.toLowerCase() === providerRef.toLowerCase()
    );
    if (!provider) {
      throw new Error(
        `--default provider "${providerRef}" was not found. Available provider keys: ` +
        providers.map((item) => item.providerKey).join(', ')
      );
    }
    const model = provider.models.find((item) => item.id === modelId || item.sourceKey === modelId);
    if (!model) {
      throw new Error(
        `--default model "${modelId}" was not found under ${provider.providerKey}. Available models: ` +
        provider.models.map((item) => item.id).join(', ')
      );
    }
    return { providerKey: provider.providerKey, modelId: model.id, source: 'explicit' };
  }

  if (!opts.setDefault) return null;

  for (const source of sourceData) {
    const current = source.currentModel;
    if (!current) continue;
    const provider = providers.find((item) =>
      item.source === source.kind && item.sourceId === current.providerId
    );
    if (!provider) continue;
    if (!provider.models.some((model) => model.id === current.modelId)) continue;
    return {
      providerKey: provider.providerKey,
      modelId: current.modelId,
      source: `${source.kind}-log`,
      detected: current,
    };
  }

  throw new Error(
    'Could not detect a current model to apply. Pass --default <provider>/<model> explicitly.'
  );
}

function decideDefaultModel(doc, desired) {
  if (!desired) return { action: 'none' };
  const existing = dsh.getDefaultModelEntry(doc);
  const current = existing && existing.value && existing.value.config ? existing.value.config : null;
  if (current && current.provider === desired.providerKey && current.model === desired.modelId) {
    return { action: 'unchanged', desired, current };
  }
  return { action: 'set', desired, current };
}

function applyDefaultModel(doc, decision) {
  if (decision.action !== 'set') return;
  dsh.setDefaultModel(doc, decision.desired.providerKey, decision.desired.modelId);
}

function sourceSummary(source) {
  return {
    kind: source.kind,
    label: source.label,
    providerConfigPath: source.providerConfigPath,
    providerCount: source.providers.length,
    enabledProviders: source.providers.filter((provider) => provider.enabled !== false && !provider.systemDisabledReason).length,
    mcpServers: (source.mcpServers || []).map((server) => ({
      name: server.name,
      type: server.type,
      url: safeUrlDisplay(server.url),
      hasHeaders: Boolean(server.headers && Object.keys(server.headers).length > 0),
      timeoutMs: server.timeoutMs,
    })),
    skills: {
      sharedRoot: source.skills.sharedRoot,
      sharedSkills: source.skills.sharedSkills,
      configuredTotal: source.skills.configuredTotal,
      enabled: source.skills.enabled,
      disabled: source.skills.disabled,
      source: source.skills.source,
    },
    agents: {
      path: source.agents.path,
      exists: source.agents.exists,
      bytes: source.agents.exists ? Buffer.byteLength(source.agents.content, 'utf8') : 0,
    },
    proxy: safeUrlDisplay(source.settings.httpProxy),
    currentModel: source.currentModel || null,
  };
}

function providerSummary(provider, decision) {
  return {
    providerKey: decision ? decision.key : provider.providerKey,
    source: provider.source,
    sourceId: provider.sourceId,
    name: provider.sourceName,
    kind: provider.kind,
    api: provider.dsh.api,
    baseURL: safeUrlDisplay(provider.dsh.baseURL),
    modelCount: provider.models.length,
    modelIds: provider.models.map((model) => model.id),
    modelLabels: provider.models.map((model) => model.name),
    apiKeyEnv: provider.apiKeyEnv,
    apiKeyConfigured: Boolean(provider.apiKey),
    action: decision ? decision.action : 'add',
    reason: decision ? decision.reason : 'new',
  };
}

function mcpSummary(decision) {
  const item = decision.item;
  return {
    originalName: item.originalName,
    serverName: item.serverName,
    entryId: decision.entryId || (decision.existing && decision.existing.id) || item.entryId,
    transport: item.config.transport,
    url: item.config.url || null,
    hasHeaders: Boolean(item.config.headers && Object.keys(item.config.headers).length > 0),
    toolCallTimeoutMs: item.config.toolCallTimeoutMs || null,
    action: decision.action,
    reason: decision.reason,
  };
}

function prepareMigration(opts = {}) {
  const policy = opts.conflict || 'keep';
  if (!['keep', 'prefer-zcode', 'fail'].includes(policy)) {
    throw new Error(`Unknown conflict policy "${policy}". Use keep|prefer-zcode|fail.`);
  }

  const loaded = loadSources({ ...opts, source: opts.source || 'zcode' });
  const { target, sources } = loaded;
  const warnings = [...loaded.warnings];
  const yaml = loadYamlModule(target.dshAppDir);

  const patchText = readText(target.patchPath);
  const patchDoc = parseDocument(yaml, patchText, target.patchPath);
  dsh.validatePatch(patchDoc, target.patchPath);
  const existingProviders = dsh.getLlmProviders(patchDoc);

  const normalized = normalizeProviders(sources, {
    reasoning: opts.reasoning || 'omit',
  });
  warnings.push(...normalized.warnings);
  if (opts.noProviders) {
    normalized.providers = [];
    normalized.warnings.push('Provider migration disabled by --no-providers.');
  }

  const credentialsText = readTextOrEmpty(target.credentialsPath);
  const credentialsDoc = credentials.loadCredentialsDoc(yaml, credentialsText, target.credentialsPath);
  const refAssignments = credentials.assignCredentialRefs(normalized.providers, credentialsDoc, policy);
  const dshProviders = buildDshProviders(normalized.providers);
  const providerDecisions = decideProviders(existingProviders, dshProviders, policy);

  const proposedPatchDoc = parseDocument(yaml, patchText, target.patchPath);
  applyProviderDecisions(proposedPatchDoc, providerDecisions);

  const collectedMcp = opts.noMcp
    ? { servers: [], skipped: [], conflicts: [] }
    : collectMcpServers(sources, policy);
  if (opts.noMcp) warnings.push('MCP migration disabled by --no-mcp.');
  const mcpDecisions = decideMcp(proposedPatchDoc, collectedMcp, policy);
  applyMcpDecisions(proposedPatchDoc, mcpDecisions);

  const defaultModel = resolveDefaultModel(sources, dshProviders, opts);
  const defaultModelDecision = decideDefaultModel(proposedPatchDoc, defaultModel);
  applyDefaultModel(proposedPatchDoc, defaultModelDecision);

  dsh.validatePatch(proposedPatchDoc, target.patchPath);
  const patchChanged =
    providerDecisions.some((decision) => decision.action === 'add' || decision.action === 'update') ||
    mcpDecisions.some((decision) => decision.action === 'add' || decision.action === 'update') ||
    defaultModelDecision.action === 'set';
  const proposedPatchText = patchChanged ? proposedPatchDoc.toString() : patchText;

  const proposedCredentialsDoc = credentials.loadCredentialsDoc(yaml, credentialsText, target.credentialsPath);
  credentials.applyRefUpdates(proposedCredentialsDoc, refAssignments.updates);
  credentials.validateCredentialsDoc(proposedCredentialsDoc, target.credentialsPath);
  const proposedCredentialsText = refAssignments.updates.length > 0
    ? proposedCredentialsDoc.toString()
    : credentialsText;

  const agentsCollected = opts.noAgents
    ? { selected: null, entries: [], warnings: [] }
    : collectAgents(sources);
  if (opts.noAgents) warnings.push('AGENTS.md migration disabled by --no-agents.');
  const agentsDecision = decideAgents(target, agentsCollected, policy);
  const proposedAgentsText = agentsDecision.content !== undefined
    ? agentsDecision.content
    : readTextOrEmpty(target.agentsPath);

  const proxyCollected = collectProxy(sources);
  const proxyPlan = buildProxyPlan(target, proxyCollected, policy, Boolean(opts.noProxy));

  warnings.push(...agentsCollected.warnings, ...proxyCollected.warnings);

  if (proxyCollected.selected && process.env.HTTP_PROXY && process.env.HTTP_PROXY !== proxyCollected.selected.normalized.url) {
    warnings.push(`Startup environment HTTP_PROXY=${safeUrlDisplay(process.env.HTTP_PROXY)} will override $DSH_HOME/.env.`);
  }
  if (proxyCollected.selected && process.env.HTTPS_PROXY && process.env.HTTPS_PROXY !== proxyCollected.selected.normalized.url) {
    warnings.push('Startup environment HTTPS_PROXY will override $DSH_HOME/.env.');
  }

  const conflicts = [
    ...refAssignments.conflicts,
    ...collectedMcp.conflicts,
    ...proxyPlan.conflicts.map((conflict) => ({ type: 'env', ...conflict })),
  ];
  for (const decision of providerDecisions) {
    if (decision.action === 'conflict') {
      conflicts.push({
        type: 'provider',
        providerKey: decision.key,
        reason: decision.reason,
      });
    }
  }
  if (agentsDecision.action === 'conflict') {
    conflicts.push({ type: 'agents', reason: 'target-exists' });
  }

  const changes = [];
  if (proposedPatchText !== patchText) {
    changes.push({ path: target.patchPath, label: 'cordis.patch.yml', oldText: patchText, newText: proposedPatchText });
  }
  if (proposedCredentialsText !== credentialsText) {
    changes.push({ path: target.credentialsPath, label: '.credentials.yaml', oldText: credentialsText, newText: proposedCredentialsText });
  }
  if (proxyPlan.changed) {
    changes.push({ path: target.envPath, label: '.env', oldText: proxyPlan.originalText, newText: proxyPlan.proposedText });
  }
  if (agentsDecision.action === 'create' || agentsDecision.action === 'overwrite') {
    const oldText = fs.existsSync(target.agentsPath) ? readText(target.agentsPath) : '';
    if (oldText !== proposedAgentsText) {
      changes.push({ path: target.agentsPath, label: 'AGENTS.md', oldText, newText: proposedAgentsText });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    source: opts.source || 'zcode',
    conflictPolicy: policy,
    target: {
      dshHome: target.dshHome,
      profile: target.profile,
      patchPath: target.patchPath,
      credentialsPath: target.credentialsPath,
      envPath: target.envPath,
      agentsPath: target.agentsPath,
      dshAppDir: target.dshAppDir,
    },
    sources: sources.map(sourceSummary),
    providers: providerDecisions.map((decision) => providerSummary(decision.provider, decision)),
    skippedProviders: normalized.skipped,
    duplicateProviders: normalized.duplicates,
    modelReport: normalized.report,
    mcpServers: mcpDecisions.map(mcpSummary),
    mcpSkipped: collectedMcp.skipped,
    defaultModel: defaultModelDecision.action === 'none' ? null : {
      provider: defaultModelDecision.desired.providerKey,
      model: defaultModelDecision.desired.modelId,
      source: defaultModelDecision.desired.source,
      action: defaultModelDecision.action,
      previous: defaultModelDecision.current || null,
    },
    proxy: {
      source: proxyCollected.selected ? proxyCollected.selected.source : null,
      value: proxyPlan.proxy,
      action: proxyPlan.action,
      unsupported: proxyCollected.unsupported.map((entry) => ({
        source: entry.source,
        raw: safeUrlDisplay(entry.raw),
        reason: entry.normalized.reason,
      })),
      envActions: proxyPlan.actions,
    },
    agents: {
      selectedSource: agentsDecision.source || null,
      action: agentsDecision.action,
      reason: agentsDecision.reason || null,
    },
    credentials: {
      updates: refAssignments.updates.map((update) => ({ ref: update.ref, action: update.action })),
      decisions: refAssignments.decisions,
    },
    warnings,
    conflicts,
    changes: changes.map((change) => ({
      path: change.path,
      label: change.label,
      oldBytes: Buffer.byteLength(change.oldText, 'utf8'),
      newBytes: Buffer.byteLength(change.newText, 'utf8'),
    })),
  };

  return {
    target,
    yaml,
    sources,
    sourcePaths: loaded.sourcePaths,
    normalized,
    providers: dshProviders,
    providerDecisions,
    mcpDecisions,
    defaultModelDecision,
    agentsDecision,
    proxyPlan,
    credentials: {
      originalText: credentialsText,
      proposedText: proposedCredentialsText,
      updates: refAssignments.updates,
      decisions: refAssignments.decisions,
    },
    env: {
      originalText: proxyPlan.originalText,
      proposedText: proxyPlan.proposedText,
    },
    agents: {
      originalText: fs.existsSync(target.agentsPath) ? readText(target.agentsPath) : '',
      proposedText: proposedAgentsText,
    },
    patch: {
      originalText: patchText,
      proposedText: proposedPatchText,
    },
    summary,
    changes,
  };
}

module.exports = {
  prepareMigration,
  loadSources,
  normalizeBaseUrl,
  providerIdentity,
  findEquivalentProvider,
  buildProviderConfig,
  decideProviders,
  collectMcpServers,
  decideMcp,
  collectAgents,
  decideAgents,
  normalizeProxy,
  collectProxy,
  resolveDefaultModel,
};
