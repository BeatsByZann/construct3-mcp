/**
 * Real-writer tests for the bulk instance tools: add_instances_to_layout,
 * update_instances, move_instances and delete_instances_from_layout.
 *
 * Each bulk call must write its layout once, write nothing when any item fails
 * or dryRun is set, and leave the layout exactly as the same edits made one at
 * a time with the single tools would.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const LAYOUT = 'Layout 1';

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

interface Project {
  dir: string;
  server: MockServer;
  writer: Construct3ProjectWriter;
  layoutFile: string;
}

async function openProject(): Promise<Project> {
  resetProjectIndex();
  const dir = await mkdtemp(join(tmpdir(), 'c3-bulk-int-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  const server = new MockServer();
  registerLayoutTools({ server, reader, writer, idGen } as any);
  const added = parseResult(await server.callTool('add_layer', { layoutName: LAYOUT, layerName: 'Top' }));
  expect(added.success).toBe(true);
  return { dir, server, writer, layoutFile: join(dir, 'layouts', `${LAYOUT}.json`) };
}

/** Every instance of the layout as [layer, uid] in stored order. */
async function placements(project: Project): Promise<Array<[string, number]>> {
  const layout = JSON.parse(await readFile(project.layoutFile, 'utf-8'));
  return layout.layers.flatMap((l: any) => l.instances.map((i: any) => [l.name, i.uid] as [string, number]));
}

/** The layout file with SIDs, which are random, replaced by a placeholder. */
async function layoutWithoutSids(project: Project): Promise<string> {
  return (await readFile(project.layoutFile, 'utf-8')).replace(/"sid": \d+/g, '"sid": 0');
}

const SPRITES = [
  { layerName: 'Main', objectType: 'Sprite', x: 10, y: 20 },
  { layerName: 'Top', objectType: 'Sprite', x: 30, y: 40, width: 64, height: 32, angle: 0.5, tags: 'enemy' },
  { layerName: 'Main', objectType: 'Sprite', x: 50, y: 60, showing: false },
];

describe('bulk instance tools (real project on disk)', () => {
  let project: Project;
  const opened: Project[] = [];

  beforeEach(async () => {
    project = await openProject();
    opened.push(project);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const p of opened.splice(0)) await rm(p.dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('add_instances_to_layout places every item with fresh UIDs in one write', async () => {
    const write = vi.spyOn(project.writer, 'writeEntityFile');
    const result = parseResult(await project.server.callTool('add_instances_to_layout', { layoutName: LAYOUT, instances: SPRITES }));
    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(write).toHaveBeenCalledTimes(1);

    const uids = result.results.map((r: any) => r.uid);
    expect(new Set(uids).size).toBe(3);
    // The fixture's only instance has UID 0, so new ones start above it.
    expect(uids.every((u: number) => u > 0)).toBe(true);
    expect(await placements(project)).toEqual([['Main', 0], ['Main', uids[0]], ['Main', uids[2]], ['Top', uids[1]]]);
  });

  it('add_instances_to_layout writes nothing when one item fails, and names that item', async () => {
    const before = await readFile(project.layoutFile, 'utf-8');
    const write = vi.spyOn(project.writer, 'writeEntityFile');
    const result = await project.server.callTool('add_instances_to_layout', {
      layoutName: LAYOUT,
      instances: [SPRITES[0], { ...SPRITES[1], layerName: 'Nowhere' }, SPRITES[2]],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Item 1: Layer "Nowhere" not found');
    expect(result.content[0].text).toContain('Nothing was written.');
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(project.layoutFile, 'utf-8')).toBe(before);
  });

  it('add_instances_to_layout refuses an unknown object type by item index', async () => {
    const before = await readFile(project.layoutFile, 'utf-8');
    const result = await project.server.callTool('add_instances_to_layout', {
      layoutName: LAYOUT,
      instances: [SPRITES[0], SPRITES[1], { ...SPRITES[2], objectType: 'Ghost' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Item 2: Object type "Ghost" does not exist');
    expect(await readFile(project.layoutFile, 'utf-8')).toBe(before);
  });

  it('dryRun reports the results of every bulk tool and writes nothing', async () => {
    const placed = parseResult(await project.server.callTool('add_instances_to_layout', { layoutName: LAYOUT, instances: SPRITES }));
    const [a, b] = placed.results.map((r: any) => r.uid);
    const before = await readFile(project.layoutFile, 'utf-8');
    const write = vi.spyOn(project.writer, 'writeEntityFile');

    const calls: Array<[string, Record<string, unknown>]> = [
      ['add_instances_to_layout', { instances: SPRITES }],
      ['update_instances', { updates: [{ uid: a, x: 999 }] }],
      ['move_instances', { moves: [{ uid: a, toLayer: 'Top' }] }],
      ['delete_instances_from_layout', { uids: [a, b] }],
    ];
    for (const [tool, args] of calls) {
      const result = parseResult(await project.server.callTool(tool, { layoutName: LAYOUT, dryRun: true, ...args }));
      expect(result.success, tool).toBe(true);
      expect(result.action, tool).toBe('dry-run');
      expect(result.message, tool).toContain('Nothing was written.');
    }
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(project.layoutFile, 'utf-8')).toBe(before);
  });

  it('update_instances applies every update in one write, and refuses an empty item', async () => {
    const placed = parseResult(await project.server.callTool('add_instances_to_layout', { layoutName: LAYOUT, instances: SPRITES }));
    const [a, b] = placed.results.map((r: any) => r.uid);

    const empty = await project.server.callTool('update_instances', { layoutName: LAYOUT, updates: [{ uid: a, x: 1 }, { uid: b }] });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain('Item 1: No updates provided.');

    const write = vi.spyOn(project.writer, 'writeEntityFile');
    const result = parseResult(await project.server.callTool('update_instances', {
      layoutName: LAYOUT,
      updates: [{ uid: a, x: 111, tags: 'moved' }, { uid: b, y: 222 }],
    }));
    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const layout = JSON.parse(await readFile(project.layoutFile, 'utf-8'));
    const all = layout.layers.flatMap((l: any) => l.instances);
    expect(all.find((i: any) => i.uid === a).world.x).toBe(111);
    expect(all.find((i: any) => i.uid === a).tags).toBe('moved');
    expect(all.find((i: any) => i.uid === b).world.y).toBe(222);
  });

  it('update_instances writes nothing when a later item names a missing UID', async () => {
    const placed = parseResult(await project.server.callTool('add_instances_to_layout', { layoutName: LAYOUT, instances: SPRITES }));
    const before = await readFile(project.layoutFile, 'utf-8');
    const result = await project.server.callTool('update_instances', {
      layoutName: LAYOUT,
      updates: [{ uid: placed.results[0].uid, x: 5 }, { uid: 987654, x: 6 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Item 1: Instance with UID 987654 not found');
    expect(await readFile(project.layoutFile, 'utf-8')).toBe(before);
  });

  it('move_instances applies moves in list order, and reports a no-op without writing', async () => {
    const placed = parseResult(await project.server.callTool('add_instances_to_layout', { layoutName: LAYOUT, instances: SPRITES }));
    const [a, b, c] = placed.results.map((r: any) => r.uid);

    // Main holds [0, a, c]; move c to the bottom, then put a directly below c.
    const result = parseResult(await project.server.callTool('move_instances', {
      layoutName: LAYOUT,
      moves: [{ uid: c, position: 'bottom' }, { uid: a, belowUid: c }, { uid: b, toLayer: 'Main' }],
    }));
    expect(result.success).toBe(true);
    expect(await placements(project)).toEqual([['Main', a], ['Main', c], ['Main', 0], ['Main', b]]);

    const write = vi.spyOn(project.writer, 'writeEntityFile');
    const noop = parseResult(await project.server.callTool('move_instances', { layoutName: LAYOUT, moves: [{ uid: b, position: 'top' }] }));
    expect(noop.action).toBe('unchanged');
    expect(write).not.toHaveBeenCalled();
  });

  it('move_instances checks every item\'s arguments before reading the layout', async () => {
    const before = await readFile(project.layoutFile, 'utf-8');
    const result = await project.server.callTool('move_instances', {
      layoutName: LAYOUT,
      moves: [{ uid: 0, position: 'top' }, { uid: 0, position: 'top', aboveUid: 0 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Item 1: Give at most one of position, aboveUid and belowUid.');
    expect(await readFile(project.layoutFile, 'utf-8')).toBe(before);
  });

  it('delete_instances_from_layout removes every UID in one write and detaches hierarchy links', async () => {
    const placed = parseResult(await project.server.callTool('add_instances_to_layout', { layoutName: LAYOUT, instances: SPRITES }));
    const [a, b, c] = placed.results.map((r: any) => r.uid);
    expect(parseResult(await project.server.callTool('set_instance_parent', { layoutName: LAYOUT, childUid: c, parentUid: a })).success).toBe(true);

    const write = vi.spyOn(project.writer, 'writeEntityFile');
    const result = parseResult(await project.server.callTool('delete_instances_from_layout', { layoutName: LAYOUT, uids: [a, b] }));
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain(`Item 0: Detached its hierarchy children: ${c}.`);

    expect(await placements(project)).toEqual([['Main', 0], ['Main', c]]);
    const layout = JSON.parse(await readFile(project.layoutFile, 'utf-8'));
    const child = layout.layers[0].instances.find((i: any) => i.uid === c);
    expect(child.sceneGraphData['parent-uid']).toBeNull();
  });

  it('delete_instances_from_layout refuses a repeated or missing UID and writes nothing', async () => {
    const placed = parseResult(await project.server.callTool('add_instances_to_layout', { layoutName: LAYOUT, instances: SPRITES }));
    const [a, b] = placed.results.map((r: any) => r.uid);
    const before = await readFile(project.layoutFile, 'utf-8');

    const repeated = await project.server.callTool('delete_instances_from_layout', { layoutName: LAYOUT, uids: [a, b, a] });
    expect(repeated.isError).toBe(true);
    expect(repeated.content[0].text).toContain(`Item 2: UID ${a} is listed more than once.`);

    const missing = await project.server.callTool('delete_instances_from_layout', { layoutName: LAYOUT, uids: [a, 987654] });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('Item 1: Instance with UID 987654 not found');
    expect(await readFile(project.layoutFile, 'utf-8')).toBe(before);
  });

  it('refuses more than 500 items', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ layerName: 'Main', objectType: 'Sprite', x: i, y: 0 }));
    await expect(project.server.callTool('add_instances_to_layout', { layoutName: LAYOUT, instances: tooMany })).rejects.toThrow();
  });

  it('leaves the layout exactly as the same edits made one at a time with the single tools', async () => {
    const single = await openProject();
    opened.push(single);

    // Bulk path.
    const placed = parseResult(await project.server.callTool('add_instances_to_layout', { layoutName: LAYOUT, instances: SPRITES }));
    const [a, b, c] = placed.results.map((r: any) => r.uid);
    const updates = [
      { uid: a, x: 5, color: [1, 0, 0, 1], instanceVariables: {} },
      { uid: c, width: 12, locked: true, properties: { 'initial-animation': 'Animation 1' } },
    ];
    const moves = [{ uid: c, toLayer: 'Top', position: 0 }, { uid: a, position: 'bottom' as const }];
    expect(parseResult(await project.server.callTool('update_instances', { layoutName: LAYOUT, updates })).success).toBe(true);
    expect(parseResult(await project.server.callTool('move_instances', { layoutName: LAYOUT, moves })).success).toBe(true);
    expect(parseResult(await project.server.callTool('delete_instances_from_layout', { layoutName: LAYOUT, uids: [b] })).success).toBe(true);

    // Single-tool path on an identical copy. UIDs are sequential from the
    // same starting point, so they match; SIDs are random and are masked.
    const singleUids: number[] = [];
    for (const item of SPRITES) {
      const r = parseResult(await single.server.callTool('add_instance_to_layout', { layoutName: LAYOUT, ...item }));
      singleUids.push(r.generatedUid);
    }
    expect(singleUids).toEqual([a, b, c]);
    for (const u of updates) expect(parseResult(await single.server.callTool('update_instance', { layoutName: LAYOUT, ...u })).success).toBe(true);
    for (const m of moves) expect(parseResult(await single.server.callTool('move_instance', { layoutName: LAYOUT, ...m })).success).toBe(true);
    expect(parseResult(await single.server.callTool('delete_instance_from_layout', { layoutName: LAYOUT, uid: b })).success).toBe(true);

    expect(await layoutWithoutSids(project)).toBe(await layoutWithoutSids(single));
  });
});
