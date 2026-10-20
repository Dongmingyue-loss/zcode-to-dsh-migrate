'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function fallbackDiff(oldText, newText, label) {
  const oldLines = oldText ? oldText.replace(/\r\n/g, '\n').split('\n') : [];
  const newLines = newText ? newText.replace(/\r\n/g, '\n').split('\n') : [];
  const output = [
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
  return output.join('\n');
}

function unifiedDiff(oldText, newText, label = 'file') {
  if (oldText === newText) return '';

  let tempDir = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode2dsh-diff-'));
    const oldFile = path.join(tempDir, 'old');
    const newFile = path.join(tempDir, 'new');
    fs.writeFileSync(oldFile, oldText, 'utf8');
    fs.writeFileSync(newFile, newText, 'utf8');

    const result = spawnSync('git', [
      'diff',
      '--no-index',
      '--no-color',
      '--unified=3',
      '--',
      oldFile,
      newFile,
    ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });

    if ((result.status === 0 || result.status === 1) && typeof result.stdout === 'string') {
      const cleaned = [];
      for (const line of result.stdout.replace(/\r\n/g, '\n').split('\n')) {
        if (line.startsWith('diff --git ')) continue;
        if (line.startsWith('index ')) continue;
        if (line.startsWith('--- ')) {
          cleaned.push(`--- a/${label}`);
          continue;
        }
        if (line.startsWith('+++ ')) {
          cleaned.push(`+++ b/${label}`);
          continue;
        }
        cleaned.push(line);
      }
      return cleaned.join('\n');
    }
  } catch {
    // Fall through to the simple diff.
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  }

  return fallbackDiff(oldText, newText, label);
}

function capDiff(text, maxLines = 400) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= maxLines) return { text, truncated: false, omittedLines: 0 };
  return {
    text: `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more lines omitted)\n`,
    truncated: true,
    omittedLines: lines.length - maxLines,
  };
}

module.exports = {
  unifiedDiff,
  capDiff,
};
