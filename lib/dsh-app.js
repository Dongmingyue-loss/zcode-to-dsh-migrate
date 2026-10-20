'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let cached = null;

function isDshApp(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, 'package.json'));
  } catch {
    return false;
  }
}

function registryCandidates() {
  if (process.platform !== 'win32') return [];

  const script = [
    "$keys = @(",
    "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
    "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
    "  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
    ")",
    "foreach ($key in $keys) {",
    "  Get-ChildItem $key -ErrorAction SilentlyContinue | ForEach-Object {",
    "    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue",
    "    if ($p.DisplayName -like '*DSH Desktop Beta*') {",
    "      if ($p.InstallLocation) { $p.InstallLocation }",
    "      if ($p.DisplayIcon) { $p.DisplayIcon }",
    "    }",
    "  }",
    "}",
  ].join('; ');

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });

  if (result.status !== 0 || !result.stdout) return [];

  const candidates = [];
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    let value = rawLine.trim().replace(/^"|"$/g, '');
    if (!value) continue;

    // DisplayIcon may point at an executable; derive its directory.
    if (/\.exe$/i.test(value)) value = path.dirname(value);

    candidates.push(value);
    candidates.push(path.join(value, 'resources', 'app'));
    candidates.push(path.join(value, 'app'));
  }
  return candidates;
}

function driveCandidates() {
  const candidates = [];
  if (process.platform !== 'win32') return candidates;

  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    try {
      if (!fs.existsSync(drive)) continue;
    } catch {
      continue;
    }
    candidates.push(path.join(drive, 'DSH', 'DSH Desktop Beta', 'resources', 'app'));
    candidates.push(path.join(drive, 'DSH Desktop Beta', 'resources', 'app'));
    candidates.push(path.join(drive, 'Program Files', 'DSH Desktop Beta', 'resources', 'app'));
  }
  return candidates;
}

function detectDshAppDir(opts = {}) {
  if (cached && !opts.dshApp) return cached;

  const explicit = [
    opts.dshApp,
    process.env.DSH_APP_DIR,
  ].filter(Boolean);

  const common = [];
  if (process.env.LOCALAPPDATA) {
    common.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop Beta', 'resources', 'app'));
  }
  if (process.env.PROGRAMFILES) {
    common.push(path.join(process.env.PROGRAMFILES, 'DSH Desktop Beta', 'resources', 'app'));
  }
  if (process.env['PROGRAMFILES(X86)']) {
    common.push(path.join(process.env['PROGRAMFILES(X86)'], 'DSH Desktop Beta', 'resources', 'app'));
  }

  const candidates = [
    ...explicit,
    ...common,
    ...registryCandidates(),
    ...driveCandidates(),
  ];

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (isDshApp(resolved)) {
      if (!opts.dshApp) cached = resolved;
      return resolved;
    }
  }

  return explicit[0] ? path.resolve(explicit[0]) : null;
}

module.exports = {
  detectDshAppDir,
};
