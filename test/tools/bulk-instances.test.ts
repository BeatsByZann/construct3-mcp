/**
 * The bulk instance tools (#ISSUE): add_instances_to_layout, update_instances
 * and delete_instances_from_layout apply many items to one layout in one
 * call and one write, each as the single tool does. Every item is applied to
 * the layout in memory first; a refused item, a step that throws, or a layout
 * that would pass the size limit refuses the whole call before anything is
 * written, and a failed write is rolled back. Checked on a temp copy of the
 * minimal fixture (a Sprite with one instance, UID 0, on layer "Main" of
 * "Layout 1") with the real reader, writer and IdGenerator.
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
import type { UnscannedFileReport } from '../../src/construct3/analyzers/unscanned-uses.js';

// Lets one test make the step after the item loop throw: the merge of the unscanned reports runs there
const hooks = vi.hoisted(() => ({ failMerge: false }));
vi.mock('../../src/construct3/analyzers/unscanned-uses.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/construct3/analyzers/unscanned-uses.js')>();
  return {
    ...actual,
    mergeUnscannedReports: (...lists: Array<readonly UnscannedFileReport[]>) => {
      if (hooks.failMerge) throw new Error('reports unreadable');
      return actual.mergeUnscannedReports(...lists);
    },
  };
});

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
  backupFile?: string;
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
  hooks.failMerge = false;
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

  it('does not reuse the UIDs and SIDs a refused call or a dry run took', async () => {
    const uids: number[] = [];
    const sids: number[] = [];
    const generateUid = idGen.generateUid.bind(idGen);
    const generateSid = idGen.generateSid.bind(idGen);
    vi.spyOn(idGen, 'generateUid').mockImplementation(async (r) => { const uid = await generateUid(r); uids.push(uid); return uid; });
    vi.spyOn(idGen, 'generateSid').mockImplementation(async (r) => { const sid = await generateSid(r); sids.push(sid); return sid; });

    expect((await add([sprite(1), sprite(2, { objectType: 'Missing' })])).isError).toBe(true);
    expect((await add([sprite(1)], { dryRun: true })).success).toBe(true);
    expect(uids).toHaveLength(2);
    expect(sids).toHaveLength(2);
    const takenUids = [...uids];
    const takenSids = [...sids];

    const data = await add([sprite(1), sprite(2)]);
    expect(data.success).toBe(true);
    for (const r of data.results!) {
      expect(takenUids).not.toContain(r.uid);
      expect(takenSids).not.toContain(r.sid);
      expect(r.uid).toBeGreaterThan(Math.max(...takenUids));
    }
  });

  it('returns the backup file of a real call and none for a dry run', async () => {
    const dry = await add([sprite(1)], { dryRun: true });
    expect(dry.backupFile).toBeUndefined();
    const real = await add([sprite(1)]);
    expect(real.backupFile).toEqual(expect.any(String));
    expect(real.backupFile).toContain('Layout 1');
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

    it('lists a warning given by more than five items with the first five and the count of the rest', async () => {
      const data = await add(Array.from({ length: 12 }, (_, i) => sprite(i)));
      expect(data.success).toBe(true);
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings![0].startsWith('Items 0, 1, 2, 3, 4 and 7 more: ')).toBe(true);
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

describe('update_instances and delete_instances_from_layout', () => {
  let a: number;
  let b: number;
  let c: number;
  let d: number;

  const update = (updates: Item[], extra: Item = {}) => call('update_instances', { layoutName: 'Layout 1', updates, ...extra });
  const remove = (uids: number[], extra: Item = {}) => call('delete_instances_from_layout', { layoutName: 'Layout 1', uids, ...extra });
  const instanceOf = async (uid: number) => (await mainInstances()).find(i => i.uid === uid);

  /** Edit the layout file directly and re-read the project. */
  async function editLayout(change: (layout: LayoutFile) => void): Promise<void> {
    const layout = await readLayout();
    change(layout);
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
  }

  const flags = { x: true, y: true, z: false, w: true, h: true, a: false, o: false, v: false, d: true, sm: 'normal' };
  const preview = {
    transformX: 0, transformY: 0, transformZElevation: 0, transformW: 0, transformH: 0, transformA: 0,
    transformSX: 0, transformSY: 0, transformO: 0, previewSceneGraph: false,
  };
  /** A sceneGraphData record, as the editor saves one. */
  const record = (uid: number, parent: number | null, children: number[] = []) => ({
    'parent-uid': parent, uid, ...(children.length > 0 ? { children: children.map(child => ({ uid: child, flags: { ...flags } })) } : {}),
    flags: { ...flags }, preview: { ...preview },
  });
  const byUid = (layout: LayoutFile, uid: number) => layout.layers[0].instances.find(i => i.uid === uid)!;

  beforeEach(async () => {
    const placed = await add([sprite(1), sprite(2), sprite(3), sprite(4)]);
    [a, b, c, d] = placed.results!.map(r => r.uid);
  });

  it('updates every item and writes once', async () => {
    const spy = writeSpy();
    const data = await update([{ uid: a, x: 50 }, { uid: b, zElevation: 7 }]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({ success: true, action: 'updated', count: 2 });
    expect(data.results).toEqual([{ index: 0, uid: a }, { index: 1, uid: b }]);
    expect((await instanceOf(a))!.world!.x).toBe(50);
    expect((await instanceOf(b))!.world!.z).toBe(7);
  });

  it('applies two updates of one UID in order', async () => {
    const data = await update([{ uid: a, x: 1 }, { uid: a, x: 2 }]);
    expect(data.success).toBe(true);
    expect((await instanceOf(a))!.world!.x).toBe(2);
  });

  it('refuses an empty update by its index', async () => {
    const spy = writeSpy();
    const before = await layoutBytes();
    const data = await update([{ uid: a, x: 1 }, { uid: b }]);
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`Item 1: No updates provided. Specify at least one property to update. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an update or a delete the single tool would refuse', async () => {
    const spy = writeSpy();
    const before = await layoutBytes();

    const unknown = await update([{ uid: a, x: 1 }, { uid: 999, x: 1 }]);
    expect(unknown.isError).toBe(true);
    expect(unknown.text!.startsWith('Item 1: Instance with UID 999 not found in layout "Layout 1".')).toBe(true);
    expect(unknown.text!.endsWith(NOTHING_CHANGED)).toBe(true);

    const variable = await update([{ uid: a, x: 1 }, { uid: b, instanceVariables: { nosuchvar: 1 } }]);
    expect(variable.isError).toBe(true);
    expect(variable.text!.startsWith('Item 1: ')).toBe(true);
    expect(variable.text).toContain('no instance variable "nosuchvar"');
    expect(countOf(variable.text!, NOTHING_CHANGED)).toBe(1);

    const missing = await remove([a, 999, b]);
    expect(missing.isError).toBe(true);
    expect(missing.text!.startsWith('Item 1: Instance with UID 999 not found in layout "Layout 1".')).toBe(true);
    expect(missing.text!.endsWith(NOTHING_CHANGED)).toBe(true);

    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the world.zElevation handling of update_instance', async () => {
    await editLayout(layout => {
      const world = layout.layers[0].instances.find(i => i.uid === a)!.world!;
      delete world.z;
      world.zElevation = 3;
    });
    const data = await update([{ uid: a, zElevation: 4 }]);
    expect(data.success).toBe(true);
    const world = (await instanceOf(a))!.world!;
    expect(world.z).toBe(4);
    expect(world).not.toHaveProperty('zElevation');
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings![0].startsWith(`Item 0: Instance ${a} held its Z elevation as world.zElevation (3)`)).toBe(true);
  });

  it('deletes every UID and writes once', async () => {
    const spy = writeSpy();
    const data = await remove([a, b]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({ success: true, action: 'updated', count: 2 });
    expect(data.results).toEqual([{ index: 0, uid: a, objectType: 'Sprite' }, { index: 1, uid: b, objectType: 'Sprite' }]);
    expect((await mainInstances()).map(i => i.uid)).toEqual([0, c, d]);
    expect(data.warnings).toEqual([
      `Item 0: Removed instance of "Sprite" (UID ${a}) from layer "Main".`,
      `Item 1: Removed instance of "Sprite" (UID ${b}) from layer "Main".`,
    ]);
  });

  it('refuses a UID listed twice', async () => {
    const before = await layoutBytes();
    const data = await remove([a, b, a]);
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`Item 2: UID ${a} is listed more than once. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
  });

  it('removes a parent and its child together, unlinking once', async () => {
    await editLayout(layout => {
      byUid(layout, a).sceneGraphData = record(a, null, [b]);
      byUid(layout, b).sceneGraphData = record(b, a, [c]);
      byUid(layout, c).sceneGraphData = record(c, b);
    });

    const data = await remove([a, b]);
    expect(data.success).toBe(true);
    const left = await mainInstances();
    expect(left.map(i => i.uid)).toEqual([0, c, d]);
    expect((left.find(i => i.uid === c)!.sceneGraphData as { 'parent-uid': number | null })['parent-uid']).toBeNull();
    const detached = data.warnings!.filter(w => w.includes('Detached hierarchy children'));
    expect(detached).toHaveLength(1);
    expect(detached[0].startsWith('Detached hierarchy children')).toBe(true);
    expect(detached[0]).toContain(`UID ${c} `);
    expect(detached[0]).not.toContain(`UID ${b}`);
  });

  it('says which links it removed from a parent that stays', async () => {
    await editLayout(layout => {
      byUid(layout, a).sceneGraphData = record(a, null, [c]);
      byUid(layout, c).sceneGraphData = record(c, a);
    });
    const data = await remove([c]);
    expect(data.success).toBe(true);
    expect(data.warnings).toContain(`Removed the hierarchy links from UID ${a} to the removed instance(s).`);
    expect(data.warnings!.some(w => w.includes('Detached hierarchy children'))).toBe(false);
    expect(byUid(await readLayout(), a).sceneGraphData).not.toHaveProperty('children');
  });

  it('leaves the links to a removed UID that another instance of the layout still has, and says so', async () => {
    await editLayout(layout => {
      byUid(layout, d).uid = c;
      byUid(layout, a).sceneGraphData = record(a, null, [c]);
    });
    const data = await remove([c]);
    expect(data.success).toBe(true);
    expect(data.warnings).toContain(`Another instance of the layout has UID ${c} too (duplicate-uid in validate_project), so `
      + 'hierarchy links naming that UID were left as they are: check them in the Construct 3 editor.');
    expect((await mainInstances()).filter(i => i.uid === c)).toHaveLength(1);
    expect((byUid(await readLayout(), a).sceneGraphData as { children: unknown[] }).children).toHaveLength(1);
  });

  it('puts the layout back when the read-back of its write fails, for both tools', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await layoutBytes();

    failReadBackOf('Layout 1.json');
    const updated = await update([{ uid: a, x: 9 }, { uid: b, x: 8 }]);
    expect(updated.isError).toBe(true);
    expect(updated.text).toContain('The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);

    failReadBackOf('Layout 1.json');
    const removed = await remove([a, b]);
    expect(removed.isError).toBe(true);
    expect(removed.text).toContain('The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
  });

  it('answers a throw after the item loop with the stopped-before-write refusal, for both tools', async () => {
    const spy = writeSpy();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await layoutBytes();
    const stopped = `The change was stopped before anything was written: reports unreadable. ${NOTHING_CHANGED}`;

    // The merge of the unscanned reports runs after the loop, before the write's checks
    hooks.failMerge = true;
    for (const [tool, run] of [['update_instances', () => update([{ uid: a, x: 9 }])], ['delete_instances_from_layout', () => remove([a])]] as const) {
      consoleError.mockClear();
      const data = await run();
      expect(data.isError).toBe(true);
      expect(data.text).toBe(stopped);
      expect(consoleError.mock.calls.some(args => String(args[0]).includes(`[${tool}] failed`))).toBe(true);
    }
    hooks.failMerge = false;

    // The unlinking of the removed UIDs runs there too: an instance whose hierarchy record cannot be read
    const real = await reader.readLayout('Layout 1');
    const unreadable = structuredClone(real);
    Object.defineProperty(unreadable.layers[0].instances[3], 'sceneGraphData', {
      enumerable: true,
      get: () => { throw new Error('links unreadable'); },
    });
    vi.spyOn(reader, 'readLayout').mockResolvedValueOnce(unreadable);
    consoleError.mockClear();
    const unlinking = await remove([a]);
    expect(unlinking.text).toBe(`The change was stopped before anything was written: links unreadable. ${NOTHING_CHANGED}`);
    expect(consoleError.mock.calls.some(args => String(args[0]).includes('[delete_instances_from_layout] failed'))).toBe(true);

    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a dry run writes nothing', async () => {
    const spy = writeSpy();
    const before = await layoutBytes();
    const updated = await update([{ uid: a, x: 9 }], { dryRun: true });
    expect(updated).toMatchObject({ success: true, action: 'dry-run', dryRun: true, count: 1 });
    const removed = await remove([a, b], { dryRun: true });
    expect(removed).toMatchObject({ success: true, action: 'dry-run', dryRun: true, count: 2 });
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a layout name in another letter case, and a layout it cannot read, for both tools', async () => {
    const spy = writeSpy();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = await layoutBytes();
    const calls: Array<[string, Item]> = [
      ['update_instances', { updates: [{ uid: a, x: 1 }] }],
      ['delete_instances_from_layout', { uids: [a] }],
    ];
    for (const [tool, args] of calls) {
      await resetLayout(original);
      const run = (layoutName: string) => call(tool, { layoutName, ...args });
      const unchanged = async (expected: Buffer) => {
        expect(Buffer.compare(await layoutBytes(), expected)).toBe(0);
        expect(spy).not.toHaveBeenCalled();
      };

      const letterCase = await run('layout 1');
      expect(letterCase.text).toBe(`Layout "layout 1" not found: names are matched with their letter case. Did you mean "Layout 1"? ${NOTHING_CHANGED}`);
      await unchanged(original);

      const broken = Buffer.from('{ broken');
      await resetLayout(broken);
      const unreadable = await run('Layout 1');
      expect(unreadable.text!.startsWith('Cannot read layout "Layout 1": ')).toBe(true);
      expect(unreadable.text!.endsWith(` ${NOTHING_CHANGED}`)).toBe(true);
      await unchanged(broken);

      const nothing = Buffer.from('null');
      await resetLayout(nothing);
      expect((await run('Layout 1')).text).toBe(`Cannot read layout "Layout 1": it does not hold a layout object. ${NOTHING_CHANGED}`);
      await unchanged(nothing);

      await resetLayout(original);
      consoleError.mockClear();
      vi.spyOn(reader, 'listLayouts').mockRejectedValueOnce(new Error('EMFILE'));
      expect((await run('Layout 1')).text).toBe(`The change was stopped before anything was written: EMFILE. ${NOTHING_CHANGED}`);
      expect(consoleError.mock.calls.some(args => String(args[0]).includes(`[${tool}] failed`))).toBe(false);
      await unchanged(original);
    }
  });

  it('reports the first refused item in list order, whatever kind its refusal is', async () => {
    const updates = await update([{ uid: 999, x: 1 }, { uid: b }]);
    expect(updates.text!.startsWith('Item 0: Instance with UID 999 not found')).toBe(true);

    const missingFirst = await remove([999, a, a]);
    expect(missingFirst.text!.startsWith('Item 0: Instance with UID 999 not found')).toBe(true);

    const repeatedFirst = await remove([a, a, 999]);
    expect(repeatedFirst.text).toBe(`Item 1: UID ${a} is listed more than once. ${NOTHING_CHANGED}`);
  });

  it('turns an error a step throws into the item\'s refusal, for both tools', async () => {
    const spy = writeSpy();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await layoutBytes();

    // A name Sprite has no variable of makes the check read the family files, which fail
    vi.spyOn(reader, 'listFamilies').mockRejectedValueOnce(new Error('EBUSY'));
    const updated = await update([{ uid: a, x: 1 }, { uid: b, instanceVariables: { nosuchvar: 1 } }]);
    expect(updated.text).toBe(`Item 1: EBUSY. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);

    // A layout whose layers cannot be read: the step throws on the first item
    const real = await reader.readLayout('Layout 1');
    const unreadableLayers = Object.defineProperty({ ...real }, 'layers', {
      enumerable: true,
      get: () => { throw new Error('layers unreadable'); },
    });
    vi.spyOn(reader, 'readLayout').mockResolvedValueOnce(unreadableLayers);
    const removed = await remove([a]);
    expect(removed.text).toBe(`Item 0: layers unreadable. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.some(args => String(args[0]).includes('failed'))).toBe(false);
  });

  it('refuses a dry run of an update whose write the size limit refuses', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    const size = async () => (await stat(layoutPath())).size;
    const target = MB - 2000;
    const bigItem = (x: number): Item => sprite(x, { properties: { note: '€'.repeat(16_000) } });
    const filler = (bytes: number): Item => sprite(0, { properties: { note: 'x'.repeat(bytes) } });

    // Fill the layout to within about 2KB of the limit: multibyte items, then ASCII fillers, then one sized to the gap
    const s0 = await size();
    await add([bigItem(0)]);
    const growth = (await size()) - s0;
    await add(Array.from({ length: Math.floor((MB - (await size()) - 52_000) / growth) }, (_, i) => bigItem(i)));
    while (target - (await size()) > 45_000) await add([filler(40_000)]);
    const s1 = await size();
    await add([filler(0)]);
    const overhead = (await size()) - s1;
    await add([filler(target - (await size()) - overhead)]);
    expect(await size()).toBeGreaterThan(MB - 3000);
    expect(await size()).toBeLessThan(MB - 1000);

    const [x, y] = (await mainInstances()).slice(-2).map(i => i.uid);
    const tags = '€'.repeat(500);
    const before = await layoutBytes();
    const spy = writeSpy();

    // One update adds 1,500 bytes and fits; two do not
    const fits = await update([{ uid: x, tags }], { dryRun: true });
    expect(fits).toMatchObject({ success: true, action: 'dry-run' });

    const data = await update([{ uid: x, tags }, { uid: y, tags }], { dryRun: true });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('is too large');
    expect(data.text).toContain('over the');
    expect(data.text!.endsWith(NOTHING_CHANGED)).toBe(true);
    expect(countOf(data.text!, NOTHING_CHANGED)).toBe(1);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  }, 60_000);
});
