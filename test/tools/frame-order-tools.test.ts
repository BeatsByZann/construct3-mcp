/**
 * reorder_frames, reverse_frames and duplicate_frame (#ISSUE): the frames of a
 * Sprite animation in a new order, or a frame copied, with their image files
 * renamed or copied so every frame keeps its image, and everything undone
 * when a step fails. Synthetic data on a temp copy of the minimal fixture
 * (Sprite "Sprite", animation "Animation 1"), with the real reader and
 * writer; every image has distinct content, compared by hash.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const ANIMATION = 'Animation 1';
const PREFIX = 'sprite-animation 1-';
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

interface FrameSetup {
  label: string;
  fileType?: string;
  /** File name of its image in images/ (default: the editor's name); null for none */
  file?: string | null;
}

/** The parts of a tool result these tests read. */
interface ToolData {
  warnings?: string[];
  index?: number;
  imageSpriteId?: number;
  [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;
/** Content hash to label of every image a test wrote */
let labels: Map<string, string>;

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const objectPath = () => join(tmpDir, 'objectTypes', 'Sprite.json');
const imagesDir = () => join(tmpDir, 'images');

function register(writer: Construct3ProjectWriter, idGen: IdGenerator): MockServer {
  const mock = new MockServer();
  registerAnimationTools({ server: mock, reader, writer, idGen } as never);
  return mock;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-frame-order-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = register(new Construct3ProjectWriter(reader, idGen), idGen);
  labels = new Map();
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Give "Animation 1" these frames (imageSpriteId 1000 + index) and their images, plus `extra` files (name to label). */
async function setupFrames(frames: FrameSetup[], extra: Record<string, string> = {}): Promise<void> {
  const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
  obj.animations.items[0].frames = frames.map((frame, index) => ({
    width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1, imageSpriteId: 1000 + index,
    ...(frame.fileType !== undefined ? { fileType: frame.fileType } : {}),
  }));
  await writeFile(objectPath(), JSON.stringify(obj, null, '\t'));
  await mkdir(imagesDir(), { recursive: true });
  const files: Record<string, string> = { ...extra };
  frames.forEach((frame, index) => {
    if (frame.file === null) return;
    files[frame.file ?? `${PREFIX}${String(index).padStart(3, '0')}.${EXTENSIONS[frame.fileType ?? 'image/png']}`] = frame.label;
  });
  for (const [file, label] of Object.entries(files)) {
    const content = Buffer.from(`image ${label}`);
    labels.set(sha(content), label);
    await writeFile(join(imagesDir(), file), content);
  }
  reader.invalidateCaches();
}

/** Take the imageSpriteId out of every frame of "Animation 1". */
async function dropImageSpriteIds(): Promise<void> {
  const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
  for (const frame of obj.animations.items[0].frames) delete frame.imageSpriteId;
  await writeFile(objectPath(), JSON.stringify(obj, null, '\t'));
  reader.invalidateCaches();
}

/** images/ as name to label of its content. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of (await readdir(imagesDir())).sort()) {
    const hash = sha(await readFile(join(imagesDir(), file)));
    out[file] = labels.get(hash) ?? `unknown ${hash.slice(0, 12)}`;
  }
  return out;
}

/** Shorthand: "000.png" for "sprite-animation 1-000.png". */
function images(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([file, label]) => [`${PREFIX}${file}`, label]));
}

async function frames(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(objectPath(), 'utf8')).animations.items[0].frames;
}

async function frameIds(): Promise<unknown[]> {
  return (await frames()).map(frame => frame.imageSpriteId);
}

async function ok(tool: string, args: Record<string, unknown>, mock = server): Promise<ToolData> {
  const result = await mock.callTool(tool, { objectName: 'Sprite', animationName: ANIMATION, ...args });
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text) as ToolData;
}

async function refused(tool: string, args: Record<string, unknown>, mock = server): Promise<string> {
  const result = await mock.callTool(tool, { objectName: 'Sprite', animationName: ANIMATION, ...args });
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

/**
 * A refused call that must have changed nothing: the object file's bytes,
 * images/ and the files in objectTypes/ (so no .bak was made) are the same
 * after it. Returns the error text.
 */
async function refusedUnchanged(tool: string, args: Record<string, unknown>, mock = server): Promise<string> {
  const objectBefore = await readFile(objectPath());
  const imagesBefore = await snapshot();
  const objectFilesBefore = (await readdir(join(tmpDir, 'objectTypes'))).sort();
  const text = await refused(tool, args, mock);
  expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
  expect(await snapshot()).toEqual(imagesBefore);
  expect((await readdir(join(tmpDir, 'objectTypes'))).sort()).toEqual(objectFilesBefore);
  return text;
}

/** Add animations to the fixture Sprite that differ from "Animation 1" only in case (they share its image file names). */
async function addCaseVariantAnimations(...names: string[]): Promise<void> {
  const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
  names.forEach((name, i) => obj.animations.items.push({ ...obj.animations.items[0], name, sid: 300000000000009 + i }));
  await writeFile(objectPath(), JSON.stringify(obj, null, '\t'));
  reader.invalidateCaches();
}

/** A server whose writer refuses to write the object file (before replacing it), with `error`. */
function failingObjectWrite(error: () => Error = () => new Error('disk full')): MockServer {
  class FailingObjectWriter extends Construct3ProjectWriter {
    override async writeEntityFile(...args: Parameters<Construct3ProjectWriter['writeEntityFile']>): Promise<string> {
      if (args[0] === 'objectTypes') throw error();
      return super.writeEntityFile(...args);
    }
  }
  const idGen = new IdGenerator();
  return register(new FailingObjectWriter(reader, idGen), idGen);
}

/** An fs error for the object file, whose message holds the absolute path. */
const objectFsError = () => Object.assign(new Error(`EPERM: operation not permitted, open '${objectPath()}'`), { code: 'EPERM', path: objectPath() });

/** A server whose writer replaces the object file, then fails its post-write check. */
function failingObjectVerify(): MockServer {
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<void> };
  internals.verifyWrittenFile = async () => { throw new Error('Post-write verification failed for "Sprite"'); };
  return register(writer, idGen);
}

/** A server whose writer's renameImageFiles fails part way the first time (after renaming files for real). */
function failingRenames(): MockServer {
  class FailingRenameWriter extends Construct3ProjectWriter {
    private failed = false;
    override async renameImageFiles(renames: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
      if (this.failed || renames.length === 0) return super.renameImageFiles(renames);
      this.failed = true;
      return super.renameImageFiles([...renames, { from: 'not-there.png', to: 'nowhere.png' }]);
    }
  }
  const idGen = new IdGenerator();
  return register(new FailingRenameWriter(reader, idGen), idGen);
}

/** A server whose writer lets another write land on the object file right after it replaced it: the file then holds `other(written, before)`. */
function withOtherWrite(other: (written: string, before: string) => string, before: string): MockServer {
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
  const atomicWrite = internals.atomicWrite.bind(writer);
  internals.atomicWrite = async (path, content) => {
    await atomicWrite(path, content);
    if (path.endsWith('Sprite.json')) await writeFile(path, other(String(content), before));
  };
  return register(writer, idGen);
}

/** The JSON `text` with the first animation's speed set to 42 (what the other write changed). */
const withSpeed42 = (text: string) => {
  const obj = JSON.parse(text);
  obj.animations.items[0].speed = 42;
  return JSON.stringify(obj, null, '\t');
};

const ABC: FrameSetup[] = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];

describe('reorder_frames and reverse_frames keep every frame\'s image', () => {
  it('reorder_frames moves each frame\'s image to its new index', async () => {
    await setupFrames(ABC);
    const data = await ok('reorder_frames', { order: [2, 0, 1] });
    expect(await snapshot()).toEqual(images({ '000.png': 'C', '001.png': 'A', '002.png': 'B' }));
    expect(await frameIds()).toEqual([1002, 1000, 1001]);
    expect(data.warnings?.[0]).toContain('Renamed 3 frame image file(s) in images/ to the new index of their frame');
  });

  it('reverse_frames reverses the frames and their images; the middle one stays', async () => {
    await setupFrames(ABC);
    const data = await ok('reverse_frames', {});
    expect(await snapshot()).toEqual(images({ '000.png': 'C', '001.png': 'B', '002.png': 'A' }));
    expect(await frameIds()).toEqual([1002, 1001, 1000]);
    expect(data.warnings?.[0]).toContain('Renamed 2 frame image file(s)');
  });

  it('JPEG and GIF frames keep their extension', async () => {
    await setupFrames([{ label: 'A' }, { label: 'J', fileType: 'image/jpeg' }, { label: 'G', fileType: 'image/gif' }]);
    await ok('reverse_frames', {});
    expect(await snapshot()).toEqual(images({ '000.gif': 'G', '001.jpg': 'J', '002.png': 'A' }));
  });

  it('keeps a file no frame uses at a target name as .bak, and names it', async () => {
    await setupFrames([{ label: 'A' }, { label: 'J', fileType: 'image/jpeg' }], images({ '001.png': 'stale' }));
    const data = await ok('reorder_frames', { order: [1, 0] });
    expect(await snapshot()).toEqual(images({ '000.jpg': 'J', '001.png': 'A', '001.png.bak': 'stale' }));
    expect((data.warnings ?? []).join('\n')).toContain(`images/${PREFIX}001.png to images/${PREFIX}001.png.bak`);
  });

  it('names frames that change index but have no image file', async () => {
    await setupFrames([{ label: 'A' }, { label: 'B', file: null }, { label: 'C' }]);
    const data = await ok('reverse_frames', {});
    expect(await snapshot()).toEqual(images({ '000.png': 'C', '002.png': 'A' }));
    expect((data.warnings ?? []).join('\n')).not.toContain('No image file');
    const rotated = await ok('reorder_frames', { order: [1, 2, 0] });
    expect((rotated.warnings ?? []).join('\n'))
      .toContain(`No image file in images/ for 1 frame(s) of "Animation 1" that changed index (expected "${PREFIX}001.png")`);
  });

  it('refuses an order that does not list every frame once, before writing anything', async () => {
    await setupFrames(ABC);
    expect(await refusedUnchanged('reorder_frames', { order: [0, 1] }))
      .toBe('order must list each of the 3 frame(s) of "Animation 1" once, by its index before the call (0 to 2); it lists 2. Nothing was changed.');
    expect(await refusedUnchanged('reorder_frames', { order: [0, 1, 3] }))
      .toBe('order names frame index 3, but "Animation 1" has 3 frame(s) (0 to 2). Nothing was changed.');
    expect(await refusedUnchanged('reorder_frames', { order: [0, 0, 1] }))
      .toBe('order names frame index 0 twice; it must list each frame index once. Nothing was changed.');
  });

  it('refuses an order that leaves every frame where it is', async () => {
    await setupFrames(ABC);
    expect(await refusedUnchanged('reorder_frames', { order: [0, 1, 2] }))
      .toBe('The order leaves every frame of "Animation 1" at its index. Nothing was changed.');
  });

  it('refuses to reverse an animation with one frame, saying it has one frame', async () => {
    await setupFrames([{ label: 'A' }]);
    expect(await refusedUnchanged('reverse_frames', {}))
      .toBe('Animation "Animation 1" has one frame, so reversing it changes nothing. Nothing was changed.');
  });

  it('refuses an animation with no frames, or with a frames list that is not a list, as one tool error', async () => {
    await setupFrames([]);
    const empty = 'Animation "Animation 1" on "Sprite" has no frames. Nothing was changed.';
    expect(await refusedUnchanged('reorder_frames', { order: [0] })).toBe(empty);
    expect(await refusedUnchanged('reverse_frames', {})).toBe(empty);
    expect(await refusedUnchanged('duplicate_frame', { frameIndex: 0 })).toBe(empty);
    const obj = JSON.parse(await readFile(objectPath(), 'utf8'));
    obj.animations.items[0].frames = 'not a list';
    await writeFile(objectPath(), JSON.stringify(obj, null, '\t'));
    reader.invalidateCaches();
    const malformed = 'Animation "Animation 1" on "Sprite" has no frames list in its object file. Nothing was changed.';
    expect(await refusedUnchanged('reorder_frames', { order: [0] })).toBe(malformed);
    expect(await refusedUnchanged('reverse_frames', {})).toBe(malformed);
    expect(await refusedUnchanged('duplicate_frame', { frameIndex: 0 })).toBe(malformed);
  });

  it('refuses while another animation shares the image files', async () => {
    await setupFrames(ABC);
    await addCaseVariantAnimations('ANIMATION 1');
    expect(await refusedUnchanged('reverse_frames', {}))
      .toBe('Cannot reorder the frames of "Animation 1" on "Sprite": animation "ANIMATION 1" differs from it only in case, so both use the '
        + 'same frame image files, and changing them would give that animation other images. Nothing was changed. Delete the other animation first.');
  });

  it('says "animations" and "those" when several animations share the image files', async () => {
    await setupFrames(ABC);
    await addCaseVariantAnimations('ANIMATION 1', 'animation 1');
    expect(await refusedUnchanged('reverse_frames', {}))
      .toBe('Cannot reorder the frames of "Animation 1" on "Sprite": animations "ANIMATION 1", "animation 1" differ from it only in case, so all '
        + 'use the same frame image files, and changing them would give those animations other images. Nothing was changed. Delete the other animations first.');
  });

  it('refuses when the image file renames cannot be planned without replacing a file, and changes nothing', async () => {
    await setupFrames(ABC);
    // The listing reports a file that differs from frame 0's image only in case (as a case-sensitive file system would): both would get one name
    class CaseVariantListing extends Construct3ProjectWriter {
      override async listImageFiles(): Promise<string[]> {
        return [...await super.listImageFiles(), `${PREFIX.toUpperCase()}000.png`];
      }
    }
    const idGen = new IdGenerator();
    const text = await refusedUnchanged('reverse_frames', {}, register(new CaseVariantListing(reader, idGen), idGen));
    expect(text).toBe(`Cannot reorder the frames of "Animation 1" on "Sprite": the frame image files cannot be renamed to their new indexes `
      + `("images/${PREFIX}000.png and images/${PREFIX.toUpperCase()}000.png would both be renamed to images/${PREFIX}002.png"). `
      + 'Nothing was changed. Check these files in images/.');
  });
});

describe('reorder_frames undoes everything when a step fails', () => {
  let objectBefore: Buffer;
  let imagesBefore: Record<string, string>;

  beforeEach(async () => {
    await setupFrames([{ label: 'A' }, { label: 'J', fileType: 'image/jpeg' }, { label: 'G', fileType: 'image/gif' }, { label: 'D' }]);
    objectBefore = await readFile(objectPath());
    imagesBefore = await snapshot();
  });

  async function expectUnchanged(): Promise<void> {
    expect(await snapshot()).toEqual(imagesBefore);
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
  }

  it('a failed object write renames the image files back', async () => {
    expect(await refused('reorder_frames', { order: [3, 2, 1, 0] }, failingObjectWrite()))
      .toBe('Error reordering frames: disk full. Nothing was changed: the image files have their old names again.');
    await expectUnchanged();
  });

  it('an fs error of the object write is named by its code and project-relative path', async () => {
    const text = await refused('reorder_frames', { order: [3, 2, 1, 0] }, failingObjectWrite(objectFsError));
    expect(text).toBe('Error reordering frames: EPERM on objectTypes/Sprite.json. Nothing was changed: the image files have their old names again.');
    expect(text).not.toContain(tmpDir);
    await expectUnchanged();
  });

  it('an object write that failed after replacing the file restores it too, and says its .bak stays', async () => {
    expect(await refused('reorder_frames', { order: [3, 2, 1, 0] }, failingObjectVerify()))
      .toContain('The change was rolled back: the image files have their old names again and objectTypes/Sprite.json was restored from its backup (its .bak stays).');
    await expectUnchanged();
    expect(await readdir(join(tmpDir, 'objectTypes'))).toContain('Sprite.json.bak');
  });

  it('renames a swap back through its temporary name when the first rename back fails for a moment', async () => {
    // The object write fails, then the first attempt to rename the files back fails before renaming anything
    class FlakyWriter extends Construct3ProjectWriter {
      private calls = 0;
      override async writeEntityFile(...args: Parameters<Construct3ProjectWriter['writeEntityFile']>): Promise<string> {
        if (args[0] === 'objectTypes') throw new Error('disk full');
        return super.writeEntityFile(...args);
      }
      override async renameImageFiles(renames: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
        if (++this.calls === 2) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        return super.renameImageFiles(renames);
      }
    }
    const idGen = new IdGenerator();
    // Frames 0 and 3 are PNG, so swapping them goes through 003.png.reorder
    expect(await refused('reorder_frames', { order: [3, 1, 2, 0] }, register(new FlakyWriter(reader, idGen), idGen)))
      .toBe('Error reordering frames: disk full. Nothing was changed: the image files have their old names again.');
    await expectUnchanged();
  });

  it('keeps the images, and says recovery is unresolved, when another write kept the order but changed a frame\'s fileType', async () => {
    const toJpeg = (written: string) => {
      const obj = JSON.parse(written);
      obj.animations.items[0].frames[0].fileType = 'image/jpeg';
      return JSON.stringify(obj, null, '\t');
    };
    const text = await refused('reorder_frames', { order: [3, 2, 1, 0] }, withOtherWrite(written => toJpeg(written), objectBefore.toString('utf8')));
    expect(text).toContain('objectTypes/Sprite.json holds neither the frames from before the call nor this call\'s, so the image files were left as this call left them');
    expect(text).toContain('Recovery is unresolved');
    expect(await snapshot()).toEqual(images({ '000.png': 'D', '001.gif': 'G', '002.jpg': 'J', '003.png': 'A' }));
  });

  it('a failed rename renames the files back and writes nothing', async () => {
    expect(await refused('reorder_frames', { order: [1, 0, 3, 2] }, failingRenames())).toContain('The files renamed before were renamed back.');
    await expectUnchanged();
  });

  it('a write made on top of the new order is kept, with the images moved', async () => {
    const data = await ok('reorder_frames', { order: [3, 2, 1, 0] }, withOtherWrite(written => withSpeed42(written), objectBefore.toString('utf8')));
    expect((data.warnings ?? []).join('\n')).toContain('The file still has the new frame order');
    expect(await frameIds()).toEqual([1003, 1002, 1001, 1000]);
    expect(await snapshot()).toEqual(images({ '000.png': 'D', '001.gif': 'G', '002.jpg': 'J', '003.png': 'A' }));
  });

  it('a write made on top of the new order is kept also when the frames have no imageSpriteId (compared by content)', async () => {
    await dropImageSpriteIds();
    const before = await readFile(objectPath(), 'utf8');
    const data = await ok('reorder_frames', { order: [3, 2, 1, 0] }, withOtherWrite(written => withSpeed42(written), before));
    expect((data.warnings ?? []).join('\n')).toContain('The file still has the new frame order');
    expect(await snapshot()).toEqual(images({ '000.png': 'D', '001.gif': 'G', '002.jpg': 'J', '003.png': 'A' }));
  });

  it('a write made on the old content is kept, and the image files are renamed back to match it', async () => {
    const before = objectBefore.toString('utf8');
    expect(await refused('reorder_frames', { order: [3, 2, 1, 0] }, withOtherWrite((_written, old) => withSpeed42(old), before)))
      .toContain('the object file was left as that write left it. Nothing was changed: the image files have their old names again.');
    expect(await snapshot()).toEqual(imagesBefore);
    expect(await readFile(objectPath(), 'utf8')).toBe(withSpeed42(before));
  });
});

/** A server whose writer fails the `nth` image write through replaceFile with `error` (the writes before go through). */
function failingImageWrite(nth: number, error: (path: string) => Error): MockServer {
  class FailingImageWriter extends Construct3ProjectWriter {
    private images = 0;
    override async replaceFile(...args: Parameters<Construct3ProjectWriter['replaceFile']>): Promise<string | undefined> {
      if (args[0].startsWith(imagesDir()) && ++this.images === nth) throw error(args[0]);
      return super.replaceFile(...args);
    }
  }
  const idGen = new IdGenerator();
  return register(new FailingImageWriter(reader, idGen), idGen);
}

describe('duplicate_frame copies a frame with its image', () => {
  it('inserts the copy right after the frame by default, with its image and a new imageSpriteId', async () => {
    await setupFrames(ABC);
    const data = await ok('duplicate_frame', { frameIndex: 0 });
    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.png': 'A', '002.png': 'B', '003.png': 'C' }));
    const ids = await frameIds();
    expect([ids[0], ids[2], ids[3]]).toEqual([1000, 1001, 1002]);
    expect(typeof ids[1]).toBe('number');
    expect([1000, 1001, 1002]).not.toContain(ids[1]);
    expect(data.index).toBe(1);
    expect(data.imageSpriteId).toBe(ids[1]);
    const all = await frames();
    expect(all[1]).toEqual({ ...all[0], imageSpriteId: ids[1] });
  });

  it('copies a frame that moved up from its new name', async () => {
    await setupFrames(ABC);
    await ok('duplicate_frame', { frameIndex: 2, index: 0 });
    expect(await snapshot()).toEqual(images({ '000.png': 'C', '001.png': 'A', '002.png': 'B', '003.png': 'C' }));
    expect((await frameIds()).slice(1)).toEqual([1000, 1001, 1002]);
  });

  it('a JPEG frame\'s copy keeps the extension and the fileType', async () => {
    await setupFrames([{ label: 'A' }, { label: 'J', fileType: 'image/jpeg' }]);
    await ok('duplicate_frame', { frameIndex: 1 });
    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.jpg': 'J', '002.jpg': 'J' }));
    expect((await frames())[2].fileType).toBe('image/jpeg');
  });

  it('copies a frame without an image file, and says the copy has none', async () => {
    await setupFrames([{ label: 'A' }, { label: 'B', file: null }]);
    const data = await ok('duplicate_frame', { frameIndex: 1 });
    expect(await snapshot()).toEqual(images({ '000.png': 'A' }));
    expect(data.warnings).toContain(`Frame 1 has no image file in images/ (expected images/${PREFIX}001.png), so the copy has none either.`);
  });

  it('keeps an unused file at the copy\'s name as .bak, so a copy without an image does not take it', async () => {
    await setupFrames([{ label: 'A', file: null }], images({ '001.png': 'orphan' }));
    await ok('duplicate_frame', { frameIndex: 0 });
    expect(await snapshot()).toEqual(images({ '001.png.bak': 'orphan' }));
  });

  it('refuses while another animation shares the image files, and changes nothing', async () => {
    await setupFrames(ABC);
    await addCaseVariantAnimations('ANIMATION 1');
    expect(await refusedUnchanged('duplicate_frame', { frameIndex: 0 }))
      .toBe('Cannot copy a frame of "Animation 1" on "Sprite": animation "ANIMATION 1" differs from it only in case, so both use the '
        + 'same frame image files, and changing them would give that animation other images. Nothing was changed. Delete the other animation first.');
  });

  it('refuses a frame or an index out of range before writing anything', async () => {
    await setupFrames(ABC);
    expect(await refusedUnchanged('duplicate_frame', { frameIndex: 3 }))
      .toBe('Frame index 3 is out of range. Animation "Animation 1" has 3 frame(s). Nothing was changed.');
    expect(await refusedUnchanged('duplicate_frame', { frameIndex: 0, index: 4 }))
      .toBe('Index 4 is out of range: insert the copy at an index from 0 to 3, or leave index out to insert it right after frame 0. Nothing was changed.');
  });
});

describe('duplicate_frame undoes everything when a step fails', () => {
  let objectBefore: Buffer;
  let imagesBefore: Record<string, string>;

  beforeEach(async () => {
    await setupFrames(ABC);
    objectBefore = await readFile(objectPath());
    imagesBefore = await snapshot();
  });

  async function expectUnchanged(): Promise<void> {
    expect(await snapshot()).toEqual(imagesBefore);
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
  }

  it('a failed object write removes the copy and renames the image files back', async () => {
    expect(await refused('duplicate_frame', { frameIndex: 0, index: 0 }, failingObjectWrite()))
      .toBe('Error duplicating frame: disk full. Nothing was changed: the image files have their old names again and the copied frame image was removed.');
    await expectUnchanged();
  });

  it('an object write that failed after replacing the file restores it too, and says its .bak stays', async () => {
    expect(await refused('duplicate_frame', { frameIndex: 0, index: 0 }, failingObjectVerify()))
      .toContain('The change was rolled back: the image files have their old names again, the copied frame image was removed and '
        + 'objectTypes/Sprite.json was restored from its backup (its .bak stays).');
    await expectUnchanged();
    expect(await readdir(join(tmpDir, 'objectTypes'))).toContain('Sprite.json.bak');
  });

  it('keeps the images, and says recovery is unresolved, when another write left neither frame list (frames without imageSpriteId)', async () => {
    // Compared by content: the other write restored the old frames and added an unrelated one, so the frame count matches the copy's
    await dropImageSpriteIds();
    const before = await readFile(objectPath(), 'utf8');
    const withUnrelatedFrame = (_written: string, old: string) => {
      const obj = JSON.parse(old);
      obj.animations.items[0].frames.push({ width: 8, height: 8, originX: 0, originY: 0, duration: 1 });
      return JSON.stringify(obj, null, '\t');
    };
    const text = await refused('duplicate_frame', { frameIndex: 0 }, withOtherWrite(withUnrelatedFrame, before));
    expect(text).toContain('holds neither the frames from before the call nor this call\'s');
    expect(text).toContain('Recovery is unresolved');
    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.png': 'A', '002.png': 'B', '003.png': 'C' }));
  });

  it('a failed rename renames the files back and writes nothing', async () => {
    expect(await refused('duplicate_frame', { frameIndex: 0, index: 0 }, failingRenames())).toContain('The files renamed before were renamed back.');
    await expectUnchanged();
  });

  it('a copy write that fails with an fs error is named by its code and project-relative path', async () => {
    const text = await refused('duplicate_frame', { frameIndex: 0 },
      failingImageWrite(1, path => Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES', path })));
    expect(text).toBe(`Error duplicating frame: EACCES on images/${PREFIX}001.png. Nothing was changed: the image files have their old names again.`);
    expect(text).not.toContain(tmpDir);
    await expectUnchanged();
  });

  it('a copy whose write was not confirmed is left as it is and named, never removed', async () => {
    // Another write lands on the copy's name right after the copy was written, so the write is not confirmed
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    const other = Buffer.from('image OTHER');
    labels.set(sha(other), 'OTHER');
    internals.atomicWrite = async (path, content) => {
      await atomicWrite(path, content);
      if (path.endsWith(`${PREFIX}001.png`)) await writeFile(path, other);
    };
    const text = await refused('duplicate_frame', { frameIndex: 0 }, register(writer, idGen));
    expect(text).toContain(`images/${PREFIX}001.png (it is not known to hold what this call wrote, or it changed on disk after this call wrote it, `
      + 'so it was left as it is)');
    expect((await snapshot())[`${PREFIX}001.png`]).toBe('OTHER');
    expect(Buffer.compare(await readFile(objectPath()), objectBefore)).toBe(0);
  });

  it('a write made on top of the copy is kept, with its image', async () => {
    const data = await ok('duplicate_frame', { frameIndex: 0 }, withOtherWrite(written => withSpeed42(written), objectBefore.toString('utf8')));
    expect((data.warnings ?? []).join('\n')).toContain('The file still has the copied frame');
    expect(await snapshot()).toEqual(images({ '000.png': 'A', '001.png': 'A', '002.png': 'B', '003.png': 'C' }));
  });

  it('a write made on the old content is kept, and the copy and the renames are undone to match it', async () => {
    const before = objectBefore.toString('utf8');
    expect(await refused('duplicate_frame', { frameIndex: 0 }, withOtherWrite((_written, old) => withSpeed42(old), before)))
      .toContain('the object file was left as that write left it. Nothing was changed: the image files have their old names again and the copied frame image was removed.');
    expect(await snapshot()).toEqual(imagesBefore);
    expect(await readFile(objectPath(), 'utf8')).toBe(withSpeed42(before));
  });
});

describe('duplicate_frame with a frame that has two image files', () => {
  it('removes the first copy when the second one fails', async () => {
    // A frame of another fileType: every file with its name and a single extension is its image
    await setupFrames([{ label: 'A' }, { label: 'W', fileType: 'image/webp', file: `${PREFIX}001.webp` }], images({ '001.gif': 'W2' }));
    const before = await snapshot();
    const text = await refused('duplicate_frame', { frameIndex: 1 },
      failingImageWrite(2, () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })));
    expect(text).toBe('Error duplicating frame: ENOSPC: no space left on device, write. Nothing was changed: the copied frame image was removed.');
    expect(await snapshot()).toEqual(before);
  });
});
