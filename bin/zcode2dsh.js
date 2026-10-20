#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { discoverTarget, discoverSources } = require('../lib/discover');
const { loadYamlModule, parseDocument } = require('../lib/yaml');
const { prepareMigration } = require('../lib/migrate');
const { createRedactor } = require('../lib/redact');
const { renderText, writeReport } = require('../lib/report');
const { unifiedDiff, capDiff } = require('../lib/diff');
const { createBackup, restoreBackup, resolveBackup, listBackups } = require('../lib/backup');
const { readText, readTextOrEmpty, atomicWrite } = require('../lib/util');
const dsh = require('../lib/dsh-config');
const credentials = require('../lib/credentials');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BACKUP_DIR = path.join(ROOT, 'backups');
const DEFAULT_REPORT_DIR = path.join(ROOT, 'reports');

function usage() {
  return `
zcode2dsh - ZCode / ZCodium -> DSH Desktop Beta configuration migration

Usage:
  zcode2dsh scan   [options]     Inspect sources and target, no writes
  zcode2dsh plan   [options]     Show actions, conflicts, and a diff, no writes
  zcode2dsh apply  [options]     Back up, write, verify, and report
  zcode2dsh restore --backup ID  Restore a previous migration backup
  zcode2dsh doctor [options]     Check paths, YAML, credentials, and process state
  zcode2dsh diff   [options]     Show only the proposed diff

Options:
  --source zcode|zcodium|all   Source configs (default: zcode)
  --dsh-home <path>            DSH home (default: %USERPROFILE%\\.dsh-beta)
  --profile <name>             DSH profile (default: desktop)
  --dsh-app <path>             DSH resources/app directory (for the yaml package)
  --conflict keep|prefer-zcode|fail
                               Conflict policy (default: keep)
  --reasoning omit|map         Reasoning mapping (default: omit)
  --set-default                Set DSH default model from the detected ZCode model
  --default <provider>/<model> Set DSH default model explicitly
  --no-providers               Skip provider migration
  --no-mcp                     Skip MCP migration
  --no-proxy                   Skip proxy migration
  --no-agents                  Skip AGENTS.md migration
  --backup <id>                Backup id for restore
  --backup-dir <path>          Backup directory (default: ${DEFAULT_BACKUP_DIR})
  --report-dir <path>          Report directory (default: ${DEFAULT_REPORT_DIR})
  --force                      Allow apply/restore while DSH is running
  --restart                    Start DSH Desktop Beta after a successful apply
  --dry-run                    Same as plan for apply
  --json                       Machine-readable output
  --verbose                    Print extra diagnostics
  --help                       Show this help

Examples:
  zcode2dsh scan
  zcode2dsh plan --source all
  zcode2dsh apply --set-default
  zcode2dsh restore --backup 2026-10-19T12-00-00-000Z
`.trim();
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    source: 'zcode',
    conflict: 'keep',
    reasoning: 'omit',
    backupsDir: DEFAULT_BACKUP_DIR,
    reportsDir: DEFAULT_REPORT_DIR,
  };
  let command = 'help';
  let index = 0;

  if (args[0] && !args[0].startsWith('-')) {
    command = args[0];
    index = 1;
  }

  const valueOptions = new Map([
    ['--source', 'source'],
    ['--dsh-home', 'dshHome'],
    ['--profile', 'profile'],
    ['--dsh-app', 'dshApp'],
    ['--conflict', 'conflict'],
    ['--reasoning', 'reasoning'],
    ['--default', 'defaultModel'],
    ['--backup', 'backup'],
    ['--backup-dir', 'backupsDir'],
    ['--report-dir', 'reportsDir'],
    ['--zcode-config', 'zcodeConfig'],
    ['--zcode-order', 'zcodeOrder'],
    ['--zcode-cli', 'zcodeCli'],
    ['--zcode-setting', 'zcodeSetting'],
    ['--zcode-agents', 'zcodeAgents'],
    ['--zcodium-config', 'zcodiumConfig'],
    ['--zcodium-cli', 'zcodiumCli'],
    ['--zcodium-setting', 'zcodiumSetting'],
    ['--zcodium-agents', 'zcodiumAgents'],
    ['--patch-path', 'patchPath'],
    ['--credentials-path', 'credentialsPath'],
    ['--dsh-env-path', 'dshEnvPath'],
    ['--dsh-agents-path', 'dshAgentsPath'],
  ]);

  const flagOptions = new Map([
    ['--dry-run', 'dryRun'],
    ['--json', 'json'],
    ['--set-default', 'setDefault'],
    ['--no-providers', 'noProviders'],
    ['--no-mcp', 'noMcp'],
    ['--no-proxy', 'noProxy'],
    ['--no-agents', 'noAgents'],
    ['--force', 'force'],
    ['--restart', 'restart'],
    ['--verbose', 'verbose'],
    ['--help', 'help'],
  ]);

  while (index < args.length) {
    const arg = args[index];
    if (valueOptions.has(arg)) {
      if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
        throw new Error(`Option ${arg} needs a value.`);
      }
      options[valueOptions.get(arg)] = args[index + 1];
      index += 2;
      continue;
    }
    if (flagOptions.has(arg)) {
      options[flagOptions.get(arg)] = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!['zcode', 'zcodium', 'all'].includes(options.source)) {
    throw new Error('--source must be zcode, zcodium, or all.');
  }
  if (!['keep', 'prefer-zcode', 'fail'].includes(options.conflict)) {
    throw new Error('--conflict must be keep, prefer-zcode, or fail.');
  }
  if (!['omit', 'map'].includes(options.reasoning)) {
    throw new Error('--reasoning must be omit or map.');
  }

  options.backupsDir = path.resolve(options.backupsDir);
  options.reportsDir = path.resolve(options.reportsDir);
  return { command, options };
}

function isDshRunning() {
  if (process.platform !== 'win32') return false;
  for (const name of ['DSH Desktop Beta.exe', 'DSH.exe']) {
    const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status === 0 && typeof result.stdout === 'string' &&
      result.stdout.toLowerCase().includes(name.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function isDefaultDshHome(dshHome) {
  return typeof dshHome === 'string' && /[\\/]\.dsh-beta[\\/]?$/i.test(dshHome);
}

function ensureNotRunning(options) {
  if (options.force) return;
  // A custom --dsh-home belongs to an isolated profile, so the running desktop
  // app cannot be using it. The default home still requires a closed app.
  if (options.dshHome && !isDefaultDshHome(options.dshHome)) return;
  if (isDshRunning()) {
    throw new Error(
      'DSH Desktop Beta is running. Close it before applying or restoring, or pass --force. ' +
      'The tool will not modify a live profile by default.'
    );
  }
}

function buildRedactor(plan) {
  const redactor = createRedactor();
  for (const provider of plan.normalized.providers) {
    redactor.add(provider.apiKey);
  }
  for (const source of plan.sources) {
    for (const provider of source.providers) redactor.add(provider.apiKey);
    if (source.sidecars && source.sidecars.raw) redactor.addFromObject(source.sidecars.raw);
    if (source.settings && source.settings.raw) redactor.addFromObject(source.settings.raw);
  }
  return redactor;
}

function buildDiff(plan, redactor) {
  let output = '';
  for (const change of plan.changes) {
    if (change.label === '.credentials.yaml') {
      output += `--- a/${change.label}\n+++ b/${change.label}\n[credentials diff omitted: contains secret values]\n\n`;
      continue;
    }
    const diff = unifiedDiff(change.oldText, change.newText, change.label);
    if (diff) output += `${diff}${diff.endsWith('\n') ? '' : '\n'}\n`;
  }
  return redactor.redactString(output);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printPlan(plan, options) {
  const redactor = buildRedactor(plan);
  const diff = buildDiff(plan, redactor);
  if (options.json) {
    printJson({ summary: plan.summary, diff });
    return;
  }
  process.stdout.write(renderText(plan.summary));
  process.stdout.write('\nProposed diff:\n');
  process.stdout.write(capDiff(diff).text);
}

function commandScan(options) {
  const plan = prepareMigration(options);
  if (options.json) {
    printJson(plan.summary);
  } else {
    process.stdout.write(renderText(plan.summary));
  }
  return 0;
}

function commandPlan(options) {
  const plan = prepareMigration(options);
  printPlan(plan, options);
  return options.conflict === 'fail' && plan.summary.conflicts.length > 0 ? 2 : 0;
}

function commandDiff(options) {
  const plan = prepareMigration(options);
  const redactor = buildRedactor(plan);
  const diff = buildDiff(plan, redactor);
  if (options.json) {
    printJson({ diff });
  } else {
    process.stdout.write(capDiff(diff).text);
  }
  return 0;
}

function verifyApplied(plan) {
  const patch = parseDocument(plan.yaml, readText(plan.target.patchPath), plan.target.patchPath);
  dsh.validatePatch(patch, plan.target.patchPath);
  const credText = readTextOrEmpty(plan.target.credentialsPath);
  const credDoc = credentials.loadCredentialsDoc(plan.yaml, credText, plan.target.credentialsPath);
  credentials.validateCredentialsDoc(credDoc, plan.target.credentialsPath);
  if (plan.env.proposedText !== plan.env.originalText) {
    const envText = readTextOrEmpty(plan.target.envPath);
    if (envText !== plan.env.proposedText) {
      throw new Error(`Verification failed: ${plan.target.envPath} does not match the proposed content.`);
    }
  }
  const agentsText = readTextOrEmpty(plan.target.agentsPath);
  if (agentsText !== plan.agents.proposedText) {
    throw new Error(`Verification failed: ${plan.target.agentsPath} does not match the proposed content.`);
  }
}

function commandApply(options) {
  if (options.dryRun) return commandPlan(options);
  ensureNotRunning(options);

  const plan = prepareMigration(options);
  if (options.conflict === 'fail' && plan.summary.conflicts.length > 0) {
    throw new Error(`Conflict policy is fail and ${plan.summary.conflicts.length} conflict(s) were found. No files were written.`);
  }

  if (plan.changes.length === 0) {
    if (options.json) printJson({ summary: plan.summary, applied: false });
    else {
      process.stdout.write(renderText(plan.summary));
      process.stdout.write('\nNo changes were needed.\n');
    }
    return 0;
  }

  const backup = createBackup({
    backupRoot: options.backupsDir,
    targets: [
      { path: plan.target.patchPath, label: 'cordis.patch.yml' },
      { path: plan.target.credentialsPath, label: '.credentials.yaml' },
      { path: plan.target.envPath, label: '.env' },
      { path: plan.target.agentsPath, label: 'AGENTS.md' },
    ],
    metadata: {
      source: options.source,
      conflictPolicy: options.conflict,
      changes: plan.summary.changes,
    },
  });

  try {
    for (const change of plan.changes) {
      atomicWrite(change.path, change.newText);
    }
    verifyApplied(plan);

    const summary = {
      ...plan.summary,
      appliedAt: new Date().toISOString(),
      backup: { id: backup.id, dir: backup.dir },
    };
    const redactor = buildRedactor(plan);
    const diff = buildDiff(plan, redactor);
    const report = writeReport(options.reportsDir, summary, { diffText: diff });

    if (options.json) {
      printJson({ summary, report, diff });
    } else {
      process.stdout.write(renderText(summary));
      process.stdout.write(`\nApplied. Backup: ${backup.id}\n  ${backup.dir}\n`);
      process.stdout.write(`Report: ${report.jsonPath}\n        ${report.htmlPath}\n`);
    }

    if (options.restart) {
      const appRoot = path.dirname(path.dirname(plan.target.dshAppDir));
      const exe = path.join(appRoot, 'DSH Desktop Beta.exe');
      if (fs.existsSync(exe)) {
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
        process.stdout.write(`Started: ${exe}\n`);
      } else {
        process.stderr.write(`Could not find DSH executable: ${exe}\n`);
      }
    }
    return 0;
  } catch (error) {
    try {
      restoreBackup({
        backupDir: backup.dir,
        backupRoot: options.backupsDir,
        allowedRoots: [plan.target.dshHome],
        force: true,
      });
      process.stderr.write(`Rollback completed from backup ${backup.id}.\n`);
    } catch (rollbackError) {
      process.stderr.write(`Rollback failed: ${rollbackError.message}\n`);
    }
    throw error;
  }
}

function commandRestore(options) {
  if (!options.backup) throw new Error('restore requires --backup <id>.');
  ensureNotRunning(options);
  const target = discoverTarget(options);
  const backupDir = resolveBackup(options.backupsDir, options.backup);
  const result = restoreBackup({
    backupDir,
    backupRoot: options.backupsDir,
    allowedRoots: [target.dshHome],
    force: Boolean(options.force),
  });

  if (options.json) {
    printJson({
      restored: result.manifest.id,
      actions: result.actions,
      preRestoreBackup: result.preRestore.id,
    });
  } else {
    process.stdout.write(`Restored backup ${result.manifest.id}\n`);
    for (const action of result.actions) {
      process.stdout.write(`  ${action.action}: ${action.path}\n`);
    }
    process.stdout.write(`Pre-restore backup: ${result.preRestore.id}\n`);
  }
  return 0;
}

function commandDoctor(options) {
  const target = discoverTarget(options);
  const issues = [];
  const warnings = [];
  const lines = [];
  const ok = (message) => lines.push(`[OK]   ${message}`);
  const warn = (message) => { warnings.push(message); lines.push(`[WARN] ${message}`); };
  const fail = (message) => { issues.push(message); lines.push(`[FAIL] ${message}`); };

  if (fs.existsSync(target.dshHome)) ok(`DSH home: ${target.dshHome}`);
  else fail(`DSH home not found: ${target.dshHome}`);

  if (fs.existsSync(target.profileDir)) ok(`Profile: ${target.profileDir}`);
  else fail(`Profile not found: ${target.profileDir}`);

  if (fs.existsSync(target.patchPath)) ok(`Patch: ${target.patchPath}`);
  else fail(`Patch not found: ${target.patchPath}`);

  if (fs.existsSync(target.credentialsPath)) ok(`Credentials: ${target.credentialsPath}`);
  else warn(`Credentials file does not exist yet: ${target.credentialsPath}`);

  if (fs.existsSync(target.envPath)) ok(`Env file: ${target.envPath}`);
  else warn(`Env file does not exist yet: ${target.envPath}`);

  if (fs.existsSync(target.agentsPath)) ok(`Global AGENTS.md: ${target.agentsPath}`);
  else warn(`Global AGENTS.md does not exist yet: ${target.agentsPath}`);

  if (target.dshAppDir && fs.existsSync(path.join(target.dshAppDir, 'package.json'))) {
    ok(`DSH app: ${target.dshAppDir}`);
  } else {
    fail(`DSH app not found (needed for the yaml package): ${target.dshAppDir || '(none)'}`);
  }

  let yaml = null;
  try {
    yaml = loadYamlModule(target.dshAppDir);
    ok(`yaml package loaded: ${yaml.version || 'unknown version'}`);
  } catch (error) {
    fail(error.message);
  }

  if (yaml && fs.existsSync(target.patchPath)) {
    try {
      const doc = parseDocument(yaml, readText(target.patchPath), target.patchPath);
      dsh.validatePatch(doc, target.patchPath);
      ok('cordis.patch.yml parses and validates.');
    } catch (error) {
      fail(`cordis.patch.yml: ${error.message}`);
    }
  }

  if (yaml && fs.existsSync(target.credentialsPath)) {
    try {
      const doc = credentials.loadCredentialsDoc(yaml, readText(target.credentialsPath), target.credentialsPath);
      credentials.validateCredentialsDoc(doc, target.credentialsPath);
      ok('.credentials.yaml parses and validates.');
    } catch (error) {
      fail(`.credentials.yaml: ${error.message}`);
    }
  }

  try {
    const sourcePaths = discoverSources(options);
    for (const source of sourcePaths) {
      if (source.exists) ok(`${source.label}: ${source.providerConfigPath}`);
      else warn(`${source.label} not found: ${source.providerConfigPath || '(no path)'}`);
    }
  } catch (error) {
    fail(`source discovery: ${error.message}`);
  }

  if (isDshRunning()) warn('DSH Desktop Beta is running; apply/restore will require --force.');
  else ok('DSH Desktop Beta is not running.');

  const backups = listBackups(options.backupsDir);
  ok(`Backups: ${backups.length} in ${options.backupsDir}`);

  process.stdout.write(`${lines.join('\n')}\n`);
  return issues.length > 0 ? 2 : 0;
}

function main() {
  const { command, options } = parseArgs(process.argv);
  if (options.help || command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  switch (command) {
    case 'scan': return commandScan(options);
    case 'plan': return commandPlan(options);
    case 'apply': return commandApply(options);
    case 'restore': return commandRestore(options);
    case 'doctor': return commandDoctor(options);
    case 'diff': return commandDiff(options);
    default:
      throw new Error(`Unknown command "${command}". Run zcode2dsh --help.`);
  }
}

try {
  const code = main();
  process.exitCode = code;
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}
