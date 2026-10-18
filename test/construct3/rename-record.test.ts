/**
 * renameImageFiles records each rename and each rollback rename as it
 * happens, so a rollback that could not rename everything back leaves the
 * moves that remain on record. fs/promises rename is mocked to fail for
 * chosen source names.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, writeFile, mkdir, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { currentToolCall, runInToolCall, type ToolCallScope } from '../../src/construct3/disk-state.js';

const { failFrom } = vi.hoisted(() => ({ failFrom: new Set<string>() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (failFrom.has(basename(String(from)))) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      return actual.rename(from, to);
    }),
  };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
let dir: string;
let writer: Construct3ProjectWriter;

beforeEach(async () => {
  failFrom.clear();
  dir = await mkdtemp(join(tmpdir(), 'c3-rename-record-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
  await mkdir(join(dir, 'images'), { recursive: true });
  await writeFile(join(dir, 'images', 'a.png'), 'a');
  await writeFile(join(dir, 'images', 'b.png'), 'b');
});

afterEach(async () => {
  failFrom.clear();
  await rm(dir, { recursive: true, force: true });
});

describe('renameImageFiles', () => {
  it('keeps on record the moves an incomplete rollback left', async () => {
    // b.png -> d.png fails; the rollback of a.png -> c.png (c.png -> a.png) fails too
    failFrom.add('b.png');
    failFrom.add('c.png');
    const scope = await runInToolCall(async () => {
      await expect(writer.renameImageFiles([{ from: 'a.png', to: 'c.png' }, { from: 'b.png', to: 'd.png' }]))
        .rejects.toThrow('could not be renamed back');
      return currentToolCall() as ToolCallScope;
    });
    const moves = scope.steps.filter(s => 'move' in s).map(s => ('move' in s ? `${s.move.fromLabel} -> ${s.move.toLabel}` : ''));
    expect(moves).toEqual(['images/a.png -> images/c.png']);
    expect((await readdir(join(dir, 'images'))).sort()).toEqual(['b.png', 'c.png']);
  });

  it('a rename whose record failed is still renamed back', async () => {
    const internals = writer as unknown as { noteFileMoved: () => Promise<void> };
    vi.spyOn(internals, 'noteFileMoved').mockRejectedValueOnce(new Error('stat failed'));
    await runInToolCall(async () => {
      await expect(writer.renameImageFiles([{ from: 'a.png', to: 'c.png' }])).rejects.toThrow('stat failed');
    });
    expect((await readdir(join(dir, 'images'))).sort()).toEqual(['a.png', 'b.png']);
  });

  it('records nothing when the rollback renamed everything back', async () => {
    failFrom.add('b.png');
    const scope = await runInToolCall(async () => {
      await expect(writer.renameImageFiles([{ from: 'a.png', to: 'c.png' }, { from: 'b.png', to: 'd.png' }])).rejects.toThrow();
      return currentToolCall() as ToolCallScope;
    });
    expect(scope.steps).toEqual([]);
  });
});
