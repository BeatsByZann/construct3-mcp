/**
 * changedSinceCall and revertEntry on calls recorded in the change journal,
 * with the real writer as the revert port: put back last change first,
 * report a file or backup changed since the call before restoring anything,
 * stop at the first step that cannot be undone, and resume there on the
 * next attempt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir, utimes } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { getImageFileName } from '../../src/construct3/png-generator.js';
import { currentToolCall, fileKey, runInToolCall, stampOf, statFileState, type FileState, type ToolCallScope } from '../../src/construct3/disk-state.js';
import { changedSinceCall, recordToolCall, revertEntry, type JournalEntry } from '../../src/construct3/change-journal.js';

// statFileState behaves as it does unless a test makes a read fail (failStatOnce)
vi.mock('../../src/construct3/disk-state.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/construct3/disk-state.js')>();
  return { ...actual, statFileState: vi.fn(actual.statFileState) };
});
const realStat = (path: string): Promise<FileState> => vi.importActual<typeof import('../../src/construct3/disk-state.js')>('../../src/construct3/disk-state.js').then(m => m.statFileState(path));

/** A read of the state of `path` fails with EPERM, once, while the file is `present` or not; the first `skip` such reads succeed. */
function failStatOnce(path: string, present: boolean, skip = 0): void {
  const key = fileKey(path);
  let armed = true;
  let toSkip = skip;
  vi.mocked(statFileState).mockImplementation(async p => {
    if (armed && fileKey(p) === key && existsSync(p) === present && toSkip-- <= 0) {
      armed = false;
      throw Object.assign(new Error(`EPERM: operation not permitted, stat '${p}'`), { code: 'EPERM' });
    }
    return realStat(p);
  });
}

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

beforeEach(async () => {
  vi.mocked(statFileState).mockImplementation(realStat);
  dir = await mkdtemp(join(tmpdir(), 'c3-call-revert-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function recorded(tool: string, fn: () => Promise<unknown>): Promise<JournalEntry> {
  const entry = await runInToolCall(async () => {
    await fn();
    return recordToolCall(reader, tool, Date.now(), currentToolCall() as ToolCallScope);
  });
  if (!entry) throw new Error('the call changed nothing');
  return entry;
}

const read = (rel: string) => readFile(join(dir, ...rel.split('/')), 'utf-8');
const revert = (entry: JournalEntry) => runInToolCall(() => revertEntry(entry, writer));

async function addLayer(name: string): Promise<void> {
  const layout = JSON.parse(await read('layouts/Layout 1.json'));
  layout.layers.push({ ...layout.layers[0], name, instances: [] });
  await writer.writeEntityFile('layouts', 'Layout 1', layout);
}

describe('revertEntry', () => {
  it('puts back a written layout, removes a created timeline and restores project.c3proj', async () => {
    const layoutBefore = await read('layouts/Layout 1.json');
    const projectBefore = await read('project.c3proj');
    const entry = await recorded('several', async () => {
      await addLayer('HUD');
      await writer.replaceFile(join(dir, 'timelines', 'T.json'), '{}');
      await writer.updateProject(project => { project.properties.author = 'Journal'; });
    });

    expect(await changedSinceCall(entry)).toEqual({ files: [], backups: [] });
    const report = await revert(entry);

    expect(report.notRestored).toEqual([]);
    expect(report.restored).toEqual([
      { file: 'project.c3proj', how: 'restored from project.c3proj.bak' },
      { file: 'timelines/T.json', how: 'removed (the call created it)' },
      { file: 'layouts/Layout 1.json', how: 'restored from layouts/Layout 1.json.bak' },
    ]);
    expect(entry.reverted).toBe(true);
    expect(await read('layouts/Layout 1.json')).toBe(layoutBefore);
    expect(await read('project.c3proj')).toBe(projectBefore);
    expect(existsSync(join(dir, 'timelines', 'T.json'))).toBe(false);
  });

  it('removes a placeholder written into a freed slot before it renames the image back', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    const first = getImageFileName('Hero', 'Animation 1', 0, 'Sprite');
    const second = getImageFileName('Hero', 'Animation 1', 1, 'Sprite');
    await writeFile(join(images, first), 'frame 0');
    const entry = await recorded('add_frame_to_animation', async () => {
      await writer.renameImageFiles([{ from: first, to: second }]);
      await writer.writeImageFiles([{ objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, pluginId: 'Sprite' }]);
    });

    const report = await revert(entry);

    expect(report.notRestored).toEqual([]);
    expect(report.restored.map(r => r.how)).toEqual(['removed (the call created it)', `moved back from images/${second}`]);
    expect(await readFile(join(images, first), 'utf-8')).toBe('frame 0');
    expect(existsSync(join(images, second))).toBe(false);
  });

  it('does not rename over a file in the way, and stops there', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    await writeFile(join(images, 'a.png'), 'a');
    const entry = await recorded('rename', () => writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]));
    await writeFile(join(images, 'a.png'), 'someone else');

    const report = await revert(entry);

    expect(report.restored).toEqual([]);
    expect(report.notRestored).toEqual([{ file: 'images/b.png', reason: 'images/b.png changed on disk, or a file is in the way at images/a.png' }]);
    expect(await readFile(join(images, 'a.png'), 'utf-8')).toBe('someone else');
    expect(await readFile(join(images, 'b.png'), 'utf-8')).toBe('a');
    expect(entry.reverted).toBe(false);
  });

  it('resumes a revert that stopped part way, from the step it stopped at', async () => {
    const layoutBefore = await read('layouts/Layout 1.json');
    const timeline = join(dir, 'timelines', 'T.json');
    const entry = await recorded('two files', async () => {
      await addLayer('HUD');
      await writer.replaceFile(timeline, '{}');
    });
    // The second step (the layout, reverting last change first) fails once
    const original = writer.putBackChange.bind(writer);
    let failed = false;
    vi.spyOn(writer, 'putBackChange').mockImplementation(async (change, asLeft) => {
      if (!failed && fileKey(change.path) === fileKey(join(dir, 'layouts', 'Layout 1.json'))) {
        failed = true;
        return { done: false };
      }
      return original(change, asLeft);
    });

    const first = await revert(entry);
    expect(first.restored.map(r => r.file)).toEqual(['timelines/T.json']);
    expect(first.notRestored.map(r => r.file)).toEqual(['layouts/Layout 1.json']);
    expect(entry.reverted).toBe(false);
    expect(entry.undone).toBe(1);
    expect(await changedSinceCall(entry)).toEqual({ files: [], backups: [] });

    const second = await revert(entry);
    expect(second.restored.map(r => r.file)).toEqual(['layouts/Layout 1.json']);
    expect(second.notRestored).toEqual([]);
    expect(entry.reverted).toBe(true);
    expect(await read('layouts/Layout 1.json')).toBe(layoutBefore);
    expect(existsSync(timeline)).toBe(false);
  });
});

describe('changedSinceCall', () => {
  it('names a replaced backup, a changed file, and a file whose mtime alone moved', async () => {
    const metadata = await recorded('update_project_metadata', () => writer.updateProject(project => { project.properties.author = 'Journal'; }));
    await writeFile(join(dir, 'project.c3proj.bak'), 'replaced');
    expect(await changedSinceCall(metadata)).toEqual({ files: [], backups: ['project.c3proj.bak'] });

    const layout = await recorded('add_layer', () => addLayer('HUD'));
    await utimes(join(dir, 'layouts', 'Layout 1.json'), new Date(), new Date(Date.now() + 5000));
    expect(await changedSinceCall(layout)).toEqual({ files: ['layouts/Layout 1.json'], backups: [] });
  });
});

// Tests added beyond the plan's 5 (progress.md, Task 7 notes): the protections the plan's tests leave unproved

describe('revertEntry: the rest of a stopped revert', () => {
  it('does not attempt the steps after the one that could not be undone, and leaves their files alone', async () => {
    const timelineOne = join(dir, 'timelines', 'One.json');
    const timelineTwo = join(dir, 'timelines', 'Two.json');
    const entry = await recorded('three files', async () => {
      await addLayer('HUD');
      await writer.replaceFile(timelineOne, '{}');
      await writer.replaceFile(timelineTwo, '{}');
    });
    const original = writer.putBackChange.bind(writer);
    vi.spyOn(writer, 'putBackChange').mockImplementation(async (change, asLeft) => (
      fileKey(change.path) === fileKey(timelineTwo) ? { done: false } : original(change, asLeft)
    ));

    const report = await revert(entry);

    expect(report.restored).toEqual([]);
    expect(report.notRestored).toEqual([
      { file: 'timelines/Two.json', reason: 'it, or its backup, changed on disk while the revert ran' },
      { file: 'timelines/One.json', reason: 'not attempted: an earlier step could not be undone' },
      { file: 'layouts/Layout 1.json', reason: 'not attempted: an earlier step could not be undone' },
    ]);
    expect(entry.undone).toBe(0);
    expect(entry.reverted).toBe(false);
    expect(existsSync(timelineOne)).toBe(true);
    expect(JSON.parse(await read('layouts/Layout 1.json')).layers.map((l: { name: string }) => l.name)).toContain('HUD');
  });

  it('reports a step that threw by its error code, never a path, and stops there', async () => {
    const timeline = join(dir, 'timelines', 'T.json');
    const entry = await recorded('two files', async () => {
      await addLayer('HUD');
      await writer.replaceFile(timeline, '{}');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(writer, 'putBackChange').mockRejectedValue(
      Object.assign(new Error(`EACCES: permission denied, unlink '${timeline}'`), { code: 'EACCES' }),
    );

    const report = await revert(entry);

    expect(report.notRestored).toEqual([
      { file: 'timelines/T.json', reason: 'EACCES' },
      { file: 'layouts/Layout 1.json', reason: 'not attempted: an earlier step could not be undone' },
    ]);
    expect(entry.reverted).toBe(false);
    expect(existsSync(timeline)).toBe(true);
  });

  it('does not hold back the resume for a file an earlier attempt already undid, changed again since', async () => {
    const timeline = join(dir, 'timelines', 'T.json');
    const entry = await recorded('two files', async () => {
      await addLayer('HUD');
      await writer.replaceFile(timeline, '{}');
    });
    const original = writer.putBackChange.bind(writer);
    let failed = false;
    vi.spyOn(writer, 'putBackChange').mockImplementation(async (change, asLeft) => {
      if (!failed && fileKey(change.path) === fileKey(join(dir, 'layouts', 'Layout 1.json'))) {
        failed = true;
        return { done: false };
      }
      return original(change, asLeft);
    });
    await revert(entry);
    expect(existsSync(timeline)).toBe(false);

    await writeFile(timeline, '{"someone":"else"}');

    expect(await changedSinceCall(entry)).toEqual({ files: [], backups: [] });
    const second = await revert(entry);
    expect(second.notRestored).toEqual([]);
    expect(await readFile(timeline, 'utf-8')).toBe('{"someone":"else"}');
  });

  it('loads project.c3proj again after it was put back', async () => {
    const authorBefore = reader.getProject().properties.author;
    const entry = await recorded('update_project_metadata', () => writer.updateProject(project => { project.properties.author = 'Journal'; }));
    expect(reader.getProject().properties.author).toBe('Journal');

    await revert(entry);

    expect(reader.getProject().properties.author).toBe(authorBefore);
  });
});

describe('revertEntry: a step that worked, whose file cannot be read afterwards', () => {
  it('counts a file put back as done, and the next attempt goes on from there', async () => {
    const layoutBefore = await read('layouts/Layout 1.json');
    const timeline = join(dir, 'timelines', 'T.json');
    const entry = await recorded('two files', async () => {
      await addLayer('HUD');
      await writer.replaceFile(timeline, '{}');
    });
    // The timeline is removed first; a read of it after that fails once, as EPERM can right after an unlink. The layout fails once.
    failStatOnce(timeline, false);
    const original = writer.putBackChange.bind(writer);
    let failed = false;
    vi.spyOn(writer, 'putBackChange').mockImplementation(async (change, asLeft) => {
      if (!failed && fileKey(change.path) === fileKey(join(dir, 'layouts', 'Layout 1.json'))) {
        failed = true;
        return { done: false };
      }
      return original(change, asLeft);
    });

    const first = await revert(entry);
    expect(first.restored.map(r => r.file)).toEqual(['timelines/T.json']);
    expect(first.notRestored.map(r => r.file)).toEqual(['layouts/Layout 1.json']);
    expect(entry.undone).toBe(1);
    expect(existsSync(timeline)).toBe(false);

    const second = await revert(entry);
    expect(second.notRestored).toEqual([]);
    expect(second.restored.map(r => r.file)).toEqual(['layouts/Layout 1.json']);
    expect(entry.reverted).toBe(true);
    expect(await read('layouts/Layout 1.json')).toBe(layoutBefore);
  });

  it('counts a file restored from its backup as done when it cannot be read back, and the next attempt goes on from there', async () => {
    const layoutBefore = await read('layouts/Layout 1.json');
    const layoutPath = join(dir, 'layouts', 'Layout 1.json');
    const timeline = join(dir, 'timelines', 'T.json');
    const entry = await recorded('two files', async () => {
      await writer.replaceFile(timeline, '{}');
      await addLayer('HUD');
    });
    // The layout is restored first; of the reads of its state, the second (the one after the write) fails once. The timeline fails once.
    failStatOnce(layoutPath, true, 1);
    const original = writer.putBackChange.bind(writer);
    let failed = false;
    vi.spyOn(writer, 'putBackChange').mockImplementation(async (change, asLeft) => {
      if (!failed && fileKey(change.path) === fileKey(timeline)) {
        failed = true;
        return { done: false };
      }
      return original(change, asLeft);
    });

    const first = await revert(entry);
    expect(first.restored.map(r => r.file)).toEqual(['layouts/Layout 1.json']);
    expect(first.notRestored.map(r => r.file)).toEqual(['timelines/T.json']);
    expect(entry.undone).toBe(1);
    expect(await read('layouts/Layout 1.json')).toBe(layoutBefore);
    // No state is known for the layout, so nothing may be put back or renamed over it later
    expect(entry.expected.get(fileKey(layoutPath))).toBeUndefined();
    const layoutChange = entry.changes[1];
    if (layoutChange.kind === 'move') throw new Error('expected a file change');
    expect(await writer.putBackChange(layoutChange.file, () => entry.expected.get(fileKey(layoutPath)))).toEqual({ done: false });
    expect(await read('layouts/Layout 1.json')).toBe(layoutBefore);

    const second = await revert(entry);
    expect(second.notRestored).toEqual([]);
    expect(second.restored.map(r => r.file)).toEqual(['timelines/T.json']);
    expect(entry.reverted).toBe(true);
    expect(existsSync(timeline)).toBe(false);
  });

  it('does not count a file as done when it holds other bytes right after the restore', async () => {
    const layoutPath = join(dir, 'layouts', 'Layout 1.json');
    const entry = await recorded('add_layer', () => addLayer('HUD'));
    const atomicWrite = (writer as unknown as { atomicWrite: (path: string, content: Buffer) => Promise<void> }).atomicWrite.bind(writer);
    vi.spyOn(writer as unknown as { atomicWrite: typeof atomicWrite }, 'atomicWrite').mockImplementation(async (path, content) => {
      await atomicWrite(path, content);
      await writeFile(path, 'another write, right after');
    });

    const report = await revert(entry);

    expect(report.restored).toEqual([]);
    expect(report.notRestored).toEqual([{ file: 'layouts/Layout 1.json', reason: 'it, or its backup, changed on disk while the revert ran' }]);
    expect(entry.undone).toBe(0);
    expect(await readFile(layoutPath, 'utf-8')).toBe('another write, right after');
  });

  it('does not count a file as done when it is gone right after the restore', async () => {
    const layoutPath = join(dir, 'layouts', 'Layout 1.json');
    const entry = await recorded('add_layer', () => addLayer('HUD'));
    const atomicWrite = (writer as unknown as { atomicWrite: (path: string, content: Buffer) => Promise<void> }).atomicWrite.bind(writer);
    vi.spyOn(writer as unknown as { atomicWrite: typeof atomicWrite }, 'atomicWrite').mockImplementation(async (path, content) => {
      await atomicWrite(path, content);
      await rm(path);
    });

    const report = await revert(entry);

    expect(report.restored).toEqual([]);
    expect(report.notRestored.map(r => r.file)).toEqual(['layouts/Layout 1.json']);
    expect(entry.undone).toBe(0);
    expect(existsSync(layoutPath)).toBe(false);
  });

  it('counts a file renamed back as done, and the next attempt goes on from there', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    await writeFile(join(images, 'a.png'), 'a');
    const entry = await recorded('rename twice', async () => {
      await writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]);
      await writer.renameImageFiles([{ from: 'b.png', to: 'c.png' }]);
    });
    // c back to b first; the read of b after that fails once. The second rename back (b to a) fails once.
    failStatOnce(join(images, 'b.png'), true);
    const original = writer.renameBack.bind(writer);
    let calls = 0;
    vi.spyOn(writer, 'renameBack').mockImplementation(async (move, toState) => (++calls === 2 ? { done: false } : original(move, toState)));

    const first = await revert(entry);
    expect(first.restored.map(r => r.file)).toEqual(['images/b.png']);
    expect(first.notRestored.map(r => r.file)).toEqual(['images/b.png']);
    expect(entry.undone).toBe(1);
    expect(await changedSinceCall(entry)).toEqual({ files: [], backups: [] });

    const second = await revert(entry);
    expect(second.notRestored).toEqual([]);
    expect(second.restored.map(r => r.file)).toEqual(['images/a.png']);
    expect(entry.reverted).toBe(true);
    expect(await readFile(join(images, 'a.png'), 'utf-8')).toBe('a');
    expect(existsSync(join(images, 'b.png')) || existsSync(join(images, 'c.png'))).toBe(false);
  });
});

describe('a write read back with a read that fails keeps its earlier behavior', () => {
  it('replaceFile refuses a file it cannot read back, as a file another write landed on', async () => {
    const timeline = join(dir, 'timelines', 'T.json');
    failStatOnce(timeline, true);

    await expect(runInToolCall(() => writer.replaceFile(timeline, '{}'))).rejects.toThrow('was changed by another write right after this one');
  });

  it('undoing a call leaves a file it restored but cannot read back, as left', async () => {
    const layoutPath = join(dir, 'layouts', 'Layout 1.json');
    const layoutBefore = await read('layouts/Layout 1.json');
    const undo = await runInToolCall(async () => {
      await addLayer('HUD');
      failStatOnce(layoutPath, true, 1);
      return writer.undoToolCall();
    });

    expect(undo.restored).toEqual([]);
    expect(undo.left.map(f => f.label)).toEqual(['layouts/Layout 1.json']);
    expect(await read('layouts/Layout 1.json')).toBe(layoutBefore);
  });
});

describe('the writer as the revert port', () => {
  it('putBackChange reports the state it left a file in, and that it did not put back a file that changed', async () => {
    const timeline = join(dir, 'timelines', 'T.json');
    const layoutPath = join(dir, 'layouts', 'Layout 1.json');
    const entry = await recorded('two files', async () => {
      await addLayer('HUD');
      await writer.replaceFile(timeline, '{}');
    });
    const [layoutChange, timelineChange] = entry.changes;
    if (layoutChange.kind === 'move' || timelineChange.kind === 'move') throw new Error('expected file changes');
    const left = (change: { path: string }) => entry.expected.get(fileKey(change.path));

    await writeFile(layoutPath, 'edited since the call');
    expect(await writer.putBackChange(layoutChange.file, () => left(layoutChange.file))).toEqual({ done: false });

    expect(await writer.putBackChange(timelineChange.file, () => left(timelineChange.file))).toEqual({ done: true, state: null });
    expect(existsSync(timeline)).toBe(false);

    await writeFile(layoutPath, 'edited since the call');
    const asLeft = stampOf(statSync(layoutPath));
    const restored = await writer.putBackChange(layoutChange.file, () => asLeft);
    expect(restored).toEqual({ done: true, state: stampOf(statSync(layoutPath)) });
    expect(JSON.parse(await read('layouts/Layout 1.json')).layers.map((l: { name: string }) => l.name)).not.toContain('HUD');
  });

  it('renameBack waits for the lock of the file it moves back to, and finds a placeholder written under it', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    await writeFile(join(images, 'a.png'), 'a');
    const entry = await recorded('rename', () => writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]));
    const move = entry.changes[0];
    if (move.kind !== 'move') throw new Error('expected a move');
    const toState = stampOf(statSync(join(images, 'b.png')));
    const withFileLock = (writer as unknown as { withFileLock: (path: string, fn: () => Promise<void>) => Promise<void> }).withFileLock.bind(writer);

    let back: Promise<unknown> = Promise.resolve();
    // A placeholder write holds the lock of images/a.png and lands in the slot while renameBack is asked to run
    await withFileLock(join(images, 'a.png'), async () => {
      back = runInToolCall(() => writer.renameBack(move.move, toState));
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(join(images, 'a.png'), 'placeholder');
    });

    expect(await back).toEqual({ done: false });
    expect(await readFile(join(images, 'a.png'), 'utf-8')).toBe('placeholder');
    expect(await readFile(join(images, 'b.png'), 'utf-8')).toBe('a');
  });

  it('putBackChange hands the file\'s state reader to the lock without calling it', async () => {
    const entry = await recorded('create', () => writer.replaceFile(join(dir, 'timelines', 'T.json'), '{}'));
    const change = entry.changes[0];
    if (change.kind === 'move') throw new Error('expected a file change');
    const putBackLocked = vi.spyOn(writer as unknown as { putBackLocked: () => Promise<false> }, 'putBackLocked').mockResolvedValue(false);
    const asLeft = vi.fn(() => undefined);

    await writer.putBackChange(change.file, asLeft);

    expect(putBackLocked).toHaveBeenCalledWith(change.file, asLeft);
    expect(asLeft).not.toHaveBeenCalled();
  });

  it('renameBack makes the folder of the file it moves back, when it is gone', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    await writeFile(join(images, 'b.png'), 'b');
    const toState = stampOf(statSync(join(images, 'b.png')));
    const from = join(dir, 'gone', 'sub', 'a.png');

    const moved = await runInToolCall(() => writer.renameBack({ from, to: join(images, 'b.png'), fromLabel: 'gone/sub/a.png', toLabel: 'images/b.png' }, toState));

    expect(moved).toEqual({ done: true, fromState: stampOf(statSync(from)), toState: null });
    expect(await readFile(from, 'utf-8')).toBe('b');
  });
});

describe('revertEntry: renames', () => {
  async function freshImages(): Promise<string> {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    return images;
  }

  it('does not rename back a file that is not in the state the call left it in', async () => {
    const images = await freshImages();
    await writeFile(join(images, 'a.png'), 'a');
    const entry = await recorded('rename', () => writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]));
    await writeFile(join(images, 'b.png'), 'edited since the call');

    const report = await revert(entry);

    expect(report.restored).toEqual([]);
    expect(report.notRestored).toEqual([{ file: 'images/b.png', reason: 'images/b.png changed on disk, or a file is in the way at images/a.png' }]);
    expect(await readFile(join(images, 'b.png'), 'utf-8')).toBe('edited since the call');
    expect(existsSync(join(images, 'a.png'))).toBe(false);
  });

  it('undoes a rename that moved the same file on, and one into a slot the call freed', async () => {
    const images = await freshImages();
    await writeFile(join(images, 'a.png'), 'a');
    const chain = await recorded('rename twice', async () => {
      await writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]);
      await writer.renameImageFiles([{ from: 'b.png', to: 'c.png' }]);
    });
    const chained = await revert(chain);
    expect(chained.notRestored).toEqual([]);
    expect(chained.restored.map(r => r.file)).toEqual(['images/b.png', 'images/a.png']);
    expect(await readFile(join(images, 'a.png'), 'utf-8')).toBe('a');
    expect(existsSync(join(images, 'b.png')) || existsSync(join(images, 'c.png'))).toBe(false);

    await writeFile(join(images, 'x.png'), 'x');
    await writeFile(join(images, 'y.png'), 'old y');
    const freed = await recorded('delete then rename', async () => {
      await writer.deleteFile(join(images, 'y.png'));
      await writer.renameImageFiles([{ from: 'x.png', to: 'y.png' }]);
    });
    const freedReport = await revert(freed);
    expect(freedReport.notRestored).toEqual([]);
    expect(await readFile(join(images, 'x.png'), 'utf-8')).toBe('x');
    expect(await readFile(join(images, 'y.png'), 'utf-8')).toBe('old y');
  });

  it('remembers a placeholder it removed, so a rename back that failed after it can be resumed', async () => {
    const images = await freshImages();
    const first = getImageFileName('Hero', 'Animation 1', 0, 'Sprite');
    const second = getImageFileName('Hero', 'Animation 1', 1, 'Sprite');
    await writeFile(join(images, first), 'frame 0');
    const entry = await recorded('add_frame_to_animation', async () => {
      await writer.renameImageFiles([{ from: first, to: second }]);
      await writer.writeImageFiles([{ objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, pluginId: 'Sprite' }]);
    });
    const original = writer.renameBack.bind(writer);
    let failed = false;
    vi.spyOn(writer, 'renameBack').mockImplementation(async (move, toState) => {
      if (!failed) {
        failed = true;
        return { done: false };
      }
      return original(move, toState);
    });

    const firstAttempt = await revert(entry);
    expect(firstAttempt.restored.map(r => r.how)).toEqual(['removed (the call created it)']);
    expect(entry.undone).toBe(1);
    expect(await changedSinceCall(entry)).toEqual({ files: [], backups: [] });

    const secondAttempt = await revert(entry);
    expect(secondAttempt.notRestored).toEqual([]);
    expect(entry.reverted).toBe(true);
    expect(await readFile(join(images, first), 'utf-8')).toBe('frame 0');
  });

  // A rename whose rollback rename also failed stays recorded with no state known for its target
  // while the file sits there: a state of null or undefined for a move target never means "the call left it absent"
  describe.each([
    ['not recorded', (scope: ToolCallScope, key: string) => { scope.reads.delete(key); }],
    ['recorded as absent', (scope: ToolCallScope, key: string) => { scope.reads.set(key, null); }],
  ])('a rename whose target is %s', (_name, tamper) => {
    async function renamed(): Promise<{ entry: JournalEntry; images: string }> {
      const images = await freshImages();
      await writeFile(join(images, 'a.png'), 'a');
      const entry = await runInToolCall(async () => {
        await writer.renameImageFiles([{ from: 'a.png', to: 'b.png' }]);
        const scope = currentToolCall() as ToolCallScope;
        tamper(scope, fileKey(join(images, 'b.png')));
        return recordToolCall(reader, 'rename', Date.now(), scope);
      });
      if (!entry) throw new Error('the call changed nothing');
      return { entry, images };
    }

    it('is listed as changed, and not renamed back', async () => {
      const { entry, images } = await renamed();
      expect(await changedSinceCall(entry)).toEqual({ files: ['images/b.png'], backups: [] });

      const report = await revert(entry);

      expect(report.restored).toEqual([]);
      expect(report.notRestored).toEqual([{ file: 'images/b.png', reason: 'images/b.png changed on disk, or a file is in the way at images/a.png' }]);
      expect(await readFile(join(images, 'b.png'), 'utf-8')).toBe('a');
      expect(existsSync(join(images, 'a.png'))).toBe(false);
      expect(entry.undone).toBe(0);
    });

    it('is refused, not tried, when the target is gone too', async () => {
      const { entry, images } = await renamed();
      await rm(join(images, 'b.png'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const report = await revert(entry);

      expect(report.restored).toEqual([]);
      expect(report.notRestored).toEqual([{ file: 'images/b.png', reason: 'images/b.png changed on disk, or a file is in the way at images/a.png' }]);
      expect(existsSync(join(images, 'a.png'))).toBe(false);
    });
  });
});
