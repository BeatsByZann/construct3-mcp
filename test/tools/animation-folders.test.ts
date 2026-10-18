/**
 * create_animation_folder and move_animation_to_folder (#ISSUE): animation
 * folders among a Sprite's animations, created and filled through the
 * writer, with no image file changed (the folder is not part of the frame
 * image file names), and a failed object write rolled back. Synthetic data
 * on a temp copy of the minimal fixture (Sprite "Sprite" with "Animation 1"),
 * with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface Folder { name?: unknown; items: Array<{ name: string }>; subfolders: Folder[] }

/** The parts of a tool result these tests read. */
interface ToolData {
  foldersCreated?: string[];
  fromFolder?: string | null;
  toFolder?: string | null;
  warnings?: string[];
  [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;

const objectPath = () => join(tmpDir, 'objectTypes', 'Sprite.json');
const animations = async (): Promise<Folder> => JSON.parse(await readFile(objectPath(), 'utf8')).animations;
/** Every animation by its place: "" for the top level, else the folder path. */
async function layout(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const walk = (folder: Folder, path: string) => {
    out[path] = folder.items.map(a => a.name);
    for (const sub of folder.subfolders) walk(sub, path === '' ? String(sub.name) : `${path}/${String(sub.name)}`);
  };
  walk(await animations(), '');
  return out;
}

function register(writer: Construct3ProjectWriter, idGen: IdGenerator): MockServer {
  const mock = new MockServer();
  registerAnimationTools({ server: mock, reader, writer, idGen } as never);
  registerObjectTools({ server: mock, reader, writer, idGen } as never);
  return mock;
}

async function call(tool: string, args: Record<string, unknown>, mock = server): Promise<{ isError?: boolean; text: string; data?: ToolData }> {
  const result = await mock.callTool(tool, { objectName: 'Sprite', ...args });
  return result.isError
    ? { isError: true, text: result.content[0].text }
    : { text: result.content[0].text, data: JSON.parse(result.content[0].text) as ToolData };
}

/** A server whose writer's object write fails as `error()` gives. */
function failingObjectWrite(error: () => Error): MockServer {
  class FailingObjectWriter extends Construct3ProjectWriter {
    override async writeEntityFile(...args: Parameters<Construct3ProjectWriter['writeEntityFile']>): Promise<string> {
      if (args[0] === 'objectTypes') throw error();
      return super.writeEntityFile(...args);
    }
  }
  const idGen = new IdGenerator();
  return register(new FailingObjectWriter(reader, idGen), idGen);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-animation-folders-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = register(new Construct3ProjectWriter(reader, idGen), idGen);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('create_animation_folder', () => {
  it('creates the folder and the folders above it, in the project-bar folder key order', async () => {
    const { data } = await call('create_animation_folder', { folderPath: 'Combat/Melee' });
    expect(data?.foldersCreated).toEqual(['Combat', 'Combat/Melee']);
    expect((await animations()).subfolders).toEqual([{ items: [], subfolders: [{ items: [], subfolders: [], name: 'Melee' }], name: 'Combat' }]);
    expect(Object.keys((await animations()).subfolders[0])).toEqual(['items', 'subfolders', 'name']);
    const second = await call('create_animation_folder', { folderPath: 'Combat/Ranged' });
    expect(second.data?.foldersCreated).toEqual(['Combat/Ranged']);
    expect(Object.keys(await layout())).toEqual(['', 'Combat', 'Combat/Melee', 'Combat/Ranged']);
  });

  it('refuses a folder that exists, or one that differs from an existing folder only in case, and changes nothing', async () => {
    await call('create_animation_folder', { folderPath: 'Combat' });
    const before = await readFile(objectPath());
    expect((await call('create_animation_folder', { folderPath: 'Combat' })).text)
      .toBe('Animation folder "Combat" already exists on "Sprite". Nothing was changed.');
    expect((await call('create_animation_folder', { folderPath: 'combat/Melee' })).text)
      .toBe('Animation folder path "combat/Melee" has a folder whose name differs only in case from an existing animation folder on "Sprite" '
        + '(spelled as the existing folders are: "Combat/Melee"): the server compares animation folder names ignoring case, as it does '
        + 'project-bar folders. Use "Combat/Melee". Nothing was changed.');
    expect(Buffer.compare(await readFile(objectPath()), before)).toBe(0);
  });

  it('refuses an invalid path and an object that is not a Sprite before writing anything', async () => {
    const before = await readFile(objectPath());
    for (const folderPath of ['../Up', 'A//B', '/Root']) {
      expect((await call('create_animation_folder', { folderPath })).isError).toBe(true);
    }
    expect((await call('create_object', { name: 'Label', pluginId: 'Text' })).isError).toBeUndefined();
    expect((await call('create_animation_folder', { objectName: 'Label', folderPath: 'Moves' })).text)
      .toBe('Object "Label" is not a Sprite. Only Sprite objects have animations. Nothing was changed.');
    expect(Buffer.compare(await readFile(objectPath()), before)).toBe(0);
    expect(await readdir(join(tmpDir, 'objectTypes'))).not.toContain('Sprite.json.bak');
  });
});

describe('move_animation_to_folder', () => {
  beforeEach(async () => {
    expect((await call('add_animation_to_sprite', { animationName: 'Walk' })).isError).toBeUndefined();
    expect((await call('create_animation_folder', { folderPath: 'Moves/Ground' })).isError).toBeUndefined();
  });

  it('moves an animation into a folder and back to the end of the top level, and changes no image file', async () => {
    const imagesBefore = (await readdir(join(tmpDir, 'images'))).sort();
    const into = await call('move_animation_to_folder', { animationName: 'Walk', folderPath: 'Moves/Ground' });
    expect(into.data).toMatchObject({ fromFolder: null, toFolder: 'Moves/Ground' });
    expect(into.data?.warnings).toBeUndefined();
    expect(await layout()).toEqual({ '': ['Animation 1'], Moves: [], 'Moves/Ground': ['Walk'] });
    // folderPath left out: the top level, at the end of its list
    const back = await call('move_animation_to_folder', { animationName: 'Walk' });
    expect(back.data).toMatchObject({ fromFolder: 'Moves/Ground', toFolder: null });
    expect(await layout()).toEqual({ '': ['Animation 1', 'Walk'], Moves: [], 'Moves/Ground': [] });
    expect((await readdir(join(tmpDir, 'images'))).sort()).toEqual(imagesBefore);
  });

  it('names only the part of a path that exists in another case, never a folder below it that does not exist', async () => {
    const before = await readFile(objectPath());
    const backupBefore = await readFile(`${objectPath()}.bak`);
    const text = (await call('move_animation_to_folder', { animationName: 'Walk', folderPath: 'moves/Fresh' })).text;
    expect(text).toBe('Animation folder "moves/Fresh" does not exist on "Sprite"; "Moves" exists, whose name differs only in case from "moves". Nothing was changed.');
    expect(text).not.toContain('"Moves/Fresh"');
    // A case variant of the whole path is named as it is
    expect((await call('move_animation_to_folder', { animationName: 'Walk', folderPath: 'moves/ground' })).text)
      .toBe('Animation folder "moves/ground" does not exist on "Sprite"; "Moves/Ground" exists, whose name differs only in case from "moves/ground". Nothing was changed.');
    expect(Buffer.compare(await readFile(objectPath()), before)).toBe(0);
    expect(Buffer.compare(await readFile(`${objectPath()}.bak`), backupBefore)).toBe(0);
  });

  it('warns only when this move leaves no animation outside animation folders', async () => {
    // Walk leaves Animation 1 at the top level: no warning
    const first = await call('move_animation_to_folder', { animationName: 'Walk', folderPath: 'Moves' });
    expect(first.data?.warnings).toBeUndefined();
    const last = await call('move_animation_to_folder', { animationName: 'Animation 1', folderPath: 'Moves' });
    expect(last.data?.warnings).toEqual(['"Animation 1" was the last animation outside animation folders: the top level of the animations of "Sprite" now has none.']);
    // A move between two folders, with the top level already empty, says nothing about it
    const between = await call('move_animation_to_folder', { animationName: 'Walk', folderPath: 'Moves/Ground' });
    expect(between.data?.warnings).toBeUndefined();
  });

  it('refuses a missing folder, a case variant of one, a missing animation and a move that changes nothing', async () => {
    const before = await readFile(objectPath());
    expect((await call('move_animation_to_folder', { animationName: 'Walk', folderPath: 'Air' })).text)
      .toBe('Animation folder "Air" does not exist on "Sprite". Create it with create_animation_folder first. Nothing was changed.');
    expect((await call('move_animation_to_folder', { animationName: 'Walk', folderPath: 'moves' })).text)
      .toBe('Animation folder "moves" does not exist on "Sprite"; "Moves" exists, whose name differs only in case from "moves". Nothing was changed.');
    expect((await call('move_animation_to_folder', { animationName: 'Run', folderPath: 'Moves' })).text)
      .toContain('Animation "Run" not found on "Sprite". Available: Animation 1, Walk');
    expect((await call('move_animation_to_folder', { animationName: 'Walk', folderPath: '' })).text)
      .toBe('Animation "Walk" is already in the top level of the animations. Nothing was changed.');
    expect(Buffer.compare(await readFile(objectPath()), before)).toBe(0);
  });
});

describe('a failed object write', () => {
  it('restores the object file when its write failed after replacing it', async () => {
    const before = await readFile(objectPath());
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<void> };
    internals.verifyWrittenFile = async () => { throw new Error('Post-write verification failed for "Sprite"'); };
    expect((await call('create_animation_folder', { folderPath: 'Moves' }, register(writer, idGen))).text)
      .toBe('Error creating animation folder: Post-write verification failed for "Sprite". The change was rolled back: '
        + 'objectTypes/Sprite.json was restored from its backup (its .bak stays).');
    expect(Buffer.compare(await readFile(objectPath()), before)).toBe(0);
    expect(await readdir(join(tmpDir, 'objectTypes'))).toContain('Sprite.json.bak');
  });

  it('leaves the object file as another write that replaced it during this one left it', async () => {
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    const other = JSON.stringify({ ...JSON.parse(await readFile(objectPath(), 'utf8')), isGlobal: true }, null, '\t');
    internals.atomicWrite = async (path, content) => {
      await atomicWrite(path, content);
      if (path.endsWith('Sprite.json')) await writeFile(path, other);
    };
    expect((await call('create_animation_folder', { folderPath: 'Moves' }, register(writer, idGen))).text)
      .toContain('Another write replaced the object file during this one (a tool call running in parallel?); it was left as that write left it');
    expect(await readFile(objectPath(), 'utf8')).toBe(other);
  });

  it('names an fs error by its code and project-relative path', async () => {
    const text = (await call('create_animation_folder', { folderPath: 'Moves' }, failingObjectWrite(
      () => Object.assign(new Error(`EPERM: operation not permitted, open '${objectPath()}'`), { code: 'EPERM', path: objectPath() }),
    ))).text;
    expect(text).toBe('Error creating animation folder: EPERM on objectTypes/Sprite.json. Nothing was changed.');
    expect(text).not.toContain(tmpDir);
  });
});
