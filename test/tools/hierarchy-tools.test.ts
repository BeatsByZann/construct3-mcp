/**
 * set_instance_parent and remove_instance_children (#ISSUE): hierarchy
 * links are written on both sides (the child's sceneGraphData "parent-uid"
 * and flags, the parent's "children" entry), also across layers; a loop, a
 * self-link, a non-world instance and a UID that several instances share
 * are refused, changing nothing; every other edit leaves no link that
 * validate_project's hierarchy-link check reports. Synthetic data on a temp
 * copy of the minimal fixture, with the real reader and writer; the record
 * shape follows Scirra's example project three-cups, as in
 * hierarchy-links.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerHierarchyTools } from '../../src/tools/hierarchy-tools.js';
import { DEFAULT_LINK_FLAGS, findHierarchyLinkProblems } from '../../src/construct3/hierarchy.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

const FLAGS = { x: true, y: true, z: false, w: true, h: true, a: false, o: false, v: false, d: true, sm: 'normal' };
const PREVIEW = {
  transformX: 0, transformY: 0, transformZElevation: 0, transformW: 0, transformH: 0, transformA: 0,
  transformSX: 0, transformSY: 0, transformO: 0, previewSceneGraph: false,
};

interface GraphJson { 'parent-uid'?: number | null; uid?: number; children?: Array<{ uid: number; flags: Record<string, unknown> }>; flags?: Record<string, unknown>; preview?: Record<string, unknown> }
interface InstanceJson { type: string; uid: number; sid: number; sceneGraphData?: GraphJson; world?: Record<string, number>; [key: string]: unknown }
interface LayerJson { name: string; sid: number; instances: InstanceJson[]; subLayers: LayerJson[]; [key: string]: unknown }
interface LayoutFile { name: string; layers: LayerJson[]; 'nonworld-instances'?: InstanceJson[]; [key: string]: unknown }
interface ToolData {
  isError?: boolean; text?: string; success?: boolean; action?: string; editorNote?: string; warnings?: string[];
  previousParentUid?: number; createdRecords?: number[]; detached?: number[]; unlisted?: number[]; missing?: number[]; otherParent?: number[]; [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
const readLayout = async (): Promise<LayoutFile> => JSON.parse(await readFile(layoutPath(), 'utf8')) as LayoutFile;
const call = async (tool: string, args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool(tool, { layoutName: 'Layout 1', ...args });
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};

function instance(uid: number, sceneGraphData?: GraphJson): InstanceJson {
  return {
    type: 'Sprite', properties: {}, uid, sid: 500000000000100 + uid, tags: '', instanceVariables: {}, behaviors: {},
    ...(sceneGraphData ? { sceneGraphData } : {}), world: { x: 10 * uid, y: 0, width: 64, height: 64 },
  };
}
const parentRecord = (uid: number, children: number[]): GraphJson =>
  ({ 'parent-uid': null, uid, children: children.map(c => ({ uid: c, flags: { ...FLAGS } })), flags: { ...FLAGS }, preview: { ...PREVIEW } });
const childRecord = (uid: number, parent: number | null): GraphJson =>
  ({ 'parent-uid': parent, uid, flags: { ...FLAGS }, preview: { ...PREVIEW } });

/** Main: parent UID 0 of 1 and 2, and UID 3 without a record; Top: child UID 2 and UID 4 without a record; non-world UID 9. */
async function setup(records = true): Promise<void> {
  const layout = await readLayout();
  layout.layers = [
    { ...layout.layers[0], instances: records ? [instance(0, parentRecord(0, [1, 2])), instance(1, childRecord(1, 0)), instance(3)] : [instance(0), instance(1), instance(3)], subLayers: [] },
    { name: 'Top', sid: 500000000000011, instances: records ? [instance(2, childRecord(2, 0)), instance(4)] : [instance(2), instance(4)], subLayers: [], isInitiallyVisible: true },
  ];
  layout['nonworld-instances'] = [{ type: 'Sprite', uid: 9, sid: 500000000000109, properties: {} }];
  await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
  await reader.loadProject();
}

/** uid -> [parent-uid, child UIDs] of every instance with a hierarchy record. */
async function links(): Promise<Record<number, [number | null | undefined, number[] | undefined]>> {
  const out: Record<number, [number | null | undefined, number[] | undefined]> = {};
  for (const layer of (await readLayout()).layers) {
    for (const inst of layer.instances) {
      const graph = inst.sceneGraphData;
      if (graph) out[inst.uid] = [graph['parent-uid'], graph.children?.map(c => c.uid)];
    }
  }
  return out;
}
const recordOf = async (uid: number): Promise<GraphJson | undefined> =>
  (await readLayout()).layers.flatMap(l => l.instances).find(i => i.uid === uid)?.sceneGraphData;
const linkProblems = async () => findHierarchyLinkProblems(await readLayout());
const layoutFiles = async () => (await readdir(join(tmpDir, 'layouts'))).sort();

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-hierarchy-tools-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerHierarchyTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('set_instance_parent', () => {
  it('links two instances without hierarchy records, on both sides, with the project\'s preview keys blanked', async () => {
    await setup();
    // A sample preview a plain copy or a reference could not pass for: values other than 0 and false, and a key no default has
    const layout = await readLayout();
    layout.layers[0].instances[0].sceneGraphData!.preview = { ...PREVIEW, transformX: 5, previewSceneGraph: true, transformExtra: 2 };
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const data = await call('set_instance_parent', { childUid: 4, parentUid: 3 });
    expect(data.action).toBe('updated');
    expect(data.createdRecords).toEqual([4, 3]);
    expect((await links())[3]).toEqual([null, [4]]);
    expect((await links())[4]).toEqual([3, undefined]);
    expect((await recordOf(4))?.flags).toEqual(DEFAULT_LINK_FLAGS);
    expect((await recordOf(3))?.children?.[0].flags).toEqual(DEFAULT_LINK_FLAGS);
    expect((await recordOf(4))?.preview).toEqual({ ...PREVIEW, transformX: 0, previewSceneGraph: false, transformExtra: 0 });
    expect(await linkProblems()).toEqual([]);
  });

  it('writes the default flags in the key order Construct 3 r495.2 saves', async () => {
    await setup();
    await call('set_instance_parent', { childUid: 4, parentUid: 3 });
    expect(Object.keys((await recordOf(4))!.flags!)).toEqual(['x', 'y', 'z', 'w', 'h', 'd', 'a', 'o', 'v', 'sm']);
    expect((await recordOf(4))?.flags).toEqual({ x: true, y: true, z: true, w: true, h: true, d: true, a: true, o: false, v: false, sm: 'normal' });
  });

  it('puts new keys where the editor saves them: sceneGraphData before world, children after uid', async () => {
    await setup();
    await call('set_instance_parent', { childUid: 4, parentUid: 3 });
    const instance4 = (await readLayout()).layers[1].instances.find(i => i.uid === 4)!;
    expect(Object.keys(instance4).slice(-2)).toEqual(['sceneGraphData', 'world']);
    expect(Object.keys((await recordOf(4))!)).toEqual(['parent-uid', 'uid', 'flags', 'preview']);
    expect(Object.keys((await recordOf(3))!)).toEqual(['parent-uid', 'uid', 'children', 'flags', 'preview']);
    // A record that gains children: children goes after uid, before flags and preview
    await call('set_instance_parent', { childUid: 3, parentUid: 1 });
    expect(Object.keys((await recordOf(1))!)).toEqual(['parent-uid', 'uid', 'children', 'flags', 'preview']);
  });

  it('gives a new record no preview when no record of the project has one', async () => {
    await setup(false);
    await call('set_instance_parent', { childUid: 4, parentUid: 3 });
    expect(await recordOf(4)).not.toHaveProperty('preview');
    expect(await recordOf(3)).not.toHaveProperty('preview');
    expect(await linkProblems()).toEqual([]);
  });

  it('moves a child on another layer to a new parent and takes it off the old one', async () => {
    await setup();
    const data = await call('set_instance_parent', { childUid: 2, parentUid: 1 });
    expect(data.previousParentUid).toBe(0);
    expect(data.warnings?.join(' ')).toContain('Took UID 2 off its previous parent, UID 0.');
    const after = await links();
    expect([after[0], after[1], after[2]]).toEqual([[null, [1]], [0, [2]], [1, undefined]]);
    expect(await linkProblems()).toEqual([]);
  });

  it('writes the given flags over the link\'s saved flags, on both sides', async () => {
    await setup();
    await call('set_instance_parent', { childUid: 1, parentUid: 0, flags: { o: true, x: false } });
    const expected = { ...FLAGS, o: true, x: false };
    expect((await recordOf(1))?.flags).toEqual(expected);
    expect((await recordOf(0))?.children?.find(c => c.uid === 1)?.flags).toEqual(expected);
    expect(await linkProblems()).toEqual([]);
  });

  it('keeps an existing link\'s flags, keys it does not know included, when no flags are given', async () => {
    await setup();
    const custom = { ...FLAGS, o: true, extra: true };
    const layout = await readLayout();
    layout.layers[0].instances[1].sceneGraphData!.flags = { ...custom };
    layout.layers[0].instances[0].sceneGraphData!.children![0].flags = { ...custom };
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const before = await readFile(layoutPath(), 'utf8');
    const data = await call('set_instance_parent', { childUid: 1, parentUid: 0 });
    expect(data.action).toBe('unchanged');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
    await call('set_instance_parent', { childUid: 1, parentUid: 0, flags: { x: false } });
    expect((await recordOf(1))?.flags).toEqual({ ...custom, x: false });
    expect((await recordOf(0))?.children?.find(c => c.uid === 1)?.flags).toEqual({ ...custom, x: false });
  });

  it('reports a link that exists with these flags as unchanged and writes nothing', async () => {
    await setup();
    await call('set_instance_parent', { childUid: 4, parentUid: 3 });
    const before = await readFile(layoutPath(), 'utf8');
    const filesBefore = await layoutFiles();
    const data = await call('set_instance_parent', { childUid: 4, parentUid: 3 });
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
    expect(await layoutFiles()).toEqual(filesBefore);
  });

  it('detaches a child with parentUid null, keeps its record and removes an emptied children list', async () => {
    await setup();
    expect((await call('set_instance_parent', { childUid: 1, parentUid: null })).previousParentUid).toBe(0);
    await call('set_instance_parent', { childUid: 2, parentUid: null });
    const after = await links();
    expect([after[0], after[1], after[2]]).toEqual([[null, undefined], [null, undefined], [null, undefined]]);
    expect(await recordOf(0)).not.toHaveProperty('children');
    expect(await linkProblems()).toEqual([]);
  });

  it('reports a child without a parent as unchanged', async () => {
    await setup();
    const data = await call('set_instance_parent', { childUid: 3, parentUid: null });
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
  });

  it('refuses a loop, a self-link, an unknown UID, a non-world instance and a shared UID, and changes nothing', async () => {
    await setup();
    const before = await readFile(layoutPath(), 'utf8');
    expect((await call('set_instance_parent', { childUid: 0, parentUid: 1 })).text)
      .toContain('UID 1 already descends from UID 0 in the hierarchy, so the link would close a loop. Nothing was changed.');
    expect((await call('set_instance_parent', { childUid: 3, parentUid: 3 })).text)
      .toContain('UID 3 cannot be its own hierarchy parent. Nothing was changed.');
    expect((await call('set_instance_parent', { childUid: 42, parentUid: 0 })).text)
      .toContain('No instance with UID 42 in the layout.');
    expect((await call('set_instance_parent', { childUid: 9, parentUid: 0 })).text)
      .toContain('UID 9 is a non-world instance: hierarchy links join instances placed on layers. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);

    const layout = await readLayout();
    layout.layers[1].instances.push(instance(3));
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const shared = await readFile(layoutPath(), 'utf8');
    expect((await call('set_instance_parent', { childUid: 3, parentUid: 0 })).text)
      .toContain('UID 3 is used by 2 instances of the layout (duplicate-uid in validate_project), so which one is meant cannot be told. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(shared);
  });

  it('refuses to re-parent a child whose current parent\'s UID several instances share, and changes nothing', async () => {
    await setup();
    const layout = await readLayout();
    layout.layers[1].instances.push(instance(0));
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const before = await readFile(layoutPath(), 'utf8');
    const data = await call('set_instance_parent', { childUid: 1, parentUid: 3 });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The parent of UID 1, UID 0, is used by several instances of the layout (duplicate-uid in validate_project), '
      + 'so its link cannot be removed safely. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('refuses to take a child off a parent whose UID several instances share, and changes nothing', async () => {
    await setup();
    const layout = await readLayout();
    layout.layers[1].instances.push(instance(0));
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const before = await readFile(layoutPath(), 'utf8');
    const data = await call('set_instance_parent', { childUid: 1, parentUid: null });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The parent of UID 1, UID 0, is used by several instances of the layout (duplicate-uid in validate_project), '
      + 'so its link cannot be removed safely. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('refuses to link or unlink a child that an instance with a shared UID lists, and changes nothing', async () => {
    await setup();
    // UID 4 has no record, but two instances with UID 7 both list it as a child
    const layout = await readLayout();
    layout.layers[1].instances.push(instance(7, parentRecord(7, [4])), instance(7, parentRecord(7, [4])));
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const before = await readFile(layoutPath(), 'utf8');
    for (const parentUid of [null, 3]) {
      const data = await call('set_instance_parent', { childUid: 4, parentUid });
      expect(data.isError).toBe(true);
      expect(data.text).toContain('UID 4 is listed as a child by UID 7, which several instances of the layout have (duplicate-uid in validate_project), '
        + 'so its link cannot be changed safely. Nothing was changed.');
    }
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('refuses flags without a parent', async () => {
    await setup();
    expect((await call('set_instance_parent', { childUid: 1, parentUid: null, flags: { o: true } })).text)
      .toContain('flags belong to a link: give a parentUid with them. Nothing was changed.');
  });

  // Links one side alone records. UID 3 lists 4 as a child; 4 names no parent
  async function parentSideOnly(): Promise<void> {
    await setup();
    const layout = await readLayout();
    layout.layers[0].instances[2].sceneGraphData = parentRecord(3, [4]);
    layout.layers[1].instances[1].sceneGraphData = childRecord(4, null);
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
  }

  it('refuses a link that closes a loop through a parent-side entry, and changes nothing', async () => {
    await parentSideOnly();
    const before = await readFile(layoutPath(), 'utf8');
    expect((await call('set_instance_parent', { childUid: 3, parentUid: 4 })).text)
      .toContain('UID 4 already descends from UID 3 in the hierarchy, so the link would close a loop. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('detaches a child listed by a parent it does not name, and says so', async () => {
    await parentSideOnly();
    const data = await call('set_instance_parent', { childUid: 4, parentUid: null });
    expect(data.action).toBe('updated');
    expect(data.staleEntries).toEqual([3]);
    expect(data.warnings?.join(' ')).toContain('Removed UID 4 from the children of UID 3');
    expect(await recordOf(3)).not.toHaveProperty('children');
    expect(await linkProblems()).toEqual([]);
  });

  it('takes a re-parented child out of every instance that lists it', async () => {
    await setup();
    const layout = await readLayout();
    layout.layers[0].instances[2].sceneGraphData = parentRecord(3, [1]); // 1 is 0's child; 3 lists it too
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    await call('set_instance_parent', { childUid: 1, parentUid: 2 });
    const after = await links();
    expect([after[0], after[1], after[2], after[3]]).toEqual([[null, [2]], [2, undefined], [0, [1]], [null, undefined]]);
    expect(await linkProblems()).toEqual([]);
    expect(await acyclic()).toBe(true);
  });
});

/** No instance reaches itself along either side of any link (findHierarchyLinkProblems does not look for loops). */
async function acyclic(): Promise<boolean> {
  const up = new Map<number, Set<number>>();
  const add = (child: number, parent: number) => { if (!up.has(child)) up.set(child, new Set()); up.get(child)!.add(parent); };
  for (const inst of (await readLayout()).layers.flatMap(l => l.instances)) {
    const graph = inst.sceneGraphData;
    if (typeof graph?.['parent-uid'] === 'number') add(inst.uid, graph['parent-uid']);
    for (const child of graph?.children ?? []) add(child.uid, inst.uid);
  }
  const reaches = (from: number, target: number, seen = new Set<number>()): boolean =>
    [...(up.get(from) ?? [])].some(p => p === target || (!seen.has(p) && (seen.add(p), reaches(p, target, seen))));
  return [...up.keys()].every(uid => !reaches(uid, uid));
}

describe('remove_instance_children', () => {
  it('refuses a parentUid that names no instance, and changes nothing', async () => {
    await setup();
    const before = await readFile(layoutPath(), 'utf8');
    const data = await call('remove_instance_children', { parentUid: 42 });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('No instance with UID 42 in the layout. Use get_layout_details to see the instance UIDs. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('detaches every child of a parent, on every layer', async () => {
    await setup();
    const data = await call('remove_instance_children', { parentUid: 0 });
    expect(data.detached).toEqual([1, 2]);
    const after = await links();
    expect([after[0], after[1], after[2]]).toEqual([[null, undefined], [null, undefined], [null, undefined]]);
    expect(await linkProblems()).toEqual([]);
  });

  it('drops entries that name no instance or a child of another parent, and says so', async () => {
    await setup();
    const layout = await readLayout();
    layout.layers[0].instances[0].sceneGraphData = parentRecord(0, [1, 2, 7]);
    layout.layers[1].instances[0].sceneGraphData = childRecord(2, 3);
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const data = await call('remove_instance_children', { parentUid: 0 });
    expect(data).toMatchObject({ detached: [1], missing: [7], otherParent: [2] });
    expect(data.warnings?.join(' ')).toContain('UID 7 names no instance of the layout');
    expect((await links())[2]).toEqual([3, undefined]);
  });

  it('detaches a child that names the parent without being listed (a one-sided link), and says so', async () => {
    await setup();
    const layout = await readLayout();
    layout.layers[0].instances[2].sceneGraphData = childRecord(3, 0); // UID 3 names 0; 0 lists 1 and 2 only
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const data = await call('remove_instance_children', { parentUid: 0 });
    expect(data).toMatchObject({ detached: [1, 2], unlisted: [3] });
    expect(data.warnings?.join(' ')).toContain('UID 3 named UID 0 as their parent without being listed as its children (a one-sided link)');
    expect((await links())[3]).toEqual([null, undefined]);
    expect(await linkProblems()).toEqual([]);
  });

  it('refuses unlisted children that share a UID, and changes nothing', async () => {
    await setup();
    const layout = await readLayout();
    layout.layers[1].instances.push(instance(5, childRecord(5, 0)), instance(5, childRecord(5, 0)));
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const before = await readFile(layoutPath(), 'utf8');
    expect((await call('remove_instance_children', { parentUid: 0 })).text)
      .toContain('Child UID 5 is used by 2 instances of the layout (duplicate-uid in validate_project), so which one is meant cannot be told. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('reports a parent without children as unchanged', async () => {
    await setup();
    const data = await call('remove_instance_children', { parentUid: 3 });
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
  });
});

describe('a failed layout write', () => {
  it('puts the layout back when its write fails its read-back', async () => {
    await setup();
    const before = await readFile(layoutPath(), 'utf8');
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    internals.verifyWrittenFile = async (path, name, text) => {
      if (path.endsWith('Layout 1.json')) throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
      return verify(path, name, text);
    };
    const data = await call('set_instance_parent', { childUid: 4, parentUid: 3 });
    expect(data.text).toContain('The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });
});
