import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerFlowchartTools } from '../../src/tools/flowchart-tools.js';

const FLOWCHART_PLUGIN = { type: 'plugin', id: 'Flowchart', name: 'Flowchart controller', author: 'Scirra', bundled: false };

/**
 * Build a tool set whose MockReader reports the given flowcharts container.
 * MockReader has no flowcharts support of its own, so getProject is patched
 * the same way the timeline tests patch timelines.
 */
function setup(options: {
  flowcharts?: { items: string[]; subfolders: unknown[] };
  withPlugin?: boolean;
} = {}) {
  const server = new MockServer();
  const reader = new MockReader(
    options.withPlugin === false || options.withPlugin === undefined
      ? {}
      : { usedAddons: [FLOWCHART_PLUGIN as never] }
  );
  const origGetProject = reader.getProject.bind(reader);
  if (options.flowcharts) {
    (reader as any).getProject = () => ({ ...origGetProject(), flowcharts: options.flowcharts });
  }
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerFlowchartTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

const ALL_TOOLS = [
  'list_flowcharts',
  'get_flowchart_details',
  'create_flowchart',
  'delete_flowchart',
  'add_flowchart_node',
  'update_flowchart_node',
  'delete_flowchart_node',
  'add_flowchart_output',
  'update_flowchart_output',
  'delete_flowchart_output',
  'reorder_flowchart_outputs',
  'connect_flowchart_nodes',
  'disconnect_flowchart_nodes',
];

// ─── registration ─────────────────────────────────────────

describe('registerFlowchartTools', () => {
  it('registers every flowchart tool', () => {
    const { server } = setup();
    for (const name of ALL_TOOLS) {
      expect(server.hasTool(name), `${name} should be registered`).toBe(true);
    }
  });
});

// ─── list_flowcharts ──────────────────────────────────────

describe('list_flowcharts', () => {
  it('returns an empty list when the project has no flowcharts container at all', async () => {
    const { server } = setup();
    const data = parseResult(await server.callTool('list_flowcharts', {}));
    expect(data.flowcharts).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('lists flowcharts registered at the container root', async () => {
    const { server } = setup({ flowcharts: { items: ['Graph A', 'Graph B'], subfolders: [] } });
    const data = parseResult(await server.callTool('list_flowcharts', {}));
    expect(data.count).toBe(2);
    expect(data.flowcharts).toContain('Graph A');
    expect(data.flowcharts).toContain('Graph B');
  });

  it('lists flowcharts from nested subfolders too', async () => {
    const { server } = setup({
      flowcharts: {
        items: ['Root Graph'],
        subfolders: [
          {
            items: [],
            subfolders: [{ items: ['State Machine 1'], subfolders: [], name: 'State Machines' }],
            name: 'AI Graph',
          },
        ],
      },
    });
    const data = parseResult(await server.callTool('list_flowcharts', {}));
    expect(data.count).toBe(2);
    expect(data.flowcharts).toContain('State Machine 1');
  });
});

// ─── get_flowchart_details ────────────────────────────────

describe('get_flowchart_details', () => {
  it('errors when the flowchart is not registered', async () => {
    const { server } = setup();
    const result = await server.callTool('get_flowchart_details', { name: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
    expect(result.content[0].text).toContain('list_flowcharts');
  });

  it('reports a registered flowchart whose file cannot be read', async () => {
    const { server } = setup({ flowcharts: { items: ['Graph A'], subfolders: [] } });
    const result = await server.callTool('get_flowchart_details', { name: 'Graph A' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('registered in the project');
    expect(result.content[0].text).toContain('flowcharts/Graph A.json');
  });
});

// ─── create_flowchart ─────────────────────────────────────

describe('create_flowchart', () => {
  it('refuses to create a flowchart when the Flowchart plugin is missing', async () => {
    const { server } = setup({ withPlugin: false });
    const result = await server.callTool('create_flowchart', { name: 'Graph A' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Flowchart plugin is not listed');
    expect(result.content[0].text).toContain('Construct 3 editor');
  });

  it('does not auto-register the Flowchart plugin', async () => {
    const { server, writer } = setup({ withPlugin: false });
    await server.callTool('create_flowchart', { name: 'Graph A' });
    expect(writer.callsFor('ensureAddonRegistered')).toHaveLength(0);
  });

  it('rejects a duplicate flowchart name', async () => {
    const { server } = setup({ withPlugin: true, flowcharts: { items: ['Graph A'], subfolders: [] } });
    const result = await server.callTool('create_flowchart', { name: 'Graph A' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('rejects a duplicate name registered in a subfolder', async () => {
    const { server } = setup({
      withPlugin: true,
      flowcharts: { items: [], subfolders: [{ items: ['Graph A'], subfolders: [], name: 'AI' }] },
    });
    const result = await server.callTool('create_flowchart', { name: 'Graph A' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('rejects an unsafe name', async () => {
    const { server } = setup({ withPlugin: true });
    const result = await server.callTool('create_flowchart', { name: '../escape' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error creating flowchart');
  });

  it('rejects a traversing subfolder path', async () => {
    const { server } = setup({ withPlugin: true });
    const result = await server.callTool('create_flowchart', { name: 'Graph A', subfolder: '../../evil' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid characters');
  });
});

// ─── delete_flowchart ─────────────────────────────────────

describe('delete_flowchart', () => {
  it('errors when the flowchart is not registered', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_flowchart', { name: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});

// ─── node and output tools: unknown flowchart ─────────────

describe('node and output tools', () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['add_flowchart_node', { flowchartName: 'Ghost', caption: 'N', x: 0, y: 0 }],
    ['update_flowchart_node', { flowchartName: 'Ghost', nodeSid: 1, caption: 'N' }],
    ['delete_flowchart_node', { flowchartName: 'Ghost', nodeSid: 1 }],
    ['add_flowchart_output', { flowchartName: 'Ghost', nodeSid: 1, name: 'Option 1' }],
    ['update_flowchart_output', { flowchartName: 'Ghost', outputSid: 1, name: 'Option 1' }],
    ['delete_flowchart_output', { flowchartName: 'Ghost', outputSid: 1 }],
    ['reorder_flowchart_outputs', { flowchartName: 'Ghost', nodeSid: 1, outputSids: [1] }],
    ['connect_flowchart_nodes', { flowchartName: 'Ghost', outputSid: 1, targetNodeSid: 2 }],
    ['disconnect_flowchart_nodes', { flowchartName: 'Ghost', outputSid: 1 }],
  ];

  for (const [tool, args] of calls) {
    it(`${tool} errors when the flowchart is not registered`, async () => {
      const { server } = setup();
      const result = await server.callTool(tool, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('"Ghost" not found');
    });
  }

  it('update_flowchart_node errors when no updates are provided', async () => {
    const { server } = setup();
    const result = await server.callTool('update_flowchart_node', { flowchartName: 'Ghost', nodeSid: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates provided');
  });

  it('update_flowchart_output errors when no updates are provided', async () => {
    const { server } = setup();
    const result = await server.callTool('update_flowchart_output', { flowchartName: 'Ghost', outputSid: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates provided');
  });
});
