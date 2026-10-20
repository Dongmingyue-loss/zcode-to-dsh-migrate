'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { tryReadJson, fileExists } = require('./util');
const { detectDshAppDir } = require('./dsh-app');

function firstExisting(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return paths.find(Boolean) || null;
}

function discoverZcode(opts = {}) {
  const home = os.homedir();
  const userHome = path.join(home, '.zcode');
  const settingPath = opts.zcodeSetting || path.join(userHome, 'v2', 'setting.json');
  const setting = tryReadJson(settingPath) || {};

  const dataBaseDir = opts.zcodeDataDir
    ? path.resolve(opts.zcodeDataDir)
    : setting.dataBaseDir
      ? path.resolve(setting.dataBaseDir)
      : userHome;

  const dataConfig = path.join(dataBaseDir, '.zcode', 'v2', 'config.json');
  const userConfig = path.join(userHome, 'v2', 'config.json');
  const providerConfigPath = opts.zcodeConfig
    ? path.resolve(opts.zcodeConfig)
    : firstExisting([dataConfig, userConfig]);

  const providerDir = providerConfigPath ? path.dirname(providerConfigPath) : path.join(userHome, 'v2');
  const orderPath = opts.zcodeOrder
    ? path.resolve(opts.zcodeOrder)
    : path.join(providerDir, 'model-provider-display-order.json');
  const cliConfigPath = opts.zcodeCli
    ? path.resolve(opts.zcodeCli)
    : path.join(userHome, 'cli', 'config.json');
  const agentsPath = opts.zcodeAgents
    ? path.resolve(opts.zcodeAgents)
    : path.join(userHome, 'AGENTS.md');

  return {
    kind: 'zcode',
    label: 'official ZCode',
    home: userHome,
    settingPath,
    setting,
    dataBaseDir,
    providerConfigPath,
    orderPath,
    cliConfigPath,
    agentsPath,
    exists: Boolean(providerConfigPath && fileExists(providerConfigPath)),
  };
}

function discoverZcodium(opts = {}) {
  const home = os.homedir();
  const userHome = path.join(home, '.zcodium');
  const settingPath = opts.zcodiumSetting || path.join(userHome, 'v2', 'setting.json');
  const setting = tryReadJson(settingPath) || {};

  const baseCandidates = [
    opts.zcodiumDataDir,
    process.env.ZCODIUM_DATA_BASE_DIR,
  ].filter(Boolean);

  const providerCandidates = [];
  if (opts.zcodiumConfig) providerCandidates.push(path.resolve(opts.zcodiumConfig));
  for (const base of baseCandidates) {
    providerCandidates.push(path.join(path.resolve(base), '.zcodium', 'v2', 'provider_config.json'));
  }
  providerCandidates.push(path.join(userHome, 'v2', 'provider_config.json'));

  // Custom installs keep the data base dir on another drive. Probe the same
  // layouts the launcher uses, without hardcoding a drive letter.
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      try {
        if (!fs.existsSync(drive)) continue;
      } catch {
        continue;
      }
      providerCandidates.push(path.join(drive, 'ZCodium', 'data', '.zcodium', 'v2', 'provider_config.json'));
      providerCandidates.push(path.join(drive, 'ZCodium', '.zcodium', 'v2', 'provider_config.json'));
    }
  }

  const providerConfigPath = firstExisting(providerCandidates);
  const cliConfigPath = opts.zcodiumCli
    ? path.resolve(opts.zcodiumCli)
    : path.join(userHome, 'cli', 'config.json');
  const agentsPath = opts.zcodiumAgents
    ? path.resolve(opts.zcodiumAgents)
    : path.join(userHome, 'AGENTS.md');

  return {
    kind: 'zcodium',
    label: 'ZCodium',
    home: userHome,
    settingPath,
    setting,
    dataBaseDir: providerConfigPath ? path.dirname(path.dirname(path.dirname(providerConfigPath))) : null,
    providerConfigPath,
    orderPath: null,
    cliConfigPath,
    agentsPath,
    exists: Boolean(providerConfigPath && fileExists(providerConfigPath)),
  };
}

function discoverTarget(opts = {}) {
  const dshHome = path.resolve(opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta'));
  const profile = opts.profile || 'desktop';
  const profileDir = path.join(dshHome, 'profiles', profile);
  const agentsHome = process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents');

  return {
    dshHome,
    profile,
    profileDir,
    patchPath: opts.patchPath ? path.resolve(opts.patchPath) : path.join(profileDir, 'cordis.patch.yml'),
    packagePath: path.join(profileDir, 'package.json'),
    credentialsPath: opts.credentialsPath ? path.resolve(opts.credentialsPath) : path.join(dshHome, '.credentials.yaml'),
    envPath: opts.dshEnvPath ? path.resolve(opts.dshEnvPath) : path.join(dshHome, '.env'),
    agentsPath: opts.dshAgentsPath ? path.resolve(opts.dshAgentsPath) : path.join(dshHome, 'AGENTS.md'),
    skillsDir: path.join(dshHome, 'skills'),
    sharedSkillsDir: path.join(agentsHome, 'skills'),
    dshAppDir: detectDshAppDir(opts),
  };
}

function discoverSources(opts = {}) {
  const requested = opts.source || 'zcode';
  const allowed = new Set(['zcode', 'zcodium', 'all']);
  if (!allowed.has(requested)) {
    throw new Error(`Unknown source "${requested}". Use --source zcode|zcodium|all.`);
  }

  const sources = [];
  if (requested === 'zcode' || requested === 'all') sources.push(discoverZcode(opts));
  if (requested === 'zcodium' || requested === 'all') sources.push(discoverZcodium(opts));

  if (requested !== 'all') {
    const missing = sources.filter((source) => !source.exists);
    if (missing.length > 0) {
      const source = missing[0];
      throw new Error(
        `${source.label} provider config not found. Looked for: ${source.providerConfigPath || '(no path)'}. ` +
        'Use --source all or explicit path overrides if it is installed elsewhere.'
      );
    }
  }

  return sources;
}

module.exports = {
  discoverZcode,
  discoverZcodium,
  discoverTarget,
  discoverSources,
  detectDshAppDir,
};
