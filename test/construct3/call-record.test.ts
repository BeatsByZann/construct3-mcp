/**
 * The tool call scope records the call's changes in order (scope.steps):
 * the writer's own writes, the files tools write through the writer's file
 * primitives (journalOnly), image renames, and the failure paths: a write
 * whose post-write check failed, an undo that failed, a write another write
 * landed on (unowned). Each file's state before the call first touched it
 * is kept (scope.before). Real reader and writer on a copy of the minimal
 * fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter, EntityWriteError, type RestoreFailedWriteResult } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { getImageFileName } from '../../src/construct3/png-generator.js';
import { currentToolCall, fileKey, noteFileWritten, runInToolCall, sameFileState, statFileState, type ToolCallScope } from '../../src/construct3/disk-state.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const HERO = { objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, pluginId: 'Sprite' };

let dir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-call-record-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Run `fn` as one tool call and return the scope it left (also when `fn` throws). */
async function inCall(fn: () => Promise<unknown>): Promise<ToolCallScope> {
  return runInToolCall(async () => {
    try {
      await fn();
    } catch {
      // the scope is what the test looks at
    }
    return currentToolCall() as ToolCallScope;
  });
}

const stepLabels = (scope: ToolCallScope) => scope.steps.map(s => ('move' in s
  ? `move ${s.move.fromLabel} -> ${s.move.toLabel}`
  : `${scope.changes.get(s.file)?.journalOnly ? 'tool' : 'writer'} ${scope.changes.get(s.file)?.label}`));

/** A layer added to Layout 1 through the writer, as add_layer does it. */
async function addLayer(name: string): Promise<void> {
  const layout = JSON.parse(await readFile(join(dir, 'layouts', 'Layout 1.json'), 'utf-8'));
  layout.layers.push({ ...layout.layers[0], name, instances: [] });
  await writer.writeEntityFile('layouts', 'Layout 1', layout);
}

describe('the call record', () => {
  it('lists writer writes, tool writes and renames in the order the call made them', async () => {
    await mkdir(join(dir, 'images'), { recursive: true });
    await writeFile(join(dir, 'images', 'a.png'), 'a');
    const scope = await inCall(async () => {
      await writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]);
      await writer.updateProject(project => { project.properties.author = 'Journal'; });
      await writer.replaceFile(join(dir, 'timelines', 'T.json'), '{}');
    });
    expect(stepLabels(scope)).toEqual(['move images/a.png -> images/b.png', 'writer project.c3proj', 'tool timelines/T.json']);
    expect(scope.changes.get(fileKey(join(dir, 'timelines', 'T.json')))?.backupLabel).toBe('timelines/T.json.bak');
  });

  it('keeps the state each file had before the call first touched it, also the source of a rename', async () => {
    await mkdir(join(dir, 'images'), { recursive: true });
    await writeFile(join(dir, 'images', 'a.png'), 'a');
    const scope = await inCall(() => writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]));
    expect(scope.before.get(fileKey(join(dir, 'images', 'a.png')))).not.toBeNull();
    expect(scope.before.get(fileKey(join(dir, 'images', 'b.png')))).toBeNull();
  });

  it('a rename leaves the source recorded as gone and the target in its new state', async () => {
    await mkdir(join(dir, 'images'), { recursive: true });
    await writeFile(join(dir, 'images', 'a.png'), 'a');
    const scope = await inCall(() => writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]));
    expect(scope.reads.get(fileKey(join(dir, 'images', 'a.png')))).toBeNull();
    expect(sameFileState(scope.reads.get(fileKey(join(dir, 'images', 'b.png'))) ?? null, await statFileState(join(dir, 'images', 'b.png')))).toBe(true);
    expect(scope.reads.get(fileKey(join(dir, 'images', 'b.png')))).not.toBeNull();
  });

  it('a rename back in the same call removes the move', async () => {
    await mkdir(join(dir, 'images'), { recursive: true });
    await writeFile(join(dir, 'images', 'a.png'), 'a');
    const scope = await inCall(async () => {
      await writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]);
      await writer.renameImageFiles([{ from: 'b.png', to: 'a.png' }]);
    });
    expect(scope.steps).toEqual([]);
  });

  it('a placeholder written into a slot a rename freed, then removed and the image renamed back, ends as it started', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    const first = getImageFileName('Hero', 'Animation 1', 0, 'Sprite');
    const second = getImageFileName('Hero', 'Animation 1', 1, 'Sprite');
    await writeFile(join(images, first), 'artwork');
    let removed: Awaited<ReturnType<Construct3ProjectWriter['putBackImage']>> | undefined;
    const scope = await inCall(async () => {
      await writer.renameImageFiles([{ from: first, to: second }]);
      await writer.writeImageFiles([HERO]);
      removed = await writer.putBackImage(join(images, first));
      await writer.renameImageFiles([{ from: second, to: first }]);
    });
    const key = fileKey(join(images, first));
    expect(removed).toBe('removed');
    expect(scope.changes.has(key)).toBe(false);
    expect(scope.steps).toEqual([]);
    expect(sameFileState(scope.reads.get(key) ?? null, scope.before.get(key) ?? null)).toBe(true);
  });
});

describe('the failure paths', () => {
  it('a write another write landed on right after is recorded as unowned', async () => {
    const file = join(dir, 'timelines', 'T.json');
    const internals = writer as unknown as { atomicWrite: (p: string, c: string | Buffer) => Promise<void> };
    const original = internals.atomicWrite.bind(writer);
    vi.spyOn(internals, 'atomicWrite').mockImplementation(async (p, c) => {
      await original(p, c);
      if (fileKey(p) === fileKey(file)) await writeFile(file, '{"editor":true}');
    });
    const scope = await inCall(() => writer.replaceFile(file, '{}'));
    expect(scope.changes.has(fileKey(file))).toBe(true);
    expect(scope.unowned.has(fileKey(file))).toBe(true);
  });

  it('a bridge-style rollback through restoreForCall leaves no record', async () => {
    const file = join(dir, 'scripts', 'main.js');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(file, 'before');
    const scope = await inCall(async () => {
      await writer.replaceFile(file, 'after');
      await writer.restoreForCall(file, 'before');
    });
    expect(scope.changes.has(fileKey(file))).toBe(false);
    expect(scope.steps).toEqual([]);
  });

  it('an entity write whose post-write check failed is recorded, and restoreFailedWrite cancels it', async () => {
    const internals = writer as unknown as { verifyWrittenFile: () => Promise<void> };
    vi.spyOn(internals, 'verifyWrittenFile').mockRejectedValue(new Error('Post-write verification failed for "Layout 1"'));
    const key = fileKey(join(dir, 'layouts', 'Layout 1.json'));
    const kept = await inCall(() => addLayer('HUD'));
    expect(kept.changes.get(key)?.journalOnly).toBe(true);
    // The file holds this write's text, so that is the state the call left it in
    expect(sameFileState(kept.reads.get(key) ?? null, await statFileState(join(dir, 'layouts', 'Layout 1.json')))).toBe(true);

    let restoredResult: RestoreFailedWriteResult | undefined;
    const restored = await inCall(async () => {
      try {
        await addLayer('HUD');
      } catch (error) {
        if (!(error instanceof EntityWriteError)) throw error;
        restoredResult = await writer.restoreFailedWrite(error);
      }
    });
    expect(restoredResult?.restored).toBe(true);
    expect(restored.changes.has(key)).toBe(false);
    expect(restored.steps).toEqual([]);
  });

  it('restoreFailedWrite after a write that succeeded leaves the writer\'s change on record', async () => {
    const file = join(dir, 'layouts', 'Layout 1.json');
    let restoredResult: RestoreFailedWriteResult | undefined;
    const scope = await inCall(async () => {
      const layout = JSON.parse(await readFile(file, 'utf-8'));
      layout.layers.push({ ...layout.layers[0], name: 'HUD', instances: [] });
      const backupPath = await writer.writeEntityFile('layouts', 'Layout 1', layout);
      // The file holds this write's text, so the restore puts the backup back
      restoredResult = await writer.restoreFailedWrite(new EntityWriteError(new Error('later step failed'), backupPath, await readFile(file, 'utf-8')));
    });
    expect(restoredResult?.restored).toBe(true);
    expect(scope.changes.get(fileKey(file))?.journalOnly).toBe(false);
    expect(scope.steps).toHaveLength(1);
  });

  it('an undo that could not put a file back keeps its record', async () => {
    const key = fileKey(join(dir, 'layouts', 'Layout 1.json'));
    const internals = writer as unknown as { putBack: () => Promise<boolean> };
    vi.spyOn(internals, 'putBack').mockResolvedValue(false);
    let left: string[] | undefined;
    const scope = await inCall(async () => {
      await addLayer('HUD');
      const undo = await writer.undoToolCall();
      left = undo.left.map(l => l.label);
    });
    // Asserted here, not inside inCall, which swallows a failed expectation
    expect(left).toEqual(['layouts/Layout 1.json']);
    expect(scope.changes.get(key)?.journalOnly).toBe(false);
  });

  it('an entity write that failed before it replaced the file leaves no record', async () => {
    const key = fileKey(join(dir, 'layouts', 'Layout 1.json'));
    const internals = writer as unknown as { atomicWrite: () => Promise<void> };
    vi.spyOn(internals, 'atomicWrite').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    const scope = await inCall(() => addLayer('HUD'));
    expect(scope.changes.has(key)).toBe(false);
    expect(scope.unowned.has(key)).toBe(false);
    expect(scope.steps).toEqual([]);
  });

  it('an entity write another write replaced during its check is recorded as unowned', async () => {
    const file = join(dir, 'layouts', 'Layout 1.json');
    const internals = writer as unknown as { atomicWrite: (p: string, c: string | Buffer) => Promise<void> };
    const original = internals.atomicWrite.bind(writer);
    vi.spyOn(internals, 'atomicWrite').mockImplementation(async (p, c) => {
      await original(p, c);
      await writeFile(file, '{"editor":true}');
    });
    const scope = await inCall(() => addLayer('HUD'));
    expect(scope.changes.get(fileKey(file))?.journalOnly).toBe(true);
    expect(scope.unowned.has(fileKey(file))).toBe(true);
  });

  it('a file the writer writes after a tool wrote it is no longer journalOnly', async () => {
    const file = join(dir, 'layouts', 'Layout 1.json');
    let wasJournalOnly: boolean | undefined;
    const scope = await inCall(async () => {
      await writer.replaceFile(file, await readFile(file));
      wasJournalOnly = currentToolCall()?.changes.get(fileKey(file))?.journalOnly;
      await addLayer('HUD');
    });
    expect(wasJournalOnly).toBe(true);
    expect(scope.changes.get(fileKey(file))?.journalOnly).toBe(false);
    expect(scope.steps).toHaveLength(1);
  });

  it('the state before the call is kept for a file the call replaced and for one it created', async () => {
    const existing = join(dir, 'layouts', 'Layout 1.json');
    const created = join(dir, 'timelines', 'T.json');
    const stamp = await statFileState(existing);
    const scope = await inCall(async () => {
      await writer.replaceFile(existing, '{}');
      await writer.replaceFile(created, '{}');
    });
    expect(stamp).not.toBeNull();
    expect(sameFileState(scope.before.get(fileKey(existing)) ?? null, stamp)).toBe(true);
    expect(scope.before.get(fileKey(created))).toBeNull();
  });

  it('an image the rollback of writeImageFiles put back leaves no record', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    const first = getImageFileName('Hero', 'Animation 1', 0, 'Sprite');
    await writeFile(join(images, first), 'artwork');
    const original = writer.replaceFile.bind(writer);
    let calls = 0;
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      if (++calls === 2) throw new Error('disk full');
      return original(path, content, options);
    });
    const scope = await inCall(() => writer.writeImageFiles([HERO, { ...HERO, frameIndex: 1 }]));
    expect(await readFile(join(images, first), 'utf-8')).toBe('artwork');
    expect(scope.changes.has(fileKey(join(images, first)))).toBe(false);
    expect(scope.steps).toEqual([]);
  });

  it('an undo whose put-back write was replaced right after keeps the record and reports the file as left', async () => {
    const file = join(dir, 'layouts', 'Layout 1.json');
    let left: string[] | undefined;
    const scope = await inCall(async () => {
      await addLayer('HUD');
      const internals = writer as unknown as { atomicWrite: (p: string, c: string | Buffer) => Promise<void> };
      const original = internals.atomicWrite.bind(writer);
      vi.spyOn(internals, 'atomicWrite').mockImplementation(async (p, c) => {
        await original(p, c);
        await writeFile(file, '{"editor":true}');
      });
      left = (await writer.undoToolCall()).left.map(l => l.label);
    });
    expect(left).toEqual(['layouts/Layout 1.json']);
    expect(scope.changes.get(fileKey(file))?.journalOnly).toBe(false);
  });

  it('an undo puts a file back only under that file\'s lock', async () => {
    const file = join(dir, 'layouts', 'Layout 1.json');
    const original = await readFile(file, 'utf-8');
    const internals = writer as unknown as { underLockOf: <T>(p: string, fn: () => Promise<T>) => Promise<T> };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    let duringHold: string | undefined;
    await runInToolCall(async () => {
      await addLayer('HUD');
      const written = await readFile(file, 'utf-8');
      const lock = internals.underLockOf(file, async () => { held(); await gate; });
      await holding;
      const undo = writer.undoToolCall();
      await new Promise(resolve => setTimeout(resolve, 150));
      duringHold = await readFile(file, 'utf-8');
      expect(duringHold).toBe(written);
      release();
      await lock;
      await undo;
    });
    // The write is still there while the lock is held, and put back after
    expect(duringHold).not.toBe(original);
    expect(await readFile(file, 'utf-8')).toBe(original);
  });

  it('an undo reads the state the call left a file in only once it holds the file\'s lock', async () => {
    const file = join(dir, 'layouts', 'Layout 1.json');
    const original = await readFile(file, 'utf-8');
    const internals = writer as unknown as { underLockOf: <T>(p: string, fn: () => Promise<T>) => Promise<T> };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    let left: string[] | undefined;
    await runInToolCall(async () => {
      await addLayer('HUD');
      // Another write of this call, which holds the lock while the undo waits for it
      const lock = internals.underLockOf(file, async () => {
        held();
        await gate;
        await writeFile(file, '{"later":"write"}');
        noteFileWritten(fileKey(file), await statFileState(file));
      });
      await holding;
      const undo = writer.undoToolCall();
      await new Promise(resolve => setTimeout(resolve, 100));
      release();
      await lock;
      left = (await undo).left.map(l => l.label);
    });
    expect(left).toEqual([]);
    expect(await readFile(file, 'utf-8')).toBe(original);
  });

  it('a file put back by an undo and written again in the call has one step', async () => {
    const file = join(dir, 'layouts', 'Layout 1.json');
    const scope = await inCall(async () => {
      await addLayer('HUD');
      await writer.undoToolCall();
      await addLayer('Overlay');
    });
    expect(scope.steps).toEqual([{ file: fileKey(file) }]);
    expect(scope.changes.get(fileKey(file))?.journalOnly).toBe(false);
  });

  it('undoing the call puts back the writer\'s writes and keeps the tool\'s writes on record', async () => {
    const timeline = join(dir, 'timelines', 'T.json');
    const scope = await inCall(async () => {
      await writer.replaceFile(timeline, '{}');
      await writer.updateProject(project => { project.properties.author = 'Journal'; });
      await writer.undoToolCall();
    });
    expect([...scope.changes.values()].map(c => c.label)).toEqual(['timelines/T.json']);
  });
});
