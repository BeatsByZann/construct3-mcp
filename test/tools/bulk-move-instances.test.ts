/**
 * move_instances (#ISSUE): many moves of instances of one layout in one
 * call and one write, each applied as move_instance applies it, in list
 * order. Every move is applied to the layout in memory first; a refused
 * move, or a step that throws, refuses the whole call before anything is
 * written, and a failed write is rolled back. Synthetic data on a temp copy
 * of the minimal fixture, with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerLayerOrderTools } from '../../src/tools/layer-order.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const NOTHING_CHANGED = 'Nothing was changed.';
// The limit of move_instances' moves, as its Zod schema states it
const MOVE_LIMIT = 500;

interface InstanceJson { type: string; uid: number; sid: number; [key: string]: unknown }
interface LayerJson { name: string; sid: number; instances: InstanceJson[]; subLayers: LayerJson[]; [key: string]: unknown }
interface LayoutFile { name: string; layers: LayerJson[]; [key: string]: unknown }
interface MoveResult { index: number; uid: number; fromLayer: string; fromIndex: number; toLayer: string; toIndex: number; layerInstanceCount: number }
interface ToolData {
  isError?: boolean; text?: string; success?: boolean; action?: string; dryRun?: boolean; count?: number; message?: string;
  editorNote?: string; backupFile?: string; results?: MoveResult[]; [key: string]: unknown;
}
type Move = Record<string, unknown>;

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
const layoutBytes = () => readFile(layoutPath());
const readLayout = async (): Promise<LayoutFile> => JSON.parse(await readFile(layoutPath(), 'utf8')) as LayoutFile;
const call = async (tool: string, args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const move = (moves: Move[], extra: Record<string, unknown> = {}) => call('move_instances', { layoutName: 'Layout 1', moves, ...extra });
/** The write spy of a call: whether the layout file was written. */
const writeSpy = () => vi.spyOn(writer, 'writeEntityFile');

function layer(name: string, sid: number, instances: InstanceJson[] = []): LayerJson {
  return { name, sid, instances, subLayers: [], isInitiallyVisible: true };
}
function sprite(uid: number): InstanceJson {
  return { type: 'Sprite', uid, sid: 560000000000000 + uid, properties: {}, instanceVariables: {}, behaviors: {}, world: { x: uid, y: 0, width: 8, height: 8 } };
}
const uidsOn = async (name: string) => (await readLayout()).layers.find(l => l.name === name)!.instances.map(i => i.uid);

/** Put the layout file back to `bytes` and re-read the project. */
async function resetLayout(bytes: Buffer | string): Promise<void> {
  await writeFile(layoutPath(), bytes);
  await reader.loadProject();
}

/** Layout 1: Main holds sprites 1 to 4, Top holds 5 and 6. */
async function setupLayers(): Promise<void> {
  const layout = await readLayout();
  layout.layers = [
    layer('Main', 500000000000001, [sprite(1), sprite(2), sprite(3), sprite(4)]),
    layer('Top', 500000000000002, [sprite(5), sprite(6)]),
  ];
  await resetLayout(JSON.stringify(layout, null, '\t'));
}

/** The writer's read-back of the layout fails once, after the write the call made. */
function failLayoutReadBack(): void {
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  let failed = false;
  vi.spyOn(internals, 'verifyWrittenFile').mockImplementation(async (path, name, text) => {
    if (!failed && path.endsWith('Layout 1.json')) {
      failed = true;
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    }
    return verify(path, name, text);
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-bulk-move-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayerOrderTools({ server, reader, writer, idGen } as never);
  await setupLayers();
  resetProjectIndex();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('move_instances', () => {
  it('applies every move in order and writes once', async () => {
    const spy = writeSpy();
    const data = await move([{ uid: 1, toLayer: 'Top' }, { uid: 2, position: 'last' }]);
    expect(data.action).toBe('updated');
    expect(data.count).toBe(2);
    expect(data.backupFile).toEqual(expect.any(String));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await uidsOn('Main')).toEqual([3, 4, 2]);
    expect(await uidsOn('Top')).toEqual([5, 6, 1]);
    expect(data.results).toEqual([
      { index: 0, uid: 1, fromLayer: 'Main', fromIndex: 0, toLayer: 'Top', toIndex: 2, layerInstanceCount: 3 },
      { index: 1, uid: 2, fromLayer: 'Main', fromIndex: 0, toLayer: 'Main', toIndex: 2, layerInstanceCount: 3 },
    ]);
  });

  it('counts each move\'s position after the moves before it', async () => {
    await move([{ uid: 1, position: 'last' }, { uid: 2, position: 2 }]);
    // After item 0 Main is [2, 3, 4, 1]; 2 goes to index 2 of [3, 4, 1]. Counted on the original list it would be [1, 3, 2, 4]
    expect(await uidsOn('Main')).toEqual([3, 4, 2, 1]);
  });

  it('takes an anchor an earlier move put on the destination layer', async () => {
    // Instance 5 is on Top until item 0 moves it, so item 1 can name it as the anchor on Main
    const data = await move([{ uid: 5, toLayer: 'Main', position: 0 }, { uid: 6, toLayer: 'Main', afterUid: 5 }]);
    expect(data.action).toBe('updated');
    expect(await uidsOn('Main')).toEqual([5, 6, 1, 2, 3, 4]);
    expect(await uidsOn('Top')).toEqual([]);
  });

  it('refuses the whole call at the first bad move, changing nothing', async () => {
    const spy = writeSpy();
    const before = await layoutBytes();

    const anchor = await move([{ uid: 1, position: 'last' }, { uid: 2, toLayer: 'Main', afterUid: 5 }]);
    expect(anchor.isError).toBe(true);
    expect(anchor.text).toBe('Item 1: Instance 5 is not on the destination layer "Main": '
      + `afterUid and beforeUid name an instance of the destination layer. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);

    const both = await move([{ uid: 1, position: 'last', afterUid: 2 }]);
    expect(both.text).toBe(`Item 0: Give at most one of position, afterUid and beforeUid. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a layout name in another letter case, and a layout it cannot read', async () => {
    const spy = writeSpy();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = await layoutBytes();
    const unchanged = async (expected: Buffer) => {
      expect(Buffer.compare(await layoutBytes(), expected)).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    };
    const moves = [{ uid: 1, position: 'last' }];

    const letterCase = await call('move_instances', { layoutName: 'layout 1', moves });
    expect(letterCase.isError).toBe(true);
    expect(letterCase.text).toBe(`Layout "layout 1" not found: names are matched with their letter case. Did you mean "Layout 1"? ${NOTHING_CHANGED}`);
    await unchanged(original);

    const missing = await call('move_instances', { layoutName: 'Nope', moves });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Layout "Nope" not found.');
    expect(missing.text!.endsWith(` ${NOTHING_CHANGED}`)).toBe(true);
    await unchanged(original);

    const broken = Buffer.from('{ broken');
    await resetLayout(broken);
    const unreadable = await move(moves);
    expect(unreadable.isError).toBe(true);
    expect(unreadable.text!.startsWith('Cannot read layout "Layout 1": ')).toBe(true);
    expect(unreadable.text!.endsWith(` ${NOTHING_CHANGED}`)).toBe(true);
    await unchanged(broken);

    const nothing = Buffer.from('null');
    await resetLayout(nothing);
    const notAnObject = await move(moves);
    expect(notAnObject.text).toBe(`Cannot read layout "Layout 1": it does not hold a layout object. ${NOTHING_CHANGED}`);
    await unchanged(nothing);

    await resetLayout(original);
    consoleError.mockClear();
    vi.spyOn(reader, 'listLayouts').mockRejectedValueOnce(new Error('EMFILE'));
    const listing = await move(moves);
    expect(listing.text).toBe(`The change was stopped before anything was written: EMFILE. ${NOTHING_CHANGED}`);
    expect(consoleError.mock.calls.some(args => String(args[0]).includes('[move_instances] failed'))).toBe(false);
    await unchanged(original);
  });

  it('reports the first refused move in list order, whatever kind its refusal is', async () => {
    const before = await layoutBytes();
    // Item 1 has nothing to do, but item 0 is refused first
    const unknown = await move([{ uid: 999, position: 0 }, { uid: 1 }]);
    expect(unknown.text).toBe(`Item 0: Instance with UID 999 not found in layout "Layout 1". Use get_layout_details to see all instance UIDs. ${NOTHING_CHANGED}`);
    // Item 1's arguments are refused at item 1's turn, before item 2 is looked at
    const arguments_ = await move([{ uid: 1, position: 0 }, { uid: 2, position: 0, afterUid: 3 }, { uid: 999, position: 0 }]);
    expect(arguments_.text).toBe(`Item 1: Give at most one of position, afterUid and beforeUid. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
  });

  it('turns an error a move throws into the item\'s refusal', async () => {
    const spy = writeSpy();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await layoutBytes();
    // The call reads `layers` once before the moves (to compare afterwards); the next read, in the first move, throws
    const real = await reader.readLayout('Layout 1');
    let reads = 0;
    const unreadable = { ...real };
    Object.defineProperty(unreadable, 'layers', {
      enumerable: true,
      get: () => {
        if (reads++ === 0) return real.layers;
        throw new Error('layers unreadable');
      },
    });
    vi.spyOn(reader, 'readLayout').mockResolvedValueOnce(unreadable as typeof real);

    const data = await move([{ uid: 1, position: 0 }]);
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`Item 0: layers unreadable. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.some(args => String(args[0]).includes('[move_instances] failed'))).toBe(false);
  });

  it('answers a throw outside the moves with the stopped-before-write refusal', async () => {
    const spy = writeSpy();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await layoutBytes();
    // The call serializes the layout it read before the moves, outside the item loop
    const real = await reader.readLayout('Layout 1');
    const unserializable = { ...real, toJSON: () => { throw new Error('layout unserializable'); } };
    vi.spyOn(reader, 'readLayout').mockResolvedValueOnce(unserializable as typeof real);

    const data = await move([{ uid: 1, position: 0 }]);
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`The change was stopped before anything was written: layout unserializable. ${NOTHING_CHANGED}`);
    expect(consoleError.mock.calls.some(args => String(args[0]).includes('[move_instances] failed'))).toBe(true);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('writes nothing when the layout ends as it was', async () => {
    const spy = writeSpy();
    const before = await layoutBytes();
    const moves = [{ uid: 1, position: 'last' }, { uid: 1, position: 0 }];

    const data = await move(moves);
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
    expect(data.dryRun).toBeUndefined();
    expect(data.count).toBe(2);

    const dry = await move(moves, { dryRun: true });
    expect(dry.action).toBe('unchanged');
    expect(dry.dryRun).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
  });

  it('a dry run writes nothing', async () => {
    const spy = writeSpy();
    const before = await layoutBytes();
    const data = await move([{ uid: 1, toLayer: 'Top' }, { uid: 2, position: 'last' }], { dryRun: true });
    expect(data.action).toBe('dry-run');
    expect(data.dryRun).toBe(true);
    expect(data.results).toHaveLength(2);
    expect(data.backupFile).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
  });

  it('puts the layout back when its read-back fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await layoutBytes();
    failLayoutReadBack();

    const data = await move([{ uid: 1, toLayer: 'Top' }, { uid: 2, position: 'last' }]);
    expect(data.isError).toBe(true);
    expect(data.text!.startsWith('Error writing layout "Layout 1": ')).toBe(true);
    expect(data.text).toContain('The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
  });

  it('refuses a UID two instances share, naming the item', async () => {
    const layout = await readLayout();
    layout.layers[1].instances.push(sprite(1));
    await resetLayout(JSON.stringify(layout, null, '\t'));
    const spy = writeSpy();
    const before = await layoutBytes();

    const data = await move([{ uid: 1, position: 'last' }]);
    expect(data.text).toBe('Item 0: UID 1 is used by 2 instances of layout "Layout 1" (duplicate-uid in validate_project), '
      + `so which one is meant cannot be told. ${NOTHING_CHANGED}`);
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses more moves than the limit, in argument parsing', async () => {
    const before = await layoutBytes();
    const moves = Array.from({ length: MOVE_LIMIT + 1 }, () => ({ uid: 1, position: 'last' }));
    await expect(move(moves)).rejects.toThrow(new RegExp(`at most ${MOVE_LIMIT} element`));
    expect(Buffer.compare(await layoutBytes(), before)).toBe(0);
  });
});
