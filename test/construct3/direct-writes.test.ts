/**
 * The writer's primitives for files a tool writes itself: one backup per
 * tool call, images backed up under a free .bak name, one lock domain per
 * file, a write stamped only when its bytes are on disk, a deleted file
 * recorded as absent, and a failed batch of placeholder images put back.
 * Real reader and writer on a copy of the minimal fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { getImageFileName } from '../../src/construct3/png-generator.js';
import { currentToolCall, fileKey, runInToolCall, statFileState } from '../../src/construct3/disk-state.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-direct-writes-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Make the writer's next atomic write of `path` run `after` right after replacing the file (an editor save landing then). */
function afterNextWriteOf(path: string, after: () => Promise<void>): void {
  const internals = writer as unknown as { atomicWrite: (p: string, c: string | Buffer) => Promise<void> };
  const original = internals.atomicWrite.bind(writer);
  let done = false;
  vi.spyOn(internals, 'atomicWrite').mockImplementation(async (p, c) => {
    await original(p, c);
    if (!done && fileKey(p) === fileKey(path)) {
      done = true;
      await after();
    }
  });
}

describe('replaceFile', () => {
  it('backs a file up once per call and returns the backup', async () => {
    const file = join(dir, 'timelines', 'T.json');
    await mkdir(join(dir, 'timelines'), { recursive: true });
    await writeFile(file, '{"v":1}');
    await runInToolCall(async () => {
      expect(await writer.replaceFile(file, '{"v":2}')).toBe(file + '.bak');
      expect(await writer.replaceFile(file, '{"v":3}')).toBe(file + '.bak');
    });
    expect(await readFile(file, 'utf-8')).toBe('{"v":3}');
    expect(await readFile(file + '.bak', 'utf-8')).toBe('{"v":1}');
  });

  it('creates a new file and its folder, with no backup', async () => {
    const file = join(dir, 'timelines', 'Sub', 'New.json');
    expect(await runInToolCall(() => writer.replaceFile(file, '{}'))).toBeUndefined();
    expect(await readFile(file, 'utf-8')).toBe('{}');
    expect(existsSync(file + '.bak')).toBe(false);
  });

  it('backs an image up under a free name and keeps an image parked as .bak', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    const image = join(images, 'hero-animation 1-001.png');
    await writeFile(image, 'frame 2');
    await writeFile(image + '.bak', 'parked frame 1');
    expect(await runInToolCall(() => writer.replaceFile(image, 'new'))).toBe(join(images, 'hero-animation 1-001.png.1.bak'));
    expect(await readFile(image + '.bak', 'utf-8')).toBe('parked frame 1');
    expect(await readFile(join(images, 'hero-animation 1-001.png.1.bak'), 'utf-8')).toBe('frame 2');
  });

  it('refuses project.c3proj without the state its text was built from, and a file that changed since that state', async () => {
    const projectPath = join(dir, 'project.c3proj');
    await expect(runInToolCall(() => writer.replaceFile(projectPath, '{}'))).rejects.toThrow('state the new text was built from');
    const planned = await statFileState(projectPath);
    await writeFile(projectPath, (await readFile(projectPath, 'utf-8')) + '\n');
    await expect(runInToolCall(() => writer.replaceFile(projectPath, '{}', { expected: planned })))
      .rejects.toThrow('was changed on disk after this server read it');
    expect(existsSync(projectPath + '.bak')).toBe(false);
  });

  it('does not adopt an editor save that lands right after its write', async () => {
    const file = join(dir, 'timelines', 'T.json');
    afterNextWriteOf(file, () => writeFile(file, '{"editor":true}'));
    await expect(runInToolCall(async () => {
      try {
        await writer.replaceFile(file, '{"v":1}');
      } finally {
        // The call's state for the file is not the editor's
        const left = currentToolCall()?.reads.get(fileKey(file));
        expect(left === undefined ? undefined : JSON.stringify(left)).not.toBe(JSON.stringify(await statFileState(file)));
      }
    })).rejects.toThrow('was changed by another write right after this one');
    expect(await readFile(file, 'utf-8')).toBe('{"editor":true}');
  });
});

describe('deleteFile', () => {
  it('backs the file up before it deletes it, and returns undefined for a missing file', async () => {
    const file = join(dir, 'timelines', 'T.json');
    await mkdir(join(dir, 'timelines'), { recursive: true });
    await writeFile(file, '{"v":1}');
    expect(await runInToolCall(() => writer.deleteFile(file))).toBe(file + '.bak');
    expect(existsSync(file)).toBe(false);
    expect(await readFile(file + '.bak', 'utf-8')).toBe('{"v":1}');
    expect(await runInToolCall(() => writer.deleteFile(join(dir, 'timelines', 'None.json')))).toBeUndefined();
  });

  it('records the file as absent, also when a file appears there right after', async () => {
    const file = join(dir, 'timelines', 'T.json');
    await mkdir(join(dir, 'timelines'), { recursive: true });
    await writeFile(file, '{"v":1}');
    const internals = writer as unknown as { afterToolWrite: (p: string, c: unknown) => Promise<void> };
    const original = internals.afterToolWrite.bind(writer);
    vi.spyOn(internals, 'afterToolWrite').mockImplementation(async (p, c) => {
      await writeFile(file, '{"editor":true}');
      return original(p, c);
    });
    const left = await runInToolCall(async () => {
      await writer.deleteFile(file);
      return currentToolCall()?.reads.get(fileKey(file));
    });
    expect(left).toBeNull();
  });
});

describe('restoreForCall', () => {
  it('puts back the content from before the call, and refuses a file changed since the call wrote it', async () => {
    const file = join(dir, 'scripts', 'main.js');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(file, 'before');
    await runInToolCall(async () => {
      await writer.replaceFile(file, 'after');
      await writer.restoreForCall(file, 'before');
    });
    expect(await readFile(file, 'utf-8')).toBe('before');

    await runInToolCall(async () => {
      await writer.replaceFile(file, 'after');
      await writeFile(file, 'editor');
      await expect(writer.restoreForCall(file, 'before')).rejects.toThrow('changed on disk after this call wrote it');
    });
    expect(await readFile(file, 'utf-8')).toBe('editor');
  });

  it('leaves a file the call has no state for as it is, unless the caller names the state it is in', async () => {
    const file = join(dir, 'scripts', 'main.js');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(file, 'someone else');
    await runInToolCall(async () => {
      await expect(writer.restoreForCall(file, 'before')).rejects.toThrow('has no state recorded by this call');
      expect(await readFile(file, 'utf-8')).toBe('someone else');

      // A state that is not the file's: refused
      await writeFile(file, 'someone else, again');
      await expect(writer.restoreForCall(file, 'before', { expected: await statFileState(join(dir, 'project.c3proj')) }))
        .rejects.toThrow('changed on disk after this call wrote it');
      expect(await readFile(file, 'utf-8')).toBe('someone else, again');

      // The file's own state: put back
      await writer.restoreForCall(file, 'before', { expected: await statFileState(file) });
    });
    expect(await readFile(file, 'utf-8')).toBe('before');
  });
});

describe('updateProject', () => {
  it('writes project.c3proj through the writer and backs it up', async () => {
    const before = await readFile(join(dir, 'project.c3proj'), 'utf-8');
    const backup = await runInToolCall(() => writer.updateProject(project => { project.properties.author = 'Journal'; }));
    expect(backup).toBe(join(dir, 'project.c3proj.bak'));
    expect(await readFile(join(dir, 'project.c3proj.bak'), 'utf-8')).toBe(before);
    expect(reader.getProject().properties.author).toBe('Journal');
  });
});

describe('placeholder images', () => {
  const batch = [
    { objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, pluginId: 'Sprite' },
    { objectName: 'Hero', animationName: 'Bad/Name', frameIndex: 0, pluginId: 'Sprite' },
  ];

  it.each([
    ['inside a tool call', (fn: () => Promise<unknown>) => runInToolCall(fn)],
    ['outside a tool call', (fn: () => Promise<unknown>) => fn()],
  ])('a failed batch restores an image it wrote over from its backup, %s', async (_label, run) => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    const first = join(images, getImageFileName('Hero', 'Animation 1', 0, 'Sprite'));
    await writeFile(first, 'old');
    await expect(run(() => writer.writeImageFiles(batch))).rejects.toThrow();
    expect(await readFile(first, 'utf-8')).toBe('old');
  });

  it('names an image the rollback could not put back, with the file that holds the original', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    const first = join(images, getImageFileName('Hero', 'Animation 1', 0, 'Sprite'));
    await writeFile(first, 'old');
    // The batch's first write goes through; the rollback's write of the same image fails
    const internals = writer as unknown as { atomicWrite: (p: string, c: string | Buffer) => Promise<void> };
    const original = internals.atomicWrite.bind(writer);
    let writes = 0;
    vi.spyOn(internals, 'atomicWrite').mockImplementation(async (p, c) => {
      if (fileKey(p) === fileKey(first) && ++writes === 2) throw new Error('disk full');
      return original(p, c);
    });
    const message = await runInToolCall(() => writer.writeImageFiles(batch)).then(() => '', (e: Error) => e.message);
    expect(message).toContain('Invalid image file name');
    expect(message).toContain('images/hero-animation 1-000.png (the original is images/hero-animation 1-000.png.bak)');
    expect(await readFile(first + '.bak', 'utf-8')).toBe('old');
  });

  it('leaves an image saved in the editor after the batch wrote it, and names it', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    const first = join(images, getImageFileName('Hero', 'Animation 1', 0, 'Sprite'));
    await writeFile(first, 'old');
    const original = writer.writeImageFile.bind(writer);
    let calls = 0;
    vi.spyOn(writer, 'writeImageFile').mockImplementation(async (...args) => {
      const path = await original(...args);
      if (++calls === 1) await writeFile(path, 'editor');
      return path;
    });
    // The editor's save lands after the batch's write was confirmed and before the rollback
    const message = await runInToolCall(() => writer.writeImageFiles(batch)).then(() => '', (e: Error) => e.message);
    expect(message).toContain('Invalid image file name');
    expect(message).toContain('images/hero-animation 1-000.png (the original is images/hero-animation 1-000.png.bak)');
    expect(await readFile(first, 'utf-8')).toBe('editor');
    expect(await readFile(first + '.bak', 'utf-8')).toBe('old');
  });
});

describe('image backups never replace a file', () => {
  it('keeps a .bak that appeared between choosing the backup name and copying to it', async () => {
    const images = join(dir, 'images');
    await mkdir(images, { recursive: true });
    const image = join(images, 'hero-animation 1-001.png');
    await writeFile(image, 'frame 2');
    const internals = writer as unknown as { freeBackupPath: (p: string) => Promise<string> };
    const original = internals.freeBackupPath.bind(writer);
    let done = false;
    vi.spyOn(internals, 'freeBackupPath').mockImplementation(async p => {
      const chosen = await original(p);
      if (!done) {
        done = true;
        await writeFile(chosen, 'parked late');
      }
      return chosen;
    });
    expect(await runInToolCall(() => writer.replaceFile(image, 'new'))).toBe(join(images, 'hero-animation 1-001.png.1.bak'));
    expect(await readFile(image + '.bak', 'utf-8')).toBe('parked late');
    expect(await readFile(image + '.1.bak', 'utf-8')).toBe('frame 2');
  });
});
