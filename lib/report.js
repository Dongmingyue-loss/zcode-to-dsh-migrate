'use strict';

const path = require('path');
const { escapeHtml, ensureDir, atomicWrite, timestampForPath } = require('./util');

function renderText(summary) {
  const lines = [];
  const add = (line = '') => lines.push(line);

  add('ZCode -> DSH Desktop Beta migration');
  add(`Generated: ${summary.generatedAt}`);
  add(`Source: ${summary.source}`);
  add(`Conflict policy: ${summary.conflictPolicy}`);
  add('');

  add('Target');
  add(`  DSH home: ${summary.target.dshHome}`);
  add(`  Profile: ${summary.target.profile}`);
  add(`  Patch: ${summary.target.patchPath}`);
  add(`  Credentials: ${summary.target.credentialsPath}`);
  add(`  Env: ${summary.target.envPath}`);
  add(`  AGENTS: ${summary.target.agentsPath}`);
  add('');

  add('Sources');
  for (const source of summary.sources) {
    add(`  [${source.kind}] ${source.providerConfigPath}`);
    add(`    providers: ${source.providerCount} total / ${source.enabledProviders} enabled`);
    add(`    MCP servers: ${source.mcpServers.length}`);
    add(`    skills: ${source.skills.sharedSkills.length} shared, ${source.skills.disabled} disabled flags`);
    add(`    proxy: ${source.proxy || '(none)'}`);
    if (source.currentModel) {
      add(`    current model: ${source.currentModel.providerId}/${source.currentModel.modelId}`);
    }
  }
  add('');

  add('Providers');
  if (summary.providers.length === 0) {
    add('  (none)');
  } else {
    for (const provider of summary.providers) {
      add(`  ${provider.providerKey}  ${provider.name}`);
      add(`    api: ${provider.api}`);
      add(`    baseURL: ${provider.baseURL}`);
      add(`    models: ${provider.modelCount} (${provider.modelIds.join(', ')})`);
      add(`    credential: ${provider.apiKeyConfigured ? provider.apiKeyEnv || '(unnamed)' : '(none)'}`);
      add(`    action: ${provider.action}${provider.reason ? ` (${provider.reason})` : ''}`);
    }
  }
  add('');

  if (summary.skippedProviders.length > 0) {
    add('Skipped providers');
    for (const item of summary.skippedProviders) {
      add(`  [${item.source}] ${item.name} (${item.providerId}): ${item.reason}`);
    }
    add('');
  }

  if (summary.duplicateProviders.length > 0) {
    add('Duplicate providers (already represented by another source)');
    for (const item of summary.duplicateProviders) {
      add(`  [${item.source}] ${item.name} (${item.providerId}) -> ${item.duplicateOf}`);
    }
    add('');
  }

  add('MCP servers');
  if (summary.mcpServers.length === 0) {
    add('  (none)');
  } else {
    for (const server of summary.mcpServers) {
      add(`  ${server.serverName} (${server.transport}) -> ${server.url || '(stdio)'}`);
      add(`    entry: ${server.entryId}; headers: ${server.hasHeaders ? 'yes' : 'no'}; action: ${server.action} (${server.reason})`);
    }
  }
  if (summary.mcpSkipped.length > 0) {
    add('  skipped:');
    for (const item of summary.mcpSkipped) {
      add(`    [${item.source}] ${item.name}: ${item.reason}`);
    }
  }
  add('');

  add('Default model');
  if (!summary.defaultModel) {
    add('  unchanged (use --set-default or --default to change)');
  } else {
    add(`  ${summary.defaultModel.provider}/${summary.defaultModel.model} (${summary.defaultModel.action})`);
  }
  add('');

  add('Proxy');
  add(`  source: ${summary.proxy.source || '(none)'}`);
  add(`  value: ${summary.proxy.value || '(none)'}`);
  add(`  action: ${summary.proxy.action}`);
  if (summary.proxy.unsupported.length > 0) {
    for (const item of summary.proxy.unsupported) {
      add(`  unsupported: [${item.source}] ${item.raw} (${item.normalized.reason})`);
    }
  }
  add('');

  add('AGENTS.md');
  add(`  action: ${summary.agents.action}${summary.agents.reason ? ` (${summary.agents.reason})` : ''}`);
  add(`  source: ${summary.agents.selectedSource || '(none)'}`);
  add('');

  add('Credential refs');
  if (summary.credentials.updates.length === 0) {
    add('  (no new refs)');
  } else {
    for (const update of summary.credentials.updates) {
      add(`  ${update.ref}: ${update.action}`);
    }
  }
  add('');

  if (summary.conflicts.length > 0) {
    add('Conflicts');
    for (const conflict of summary.conflicts) {
      add(`  ${JSON.stringify(conflict)}`);
    }
    add('');
  }

  if (summary.warnings.length > 0) {
    add('Warnings');
    for (const warning of summary.warnings) add(`  - ${warning}`);
    add('');
  }

  add('Changes');
  if (summary.changes.length === 0) {
    add('  (no file changes)');
  } else {
    for (const change of summary.changes) {
      add(`  ${change.label}: ${change.oldBytes} -> ${change.newBytes} bytes`);
      add(`    ${change.path}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderHtml(summary, diffText) {
  const providerRows = summary.providers.map((provider) => `
    <tr>
      <td>${escapeHtml(provider.providerKey)}</td>
      <td>${escapeHtml(provider.name)}</td>
      <td>${escapeHtml(provider.api)}</td>
      <td>${escapeHtml(provider.baseURL)}</td>
      <td>${provider.modelCount}</td>
      <td>${escapeHtml(provider.action)}</td>
    </tr>`).join('');

  const mcpRows = summary.mcpServers.map((server) => `
    <tr>
      <td>${escapeHtml(server.serverName)}</td>
      <td>${escapeHtml(server.transport)}</td>
      <td>${escapeHtml(server.url || '(stdio)')}</td>
      <td>${escapeHtml(server.action)}</td>
    </tr>`).join('');

  const warnings = summary.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  const conflicts = summary.conflicts.map((conflict) => `<li>${escapeHtml(JSON.stringify(conflict))}</li>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>ZCode to DSH migration report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2328; background: #f6f8fa; }
  h1, h2 { margin-top: 32px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #d0d7de; padding: 8px 10px; text-align: left; font-size: 13px; }
  th { background: #eaeef2; }
  pre { background: #0d1117; color: #c9d1d9; padding: 16px; overflow: auto; border-radius: 8px; font-size: 12px; }
  .meta { color: #57606a; }
  .warning { color: #9a6700; }
</style>
</head>
<body>
<h1>ZCode → DSH Desktop Beta migration report</h1>
<p class="meta">Generated ${escapeHtml(summary.generatedAt)} · source ${escapeHtml(summary.source)} · policy ${escapeHtml(summary.conflictPolicy)}</p>
<h2>Target</h2>
<pre>${escapeHtml(JSON.stringify(summary.target, null, 2))}</pre>
<h2>Providers</h2>
<table><thead><tr><th>Key</th><th>Name</th><th>API</th><th>Base URL</th><th>Models</th><th>Action</th></tr></thead><tbody>${providerRows}</tbody></table>
<h2>MCP servers</h2>
<table><thead><tr><th>Server</th><th>Transport</th><th>URL</th><th>Action</th></tr></thead><tbody>${mcpRows}</tbody></table>
<h2>Conflicts</h2>
${conflicts ? `<ul>${conflicts}</ul>` : '<p>None.</p>'}
<h2>Warnings</h2>
${warnings ? `<ul class="warning">${warnings}</ul>` : '<p>None.</p>'}
<h2>Diff</h2>
<pre>${escapeHtml(diffText || '(no changes)')}</pre>
</body>
</html>
`;
}

function writeReport(reportDir, summary, options = {}) {
  ensureDir(reportDir);
  const base = options.name || timestampForPath();
  const jsonPath = path.join(reportDir, `${base}.json`);
  const htmlPath = path.join(reportDir, `${base}.html`);
  atomicWrite(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  atomicWrite(htmlPath, renderHtml(summary, options.diffText || ''));
  return { jsonPath, htmlPath };
}

module.exports = {
  renderText,
  renderHtml,
  writeReport,
};
