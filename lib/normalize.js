'use strict';

const API_MAP = {
  anthropic: 'anthropic-messages',
  'openai-compatible': 'openai-completions',
  openai: 'openai-responses',
};

const SUPPORTED_INPUT = new Set(['text', 'image']);
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'max']);

function slugify(value, maxLength = 40) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'provider';
}

function shortSourceId(sourceId) {
  const text = String(sourceId || '');
  const uuid = /^[0-9a-f]{8}-/i.exec(text);
  if (uuid) return text.slice(0, 8).toLowerCase();
  return slugify(text.replace(/^builtin:/i, ''), 32);
}

function validRefName(value) {
  let name = String(value || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!/^[A-Z_]/.test(name)) name = `REF_${name}`;
  return name.slice(0, 64);
}

function mapModel(model, opts, report) {
  const output = { id: model.id, name: model.name || model.id };

  if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
    output.contextWindow = model.contextWindow;
  }
  if (Number.isFinite(model.maxTokens) && model.maxTokens > 0) {
    output.maxTokens = model.maxTokens;
  }

  const input = Array.isArray(model.input) ? model.input : ['text'];
  const supported = input.filter((item) => SUPPORTED_INPUT.has(item));
  output.input = supported.length > 0 ? [...new Set(supported)] : ['text'];
  const droppedModalities = input.filter((item) => !SUPPORTED_INPUT.has(item));
  if (droppedModalities.length > 0) {
    report.droppedModalities.push({
      model: model.id,
      dropped: droppedModalities,
    });
  }

  if (opts.reasoning === 'map' && model.reasoning) {
    if (model.reasoning.enabled === false) {
      output.reasoningEfforts = false;
      report.reasoning.push({ model: model.id, action: 'non-reasoning' });
    } else {
      const efforts = {};
      for (const variant of model.reasoning.variants || []) {
        const key = String(variant);
        if (key === 'off' || key === 'disabled' || key === 'none') efforts[key] = null;
        else if (key === 'enabled') efforts[key] = 'high';
        else if (THINKING_LEVELS.has(key)) efforts[key] = key;
        else efforts[key] = key;
      }
      if (Object.keys(efforts).some((key) => key !== 'off' && key !== 'disabled' && key !== 'none')) {
        output.reasoningEfforts = efforts;
      } else if (Object.keys(efforts).length > 0) {
        output.reasoningEfforts = false;
      }
      report.reasoning.push({
        model: model.id,
        action: output.reasoningEfforts === undefined ? 'omitted' : 'mapped',
        variants: model.reasoning.variants || [],
        defaultVariant: model.reasoning.defaultVariant || null,
      });
    }
  } else if (model.reasoning) {
    report.reasoning.push({
      model: model.id,
      action: 'not-mapped',
      variants: model.reasoning.variants || [],
      defaultVariant: model.reasoning.defaultVariant || null,
    });
  }

  if (model.name && model.name !== model.id) {
    report.modelNameAliases.push({
      id: model.id,
      name: model.name,
      sourceKey: model.sourceKey || model.name,
      wireId: model.wireId || model.id,
    });
  }

  return output;
}

function normalizeProviders(sources, opts = {}) {
  const report = {
    droppedModalities: [],
    reasoning: [],
    modelNameAliases: [],
  };
  const skipped = [];
  const duplicates = [];
  const warnings = [];
  const providers = [];
  const usedKeys = new Set();
  const seenIdentities = new Map();

  for (const source of sources) {
    for (const provider of source.providers) {
      const sourceLabel = source.kind;

      if (provider.enabled === false) {
        skipped.push({ source: sourceLabel, providerId: provider.sourceId, name: provider.name, reason: 'disabled' });
        continue;
      }
      if (provider.systemDisabledReason) {
        skipped.push({
          source: sourceLabel,
          providerId: provider.sourceId,
          name: provider.name,
          reason: `system-disabled: ${provider.systemDisabledReason}`,
        });
        continue;
      }
      if (!provider.baseURL) {
        skipped.push({ source: sourceLabel, providerId: provider.sourceId, name: provider.name, reason: 'missing-base-url' });
        continue;
      }
      if (!provider.kind || !API_MAP[provider.kind]) {
        skipped.push({
          source: sourceLabel,
          providerId: provider.sourceId,
          name: provider.name,
          reason: `unsupported-kind: ${provider.kind || '(none)'}`,
        });
        continue;
      }
      if (!provider.models || provider.models.length === 0) {
        skipped.push({ source: sourceLabel, providerId: provider.sourceId, name: provider.name, reason: 'no-models' });
        continue;
      }
      if (provider.apiKeyRequired && !provider.apiKey) {
        skipped.push({ source: sourceLabel, providerId: provider.sourceId, name: provider.name, reason: 'missing-api-key' });
        continue;
      }

      const identity = [
        API_MAP[provider.kind],
        provider.baseURL,
        provider.models.map((model) => model.id).sort().join(','),
      ].join('|');
      if (seenIdentities.has(identity)) {
        duplicates.push({
          source: sourceLabel,
          providerId: provider.sourceId,
          name: provider.name,
          duplicateOf: seenIdentities.get(identity),
        });
        continue;
      }
      seenIdentities.set(identity, `${sourceLabel}:${provider.sourceId}`);

      const idPart = shortSourceId(provider.sourceId);
      const providerKeyBase = `${source.kind}-${idPart}`;
      let providerKey = providerKeyBase;
      let suffix = 2;
      while (usedKeys.has(providerKey)) {
        providerKey = `${providerKeyBase}-${suffix}`;
        suffix += 1;
      }
      usedKeys.add(providerKey);

      const refBase = validRefName(
        `${source.kind === 'zcode' ? 'ZCODE' : 'ZCODIUM'}_${idPart.replace(/-/g, '_')}_API_KEY`
      );

      const modelReport = {
        droppedModalities: [],
        reasoning: [],
        modelNameAliases: [],
      };
      const dshModels = provider.models.map((model) => mapModel(model, opts, modelReport));
      report.droppedModalities.push(
        ...modelReport.droppedModalities.map((entry) => ({ ...entry, provider: provider.name }))
      );
      report.reasoning.push(
        ...modelReport.reasoning.map((entry) => ({ ...entry, provider: provider.name }))
      );
      report.modelNameAliases.push(
        ...modelReport.modelNameAliases.map((entry) => ({ ...entry, provider: provider.name }))
      );

      const dsh = {
        displayName: provider.name,
        api: API_MAP[provider.kind],
        baseURL: provider.baseURL,
        models: dshModels,
      };

      providers.push({
        source: source.kind,
        sourceId: provider.sourceId,
        sourceName: provider.name,
        kind: provider.kind,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        apiKeyRequired: provider.apiKeyRequired,
        apiKeyEnv: null,
        providerKey,
        refBase,
        dsh,
        models: provider.models,
        meta: provider.meta || {},
      });
    }
  }

  if (providers.length === 0) {
    warnings.push('No migratable providers were found in the selected source(s).');
  }

  return { providers, skipped, duplicates, warnings, report };
}

module.exports = {
  API_MAP,
  SUPPORTED_INPUT,
  slugify,
  shortSourceId,
  validRefName,
  mapModel,
  normalizeProviders,
};
