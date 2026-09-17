/**
 * Real-filesystem tests for the flowchart tools.
 *
 * The unit tests pin the guards that fire before any I/O. These prove the
 * on-disk outcome through the real reader, writer and IdGenerator: the file
 * layout, the project.c3proj registration, the pnSIDs/poSIDs/nodeSIDs
 * bookkeeping, and the reference cleanup on delete.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerFlowchartTools } from '../../src/tools/flowchart-tools.js';
import type { Flowchart } from '../../src/construct3/types.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

const FLOWCHART_PLUGIN = {
  type: 'plugin',
  id: 'Flowchart',
  name: 'Flowchart controller',
  author: 'Scirra',
  bundled: false,
};

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

async function makeTempProject(withPlugin: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-flowchart-int-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  if (withPlugin) {
    const projectPath = join(dir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf-8'));
    project.usedAddons.push(FLOWCHART_PLUGIN);
    await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
  }
  return dir;
}

describe('flowchart tools (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let idGen: IdGenerator;
  let server: MockServer;

  async function boot(dir: string) {
    tmpDir = dir;
    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerFlowchartTools({ server, reader, writer, idGen } as any);
  }

  beforeEach(async () => {
    await boot(await makeTempProject(true));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  /** Read a flowchart straight off disk, bypassing the tools. */
  async function onDisk(name: string, subfolder = ''): Promise<Flowchart> {
    const path = subfolder
      ? join(tmpDir, 'flowcharts', ...subfolder.split('/'), `${name}.json`)
      : join(tmpDir, 'flowcharts', `${name}.json`);
    return JSON.parse(await readFile(path, 'utf-8')) as Flowchart;
  }

  async function registeredFlowcharts(): Promise<unknown> {
    const project = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8'));
    return project.flowcharts;
  }

  /** Create "Graph" and add a node; returns the node SID and its output SIDs. */
  async function addNode(
    args: Record<string, unknown>,
  ): Promise<{ sid: number; outputSids: number[] }> {
    const result = parseResult(await server.callTool('add_flowchart_node', { flowchartName: 'Graph', ...args }));
    expect(result.success).toBe(true);
    return { sid: result.generatedSid, outputSids: result.outputSids };
  }

  async function createGraph() {
    const created = parseResult(await server.callTool('create_flowchart', { name: 'Graph' }));
    expect(created.success).toBe(true);
    return created;
  }

  // ─── create / list / get / delete ───────────────────────

  it('creates a flowchart file with the r495 shape and registers it', async () => {
    const created = await createGraph();
    expect(created.category).toBe('flowchart');
    expect(created.action).toBe('created');
    expect(typeof created.generatedSid).toBe('number');

    const data = await onDisk('Graph');
    expect(data.sid).toBe(created.generatedSid);
    expect(data.name).toBe('Graph');
    expect(data.nodes).toEqual([]);
    expect(data['preset-nodes']).toEqual({ items: [], subfolders: [] });
    expect(data.w).toBe(20000);
    expect(data.h).toBe(20000);
    expect(Object.keys(data)).toEqual(['sid', 'nodes', 'preset-nodes', 'name', 'w', 'h']);

    expect(await registeredFlowcharts()).toEqual({ items: ['Graph'], subfolders: [] });

    const listed = parseResult(await server.callTool('list_flowcharts', {}));
    expect(listed.flowcharts).toEqual(['Graph']);
    expect(listed.count).toBe(1);
  });

  it('refuses to create a flowchart when the Flowchart plugin is absent, and writes nothing', async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
    await boot(await makeTempProject(false));

    const result = await server.callTool('create_flowchart', { name: 'Graph' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Flowchart plugin is not listed');

    await expect(stat(join(tmpDir, 'flowcharts', 'Graph.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const project = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8'));
    expect(project.flowcharts).toBeUndefined();
    expect(project.usedAddons.some((a: { id: string }) => a.id === 'Flowchart')).toBe(false);
  });

  it('creates a flowchart in a nested subfolder and finds it again there', async () => {
    const created = parseResult(await server.callTool('create_flowchart', {
      name: 'State Machine 1',
      subfolder: 'AI Graph/State Machines',
    }));
    expect(created.success).toBe(true);

    const data = await onDisk('State Machine 1', 'AI Graph/State Machines');
    expect(data.name).toBe('State Machine 1');

    expect(await registeredFlowcharts()).toEqual({
      items: [],
      subfolders: [
        {
          items: [],
          subfolders: [{ items: ['State Machine 1'], subfolders: [], name: 'State Machines' }],
          name: 'AI Graph',
        },
      ],
    });

    // The nested file is reachable through the tools, not just on disk.
    const details = parseResult(await server.callTool('get_flowchart_details', { name: 'State Machine 1' }));
    expect(details.sid).toBe(created.generatedSid);

    const added = parseResult(await server.callTool('add_flowchart_node', {
      flowchartName: 'State Machine 1', caption: 'Root', x: 0, y: 0, isStart: true,
    }));
    expect(added.success).toBe(true);
    expect((await onDisk('State Machine 1', 'AI Graph/State Machines')).nodes).toHaveLength(1);
  });

  it('deletes the flowchart file, its .uistate sibling and its registration', async () => {
    await createGraph();
    await writeFile(join(tmpDir, 'flowcharts', 'Graph.uistate.json'), '{"flowchart":{},"nodes":[]}', 'utf-8');

    const result = parseResult(await server.callTool('delete_flowchart', { name: 'Graph' }));
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('Graph.uistate.json');

    await expect(stat(join(tmpDir, 'flowcharts', 'Graph.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(tmpDir, 'flowcharts', 'Graph.json.bak'))).resolves.toBeDefined();
    await expect(stat(join(tmpDir, 'flowcharts', 'Graph.uistate.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await registeredFlowcharts()).toEqual({ items: [], subfolders: [] });

    const listed = parseResult(await server.callTool('list_flowcharts', {}));
    expect(listed.count).toBe(0);
  });

  // ─── nodes ──────────────────────────────────────────────

  it('adds a node with the sampled field layout and fresh SIDs for every output', async () => {
    await createGraph();
    const { sid, outputSids } = await addNode({
      caption: 'Root', x: 100, y: 200, isStart: true,
      outputs: [{ name: 'Option 1', value: 'Value 1' }, { name: 'Option 2' }],
    });

    const node = (await onDisk('Graph')).nodes[0];
    expect(node.sid).toBe(sid);
    expect(node).toMatchObject({
      pnSIDs: [], poSIDs: [], nodeSIDs: [],
      x: 100, y: 200, w: 300, h: 133,
      t: 'Root', s: true, e: true, pi: 0, c: 'Root', ty: 'dictionary',
      pr: false, prfsid: null, prfnsid: null,
    });
    expect(node.outputs).toEqual([
      { sid: outputSids[0], cnSID: null, name: 'Option 1', value: 'Value 1', enable: true, default: false },
      { sid: outputSids[1], cnSID: null, name: 'Option 2', value: '', enable: true, default: false },
    ]);
    // Node SID and both output SIDs are distinct.
    expect(new Set([sid, ...outputSids]).size).toBe(3);
  });

  it('uses nodeType for "t" when it differs from the caption', async () => {
    await createGraph();
    await addNode({ caption: 'State X', nodeType: 'State Definition', x: 0, y: 0, isStart: true });
    const node = (await onDisk('Graph')).nodes[0];
    expect(node.t).toBe('State Definition');
    expect(node.c).toBe('State X');
  });

  it('keeps exactly one start node when another node claims the flag', async () => {
    await createGraph();
    const first = await addNode({ caption: 'A', x: 0, y: 0, isStart: true });
    const second = await addNode({ caption: 'B', x: 400, y: 0, isStart: true });

    const nodes = (await onDisk('Graph')).nodes;
    expect(nodes.find(n => n.sid === first.sid)!.s).toBe(false);
    expect(nodes.find(n => n.sid === second.sid)!.s).toBe(true);
    expect(nodes.filter(n => n.s === true)).toHaveLength(1);
  });

  it('keeps exactly one start node when update_flowchart_node moves the flag', async () => {
    await createGraph();
    const first = await addNode({ caption: 'A', x: 0, y: 0, isStart: true });
    const second = await addNode({ caption: 'B', x: 400, y: 0 });

    const result = parseResult(await server.callTool('update_flowchart_node', {
      flowchartName: 'Graph', nodeSid: second.sid, isStart: true,
    }));
    expect(result.success).toBe(true);

    const nodes = (await onDisk('Graph')).nodes;
    expect(nodes.find(n => n.sid === first.sid)!.s).toBe(false);
    expect(nodes.find(n => n.sid === second.sid)!.s).toBe(true);
    expect(nodes.filter(n => n.s === true)).toHaveLength(1);
  });

  it('warns when a flowchart with nodes is left without a start node', async () => {
    await createGraph();
    const result = parseResult(await server.callTool('add_flowchart_node', {
      flowchartName: 'Graph', caption: 'A', x: 0, y: 0,
    }));
    expect(result.warnings.join(' ')).toContain('no start node');
  });

  it('updates node properties and preserves connections, preset links and unknown keys', async () => {
    await createGraph();
    const parent = await addNode({ caption: 'Parent', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }] });
    const child = await addNode({ caption: 'Child', x: 400, y: 0 });
    await server.callTool('connect_flowchart_nodes', {
      flowchartName: 'Graph', outputSid: parent.outputSids[0], targetNodeSid: child.sid,
    });

    // Give the child the preset markers and an unmodelled key, as a real
    // preset-derived node would carry.
    const path = join(tmpDir, 'flowcharts', 'Graph.json');
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Flowchart;
    const target = raw.nodes.find(n => n.sid === child.sid)!;
    target.pr = true;
    target.prfsid = 850729793124746;
    target.prfnsid = 164842432728706;
    target.futureKey = 'keep me';
    raw.futureTopLevelKey = 42;
    await writeFile(path, JSON.stringify(raw, null, '\t'), 'utf-8');

    const result = parseResult(await server.callTool('update_flowchart_node', {
      flowchartName: 'Graph', nodeSid: child.sid,
      caption: 'Renamed', enabled: false, parentIndex: 2, x: 11, y: 22, width: 400, height: 150,
    }));
    expect(result.success).toBe(true);

    const data = await onDisk('Graph');
    const updated = data.nodes.find(n => n.sid === child.sid)!;
    expect(updated).toMatchObject({
      c: 'Renamed', e: false, pi: 2, x: 11, y: 22, w: 400, h: 150,
      pr: true, prfsid: 850729793124746, prfnsid: 164842432728706,
      futureKey: 'keep me',
    });
    expect(updated.pnSIDs).toEqual([parent.sid]);
    expect(updated.poSIDs).toEqual([parent.outputSids[0]]);
    expect(data.futureTopLevelKey).toBe(42);
  });

  it('warns that the tags key was never observed in the r495 sample', async () => {
    await createGraph();
    const node = await addNode({ caption: 'A', x: 0, y: 0, isStart: true });
    const result = parseResult(await server.callTool('update_flowchart_node', {
      flowchartName: 'Graph', nodeSid: node.sid, tags: 'alpha,beta',
    }));
    expect(result.warnings.join(' ')).toContain('"tags"');
    expect((await onDisk('Graph')).nodes[0].tags).toBe('alpha,beta');
  });

  it('errors on an unknown node SID and lists the SIDs that do exist', async () => {
    await createGraph();
    const node = await addNode({ caption: 'A', x: 0, y: 0, isStart: true });
    const result = await server.callTool('update_flowchart_node', {
      flowchartName: 'Graph', nodeSid: 123, caption: 'X',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Node 123 not found');
    expect(result.content[0].text).toContain(String(node.sid));
  });

  it('deletes a node and cleans every reference to it', async () => {
    await createGraph();
    const parent = await addNode({
      caption: 'Parent', x: 0, y: 0, isStart: true,
      outputs: [{ name: 'Option 1' }, { name: 'Option 2' }],
    });
    const doomed = await addNode({ caption: 'Doomed', x: 400, y: 0, outputs: [{ name: 'Option 1' }] });
    const sibling = await addNode({ caption: 'Sibling', x: 400, y: 300 });
    const grandchild = await addNode({ caption: 'Grandchild', x: 800, y: 0 });

    await server.callTool('connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: parent.outputSids[0], targetNodeSid: doomed.sid });
    await server.callTool('connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: parent.outputSids[1], targetNodeSid: sibling.sid });
    await server.callTool('connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: doomed.outputSids[0], targetNodeSid: grandchild.sid });

    const result = parseResult(await server.callTool('delete_flowchart_node', { flowchartName: 'Graph', nodeSid: doomed.sid }));
    expect(result.success).toBe(true);

    const data = await onDisk('Graph');
    expect(data.nodes.map(n => n.sid)).not.toContain(doomed.sid);

    const parentNode = data.nodes.find(n => n.sid === parent.sid)!;
    expect(parentNode.nodeSIDs).toEqual([sibling.sid]);
    expect(parentNode.outputs[0].cnSID).toBeNull();
    // The surviving sibling connection is untouched.
    expect(parentNode.outputs[1].cnSID).toBe(sibling.sid);

    const grandchildNode = data.nodes.find(n => n.sid === grandchild.sid)!;
    expect(grandchildNode.pnSIDs).toEqual([]);
    expect(grandchildNode.poSIDs).toEqual([]);

    // No node anywhere still names the deleted node or one of its outputs.
    const doomedOutputSids = new Set(doomed.outputSids);
    for (const n of data.nodes) {
      expect(n.nodeSIDs).not.toContain(doomed.sid);
      expect(n.pnSIDs).not.toContain(doomed.sid);
      expect(n.pnSIDs.length).toBe(n.poSIDs.length);
      for (const po of n.poSIDs) expect(doomedOutputSids.has(po)).toBe(false);
      for (const o of n.outputs) expect(o.cnSID).not.toBe(doomed.sid);
    }
  });

  it('warns when the deleted node was the start node', async () => {
    await createGraph();
    const node = await addNode({ caption: 'A', x: 0, y: 0, isStart: true });
    await addNode({ caption: 'B', x: 400, y: 0 });
    const result = parseResult(await server.callTool('delete_flowchart_node', { flowchartName: 'Graph', nodeSid: node.sid }));
    expect(result.warnings.join(' ')).toContain('was the start node');
    expect(result.warnings.join(' ')).toContain('no start node');
  });

  // ─── outputs ────────────────────────────────────────────

  it('adds an output at the end or at a requested index', async () => {
    await createGraph();
    const node = await addNode({ caption: 'A', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }, { name: 'Option 3' }] });

    const appended = parseResult(await server.callTool('add_flowchart_output', {
      flowchartName: 'Graph', nodeSid: node.sid, name: 'Option 4', value: 'Value 4',
    }));
    const inserted = parseResult(await server.callTool('add_flowchart_output', {
      flowchartName: 'Graph', nodeSid: node.sid, name: 'Option 2', index: 1, enabled: false, isDefault: true,
    }));

    const outputs = (await onDisk('Graph')).nodes[0].outputs;
    expect(outputs.map(o => o.name)).toEqual(['Option 1', 'Option 2', 'Option 3', 'Option 4']);
    expect(outputs[1]).toMatchObject({ sid: inserted.generatedSid, cnSID: null, value: '', enable: false, default: true });
    expect(outputs[3].sid).toBe(appended.generatedSid);
  });

  it('rejects an insertion index past the end of the outputs array', async () => {
    await createGraph();
    const node = await addNode({ caption: 'A', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }] });
    const result = await server.callTool('add_flowchart_output', {
      flowchartName: 'Graph', nodeSid: node.sid, name: 'Option 2', index: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
    expect((await onDisk('Graph')).nodes[0].outputs).toHaveLength(1);
  });

  it('updates an output and preserves its connection', async () => {
    await createGraph();
    const parent = await addNode({ caption: 'Parent', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }] });
    const child = await addNode({ caption: 'Child', x: 400, y: 0 });
    await server.callTool('connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: parent.outputSids[0], targetNodeSid: child.sid });

    const result = parseResult(await server.callTool('update_flowchart_output', {
      flowchartName: 'Graph', outputSid: parent.outputSids[0],
      name: 'Condition', value: 'CheckIsHungry', enabled: false, isDefault: true,
    }));
    expect(result.success).toBe(true);

    const output = (await onDisk('Graph')).nodes.find(n => n.sid === parent.sid)!.outputs[0];
    expect(output).toEqual({
      sid: parent.outputSids[0], cnSID: child.sid, name: 'Condition',
      value: 'CheckIsHungry', enable: false, default: true,
    });
  });

  it('deletes an output and undoes the connection it held', async () => {
    await createGraph();
    const parent = await addNode({ caption: 'Parent', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }] });
    const child = await addNode({ caption: 'Child', x: 400, y: 0 });
    await server.callTool('connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: parent.outputSids[0], targetNodeSid: child.sid });

    const result = parseResult(await server.callTool('delete_flowchart_output', {
      flowchartName: 'Graph', outputSid: parent.outputSids[0],
    }));
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain(String(child.sid));

    const data = await onDisk('Graph');
    expect(data.nodes.find(n => n.sid === parent.sid)!.outputs).toEqual([]);
    expect(data.nodes.find(n => n.sid === parent.sid)!.nodeSIDs).toEqual([]);
    expect(data.nodes.find(n => n.sid === child.sid)!.pnSIDs).toEqual([]);
    expect(data.nodes.find(n => n.sid === child.sid)!.poSIDs).toEqual([]);
  });

  it('reorders outputs and rejects anything that is not a permutation', async () => {
    await createGraph();
    const node = await addNode({
      caption: 'A', x: 0, y: 0, isStart: true,
      outputs: [{ name: 'Option 1' }, { name: 'Option 2' }, { name: 'Option 3' }],
    });
    const [a, b, c] = node.outputSids;

    const tooShort = await server.callTool('reorder_flowchart_outputs', {
      flowchartName: 'Graph', nodeSid: node.sid, outputSids: [b, a],
    });
    expect(tooShort.isError).toBe(true);
    expect(tooShort.content[0].text).toContain('must be a permutation');

    const foreign = await server.callTool('reorder_flowchart_outputs', {
      flowchartName: 'Graph', nodeSid: node.sid, outputSids: [a, b, 999],
    });
    expect(foreign.isError).toBe(true);

    const duplicated = await server.callTool('reorder_flowchart_outputs', {
      flowchartName: 'Graph', nodeSid: node.sid, outputSids: [a, a, b],
    });
    expect(duplicated.isError).toBe(true);

    // Nothing was written by any of the rejected calls.
    expect((await onDisk('Graph')).nodes[0].outputs.map(o => o.sid)).toEqual([a, b, c]);

    const ok = parseResult(await server.callTool('reorder_flowchart_outputs', {
      flowchartName: 'Graph', nodeSid: node.sid, outputSids: [c, a, b],
    }));
    expect(ok.success).toBe(true);
    const outputs = (await onDisk('Graph')).nodes[0].outputs;
    expect(outputs.map(o => o.sid)).toEqual([c, a, b]);
    expect(outputs.map(o => o.name)).toEqual(['Option 3', 'Option 1', 'Option 2']);
  });

  // ─── connections ────────────────────────────────────────

  it('connects an output and updates cnSID, pnSIDs, poSIDs and nodeSIDs', async () => {
    await createGraph();
    const parent = await addNode({ caption: 'Parent', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }] });
    const child = await addNode({ caption: 'Child', x: 400, y: 0 });

    const result = parseResult(await server.callTool('connect_flowchart_nodes', {
      flowchartName: 'Graph', outputSid: parent.outputSids[0], targetNodeSid: child.sid,
    }));
    expect(result.success).toBe(true);
    expect(result.action).toBe('connected');

    const data = await onDisk('Graph');
    const parentNode = data.nodes.find(n => n.sid === parent.sid)!;
    const childNode = data.nodes.find(n => n.sid === child.sid)!;
    expect(parentNode.outputs[0].cnSID).toBe(child.sid);
    expect(parentNode.nodeSIDs).toEqual([child.sid]);
    expect(childNode.pnSIDs).toEqual([parent.sid]);
    expect(childNode.poSIDs).toEqual([parent.outputSids[0]]);
  });

  it('refuses to connect a node to itself', async () => {
    await createGraph();
    const node = await addNode({ caption: 'A', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }] });

    const result = await server.callTool('connect_flowchart_nodes', {
      flowchartName: 'Graph', outputSid: node.outputSids[0], targetNodeSid: node.sid,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('to itself');

    const written = (await onDisk('Graph')).nodes[0];
    expect(written.outputs[0].cnSID).toBeNull();
    expect(written.nodeSIDs).toEqual([]);
    expect(written.pnSIDs).toEqual([]);
    expect(written.poSIDs).toEqual([]);
  });

  it('refuses to connect an output that is already connected', async () => {
    await createGraph();
    const parent = await addNode({ caption: 'Parent', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }] });
    const child = await addNode({ caption: 'Child', x: 400, y: 0 });
    const other = await addNode({ caption: 'Other', x: 400, y: 300 });
    await server.callTool('connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: parent.outputSids[0], targetNodeSid: child.sid });

    const result = await server.callTool('connect_flowchart_nodes', {
      flowchartName: 'Graph', outputSid: parent.outputSids[0], targetNodeSid: other.sid,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already connected');
    expect(result.content[0].text).toContain('disconnect_flowchart_nodes');

    const data = await onDisk('Graph');
    expect(data.nodes.find(n => n.sid === parent.sid)!.outputs[0].cnSID).toBe(child.sid);
    expect(data.nodes.find(n => n.sid === other.sid)!.pnSIDs).toEqual([]);
  });

  it('errors when the connection target node does not exist', async () => {
    await createGraph();
    const node = await addNode({ caption: 'A', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }] });
    const result = await server.callTool('connect_flowchart_nodes', {
      flowchartName: 'Graph', outputSid: node.outputSids[0], targetNodeSid: 987654,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Node 987654 not found');
  });

  it('disconnects exactly one connection, leaving a second one between the same two nodes intact', async () => {
    await createGraph();
    const parent = await addNode({
      caption: 'Parent', x: 0, y: 0, isStart: true,
      outputs: [{ name: 'Option 1' }, { name: 'Option 2' }],
    });
    const child = await addNode({ caption: 'Child', x: 400, y: 0 });
    await server.callTool('connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: parent.outputSids[0], targetNodeSid: child.sid });
    await server.callTool('connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: parent.outputSids[1], targetNodeSid: child.sid });

    const result = parseResult(await server.callTool('disconnect_flowchart_nodes', {
      flowchartName: 'Graph', outputSid: parent.outputSids[0],
    }));
    expect(result.success).toBe(true);
    expect(result.formerTargetNodeSid).toBe(child.sid);

    const data = await onDisk('Graph');
    const parentNode = data.nodes.find(n => n.sid === parent.sid)!;
    const childNode = data.nodes.find(n => n.sid === child.sid)!;
    expect(parentNode.outputs[0].cnSID).toBeNull();
    expect(parentNode.outputs[1].cnSID).toBe(child.sid);
    // The child is still a child: the second connection still points at it.
    expect(parentNode.nodeSIDs).toEqual([child.sid]);
    expect(childNode.pnSIDs).toEqual([parent.sid]);
    expect(childNode.poSIDs).toEqual([parent.outputSids[1]]);

    // Disconnecting the second one clears the child link entirely.
    await server.callTool('disconnect_flowchart_nodes', { flowchartName: 'Graph', outputSid: parent.outputSids[1] });
    const after = await onDisk('Graph');
    expect(after.nodes.find(n => n.sid === parent.sid)!.nodeSIDs).toEqual([]);
    expect(after.nodes.find(n => n.sid === child.sid)!.pnSIDs).toEqual([]);
    expect(after.nodes.find(n => n.sid === child.sid)!.poSIDs).toEqual([]);
  });

  it('errors when disconnecting an output that is not connected', async () => {
    await createGraph();
    const node = await addNode({ caption: 'A', x: 0, y: 0, isStart: true, outputs: [{ name: 'Option 1' }] });
    const result = await server.callTool('disconnect_flowchart_nodes', {
      flowchartName: 'Graph', outputSid: node.outputSids[0],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not connected');
  });

  it('backs the flowchart file up before every node mutation', async () => {
    await createGraph();
    const node = await addNode({ caption: 'A', x: 0, y: 0, isStart: true });
    const bak = join(tmpDir, 'flowcharts', 'Graph.json.bak');
    await expect(stat(bak)).resolves.toBeDefined();

    await server.callTool('update_flowchart_node', { flowchartName: 'Graph', nodeSid: node.sid, caption: 'B' });
    // The backup holds the state before the last write.
    const previous = JSON.parse(await readFile(bak, 'utf-8')) as Flowchart;
    expect(previous.nodes[0].c).toBe('A');
    expect((await onDisk('Graph')).nodes[0].c).toBe('B');
  });
});
