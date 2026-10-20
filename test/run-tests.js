'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { prepareMigration } = require('../lib/migrate');
const { createBackup, listBackups, resolveBackup, restoreBackup } = require('../lib/backup');
const { readText, readTextOrEmpty, sha256 } = require('../lib/util');
const { detectDshAppDir } = require('../lib/dsh-app');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const CLI = path.join(ROOT, 'bin', 'zcode2dsh.js');
const DSH_APP = process.env.DSH_APP_DIR || process.env.TEST_DSH_APP_DIR || detectDshAppDir();

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, from), to);
}

function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode2dsh-test-'));
  const dshHome = path.join(root, 'dsh');
  const zcode = path.join(root, 'zcode');
  const zcodium = path.join(root, 'zcodium');

  copy('zcode-config.json', path.join(zcode, 'v2', 'config.json'));
  copy('zcode-order.json', path.join(zcode, 'v2', 'model-provider-display-order.json'));
  copy('zcode-setting.json', path.join(zcode, 'v2', 'setting.json'));
  copy('zcode-cli.json', path.join(zcode, 'cli', 'config.json'));
  copy('zcode-AGENTS.md', path.join(zcode, 'AGENTS.md'));
  copy('zcode-log.log', path.join(zcode, 'v2', 'logs', '2026-10-19.log'));

  copy('dsh-cordis.patch.yml', path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'));
  copy('dsh-credentials.yaml', path.join(dshHome, '.credentials.yaml'));
  copy('dsh.env', path.join(dshHome, '.env'));

  const opts = {
    source: 'zcode',
    dshHome,
    dshApp: DSH_APP,
    zcodeConfig: path.join(zcode, 'v2', 'config.json'),
    zcodeOrder: path.join(zcode, 'v2', 'model-provider-display-order.json'),
    zcodeSetting: path.join(zcode, 'v2', 'setting.json'),
    zcodeCli: path.join(zcode, 'cli', 'config.json'),
    zcodeAgents: path.join(zcode, 'AGENTS.md'),
    zcodiumConfig: path.join(zcodium, 'v2', 'provider_config.json'),
    zcodiumSetting: path.join(zcodium, 'v2', 'setting.json'),
    zcodiumCli: path.join(zcodium, 'cli', 'config.json'),
    zcodiumAgents: path.join(zcodium, 'AGENTS.md'),
    conflict: 'keep',
    reasoning: 'omit',
    backupsDir: path.join(root, 'backups'),
    reportsDir: path.join(root, 'reports'),
  };

  return {
    root,
    dshHome,
    opts,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function cliArgs(opts, command, extra = []) {
  const args = [
    CLI,
    command,
    '--source', opts.source,
    '--dsh-home', opts.dshHome,
    '--dsh-app', opts.dshApp,
    '--conflict', opts.conflict,
    '--reasoning', opts.reasoning,
    '--backup-dir', opts.backupsDir,
    '--report-dir', opts.reportsDir,
    '--zcode-config', opts.zcodeConfig,
    '--zcode-order', opts.zcodeOrder,
    '--zcode-setting', opts.zcodeSetting,
    '--zcode-cli', opts.zcodeCli,
    '--zcode-agents', opts.zcodeAgents,
    '--zcodium-config', opts.zcodiumConfig,
    '--zcodium-setting', opts.zcodiumSetting,
    '--zcodium-cli', opts.zcodiumCli,
    '--zcodium-agents', opts.zcodiumAgents,
    ...extra,
  ];
  return args;
}

function runCli(opts, command, extra = []) {
  return spawnSync(process.execPath, cliArgs(opts, command, extra), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      // Tests use a temporary DSH home; a running desktop app is irrelevant.
      TEST_ISOLATED_DSH_HOME: '1',
    },
  });
}

function snapshot(opts) {
  const files = [
    path.join(opts.dshHome, 'profiles', 'desktop', 'cordis.patch.yml'),
    path.join(opts.dshHome, '.credentials.yaml'),
    path.join(opts.dshHome, '.env'),
    path.join(opts.dshHome, 'AGENTS.md'),
  ];
  return files.map((file) => ({
    file,
    exists: fs.existsSync(file),
    text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
    hash: fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null,
  }));
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('maps providers, models, MCP, proxy, and AGENTS without leaking secrets', () => {
  const sandbox = createSandbox();
  try {
    const plan = prepareMigration(sandbox.opts);
    assert.strictEqual(plan.summary.providers.length, 3);
    assert.deepStrictEqual(
      plan.summary.providers.map((provider) => provider.name),
      ['OpenAI Compatible Test', 'Anthropic Test', 'Responses Test']
    );

    const byName = Object.fromEntries(plan.summary.providers.map((provider) => [provider.name, provider]));
    assert.strictEqual(byName['Anthropic Test'].api, 'anthropic-messages');
    assert.strictEqual(byName['OpenAI Compatible Test'].api, 'openai-completions');
    assert.strictEqual(byName['Responses Test'].api, 'openai-responses');

    const anthropicModel = plan.providers.find((provider) => provider.sourceName === 'Anthropic Test').config.models[0];
    assert.strictEqual(anthropicModel.id, 'claude-test');
    assert.strictEqual(anthropicModel.contextWindow, 200000);
    assert.strictEqual(anthropicModel.maxTokens, 8192);
    assert.deepStrictEqual(anthropicModel.input, ['text', 'image']);

    const responsesModel = plan.providers.find((provider) => provider.sourceName === 'Responses Test').config.models[0];
    assert.deepStrictEqual(responsesModel.input, ['text']);
    assert.ok(plan.summary.modelReport.droppedModalities.some((entry) => entry.dropped.includes('audio')));

    const openaiProvider = plan.providers.find((provider) => provider.sourceName === 'OpenAI Compatible Test');
    const aliasModel = openaiProvider.config.models.find((model) => model.id === 'gpt-wire');
    assert.ok(aliasModel, 'model.name should be used as the DSH wire model id');
    assert.strictEqual(aliasModel.name, 'gpt-alias');
    assert.ok(plan.summary.modelReport.modelNameAliases.some((entry) => entry.wireId === 'gpt-wire'));

    assert.strictEqual(plan.summary.mcpServers.length, 1);
    assert.strictEqual(plan.summary.mcpServers[0].serverName, 'test-http');
    assert.strictEqual(plan.summary.mcpServers[0].hasHeaders, true);
    assert.strictEqual(plan.summary.mcpSkipped.some((entry) => entry.reason === 'sse-not-supported'), true);

    assert.strictEqual(plan.summary.proxy.value, 'http://127.0.0.1:7890');
    assert.strictEqual(plan.summary.agents.action, 'create');
    assert.strictEqual(plan.summary.defaultModel, null);

    assert.ok(plan.patch.proposedText.includes('deepseek:'));
    assert.ok(plan.patch.proposedText.includes('existing-model'));
    assert.ok(plan.patch.proposedText.includes('zcode-prov-openai'));
    assert.ok(!plan.patch.proposedText.includes('sk-test-'));

    const serialized = JSON.stringify(plan.summary);
    assert.ok(!serialized.includes('sk-test-'));
    assert.ok(!serialized.includes('test-token-12345678'));
    assert.ok(!serialized.includes('sk-existing-secret-12345678'));
  } finally {
    sandbox.cleanup();
  }
});

test('supports --source all with the ZCodium adapter', () => {
  const sandbox = createSandbox();
  try {
    copy('zcodium-provider-config.json', sandbox.opts.zcodiumConfig);
    const plan = prepareMigration({ ...sandbox.opts, source: 'all' });
    assert.strictEqual(plan.summary.providers.length, 4);
    const zcodiumProvider = plan.summary.providers.find((provider) => provider.providerKey === 'zcodium-new-provider');
    assert.ok(zcodiumProvider);
    assert.strictEqual(zcodiumProvider.api, 'openai-completions');
    assert.strictEqual(zcodiumProvider.modelIds[0], 'zc-model');
    assert.strictEqual(zcodiumProvider.apiKeyEnv, 'ZCODIUM_NEW_PROVIDER_API_KEY');
  } finally {
    sandbox.cleanup();
  }
});

test('--set-default resolves the current model from ZCode logs', () => {
  const sandbox = createSandbox();
  try {
    const plan = prepareMigration({ ...sandbox.opts, setDefault: true });
    assert.ok(plan.summary.defaultModel);
    assert.strictEqual(plan.summary.defaultModel.provider, 'zcode-prov-openai');
    assert.strictEqual(plan.summary.defaultModel.model, 'gpt-test');
    assert.ok(plan.patch.proposedText.includes('provider: zcode-prov-openai'));
    assert.ok(plan.patch.proposedText.includes('model: gpt-test'));
  } finally {
    sandbox.cleanup();
  }
});

test('apply writes, verifies, is idempotent, and restore returns original bytes', () => {
  const sandbox = createSandbox();
  try {
    const before = snapshot(sandbox.opts);
    const apply = runCli(sandbox.opts, 'apply', ['--set-default']);
    assert.strictEqual(apply.status, 0, apply.stderr || apply.stdout);
    assert.ok(apply.stdout.includes('Applied.'), apply.stdout);

    const patch = readText(path.join(sandbox.dshHome, 'profiles', 'desktop', 'cordis.patch.yml'));
    const creds = readText(path.join(sandbox.dshHome, '.credentials.yaml'));
    const env = readText(path.join(sandbox.dshHome, '.env'));
    const agents = readText(path.join(sandbox.dshHome, 'AGENTS.md'));

    assert.ok(patch.includes('zcode-prov-openai'));
    assert.ok(patch.includes('zcode-prov-anthropic'));
    assert.ok(patch.includes('zcode-prov-responses'));
    assert.ok(patch.includes('id: gpt-wire'));
    assert.ok(patch.includes('name: gpt-alias'));
    assert.ok(patch.includes('provider: zcode-prov-openai'));
    assert.ok(patch.includes('deepseek:'));
    assert.ok(!patch.includes('sk-test-'));
    assert.ok(creds.includes('ZCODE_PROV_OPENAI_API_KEY'));
    assert.ok(creds.includes('DEEPSEEK_API_KEY'));
    assert.ok(creds.includes('sk-existing-secret-12345678'));
    assert.ok(env.includes('https_proxy=http://127.0.0.1:7890'));
    assert.strictEqual(agents, '# Test global instructions\n\nKeep answers concise.\n');

    const second = prepareMigration({ ...sandbox.opts, setDefault: true });
    assert.strictEqual(second.changes.length, 0, JSON.stringify(second.summary.changes));

    const backups = listBackups(sandbox.opts.backupsDir);
    assert.strictEqual(backups.length, 1);
    const backupDir = resolveBackup(sandbox.opts.backupsDir, backups[0].id);

    const restore = restoreBackup({
      backupDir,
      backupRoot: sandbox.opts.backupsDir,
      allowedRoots: [sandbox.dshHome],
      force: true,
    });
    assert.ok(restore.actions.some((action) => action.action === 'restored'));

    const after = snapshot(sandbox.opts);
    for (let index = 0; index < before.length; index += 1) {
      assert.strictEqual(after[index].exists, before[index].exists, before[index].file);
      assert.strictEqual(after[index].hash, before[index].hash, before[index].file);
    }
  } finally {
    sandbox.cleanup();
  }
});

test('dry-run does not write files or create backups', () => {
  const sandbox = createSandbox();
  try {
    const before = snapshot(sandbox.opts);
    const result = runCli(sandbox.opts, 'apply', ['--dry-run']);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const after = snapshot(sandbox.opts);
    for (let index = 0; index < before.length; index += 1) {
      assert.strictEqual(after[index].exists, before[index].exists);
      assert.strictEqual(after[index].hash, before[index].hash);
    }
    assert.strictEqual(fs.existsSync(sandbox.opts.backupsDir), false);
  } finally {
    sandbox.cleanup();
  }
});

test('credential conflict keep uses an alternate ref and reports it', () => {
  const sandbox = createSandbox();
  try {
    const credPath = path.join(sandbox.dshHome, '.credentials.yaml');
    const current = readText(credPath);
    fs.writeFileSync(
      credPath,
      current.replace(
        'records: {}',
        '  ZCODE_PROV_OPENAI_API_KEY: sk-different-secret-12345678\nrecords: {}'
      )
    );
    const plan = prepareMigration(sandbox.opts);
    const provider = plan.providers.find((item) => item.sourceName === 'OpenAI Compatible Test');
    assert.strictEqual(provider.apiKeyEnv, 'ZCODE_PROV_OPENAI_API_KEY_2');
    assert.ok(plan.summary.conflicts.some((conflict) => conflict.type === 'credential'));
    assert.ok(plan.summary.credentials.updates.some((update) => update.ref === 'ZCODE_PROV_OPENAI_API_KEY_2'));
  } finally {
    sandbox.cleanup();
  }
});

test('conflict fail aborts apply without writing', () => {
  const sandbox = createSandbox();
  try {
    const credPath = path.join(sandbox.dshHome, '.credentials.yaml');
    const current = readText(credPath);
    fs.writeFileSync(
      credPath,
      current.replace(
        'records: {}',
        '  ZCODE_PROV_OPENAI_API_KEY: sk-different-secret-12345678\nrecords: {}'
      )
    );
    const before = snapshot(sandbox.opts);
    const result = runCli({ ...sandbox.opts, conflict: 'fail' }, 'apply');
    assert.notStrictEqual(result.status, 0);
    assert.ok((result.stderr || '').includes('conflict'));
    const after = snapshot(sandbox.opts);
    for (let index = 0; index < before.length; index += 1) {
      assert.strictEqual(after[index].hash, before[index].hash);
    }
    assert.strictEqual(fs.existsSync(sandbox.opts.backupsDir), false);
  } finally {
    sandbox.cleanup();
  }
});

test('comments in existing DSH patch are preserved', () => {
  const sandbox = createSandbox();
  try {
    const plan = prepareMigration(sandbox.opts);
    assert.ok(plan.patch.proposedText.includes('# Existing DSH profile patch.'));
  } finally {
    sandbox.cleanup();
  }
});

function main() {
  if (!DSH_APP) {
    process.stdout.write(
      'SKIP tests: DSH Desktop Beta was not found. Set DSH_APP_DIR to its resources\\app directory.\n'
    );
    return;
  }

  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error.stack || error.message}\n`);
    }
  }
  process.stdout.write(`\n${tests.length - failed}/${tests.length} tests passed.\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
