/**
 * Registration, argument checks and the read tools of the flowchart tools.
 * The data is synthetic; the reader, writer and ID generator are the real ones.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeFlowchartProject,
  parseResult,
  registerByHand,
  removeFlowchartProject,
  setFlowchartContainer,
  type FlowchartProject,
} from '../helpers/flowchart-project.js';
import { createFlowchartData } from '../../src/construct3/flowchart-model.js';

let project: FlowchartProject;

beforeEach(async () => {
  project = await makeFlowchartProject();
});

afterEach(async () => {
  await removeFlowchartProject(project);
});

const GRAPH = JSON.stringify(createFlowchartData(77, 'Graph'), null, '\t');

const ALL_TOOLS = [
  'list_flowcharts', 'get_flowchart_details', 'create_flowchart', 'delete_flowchart',
  'add_flowchart_node', 'update_flowchart_node', 'delete_flowchart_node',
  'add_flowchart_output', 'update_flowchart_output', 'delete_flowchart_output', 'reorder_flowchart_outputs',
  'connect_flowchart_nodes', 'disconnect_flowchart_nodes',
];

describe('the tools of this module', () => {
  it('are the thirteen flowchart tools', () => {
    expect(project.server.getToolNames().sort()).toEqual([...ALL_TOOLS].sort());
  });
});

// The tool, its description, and each argument with its description, in order
function pin(tool: string): unknown {
  const registered = project.server.getTool(tool)!;
  return [tool, registered.description, Object.entries(registered.schema).map(([key, value]) => [key, value.description])];
}

describe('the arguments and descriptions of the fork', () => {
  it('list_flowcharts', () => { expect(pin('list_flowcharts')).toMatchInlineSnapshot(`
    [
      "list_flowcharts",
      "List all flowcharts in the project (root and every subfolder)",
      [],
    ]
  `); });
  it('get_flowchart_details', () => { expect(pin('get_flowchart_details')).toMatchInlineSnapshot(`
    [
      "get_flowchart_details",
      "Get the full contents of a flowchart: its nodes, outputs and connections",
      [
        [
          "name",
          "Flowchart name",
        ],
      ],
    ]
  `); });
  it('create_flowchart', () => { expect(pin('create_flowchart')).toMatchInlineSnapshot(`
    [
      "create_flowchart",
      "Create a new, empty flowchart file and register it in project.c3proj. Warns when the Flowchart plugin is not in the project: the editor loads the flowchart anyway, but a Flowchart object is needed to use it at runtime.",
      [
        [
          "name",
          "Flowchart name",
        ],
        [
          "subfolder",
          "Subfolder within flowcharts/ (e.g. "AI Graph/State Machines")",
        ],
      ],
    ]
  `); });
  it('delete_flowchart', () => { expect(pin('delete_flowchart')).toMatchInlineSnapshot(`
    [
      "delete_flowchart",
      "Delete a flowchart: remove its file (keeping a .bak) and its project.c3proj registration",
      [
        [
          "name",
          "Flowchart name to delete",
        ],
      ],
    ]
  `); });
  it('add_flowchart_node', () => { expect(pin('add_flowchart_node')).toMatchInlineSnapshot(`
    [
      "add_flowchart_node",
      "Add a node to a flowchart. Outputs are created unconnected; use connect_flowchart_nodes to wire them.",
      [
        [
          "flowchartName",
          "Flowchart name",
        ],
        [
          "caption",
          "Node caption (the "c" field)",
        ],
        [
          "nodeType",
          "Node type/title (the "t" field; defaults to the caption)",
        ],
        [
          "x",
          "Canvas X position",
        ],
        [
          "y",
          "Canvas Y position",
        ],
        [
          "width",
          "Box width (default: 300)",
        ],
        [
          "height",
          "Box height (default: 133)",
        ],
        [
          "isStart",
          "Make this the start node; clears the flag on every other node (default: false)",
        ],
        [
          "enabled",
          "Enable the node (default: true)",
        ],
        [
          "valueType",
          "Value type ("ty"): "dictionary" or "comment" (default: dictionary). A comment node takes no outputs and the comment fields below",
        ],
        [
          "outputs",
          "Output pins to create on the node",
        ],
        [
          "commentText",
          "Comment node: body as plain text, stored as the editor's HTML (the "n" field)",
        ],
        [
          "commentHtml",
          "Comment node: body as HTML, stored unchanged (the "n" field); give this or commentText",
        ],
        [
          "font",
          "Comment node: font face ("fo"), e.g. "Arial"",
        ],
        [
          "fontSize",
          "Comment node: font size ("fs"), e.g. 24",
        ],
        [
          "bold",
          "Comment node: bold ("fb")",
        ],
        [
          "italic",
          "Comment node: italic ("fi")",
        ],
        [
          "fontColor",
          "Comment node: font color as "#rrggbb" ("fc")",
        ],
      ],
    ]
  `); });
  it('update_flowchart_node', () => { expect(pin('update_flowchart_node')).toMatchInlineSnapshot(`
    [
      "update_flowchart_node",
      "Update properties of an existing flowchart node. Connections, preset links and unknown keys are preserved.",
      [
        [
          "flowchartName",
          "Flowchart name",
        ],
        [
          "nodeSid",
          "SID of the node to update",
        ],
        [
          "caption",
          "New caption (the "c" field)",
        ],
        [
          "nodeType",
          "New node type/title (the "t" field)",
        ],
        [
          "tags",
          "Writes a "tags" key. NOT OBSERVED in any r495 sample flowchart; use at your own risk",
        ],
        [
          "isStart",
          "Make this the start node (clears the flag on every other node), or clear it",
        ],
        [
          "enabled",
          "Enable/disable the node",
        ],
        [
          "parentIndex",
          "The "pi" field; observed values 0, 1 and 2, meaning not determined",
        ],
        [
          "x",
          "New canvas X position",
        ],
        [
          "y",
          "New canvas Y position",
        ],
        [
          "width",
          "New box width",
        ],
        [
          "height",
          "New box height",
        ],
        [
          "valueType",
          "New value type ("ty"). To "comment": the node must have no outputs or connections; its caption becomes the comment body unless one is given, and "t" is cleared. To "dictionary": the comment fields are removed and an empty "t" takes the caption",
        ],
        [
          "commentText",
          "Comment node: body as plain text, stored as the editor's HTML (the "n" field)",
        ],
        [
          "commentHtml",
          "Comment node: body as HTML, stored unchanged (the "n" field); give this or commentText",
        ],
        [
          "font",
          "Comment node: font face ("fo"), e.g. "Arial"",
        ],
        [
          "fontSize",
          "Comment node: font size ("fs"), e.g. 24",
        ],
        [
          "bold",
          "Comment node: bold ("fb")",
        ],
        [
          "italic",
          "Comment node: italic ("fi")",
        ],
        [
          "fontColor",
          "Comment node: font color as "#rrggbb" ("fc")",
        ],
      ],
    ]
  `); });
  it('delete_flowchart_node', () => { expect(pin('delete_flowchart_node')).toMatchInlineSnapshot(`
    [
      "delete_flowchart_node",
      "Delete a flowchart node and every reference to it: other nodes' nodeSIDs, pnSIDs and poSIDs entries, and outputs that pointed at it",
      [
        [
          "flowchartName",
          "Flowchart name",
        ],
        [
          "nodeSid",
          "SID of the node to delete",
        ],
      ],
    ]
  `); });
  it('add_flowchart_output', () => { expect(pin('add_flowchart_output')).toMatchInlineSnapshot(`
    [
      "add_flowchart_output",
      "Add an output pin to a flowchart node. The pin is created unconnected.",
      [
        [
          "flowchartName",
          "Flowchart name",
        ],
        [
          "nodeSid",
          "SID of the node to add the output to",
        ],
        [
          "name",
          "Output pin name",
        ],
        [
          "value",
          "Output value (default: empty string)",
        ],
        [
          "enabled",
          "Enable the output (default: true)",
        ],
        [
          "isDefault",
          "Mark the output as the default (default: false)",
        ],
        [
          "index",
          "Insertion index in the outputs array (default: append)",
        ],
      ],
    ]
  `); });
  it('update_flowchart_output', () => { expect(pin('update_flowchart_output')).toMatchInlineSnapshot(`
    [
      "update_flowchart_output",
      "Update an output pin. Its connection (cnSID) is preserved; use connect/disconnect_flowchart_nodes to change that.",
      [
        [
          "flowchartName",
          "Flowchart name",
        ],
        [
          "outputSid",
          "SID of the output to update",
        ],
        [
          "name",
          "New output pin name",
        ],
        [
          "value",
          "New output value",
        ],
        [
          "enabled",
          "Enable/disable the output",
        ],
        [
          "isDefault",
          "Mark/unmark the output as the default",
        ],
      ],
    ]
  `); });
  it('delete_flowchart_output', () => { expect(pin('delete_flowchart_output')).toMatchInlineSnapshot(`
    [
      "delete_flowchart_output",
      "Delete an output pin, first undoing any connection it holds",
      [
        [
          "flowchartName",
          "Flowchart name",
        ],
        [
          "outputSid",
          "SID of the output to delete",
        ],
      ],
    ]
  `); });
  it('reorder_flowchart_outputs', () => { expect(pin('reorder_flowchart_outputs')).toMatchInlineSnapshot(`
    [
      "reorder_flowchart_outputs",
      "Reorder a node's output pins. outputSids must be a permutation of the node's current output SIDs. The new order is the order of the outputs array in the flowchart file. Whether Construct 3 runs the outputs in that order was not observed, so check the flowchart's behavior after a reorder.",
      [
        [
          "flowchartName",
          "Flowchart name",
        ],
        [
          "nodeSid",
          "SID of the node whose outputs to reorder",
        ],
        [
          "outputSids",
          "The node's output SIDs in their new order",
        ],
      ],
    ]
  `); });
  it('connect_flowchart_nodes', () => { expect(pin('connect_flowchart_nodes')).toMatchInlineSnapshot(`
    [
      "connect_flowchart_nodes",
      "Connect an output pin to a target node: sets the output's cnSID and updates the target's pnSIDs/poSIDs and the source's nodeSIDs",
      [
        [
          "flowchartName",
          "Flowchart name",
        ],
        [
          "outputSid",
          "SID of the source output pin",
        ],
        [
          "targetNodeSid",
          "SID of the node to connect to",
        ],
      ],
    ]
  `); });
  it('disconnect_flowchart_nodes', () => { expect(pin('disconnect_flowchart_nodes')).toMatchInlineSnapshot(`
    [
      "disconnect_flowchart_nodes",
      "Disconnect an output pin, leaving any other connection between the same two nodes intact",
      [
        [
          "flowchartName",
          "Flowchart name",
        ],
        [
          "outputSid",
          "SID of the output pin to disconnect",
        ],
      ],
    ]
  `); });
});

describe('strict arguments', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['create_flowchart', { name: 'Graph' }, 'name and subfolder'],
    ['delete_flowchart', { name: 'Graph' }, 'name'],
    ['add_flowchart_node', { flowchartName: 'Graph', caption: 'N', x: 0, y: 0 }, 'flowchartName, caption, nodeType, x, y, width, height, isStart, enabled, valueType, outputs, commentText, commentHtml, font, fontSize, bold, italic and fontColor'],
    ['update_flowchart_node', { flowchartName: 'Graph', nodeSid: 1, caption: 'N' }, 'flowchartName, nodeSid, caption, nodeType, tags, isStart, enabled, parentIndex, x, y, width, height, valueType, commentText, commentHtml, font, fontSize, bold, italic and fontColor'],
    ['delete_flowchart_node', { flowchartName: 'Graph', nodeSid: 1 }, 'flowchartName and nodeSid'],
    ['add_flowchart_output', { flowchartName: 'Graph', nodeSid: 1, name: 'Next' }, 'flowchartName, nodeSid, name, value, enabled, isDefault and index'],
    ['update_flowchart_output', { flowchartName: 'Graph', outputSid: 1, name: 'Next' }, 'flowchartName, outputSid, name, value, enabled and isDefault'],
    ['delete_flowchart_output', { flowchartName: 'Graph', outputSid: 1 }, 'flowchartName and outputSid'],
    ['reorder_flowchart_outputs', { flowchartName: 'Graph', nodeSid: 1, outputSids: [1] }, 'flowchartName, nodeSid and outputSids'],
    ['connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: 1, targetNodeSid: 2 }, 'flowchartName, outputSid and targetNodeSid'],
    ['disconnect_flowchart_nodes', { flowchartName: 'Graph', outputSid: 1 }, 'flowchartName and outputSid'],
  ];
  for (const [tool, args, takes] of cases) {
    it(`${tool} refuses an argument it does not take`, async () => {
      await expect(project.server.callTool(tool, { ...args, bogus: 1 }))
        .rejects.toThrow(new RegExp(`Unknown key\\(s\\)[\\s\\S]*${tool} takes ${takes}\\.`));
    });
  }
});

describe('non-finite numbers', () => {
  const fields = ['x', 'y', 'width', 'height'];
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ...fields.map((field): [string, string, Record<string, unknown>] =>
      ['add_flowchart_node', field, { flowchartName: 'Graph', caption: 'N', x: 0, y: 0, [field]: 1e999 }]),
    ...fields.map((field): [string, string, Record<string, unknown>] =>
      ['update_flowchart_node', field, { flowchartName: 'Graph', nodeSid: 1, [field]: 1e999 }]),
  ];
  for (const [tool, field, args] of cases) {
    it(`${tool} refuses a ${field} that is not finite`, async () => {
      await expect(project.server.callTool(tool, args)).rejects.toThrow(/finite/);
    });
  }
});

describe('output entries', () => {
  it('add_flowchart_node refuses an output key it does not take', async () => {
    await expect(project.server.callTool('add_flowchart_node', {
      flowchartName: 'Graph', caption: 'N', x: 0, y: 0, outputs: [{ name: 'Next', isdefault: true }],
    })).rejects.toThrow(/Unknown key\(s\) \\"isdefault\\" in an output of add_flowchart_node[\s\S]*An output has name, value, enabled and isDefault\./);
  });
});

describe('node tools on an unknown flowchart', () => {
  const ghostCalls: Array<[string, Record<string, unknown>]> = [
    ['add_flowchart_node', { flowchartName: 'Ghost', caption: 'N', x: 0, y: 0 }],
    ['update_flowchart_node', { flowchartName: 'Ghost', nodeSid: 1, caption: 'N' }],
    ['delete_flowchart_node', { flowchartName: 'Ghost', nodeSid: 1 }],
    ['add_flowchart_output', { flowchartName: 'Ghost', nodeSid: 1, name: 'Next' }],
    ['update_flowchart_output', { flowchartName: 'Ghost', outputSid: 1, name: 'Next' }],
    ['delete_flowchart_output', { flowchartName: 'Ghost', outputSid: 1 }],
    ['reorder_flowchart_outputs', { flowchartName: 'Ghost', nodeSid: 1, outputSids: [1] }],
    ['connect_flowchart_nodes', { flowchartName: 'Ghost', outputSid: 1, targetNodeSid: 2 }],
    ['disconnect_flowchart_nodes', { flowchartName: 'Ghost', outputSid: 1 }],
  ];
  for (const [tool, args] of ghostCalls) {
    it(`${tool} answers that the flowchart is not found and changes nothing`, async () => {
      const result = await project.server.callTool(tool, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Flowchart "Ghost" not found. Use list_flowcharts to see all available names. Nothing was changed.');
    });
  }

  it('update_flowchart_node with nothing to update says so before it looks the flowchart up', async () => {
    const result = await project.server.callTool('update_flowchart_node', { flowchartName: 'Ghost', nodeSid: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('No updates provided. Specify at least one of: caption, nodeType, tags, isStart, enabled, parentIndex, x, y, width, height, valueType, commentText, commentHtml, font, fontSize, bold, italic, fontColor. Nothing was changed.');
  });

  it('update_flowchart_output with nothing to update says so before it looks the flowchart up', async () => {
    const result = await project.server.callTool('update_flowchart_output', { flowchartName: 'Ghost', outputSid: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('No updates provided. Specify at least one of: name, value, enabled, isDefault. Nothing was changed.');
  });
});

describe('list_flowcharts', () => {
  it('lists nothing when the project has no flowcharts entry', async () => {
    const data = parseResult(await project.server.callTool('list_flowcharts', {}));
    expect(data.flowcharts).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('lists the flowcharts of the root and of every folder, and leaves out a folder without a name', async () => {
    await setFlowchartContainer(project, {
      items: ['Root Graph'],
      subfolders: [
        { items: [], subfolders: [{ items: ['State Machine 1'], subfolders: [], name: 'State Machines' }], name: 'AI Graph' },
        { items: ['Hidden'], subfolders: [] },
      ],
    });
    const data = parseResult(await project.server.callTool('list_flowcharts', {}));
    expect(data.flowcharts).toEqual(['Root Graph', 'State Machine 1']);
    expect(data.count).toBe(2);
  });
});

describe('get_flowchart_details', () => {
  it('returns the file of a registered flowchart, also one in a folder', async () => {
    await registerByHand(project, 'Graph', GRAPH);
    await registerByHand(project, 'Deep', JSON.stringify(createFlowchartData(78, 'Deep')), ['AI Graph', 'States']);
    expect(parseResult(await project.server.callTool('get_flowchart_details', { name: 'Graph' })).sid).toBe(77);
    expect(parseResult(await project.server.callTool('get_flowchart_details', { name: 'Deep' })).sid).toBe(78);
  });

  it('answers an unknown name, and a name in another letter case with the registered one', async () => {
    await registerByHand(project, 'Graph', GRAPH);
    const unknown = await project.server.callTool('get_flowchart_details', { name: 'Ghost' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toBe('Flowchart "Ghost" not found. Use list_flowcharts to see all available names.');
    const variant = await project.server.callTool('get_flowchart_details', { name: 'graph' });
    expect(variant.isError).toBe(true);
    expect(variant.content[0].text).toBe('Flowchart "graph" not found: names are matched with their letter case. Did you mean "Graph"?');
  });

  it('does not resolve a name registered in a folder without a name', async () => {
    await setFlowchartContainer(project, { items: [], subfolders: [{ items: ['Hidden'], subfolders: [] }] });
    const result = await project.server.callTool('get_flowchart_details', { name: 'Hidden' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Flowchart "Hidden" is registered in project.c3proj in a folder without a name, so its file cannot be resolved. The flowchart tools do not read, change or delete it.');
  });

  it('says a registered flowchart whose file cannot be read could not be read, with the file project-relative', async () => {
    await setFlowchartContainer(project, { items: ['Graph A'], subfolders: [] });
    const result = await project.server.callTool('get_flowchart_details', { name: 'Graph A' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Flowchart "Graph A" is registered in the project but flowcharts/Graph A.json could not be read');
    expect(result.content[0].text).not.toContain(project.dir);
  });
});
