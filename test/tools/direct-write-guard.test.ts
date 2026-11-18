/**
 * The tools write project files only through the writer (replaceFile,
 * deleteFile, restoreForCall, updateProject, writeEntityFile, ...), so every
 * write takes the file's lock, is backed up once per call and is confirmed
 * on disk. A raw write is allowed only for a file outside the project or for
 * the raw files used for a copy outside it, each with its reason.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { listToolModules, rawWriteCalls } from '../helpers/raw-writes.js';

const TOOLS_DIR = join(__dirname, '..', '..', 'src', 'tools');

const ALLOWED: Array<{ file: string; call: string; reason: string }> = [
  { file: 'runtime-tools.ts', call: "writeFile(path, text, 'utf-8')", reason: 'RAW_BRIDGE_FILES: clone_project installs the bridge in a copy outside the project' },
  { file: 'runtime-tools.ts', call: 'unlink(path)', reason: 'RAW_BRIDGE_FILES: the copy outside the project' },
  { file: 'runtime-tools.ts', call: "writeFile(file, text, 'utf-8')", reason: 'restoreText, used only by RAW_BRIDGE_FILES' },
  { file: 'runtime-tools.ts', call: "writeFile(outputPath, shot.data, { flag: overwrite ? 'w' : 'wx' })", reason: 'screenshot_game writes outside the project' },
];

function rawWrites(): Array<{ file: string; call: string; line: number }> {
  return listToolModules(TOOLS_DIR).flatMap(file =>
    rawWriteCalls(file, readFileSync(join(TOOLS_DIR, file), 'utf-8')).map(c => ({ file, call: c.text, line: c.line })));
}

describe('direct writes in the tools', () => {
  it('go through the writer, except the allowed ones', () => {
    const unexpected = rawWrites().filter(w => !ALLOWED.some(a => a.file === w.file && a.call === w.call));
    expect(unexpected).toEqual([]);
  });

  it('every allowed call still exists', () => {
    const found = rawWrites();
    expect(ALLOWED.filter(a => !found.some(w => w.file === a.file && w.call === a.call))).toEqual([]);
  });
});
