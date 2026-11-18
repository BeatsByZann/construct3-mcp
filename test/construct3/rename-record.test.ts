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

const { failFrom, statPlan } = vi.hoisted(() => ({ failFrom: new Set<string>(), statPlan: new Map<string, number>() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    // statPlan: file name -> stat calls that still succeed; the next one fails once (EIO)
    stat: vi.fn(async (path: string, ...rest: unknown[]) => {
      const name = basename(String(path));
      const left = statPlan.get(name);
      if (left !== undefined) {
        if (left <= 0) {
          statPlan.delete(name);
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        }
        statPlan.set(name, left - 1);
      }
      return (actual.stat as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }),
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
  statPlan.clear();
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
  statPlan.clear();
  await rm(dir, { recursive: true, force: true });
});

describe('createBackup', () => {
  it('reports a file it cannot stat as one that cannot be backed up, not as the raw error', async () => {
    const file = join(dir, 'images', 'a.png');
    // existingSpelling stats the file once; the state read for the backup is the next stat
    statPlan.set('a.png', 1);
    const internals = writer as unknown as { createBackup: (path: string) => Promise<string> };
    const error = await runInToolCall(() => internals.createBackup(file).catch(e => e as Error));
    expect((error as Error).message).toContain('Cannot access file for backup');
    expect((error as Error).message).toContain('EIO');
  });
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

  it('a rename whose state read failed is still renamed back, and the rollback does not record a move that never was', async () => {
    // c.png is stat-ed once before the rename (its state before the call); the read after the rename fails
    statPlan.set('c.png', 1);
    const scope = await runInToolCall(async () => {
      await expect(writer.renameImageFiles([{ from: 'a.png', to: 'c.png' }])).rejects.toThrow('EIO');
      return currentToolCall() as ToolCallScope;
    });
    expect((await readdir(join(dir, 'images'))).sort()).toEqual(['a.png', 'b.png']);
    expect(scope.steps).toEqual([]);
  });

  it('a rollback rename that succeeded counts as renamed back even when its record failed', async () => {
    // b.png -> d.png fails; the rollback c.png -> a.png succeeds, then the read of a.png after it fails
    failFrom.add('b.png');
    statPlan.set('a.png', 1);
    const scope = await runInToolCall(async () => {
      const error = await writer.renameImageFiles([{ from: 'a.png', to: 'c.png' }, { from: 'b.png', to: 'd.png' }]).then(
        () => { throw new Error('expected the rename to fail'); },
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      expect(error.message).not.toContain('could not be renamed back');
      return currentToolCall() as ToolCallScope;
    });
    expect((await readdir(join(dir, 'images'))).sort()).toEqual(['a.png', 'b.png']);
    expect(scope.steps).toEqual([]);
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
