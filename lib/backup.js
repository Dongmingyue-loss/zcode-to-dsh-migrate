'use strict';

const fs = require('fs');
const path = require('path');
const {
  atomicWrite,
  ensureDir,
  isSubPath,
  sha256Buffer,
  timestampForPath,
} = require('./util');

const MANIFEST = 'manifest.json';

function readManifest(backupDir) {
  const file = path.join(backupDir, MANIFEST);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Backup manifest not found: ${file}`);
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Backup manifest is not valid JSON: ${file}: ${error.message}`);
  }
}

function uniqueBackupDir(root) {
  ensureDir(root);
  const base = timestampForPath();
  let candidate = path.join(root, base);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${base}-${index}`);
    index += 1;
  }
  return candidate;
}

function createBackup(options) {
  const {
    backupRoot,
    targets,
    metadata = {},
  } = options;

  const backupDir = uniqueBackupDir(backupRoot);
  ensureDir(backupDir);
  const files = [];
  const seen = new Set();

  for (const target of targets) {
    const targetPath = path.resolve(target.path);
    if (seen.has(targetPath)) continue;
    seen.add(targetPath);

    const label = target.label || path.basename(targetPath);
    const backupName = label.replace(/[^A-Za-z0-9._-]+/g, '_');
    const backupPath = path.join(backupDir, backupName);

    let existed = false;
    let buffer = null;
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isFile()) {
        existed = true;
        buffer = fs.readFileSync(targetPath);
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }

    if (existed) {
      fs.writeFileSync(backupPath, buffer);
    }

    files.push({
      targetPath,
      label,
      backupName: existed ? backupName : null,
      existed,
      sha256: existed ? sha256Buffer(buffer) : null,
      size: existed ? buffer.length : 0,
    });
  }

  const manifest = {
    id: path.basename(backupDir),
    createdAt: new Date().toISOString(),
    backupDir,
    files,
    metadata,
  };
  atomicWrite(path.join(backupDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

  return { id: manifest.id, dir: backupDir, manifest };
}

function verifyBackup(backupDir, manifest) {
  const problems = [];
  for (const file of manifest.files || []) {
    if (!file.existed) continue;
    const backupPath = path.join(backupDir, file.backupName);
    if (!fs.existsSync(backupPath)) {
      problems.push(`missing backup file: ${file.backupName}`);
      continue;
    }
    const buffer = fs.readFileSync(backupPath);
    const hash = sha256Buffer(buffer);
    if (hash !== file.sha256) {
      problems.push(`hash mismatch: ${file.backupName}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Backup verification failed for ${backupDir}: ${problems.join('; ')}`);
  }
}

function listBackups(backupRoot) {
  let entries;
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(backupRoot, entry.name);
    if (!fs.existsSync(path.join(dir, MANIFEST))) continue;
    try {
      const manifest = readManifest(dir);
      backups.push({
        id: manifest.id || entry.name,
        dir,
        createdAt: manifest.createdAt || null,
        files: (manifest.files || []).length,
        metadata: manifest.metadata || {},
      });
    } catch {
      // Ignore incomplete backups; doctor reports them separately if needed.
    }
  }
  return backups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function resolveBackup(backupRoot, id) {
  if (!id) throw new Error('Backup id is required. Use --backup <id>.');
  const candidates = [
    path.join(backupRoot, id),
    ...listBackups(backupRoot).filter((entry) => entry.id === id).map((entry) => entry.dir),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, MANIFEST))) return candidate;
  }
  throw new Error(`Backup not found: ${id}`);
}

function restoreBackup(options) {
  const {
    backupDir,
    backupRoot,
    allowedRoots = [],
    force = false,
  } = options;

  const manifest = readManifest(backupDir);
  verifyBackup(backupDir, manifest);

  for (const file of manifest.files || []) {
    if (allowedRoots.length > 0 && !allowedRoots.some((root) => isSubPath(file.targetPath, root))) {
      throw new Error(`Refusing to restore a path outside the DSH home: ${file.targetPath}`);
    }
  }

  const preRestore = createBackup({
    backupRoot,
    targets: (manifest.files || []).map((file) => ({
      path: file.targetPath,
      label: file.label,
    })),
    metadata: {
      reason: 'pre-restore',
      restoring: manifest.id,
    },
  });

  const actions = [];
  for (const file of manifest.files || []) {
    if (file.existed) {
      const backupPath = path.join(backupDir, file.backupName);
      const buffer = fs.readFileSync(backupPath);
      const targetPath = file.targetPath;
      ensureDir(path.dirname(targetPath));
      const temp = `${targetPath}.restore-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temp, buffer);
      try {
        fs.renameSync(temp, targetPath);
      } catch (error) {
        if (fs.existsSync(targetPath)) {
          fs.copyFileSync(temp, targetPath);
          fs.unlinkSync(temp);
        } else {
          throw error;
        }
      }
      actions.push({ path: targetPath, action: 'restored', sha256: file.sha256 });
      continue;
    }

    if (fs.existsSync(file.targetPath)) {
      if (!force) {
        throw new Error(
          `Refusing to delete a file that did not exist before migration: ${file.targetPath}. ` +
          'Re-run with --force if this is intended.'
        );
      }
      fs.unlinkSync(file.targetPath);
      actions.push({ path: file.targetPath, action: 'deleted-created-file' });
    } else {
      actions.push({ path: file.targetPath, action: 'already-absent' });
    }
  }

  return {
    manifest,
    actions,
    preRestore,
  };
}

module.exports = {
  MANIFEST,
  readManifest,
  createBackup,
  verifyBackup,
  listBackups,
  resolveBackup,
  restoreBackup,
};
