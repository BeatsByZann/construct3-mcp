/**
 * add_instances_to_layout (#ISSUE): many instances placed on one layout in
 * one call and one write, each as add_instance_to_layout places it. Every
 * item is applied to the layout in memory first; a refused item, a step that
 * throws, or a layout that would pass the size limit refuses the whole call
 * before anything is written. Checked on a temp copy of the minimal fixture
 * (a Sprite with one instance, UID 0, on layer "Main" of "Layout 1") with
 * the real reader, writer and IdGenerator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerBulkInstanceTools, MAX_BULK_INSTANCES } from '../../src/tools/bulk-instance-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const MB = 1024 * 1024;
const NOTHING_CHANGED = 'Nothing was changed.';

interface InstanceJson {
  type: string;
  uid: number;
  sid: number;
  world?: { x: number; y: number; z?: number; zElevation?: number };
  instanceVariables?: Record<string, unknown>;
  [key: string]: unknown;
}
interface LayoutFile {
  layers: Array<{ name: string; instances: InstanceJson[] }>;
  'nonworld-instances'?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}
interface ToolData {
  isError?: boolean;
  text?: string;
  success?: boolean;
  action?: string;
  dryRun?: boolean;
  count?: number;
  message?: string;
  editorNote?: string;
  results?: Array<{ index: number; objectType: string; uid: number; sid: number }>;
  warnings?: string[];
  unscannedFiles?: Array<{ file: string; textSearch: string; names?: string[] }>;
  generatedUid?: number;
  generatedSid?: number;
}
type Item = Record<string, unknown>;

interface Env {
  dir: string;
  reader: Construct3ProjectReader;
  writer: Construct3ProjectWriter;
  idGen: IdGenerator;
  server: MockServer;
}

async function makeEnv(): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-bulk-instances-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  const server = new MockServer();
  registerObjectTools({ server, reader, writer, idGen } as never);
  registerLayoutTools({ server, reader, writer, idGen } as never);
  registerBulkInstanceTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
  return { dir, reader, writer, idGen, server };
}

let env: Env;
let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let idGen: IdGenerator;
let server: MockServer;

const layoutPath = (dir = tmpDir) => join(dir, 'layouts', 'Layout 1.json');
const familyPath = (name: string) => join(tmpDir, 'families', `${name}.json`);
const readLayout = async (dir = tmpDir): Promise<LayoutFile> => JSON.parse(await readFile(layoutPath(dir), 'utf8')) as LayoutFile;
const layoutBytes = () => readFile(layoutPath());
const mainInstances = async () => (await readLayout()).layers[0].instances;

async function callOn(target: MockServer, tool: string, args: Record<string, unknown>): Promise<ToolData> {
  const result = await target.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
}
const call = (tool: string, args: Record<string, unknown>) => callOn(server, tool, args);

const sprite = (x: number, extra: Item = {}): Item => ({ layerName: 'Main', objectType: 'Sprite', x, y: 10, ...extra });
const add = (instances: Item[], extra: Item = {}) => call('add_instances_to_layout', { layoutName: 'Layout 1', instances, ...extra });
const countOf = (text: string, part: string) => text.split(part).length - 1;
const withoutIds = ({ uid: _uid, sid: _sid, ...rest }: InstanceJson) => rest;

/** The write spy of a call: whether the layout file was written. */
const writeSpy = () => vi.spyOn(writer, 'writeEntityFile');

/** The writer's read-back of `fileName` fails once with an ordinary error; `before` runs first (an editor save, say). */
function failReadBackOf(fileName: string, before: () => Promise<void> = async () => {}): void {
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  let failed = false;
  vi.spyOn(internals, 'verifyWrittenFile').mockImplementation(async (path, name, text) => {
    if (!failed && path.endsWith(fileName)) {
      failed = true;
      await before();
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    }
    return verify(path, name, text);
  });
}

/** Put the layout file back to `bytes` and re-read the project. */
async function resetLayout(bytes: Buffer | string): Promise<void> {
  await writeFile(layoutPath(), bytes);
  await reader.loadProject();
}

/** Foes: a family of Sprite whose file is not valid JSON but whose text names the member and its variable. */
async function breakFamilyFile(): Promise<void> {
  await call('update_object_properties', { name: 'Sprite', addVariables: [{ name: 'hp', type: 'number' }] });
  await call('create_family', { name: 'Foes', pluginId: 'Sprite', members: ['Sprite'] });
  await call('update_family', { name: 'Foes', addVariables: [{ name: 'armor', type: 'number' }] });
  await writeFile(familyPath('Foes'), `<<<<<<< HEAD\n${await readFile(familyPath('Foes'), 'utf8')}`);
  await reader.loadProject();
  resetProjectIndex();
}

beforeEach(async () => {
  env = await makeEnv();
  ({ dir: tmpDir, reader, writer, idGen, server } = env);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('add_instances_to_layout', () => {
  it('places every item and writes the layout once', async () => {
    const spy = writeSpy();
    const data = await add([sprite(1), sprite(2, { zElevation: 5, instanceVariables: {} }), sprite(3)]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({ success: true, action: 'updated', count: 3 });
    expect(data.editorNote).toEqual(expect.any(String));
    expect(data.results!.map(r => [r.index, r.objectType])).toEqual([[0, 'Sprite'], [1, 'Sprite'], [2, 'Sprite']]);
    const instances = await mainInstances();
    expect(instances.map(i => i.uid)).toEqual([0, ...data.results!.map(r => r.uid)]);
    expect(instances.slice(1).map(i => i.world!.x)).toEqual([1, 2, 3]);
    expect(instances[2].world!.z).toBe(5);
    expect(instances[2].world).not.toHaveProperty('zElevation');
  });

  it('gives each placement its own UID and SID', async () => {
    const data = await add([sprite(1), sprite(2), sprite(3)]);
    const results = data.results!;
    expect(new Set(results.map(r => r.uid)).size).toBe(3);
    expect(new Set(results.map(r => r.sid)).size).toBe(3);
    expect(results.every(r => r.uid > 0)).toBe(true);
    const instances = await mainInstances();
    for (const r of results) {
      const placed = instances.find(i => i.uid === r.uid)!;
      expect(placed.sid).toBe(r.sid);
    }
  });

  it('refuses the whole call at the first bad item, changing nothing', async () => {
    const spy = writeSpy();
    const before = await layoutBytes();

    const layer = await add([sprite(1), sprite(2, { layerName: 'Nope' }), sprite(3, { objectType: 'Missing' })]);
    expect(layer.isError).toBe(true);
    expect(layer.text!.startsWith('Item 1: ')).toBe(true);
    expect(layer.text).toContain('Layer "Nope" not found in layout "Layout 1". Available layers: Main');
    expect(layer.text!.endsWith(NOTHING_CHANGED)).toBe(true);
    expect(countOf(layer.text!, NOTHING_CHANGED)).toBe(1);

    const missing = await add([sprite(1), sprite(2, { objectType: 'Missing' })]);
    expect(missing.isError).toBe(true);
    expect(missing.text!.startsWith('Item 1: Object type "Missing" does not exist.')).toBe(true);
    expect(countOf(missing.text!, NOTHING_CHANGED)).toBe(1);

    const variable = await add([sprite(1), sprite(2, { instanceVariables: { nosuchvar: 1 } })]);
    expect(variable.isError).toBe(true);
    expect(variable.text!.startsWith('Item 1: ')).toBe(true);
    expect(variable.text).toContain('no instance variable "nosuchvar"');
    expect(countOf(variable.text!, NOTHING_CHANGED)).toBe(1);

    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('turns an error a step throws into the item\'s refusal', async () => {
    const spy = writeSpy();
    const before = await layoutBytes();
    const generate = idGen.generateUid.bind(idGen);
    let calls = 0;
    vi.spyOn(idGen, 'generateUid').mockImplementation(async (r) => {
      calls += 1;
      if (calls === 2) throw new Error('Cannot generate a safe UID: project file(s) could not be scanned');
      return generate(r);
    });

    const data = await add([sprite(1), sprite(2)]);
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`Item 1: Cannot generate a safe UID: project file(s) could not be scanned. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('places items as the single tool does when the family files cannot be read', async () => {
    const original = await layoutBytes();
    vi.spyOn(reader, 'readAllFamilies').mockRejectedValueOnce(new Error('EBUSY'));
    const bulk = await add([sprite(1), sprite(2)]);
    expect(bulk).toMatchObject({ success: true, count: 2 });
    const bulkInstances = (await mainInstances()).slice(1);
    expect(bulkInstances).toHaveLength(2);

    await resetLayout(original);
    vi.spyOn(reader, 'readAllFamilies').mockRejectedValueOnce(new Error('EBUSY'));
    const single = await call('add_instance_to_layout', { layoutName: 'Layout 1', ...sprite(1) });
    expect(single.success).toBe(true);
    const singleInstance = (await mainInstances())[1];
    expect(withoutIds(bulkInstances[0])).toEqual(withoutIds(singleInstance));
  });

  it('refuses a layout name in another letter case, and a layout it cannot read', async () => {
    const spy = writeSpy();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = await layoutBytes();
    const unchanged = async (expected: Buffer) => {
      expect(Buffer.compare(await layoutBytes(), expected)).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    };

    const letterCase = await call('add_instances_to_layout', { layoutName: 'layout 1', instances: [sprite(1)] });
    expect(letterCase.isError).toBe(true);
    expect(letterCase.text).toBe(`Layout "layout 1" not found: names are matched with their letter case. Did you mean "Layout 1"? ${NOTHING_CHANGED}`);
    await unchanged(original);

    const missing = await call('add_instances_to_layout', { layoutName: 'Nope', instances: [sprite(1)] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Layout "Nope" not found.');
    expect(missing.text!.endsWith(` ${NOTHING_CHANGED}`)).toBe(true);
    await unchanged(original);

    const broken = Buffer.from('{ broken');
    await resetLayout(broken);
    const unreadable = await add([sprite(1)]);
    expect(unreadable.isError).toBe(true);
    expect(unreadable.text!.startsWith('Cannot read layout "Layout 1": ')).toBe(true);
    expect(unreadable.text!.endsWith(` ${NOTHING_CHANGED}`)).toBe(true);
    await unchanged(broken);

    const nothing = Buffer.from('null');
    await resetLayout(nothing);
    const notAnObject = await add([sprite(1)]);
    expect(notAnObject.text).toBe(`Cannot read layout "Layout 1": it does not hold a layout object. ${NOTHING_CHANGED}`);
    await unchanged(nothing);

    await resetLayout(original);
    consoleError.mockClear();
    vi.spyOn(reader, 'listLayouts').mockRejectedValueOnce(new Error('EMFILE'));
    const listing = await add([sprite(1)]);
    expect(listing.text).toBe(`The change was stopped before anything was written: EMFILE. ${NOTHING_CHANGED}`);
    expect(consoleError.mock.calls.some(args => String(args[0]).includes('[add_instances_to_layout] failed'))).toBe(false);
    await unchanged(original);
  });

  it('a dry run writes nothing', async () => {
    const spy = writeSpy();
    const before = await layoutBytes();

    const data = await add([sprite(1), sprite(2)], { dryRun: true });
    expect(data).toMatchObject({ success: true, action: 'dry-run', dryRun: true, count: 2 });
    expect(data.results!.every(r => r.uid > 0 && r.sid > 0)).toBe(true);
    expect(data.message).toContain('Nothing was written');
    expect(data.message).toContain('for this preview only');
    expect(data.editorNote).toBeUndefined();
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);

    const refused = await add([sprite(1), sprite(2, { objectType: 'Missing' })], { dryRun: true });
    expect(refused.isError).toBe(true);
    expect(refused.text!.startsWith('Item 1: Object type "Missing" does not exist.')).toBe(true);
    expect(refused.text!.endsWith(NOTHING_CHANGED)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('puts the layout back when its read-back fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await layoutBytes();
    failReadBackOf('Layout 1.json');

    const data = await add([sprite(1), sprite(2)]);
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
  });

  it('names a file it could not safely put back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const saved = JSON.stringify({ ...(await readLayout()), savedInEditor: true }, null, '\t');
    failReadBackOf('Layout 1.json', () => writeFile(layoutPath(), saved));

    const data = await add([sprite(1), sprite(2)]);
    expect(data.isError).toBe(true);
    expect(data.text).toContain('rolled back only in part');
    expect(data.text).toContain('left as it is: layouts/Layout 1.json');
    expect(await readFile(layoutPath(), 'utf8')).toBe(saved);
  });

  describe('against the file size limit', () => {
    const bigItem = (x: number): Item => sprite(x, { properties: { note: '€'.repeat(16_000) } });

    it('refuses a call whose layout would pass the limit, in a real call and in a dry run, changing nothing', async () => {
      vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
      const spy = writeSpy();
      const before = await layoutBytes();
      // 25 items of 48,000 UTF-8 bytes and 16,000 code units: the JSON is under the limit in code units, the file over it in bytes
      const items = Array.from({ length: 25 }, (_, i) => bigItem(i));

      for (const dryRun of [false, true]) {
        const data = await add(items, { dryRun });
        expect(data.isError).toBe(true);
        expect(data.text).toContain('is too large');
        expect(data.text).toContain('over the');
        expect(data.text!.endsWith(NOTHING_CHANGED)).toBe(true);
        expect(countOf(data.text!, NOTHING_CHANGED)).toBe(1);
        expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
        expect(existsSync(`${layoutPath()}.bak`)).toBe(false);
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it('writes a multibyte layout just under the limit that reads back', async () => {
      vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
      // The growth of one item, from a second copy of the project
      let count = 0;
      const second = await makeEnv();
      try {
        const sizeBefore = (await stat(layoutPath(second.dir))).size;
        const one = await callOn(second.server, 'add_instances_to_layout', { layoutName: 'Layout 1', instances: [bigItem(0)] });
        expect(one.success).toBe(true);
        const growth = (await stat(layoutPath(second.dir))).size - sizeBefore;
        count = Math.floor((MB - sizeBefore) / growth) - 1;
      } finally {
        await rm(second.dir, { recursive: true, force: true });
      }
      expect(count).toBeGreaterThan(5);

      const data = await add(Array.from({ length: count }, (_, i) => bigItem(i)));
      expect(data).toMatchObject({ success: true, count });
      const size = (await stat(layoutPath())).size;
      expect(size).toBeLessThan(MB);
      expect(size).toBeGreaterThan(0.9 * MB);
      await reader.loadProject();
      const layout = await reader.readLayout('Layout 1');
      expect(layout.layers[0].instances).toHaveLength(1 + count);
    });
  });

  describe('a family file that could not be parsed', () => {
    beforeEach(async () => {
      await breakFamilyFile();
    });

    it('reports each identical warning once with its items', async () => {
      const data = await add([sprite(1), sprite(2)]);
      expect(data.success).toBe(true);
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings![0].startsWith('Items 0, 1: ')).toBe(true);
      expect(data.warnings![0]).toContain('possibly list "Sprite" as a member: families/Foes');
      expect(data.unscannedFiles).toEqual([expect.objectContaining({ file: 'families/Foes', textSearch: 'possible-use' })]);
    });

    it('keeps every name a family file could declare, with distinct warnings', async () => {
      const data = await add([sprite(1), sprite(2, { instanceVariables: { armor: 2 } })]);
      expect(data.success).toBe(true);
      expect(data.unscannedFiles).toHaveLength(1);
      expect(data.unscannedFiles![0]).toMatchObject({ file: 'families/Foes', textSearch: 'possible-use' });
      expect(data.unscannedFiles![0].names).toContain('armor');
      expect(data.warnings).toHaveLength(2);
      expect(data.warnings![0].startsWith('Item 0: ')).toBe(true);
      expect(data.warnings![1].startsWith('Item 1: ')).toBe(true);
      expect(data.warnings![1]).toContain('"armor" was written as given, without a check');
    });
  });

  it('refuses more items than the limit, in argument parsing', async () => {
    const before = await layoutBytes();
    const items = Array.from({ length: MAX_BULK_INSTANCES + 1 }, (_, i) => sprite(i));
    await expect(add(items)).rejects.toThrow(new RegExp(`at most ${MAX_BULK_INSTANCES} element`));
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
  });

  it('puts a non-world object into nonworld-instances', async () => {
    const sourceFile = JSON.parse(await readFile(join(tmpDir, 'objectTypes', 'Sprite.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(tmpDir, 'objectTypes', 'Store.json'),
      JSON.stringify({ ...sourceFile, name: 'Store', 'plugin-id': 'Arr', isGlobal: true }, null, '\t'));
    const projectFile = join(tmpDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectFile, 'utf8')) as { objectTypes: { items: string[] } };
    project.objectTypes.items.push('Store');
    await writeFile(projectFile, JSON.stringify(project, null, '\t'));
    await reader.loadProject();

    const data = await add([{ layerName: 'Main', objectType: 'Store', x: 0, y: 0 }]);
    expect(data.success).toBe(true);
    const nonworld = (await readLayout())['nonworld-instances'];
    expect(nonworld).toEqual([expect.objectContaining({ type: 'Store', uid: data.results![0].uid })]);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings![0].startsWith('Item 0: "Store" is a global (nonworld) object')).toBe(true);
  });
});
