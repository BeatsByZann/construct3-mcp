/**
 * Real-filesystem tests for the flowchart tools: the on-disk outcome through
 * the real reader, writer and ID generator. The data is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rename, readFile, readdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Flowchart } from '../../src/construct3/flowchart-model.js';
import { isCaseInsensitiveFs } from '../helpers/fs-case.js';
import {
  makeFlowchartProject,
  parseResult,
  readFlowchartFile,
  registeredFlowcharts as registeredOnDisk,
  removeFlowchartProject,
  type FlowchartProject,
} from '../helpers/flowchart-project.js';

const caseInsensitive = isCaseInsensitiveFs();

describe('flowchart tools (real project on disk)', () => {
  let project: FlowchartProject;
  let tmpDir: string;
  let server: FlowchartProject['server'];

  async function boot(options: { plugin?: boolean } = {}) {
    project = await makeFlowchartProject(options);
    tmpDir = project.dir;
    server = project.server;
  }

  beforeEach(async () => {
    await boot();
  });

  afterEach(async () => {
    await removeFlowchartProject(project);
  });

  /** Read a flowchart straight off disk, bypassing the tools. */
  async function onDisk(name: string, subfolder = ''): Promise<Flowchart> {
    return readFlowchartFile(tmpDir, name, subfolder ? subfolder.split('/') : []);
  }

  async function registeredFlowcharts(): Promise<unknown> {
    return registeredOnDisk(tmpDir);
  }

  /** Create "Graph" and add a node; returns the node SID and its output SIDs. */
  async function addNode(
    args: Record<string, unknown>,
  ): Promise<{ sid: number; outputSids: number[] }> {
    const result = parseResult(await server.callTool('add_flowchart_node', { flowchartName: 'Graph', ...args }));
    expect(result.success).toBe(true);
    return { sid: result.generatedSid as number, outputSids: result.outputSids as number[] };
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
    expect(created.backupFile).toBeUndefined();
    expect(created.editorNote).toBeDefined();

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

  it('creates a flowchart with a warning when the Flowchart plugin is absent, without registering the plugin', async () => {
    await removeFlowchartProject(project);
    await boot({ plugin: false });

    const result = await server.callTool('create_flowchart', { name: 'Graph' });
    expect(result.isError).not.toBe(true);
    expect(parseResult(result).warnings?.join(' ')).toContain('Flowchart plugin is not listed');

    await stat(join(tmpDir, 'flowcharts', 'Graph.json'));
    const projectJson = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8'));
    expect(projectJson.flowcharts.items).toContain('Graph');
    expect(projectJson.usedAddons.some((a: { id: string }) => a.id === 'Flowchart')).toBe(false);
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
    expect(result.warnings?.join(' ')).toContain('Graph.uistate.json');

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
    expect(result.warnings?.join(' ')).toContain('no start node');
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
    expect(result.warnings?.join(' ')).toContain('"tags"');
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

  it('refuses to delete a node that does not exist', async () => {
    await createGraph();
    const result = await server.callTool('delete_flowchart_node', { flowchartName: 'Graph', nodeSid: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Node 123 not found in flowchart "Graph".');
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
    expect(result.warnings?.join(' ')).toContain('was the start node');
    expect(result.warnings?.join(' ')).toContain('no start node');
  });

  // ─── file names on a case-insensitive file system ────────

  describe.skipIf(!caseInsensitive)('when the file on disk is spelled differently from the registered name', () => {
    // Registered as "graph", stored as Graph.json (with its editor-state file Graph.uistate.json)
    beforeEach(async () => {
      expect(parseResult(await server.callTool('create_flowchart', { name: 'graph' })).success).toBe(true);
      await rename(join(tmpDir, 'flowcharts', 'graph.json'), join(tmpDir, 'flowcharts', 'Graph.json'));
      await writeFile(join(tmpDir, 'flowcharts', 'Graph.uistate.json'), '{}', 'utf-8');
    });

    it('backs up under the file name on disk when a node is added', async () => {
      const result = parseResult(await server.callTool('add_flowchart_node', {
        flowchartName: 'graph', caption: 'A', x: 0, y: 0,
      }));
      expect(result.backupFile).toBe(join(tmpDir, 'flowcharts', 'Graph.json.bak'));
      const entries = await readdir(join(tmpDir, 'flowcharts'));
      expect(entries).toContain('Graph.json.bak');
      expect(entries).not.toContain('graph.json');
      expect(entries).not.toContain('graph.json.bak');
    });

    it('deletes the flowchart and backs up its files under the names on disk', async () => {
      const result = parseResult(await server.callTool('delete_flowchart', { name: 'graph' }));
      expect(result.success).toBe(true);
      expect(result.backupFile).toBe(join(tmpDir, 'flowcharts', 'Graph.json.bak'));
      const entries = (await readdir(join(tmpDir, 'flowcharts'))).sort();
      expect(entries).toEqual(['Graph.json.bak', 'Graph.uistate.json.bak']);
    });
  });
});
