'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function readTextOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`${label || 'JSON file'} not found: ${file}`);
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label || 'JSON file'} is not valid JSON: ${file}: ${error.message}`);
  }
}

function tryReadJson(file) {
  try {
    return readJson(file, path.basename(file));
  } catch {
    return null;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, content) {
  ensureDir(path.dirname(file));
  const suffix = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temp = `${file}${suffix}`;
  fs.writeFileSync(temp, content, 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    // Windows can refuse to replace a locked target. Keep the backup-based
    // workflow safe by falling back to a copy, then remove the temp file.
    if (fs.existsSync(file)) {
      fs.copyFileSync(temp, file);
      fs.unlinkSync(temp);
    } else {
      throw error;
    }
  }
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function uniqueName(base, used, startAt = 2) {
  if (!used.has(base)) return base;
  let index = startAt;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function isSubPath(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function listFiles(dir, predicate) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (!predicate || predicate(entry.name)))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function safeBasename(file) {
  return path.basename(file);
}

module.exports = {
  readText,
  readTextOrEmpty,
  readJson,
  tryReadJson,
  sha256,
  sha256Buffer,
  ensureDir,
  atomicWrite,
  timestampForPath,
  isPlainObject,
  escapeHtml,
  uniqueName,
  isSubPath,
  fileExists,
  listFiles,
  formatBytes,
  safeBasename,
};
