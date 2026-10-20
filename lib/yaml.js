'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { detectDshAppDir } = require('./dsh-app');

function loadYamlModule(dshAppDir) {
  const detected = dshAppDir || detectDshAppDir();
  const candidates = [
    process.env.DSH_APP_DIR,
    dshAppDir,
    detected,
  ].filter(Boolean);

  const seen = new Set();
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) continue;
    try {
      const req = createRequire(pkg);
      return req('yaml');
    } catch {
      // Try the dependency directory directly.
      try {
        const direct = path.join(dir, 'node_modules', 'yaml');
        if (fs.existsSync(direct)) return require(direct);
      } catch {
        // Continue to the next candidate.
      }
    }
  }

  try {
    return require('yaml');
  } catch {
    throw new Error(
      'Cannot find the "yaml" package. Pass --dsh-app "F:\\DSH\\DSH Desktop Beta\\resources\\app" ' +
      'or install it with: npm install yaml'
    );
  }
}

function parseDocument(yaml, text, label) {
  const doc = yaml.parseDocument(text, { prettyErrors: true });
  if (doc.errors && doc.errors.length > 0) {
    const message = doc.errors.map((error) => error.message).join('; ');
    throw new Error(`${label}: invalid YAML: ${message}`);
  }
  return doc;
}

function documentToText(doc) {
  return doc.toString();
}

module.exports = {
  loadYamlModule,
  parseDocument,
  documentToText,
};
