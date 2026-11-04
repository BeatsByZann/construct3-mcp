/**
 * The files pack_project packs from a project folder: version control and
 * package folders, the writer's .bak backups and the operating system's own
 * files are left out, and a folder with a skipped name is never entered.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectProjectFiles, isPackedProjectFile } from '../../src/runtime/project-files.js';

const kept = ['project.c3proj', 'eventSheets/Main.json', 'images/a.png'];
const skipped = [
  '.git/x', 'node_modules/x', '__MACOSX/x', '.bak/x', 'a/.git/x', 'a/node_modules/x',
  'a.bak', 'eventSheets/Main.json.bak', '.DS_Store', 'images/Thumbs.db', 'Thumbs.db/x',
];

describe('project files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'c3-project-files-'));
    for (const rel of [...kept, ...skipped]) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), 'x');
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('collects the project files and leaves out every skipped file and folder', async () => {
    expect((await collectProjectFiles(dir)).sort()).toEqual([...kept].sort());
  });

  it('says which paths are packed', () => {
    for (const rel of kept) expect(isPackedProjectFile(rel), rel).toBe(true);
    for (const rel of skipped) {
      // A folder named like a skipped file (Thumbs.db/x) is skipped by the walk, not by this check
      if (rel === 'Thumbs.db/x') continue;
      expect(isPackedProjectFile(rel), rel).toBe(false);
    }
  });
});
