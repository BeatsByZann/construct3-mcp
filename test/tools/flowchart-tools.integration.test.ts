/**
 * Real-filesystem tests for the flowchart tools: the on-disk outcome through
 * the real reader, writer and ID generator. The data is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rename, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
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

  // ─── file names on a case-insensitive file system ────────

  describe.skipIf(!caseInsensitive)('when the file on disk is spelled differently from the registered name', () => {
    // Registered as "graph", stored as Graph.json (with its editor-state file Graph.uistate.json)
    beforeEach(async () => {
      expect(parseResult(await server.callTool('create_flowchart', { name: 'graph' })).success).toBe(true);
      await rename(join(tmpDir, 'flowcharts', 'graph.json'), join(tmpDir, 'flowcharts', 'Graph.json'));
      await writeFile(join(tmpDir, 'flowcharts', 'Graph.uistate.json'), '{}', 'utf-8');
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
