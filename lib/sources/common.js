'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, readText, tryReadJson, listFiles } = require('../util');

function readTail(file, maxBytes = 512 * 1024) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

function detectRuntimeModel(providerConfigPath) {
  const logsDir = path.join(path.dirname(providerConfigPath), 'logs');
  const files = listFiles(logsDir, (name) => name.toLowerCase().endsWith('.log'))
    .map((file) => {
      try {
        return { file, mtime: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);

  let latest = null;
  for (const { file } of files) {
    let text = '';
    try {
      text = readTail(file);
    } catch {
      continue;
    }

    const runtimePattern = /"runtimeModel"\s*:\s*(\{[^{}]*\})/g;
    let match;
    while ((match = runtimePattern.exec(text)) !== null) {
      try {
        const value = JSON.parse(match[1]);
        if (value && value.providerId && value.model) {
          let modelId = String(value.model);
          const prefix = `${value.providerId}/`;
          if (modelId.startsWith(prefix)) modelId = modelId.slice(prefix.length);
          latest = {
            providerId: value.providerId,
            modelId,
            baseURL: value.baseURL || null,
            kind: value.kind || null,
            apiFormat: value.apiFormat || null,
            source: path.basename(file),
          };
        }
      } catch {
        // Ignore a partial line at the tail boundary.
      }
    }

    const currentPattern = /"modelCurrent"\s*:\s*"([^"/]+)\/([^"]+)"/g;
    while ((match = currentPattern.exec(text)) !== null) {
      latest = {
        providerId: match[1],
        modelId: match[2],
        baseURL: null,
        kind: null,
        apiFormat: null,
        source: path.basename(file),
      };
    }
  }
  return latest;
}

function normalizeMcpServer(name, server) {
  const rawType = String(server.type || '').toLowerCase();
  let type = rawType;
  if (!type) {
    if (server.url) type = 'http';
    else if (server.command) type = 'stdio';
  }
  if (type === 'streamable-http' || type === 'streamablehttp' || type === 'http') type = 'http';
  if (type === 'sse') type = 'sse';

  return {
    name,
    type,
    url: server.url || null,
    headers: server.headers && typeof server.headers === 'object' ? { ...server.headers } : null,
    command: server.command || null,
    args: Array.isArray(server.args) ? [...server.args] : null,
    env: server.env && typeof server.env === 'object' ? { ...server.env } : null,
    cwd: server.cwd || null,
    timeoutMs: Number.isFinite(server.timeoutMs) ? server.timeoutMs : null,
  };
}

function loadCliSidecars(cliConfigPath) {
  const config = tryReadJson(cliConfigPath);
  const servers = config && config.mcp && config.mcp.servers && typeof config.mcp.servers === 'object'
    ? config.mcp.servers
    : {};
  const skills = config && config.skills && typeof config.skills === 'object' ? config.skills : {};

  return {
    exists: Boolean(config),
    path: cliConfigPath,
    mcpServers: Object.entries(servers).map(([name, server]) => normalizeMcpServer(name, server || {})),
    skillEntries: Object.entries(skills).map(([skillPath, value]) => ({
      path: skillPath,
      enabled: !value || value.enable !== false,
    })),
    raw: config,
  };
}

function scanSharedSkills(sharedRoot) {
  if (!sharedRoot) return [];
  try {
    return fs.readdirSync(sharedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function loadAgents(agentsPath) {
  try {
    return { path: agentsPath, exists: true, content: readText(agentsPath) };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: agentsPath, exists: false, content: '' };
    }
    throw error;
  }
}

function loadSettings(settingPath) {
  const raw = tryReadJson(settingPath) || {};
  return {
    path: settingPath,
    exists: Boolean(tryReadJson(settingPath)),
    httpProxy: typeof raw.httpProxy === 'string' ? raw.httpProxy : null,
    locale: raw.locale || null,
    recentProjects: Array.isArray(raw.recentProjects) ? raw.recentProjects : [],
    raw,
  };
}

function summarizeSkills(skillEntries, sharedRoot) {
  const disabled = skillEntries.filter((entry) => !entry.enabled);
  const enabled = skillEntries.filter((entry) => entry.enabled);
  return {
    sharedRoot,
    sharedSkills: scanSharedSkills(sharedRoot),
    configuredTotal: skillEntries.length,
    enabled: enabled.length,
    disabled: disabled.length,
    disabledEntries: disabled,
    source: skillEntries.length > 0 ? 'config' : 'scan',
  };
}

module.exports = {
  readTail,
  detectRuntimeModel,
  normalizeMcpServer,
  loadCliSidecars,
  scanSharedSkills,
  loadAgents,
  loadSettings,
  summarizeSkills,
};
