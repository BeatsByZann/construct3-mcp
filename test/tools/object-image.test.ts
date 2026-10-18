/**
 * replace_object_image (#ISSUE): the single image of an object type that has
 * one image instead of animations, replaced with real PNG data through the
 * writer, the image record following as replace_sprite_image's frames do,
 * and the image put back after a failed object write only when the object
 * file still has the image record from before the call. Synthetic data on a
 * temp copy of the minimal fixture, with the real reader and writer (the
 * 9-patch object is synthetic; how the editor stores a 9-patch's image was
 * not checked).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { generatePlaceholderPng } from '../../src/construct3/png-generator.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const PNG = generatePlaceholderPng(4, 2);
const PLACEHOLDER = generatePlaceholderPng(1, 1);
const SIZE = { width: 4, height: 2 };

/** The parts of a tool result these tests read. */
interface ToolData {
  imageFile?: string;
  imageBackup?: string;
  backupFile?: string;
  warnings?: string[];
  [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;

const objectPath = (name: string) => join(tmpDir, 'objectTypes', `${name}.json`);
const imagePath = (name: string) => join(tmpDir, 'images', name);
const imageOf = async (name: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(objectPath(name), 'utf8')).image;

function register(writer: Construct3ProjectWriter, idGen: IdGenerator): MockServer {
  const mock = new MockServer();
  registerAnimationTools({ server: mock, reader, writer, idGen } as never);
  registerObjectTools({ server: mock, reader, writer, idGen } as never);
  return mock;
}

async function replace(objectName: string, extra: Record<string, unknown> = {}, mock = server, png = PNG): Promise<{ isError?: boolean; text: string; data?: ToolData }> {
  const result = await mock.callTool('replace_object_image', { objectName, pngBase64: png.toString('base64'), ...extra });
  return result.isError
    ? { isError: true, text: result.content[0].text }
    : { text: result.content[0].text, data: JSON.parse(result.content[0].text) as ToolData };
}

/** An object type with a single image (synthetic), registered, and optionally its image file. */
async function addSingleImageObject(name: string, pluginId: string, image: Record<string, unknown>, file?: [string, Buffer]): Promise<void> {
  await writeFile(objectPath(name), JSON.stringify({
    name, 'plugin-id': pluginId, sid: 200000000000050 + name.length, isGlobal: false,
    instanceVariables: [], behaviorTypes: [], effectTypes: [], image,
  }, null, '\t'));
  const project = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf8'));
  project.objectTypes.items.push(name);
  await writeFile(join(tmpDir, 'project.c3proj'), JSON.stringify(project, null, '\t'));
  if (file) {
    await mkdir(join(tmpDir, 'images'), { recursive: true });
    await writeFile(imagePath(file[0]), file[1]);
  }
  await reader.loadProject();
}

/** A server whose writer refuses to write the object file (before replacing it), after running `before`, with `error`. */
function failingObjectWrite(before: () => Promise<void> = async () => {}, error: () => Error = () => new Error('disk full')): MockServer {
  class FailingObjectWriter extends Construct3ProjectWriter {
    override async writeEntityFile(...args: Parameters<Construct3ProjectWriter['writeEntityFile']>): Promise<string> {
      if (args[0] === 'objectTypes') {
        await before();
        throw error();
      }
      return super.writeEntityFile(...args);
    }
  }
  const idGen = new IdGenerator();
  return register(new FailingObjectWriter(reader, idGen), idGen);
}

/** A server whose writer counts the object files it writes, and the count. */
function countingObjectWrites(): { mock: MockServer; count: () => number } {
  let writes = 0;
  class CountingWriter extends Construct3ProjectWriter {
    override async writeEntityFile(...args: Parameters<Construct3ProjectWriter['writeEntityFile']>): Promise<string> {
      if (args[0] === 'objectTypes') writes++;
      return super.writeEntityFile(...args);
    }
  }
  const idGen = new IdGenerator();
  return { mock: register(new CountingWriter(reader, idGen), idGen), count: () => writes };
}

/** A server whose writer saves Bg.json as `edit` gives it right before writing it, as the editor would: the write is refused as stale. */
function staleObjectWrite(edit: (text: string) => string): MockServer {
  class StaleObjectWriter extends Construct3ProjectWriter {
    override async writeEntityFile(...args: Parameters<Construct3ProjectWriter['writeEntityFile']>): Promise<string> {
      if (args[0] === 'objectTypes') await writeFile(objectPath('Bg'), edit(await readFile(objectPath('Bg'), 'utf8')));
      return super.writeEntityFile(...args);
    }
  }
  const idGen = new IdGenerator();
  return register(new StaleObjectWriter(reader, idGen), idGen);
}

/** A server whose writer lets another write land on Bg.json right after it replaced it: the file then holds `other(written, before)`. */
function withOtherObjectWrite(other: (written: string, before: string) => string, before: string): MockServer {
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
  const atomicWrite = internals.atomicWrite.bind(writer);
  internals.atomicWrite = async (path, content) => {
    await atomicWrite(path, content);
    if (path.endsWith('Bg.json')) await writeFile(path, other(String(content), before));
  };
  return register(writer, idGen);
}

/** The JSON `text` with isGlobal set (what the other write changed). */
const withGlobal = (text: string) => JSON.stringify({ ...JSON.parse(text), isGlobal: true }, null, '\t');
/** The JSON `text` with the image stored as JPEG (what the other write changed). */
const withJpeg = (text: string) => {
  const obj = JSON.parse(text);
  obj.image.fileType = 'image/jpeg';
  return JSON.stringify(obj, null, '\t');
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-object-image-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = register(new Construct3ProjectWriter(reader, idGen), idGen);
  resetProjectIndex();
  const created = await server.callTool('create_object', { name: 'Bg', pluginId: 'TiledBg' });
  expect(created.isError, created.content[0].text).toBeUndefined();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('replace_object_image', () => {
  it('writes the PNG over a Tiled Background\'s image, keeps the old one as .bak, and keeps the record when nothing in it changes', async () => {
    const recordBefore = await imageOf('Bg');
    const { data } = await replace('Bg');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PNG)).toBe(0);
    expect(Buffer.compare(await readFile(imagePath('bg.png.bak')), PLACEHOLDER)).toBe(0);
    expect(await imageOf('Bg')).toEqual(recordBefore);
    expect(data).toMatchObject({ success: true, imageFile: 'images/bg.png', imageBackup: 'images/bg.png.bak' });
    expect(typeof data?.backupFile).toBe('string');
  });

  it('writes the object file even when its record did not change, so its stale-file check runs', async () => {
    const { mock, count } = countingObjectWrites();
    const { data } = await replace('Bg', {}, mock);
    expect(count()).toBe(1);
    expect(await readdir(join(tmpDir, 'objectTypes'))).toContain('Bg.json.bak');
    expect(data?.backupFile).toMatch(/Bg\.json\.bak$/);
  });

  it('sets the image record\'s width and height only when they are given', async () => {
    await replace('Bg', SIZE);
    expect(await imageOf('Bg')).toMatchObject({ width: 4, height: 2, fileType: 'image/png' });
  });

  it('switches a JPEG image to PNG, leaves the old file, and says so', async () => {
    await addSingleImageObject('Panel', 'NinePatch', { width: 32, height: 32, originX: 0.5, originY: 0.5, fileType: 'image/jpeg', imageSpriteId: 5000 },
      ['panel.jpg', Buffer.from('image JPEG')]);
    const { data } = await replace('Panel');
    expect(Buffer.compare(await readFile(imagePath('panel.png')), PNG)).toBe(0);
    expect(await readFile(imagePath('panel.jpg'), 'utf8')).toBe('image JPEG');
    expect(await imageOf('Panel')).toMatchObject({ width: 32, height: 32, fileType: 'image/png', imageSpriteId: 5000 });
    expect(data?.warnings).toContain('The object type stored its image as images/panel.jpg ("image/jpeg"). Its fileType is now "image/png" '
      + 'and its image images/panel.png; the old file was left in images/.');
  });

  it('names the image after the object\'s name as stored in its file, also for another path to the file', async () => {
    // "./Bg" reaches objectTypes/Bg.json too; the file name comes from the name stored there
    const { data } = await replace('./Bg');
    expect(data?.imageFile).toBe('images/bg.png');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PNG)).toBe(0);
  });

  it('refuses a Sprite, an object without a single image and data that is not a PNG, and changes nothing', async () => {
    const bgBefore = await readFile(objectPath('Bg'));
    expect((await replace('Sprite')).text).toBe('Object "Sprite" has animations, and its images belong to their frames: use replace_sprite_image. Nothing was changed.');
    expect((await server.callTool('create_object', { name: 'Label', pluginId: 'Text' })).isError).toBeUndefined();
    expect((await replace('Label')).text).toBe('Object "Label" (Text) has no single image. Nothing was changed.');
    expect((await replace('Bg', {}, server, Buffer.from('not a png at all, really not'))).text)
      .toBe('Decoded data does not appear to be a valid PNG (invalid header). Nothing was changed.');
    expect(Buffer.compare(await readFile(objectPath('Bg')), bgBefore)).toBe(0);
    expect(await readdir(join(tmpDir, 'images'))).toEqual(['bg.png']);
    expect(await readdir(join(tmpDir, 'objectTypes'))).not.toContain('Bg.json.bak');
  });
});

describe('replace_object_image when a write fails', () => {
  it('puts the image back from its .bak when the object write fails', async () => {
    const bgBefore = await readFile(objectPath('Bg'));
    expect((await replace('Bg', SIZE, failingObjectWrite())).text)
      .toBe('Error replacing object image: disk full. The change was rolled back: images/bg.png has its image from before the call '
        + 'again (images/bg.png.bak holds it too).');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PLACEHOLDER)).toBe(0);
    expect(Buffer.compare(await readFile(objectPath('Bg')), bgBefore)).toBe(0);
  });

  it('restores both when the object write failed after replacing the file, and says the .bak stays', async () => {
    const bgBefore = await readFile(objectPath('Bg'));
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<void> };
    internals.verifyWrittenFile = async () => { throw new Error('Post-write verification failed for "Bg"'); };
    expect((await replace('Bg', SIZE, register(writer, idGen))).text)
      .toBe('Error replacing object image: Post-write verification failed for "Bg". The change was rolled back: images/bg.png has its image '
        + 'from before the call again (images/bg.png.bak holds it too); objectTypes/Bg.json was restored from its backup (its .bak stays).');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PLACEHOLDER)).toBe(0);
    expect(Buffer.compare(await readFile(objectPath('Bg')), bgBefore)).toBe(0);
  });

  it('leaves an image saved again after the call wrote it, without calling either file the old image', async () => {
    const saved = Buffer.from('image EDITOR');
    const text = (await replace('Bg', SIZE, failingObjectWrite(() => writeFile(imagePath('bg.png'), saved)))).text;
    expect(text).toBe('Error replacing object image: disk full. The change was not rolled back: images/bg.png was left as it is: it, '
      + 'or the file this call kept as images/bg.png.bak, changed on disk after this call wrote it, so neither is known to hold the image '
      + 'from before the call. Check the project before you run the tool again.');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), saved)).toBe(0);
  });

  it('leaves the image when the backup changed on disk before the rollback, and does not call the backup the old image', async () => {
    const text = (await replace('Bg', SIZE, failingObjectWrite(() => writeFile(imagePath('bg.png.bak'), 'image ELSE')))).text;
    expect(text).toContain('The change was not rolled back: images/bg.png was left as it is');
    expect(text).toContain('so neither is known to hold the image from before the call');
    expect(text).not.toContain('has its image from before the call again');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PNG)).toBe(0);
    expect(await readFile(imagePath('bg.png.bak'), 'utf8')).toBe('image ELSE');
  });

  it('removes a new image when the object type had no image file', async () => {
    await addSingleImageObject('Panel', 'NinePatch', { width: 32, height: 32, originX: 0.5, originY: 0.5, fileType: 'image/png' });
    expect((await replace('Panel', SIZE, failingObjectWrite())).text)
      .toBe('Error replacing object image: disk full. The change was rolled back: images/panel.png was removed (it did not exist before the call).');
    expect(await readdir(join(tmpDir, 'images'))).not.toContain('panel.png');
  });

  it('puts the image back when an editor save made the object write stale but kept the image record', async () => {
    const text = (await replace('Bg', {}, staleObjectWrite(withGlobal))).text;
    expect(text).toContain('was changed on disk after this server read it');
    expect(text).toContain('images/bg.png has its image from before the call again');
    expect(JSON.parse(await readFile(objectPath('Bg'), 'utf8')).isGlobal).toBe(true);
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PLACEHOLDER)).toBe(0);
  });

  it('keeps the image, and says recovery is unresolved, when an editor save switched the image record to JPEG (no size given)', async () => {
    const text = (await replace('Bg', {}, staleObjectWrite(withJpeg))).text;
    expect(text).toContain('was changed on disk after this server read it');
    expect(text).toContain('objectTypes/Bg.json holds neither the image record from before the call nor this call\'s, so the new image stays');
    expect(text).toContain('Recovery is unresolved');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PNG)).toBe(0);
    expect((await imageOf('Bg')).fileType).toBe('image/jpeg');
  });

  it('keeps the image, and says recovery is unresolved, when the object file cannot be read again after the failure', async () => {
    const text = (await replace('Bg', SIZE, failingObjectWrite(() => writeFile(objectPath('Bg'), '{ not json')))).text;
    expect(text).toContain('objectTypes/Bg.json could not be read again to tell which image record it holds, so the new image stays');
    expect(text).toContain('Recovery is unresolved');
    expect(text).not.toContain('has its image from before the call again');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PNG)).toBe(0);
  });

  it('keeps the image when the object file holds this call\'s image record after the failure, with no other write involved', async () => {
    const withNewRecord = async () => {
      const obj = JSON.parse(await readFile(objectPath('Bg'), 'utf8'));
      obj.image.width = 4;
      obj.image.height = 2;
      await writeFile(objectPath('Bg'), JSON.stringify(obj, null, '\t'));
    };
    const text = (await replace('Bg', SIZE, failingObjectWrite(withNewRecord))).text;
    expect(text).toContain('objectTypes/Bg.json holds this call\'s image record, so the new image stays');
    expect(text).not.toContain('has its image from before the call again');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PNG)).toBe(0);
  });

  it('keeps the image, and says the object file was not restored, when the restore was refused and the file holds this call\'s image record', async () => {
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<void> };
    internals.verifyWrittenFile = async (path, _name, written) => {
      await writeFile(path, withGlobal(written));
      throw new Error('Post-write verification failed for "Bg"');
    };
    const text = (await replace('Bg', SIZE, register(writer, idGen))).text;
    expect(text).toContain('The object file was not restored: objectTypes/Bg.json (another write changed it after this call\'s write failed; it was left as it is)');
    expect(text).toContain('objectTypes/Bg.json holds this call\'s image record, so the new image stays');
    expect(text).not.toContain('has its image from before the call again');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PNG)).toBe(0);
    expect(JSON.parse(await readFile(objectPath('Bg'), 'utf8')).isGlobal).toBe(true);
  });

  it('keeps the image when another write made on top of this one kept the new image record', async () => {
    const before = await readFile(objectPath('Bg'), 'utf8');
    const { data } = await replace('Bg', SIZE, withOtherObjectWrite(written => withGlobal(written), before));
    expect(data?.warnings).toContain('Another write changed the object file right after this one (a tool call running in parallel?). The file '
      + 'still has the new image record, so the new image stays, but the other write may have been made on older content: re-read the object to check it.');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PNG)).toBe(0);
    expect(await imageOf('Bg')).toMatchObject({ width: 4, height: 2 });
  });

  it('keeps the image, and says recovery is unresolved, when another write kept the new width but changed the format', async () => {
    const before = await readFile(objectPath('Bg'), 'utf8');
    const text = (await replace('Bg', SIZE, withOtherObjectWrite(written => withJpeg(written), before))).text;
    expect(text).toContain('holds neither the image record from before the call nor this call\'s, so the new image stays');
    expect(text).toContain('Recovery is unresolved');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PNG)).toBe(0);
  });

  it('puts the image back when another write replaced the object file without this call\'s change', async () => {
    const before = await readFile(objectPath('Bg'), 'utf8');
    const text = (await replace('Bg', SIZE, withOtherObjectWrite((_written, old) => withGlobal(old), before))).text;
    expect(text).toContain('Another write replaced the object file during this one (a tool call running in parallel?) without this call\'s change; '
      + 'the object file was left as that write left it. The change was rolled back: images/bg.png has its image from before the call again');
    expect(Buffer.compare(await readFile(imagePath('bg.png')), PLACEHOLDER)).toBe(0);
    expect(await readFile(objectPath('Bg'), 'utf8')).toBe(withGlobal(before));
  });

  it('names the .bak when the image write could not be confirmed', async () => {
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    internals.atomicWrite = async (path, content) => {
      await atomicWrite(path, content);
      if (path.endsWith('bg.png')) await writeFile(path, 'image EDITOR');
    };
    const text = (await replace('Bg', SIZE, register(writer, idGen))).text;
    expect(text).toContain('does not hold what this call wrote');
    expect(text).toContain('The object file was not written. The file this call kept before writing the image is images/bg.png.bak.');
  });

  it('names an fs error of the image write by its code and project-relative path', async () => {
    class FsErrorWriter extends Construct3ProjectWriter {
      override async replaceFile(...args: Parameters<Construct3ProjectWriter['replaceFile']>): Promise<string | undefined> {
        throw Object.assign(new Error(`EACCES: permission denied, open '${args[0]}'`), { code: 'EACCES', path: args[0] });
      }
    }
    const idGen = new IdGenerator();
    const text = (await replace('Bg', SIZE, register(new FsErrorWriter(reader, idGen), idGen))).text;
    expect(text).toBe('Error replacing object image: EACCES on images/bg.png. The object file was not written.');
    expect(text).not.toContain(tmpDir);
  });
});
