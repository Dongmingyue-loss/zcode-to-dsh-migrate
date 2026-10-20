'use strict';

/**
 * Blocking secret scan for publishable files.
 *
 * Collects real secret values from local ZCode / ZCodium / DSH configuration
 * into memory, then checks every candidate file for exact occurrences. The
 * values are never printed; only file paths and counts are reported.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { discoverSources, discoverTarget } = require('../lib/discover');
const { loadYamlModule } = require('../lib/yaml');
const credentials = require('../lib/credentials');
const { readText, isPlainObject } = require('../lib/util');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'backups', 'reports', 'dist', 'node_modules', 'bilibili']);
const SKIP_FILES = new Set(['MIGRATION-RECORD.md']);

const FAKE_SECRET_ALLOWLIST = [
  /^sk-test-[A-Za-z0-9-]+$/,
  /^sk-existing-secret-[A-Za-z0-9-]+$/,
  /^sk-different-secret-[A-Za-z0-9-]+$/,
  /^test-token-[A-Za-z0-9-]+$/,
];

/** Loopback proxy URLs are configuration, not credentials. */
const NON_SECRET_VALUE = [
  /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i,
];

function addSecret(set, value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  if (FAKE_SECRET_ALLOWLIST.some((pattern) => pattern.test(trimmed))) return;
  if (NON_SECRET_VALUE.some((pattern) => pattern.test(trimmed))) return;
  set.add(trimmed);

  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearer && bearer[1].trim().length >= 8) set.add(bearer[1].trim());
}

function collectFromObject(set, value, keyHint = '') {
  if (Array.isArray(value)) {
    for (const item of value) collectFromObject(set, item, keyHint);
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /(api[-_]?key|authorization|token|secret|password|passwd)/i.test(key)) {
      addSecret(set, child);
    } else if (typeof child === 'object') {
      collectFromObject(set, child, key);
    }
  }
}

function collectSecrets() {
  const secrets = new Set();
  const sources = [];

  const opts = {};
  let discovered = [];
  try {
    discovered = discoverSources({ ...opts, source: 'all' });
  } catch (error) {
    sources.push(`source discovery failed: ${error.message}`);
  }

  for (const source of discovered) {
    try {
      if (source.kind === 'zcode') {
        const config = JSON.parse(readText(source.providerConfigPath));
        collectFromObject(secrets, config);
      } else if (source.kind === 'zcodium') {
        const config = JSON.parse(readText(source.providerConfigPath));
        collectFromObject(secrets, config);
      }
      if (source.cliConfigPath && fs.existsSync(source.cliConfigPath)) {
        collectFromObject(secrets, JSON.parse(readText(source.cliConfigPath)));
      }
      sources.push(source.providerConfigPath);
    } catch (error) {
      sources.push(`${source.label}: ${error.message}`);
    }
  }

  let target = null;
  try {
    target = discoverTarget({});
    if (fs.existsSync(target.credentialsPath)) {
      const yaml = loadYamlModule(target.dshAppDir);
      const doc = credentials.loadCredentialsDoc(
        yaml,
        readText(target.credentialsPath),
        target.credentialsPath
      );
      collectFromObject(secrets, doc.toJSON());
      sources.push(target.credentialsPath);
    }
    if (fs.existsSync(target.envPath)) {
      const text = readText(target.envPath);
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)\s*$/.exec(line);
        if (match && /key|token|secret|password/i.test(match[1])) addSecret(secrets, match[2]);
      }
      sources.push(target.envPath);
    }
  } catch (error) {
    sources.push(`DSH credentials: ${error.message}`);
  }

  return { secrets, sources };
}

function walk(dir, output) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, output);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    output.push(full);
  }
}

function findGenericCandidates(text) {
  const hits = [];
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[0];
      if (!FAKE_SECRET_ALLOWLIST.some((allowed) => allowed.test(value.replace(/^Bearer\s+/i, '')))) {
        hits.push(value);
      }
    }
  }
  return hits;
}

function scanFile(file, secrets) {
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) return { exact: 0, generic: 0 };
  const text = buffer.toString('utf8');

  let exact = 0;
  for (const secret of secrets) {
    if (text.includes(secret)) exact += 1;
  }

  return { exact, generic: findGenericCandidates(text).length };
}

function main() {
  const { secrets, sources } = collectSecrets();
  const files = [];
  walk(ROOT, files);

  const findings = [];
  for (const file of files) {
    const result = scanFile(file, secrets);
    if (result.exact > 0 || result.generic > 0) {
      findings.push({
        file: path.relative(ROOT, file),
        exact: result.exact,
        generic: result.generic,
      });
    }
  }

  process.stdout.write(`Scanned ${files.length} files against ${secrets.size} real secret value(s).\n`);
  process.stdout.write(`Secret sources: ${sources.length} local file(s).\n`);

  if (findings.length > 0) {
    process.stdout.write('BLOCKED: potential secret matches found:\n');
    for (const finding of findings) {
      process.stdout.write(`  ${finding.file}: exact=${finding.exact} generic=${finding.generic}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('PASS: no real secret values found in publishable files.\n');
}

main();
