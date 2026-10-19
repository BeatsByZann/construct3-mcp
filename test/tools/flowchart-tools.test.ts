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

describe('registerFlowchartTools', () => {
  it('registers the tools of this module', () => {
    for (const name of [
      'list_flowcharts', 'get_flowchart_details', 'create_flowchart', 'delete_flowchart',
      'add_flowchart_node', 'update_flowchart_node', 'delete_flowchart_node',
    ]) {
      expect(project.server.hasTool(name), `${name} should be registered`).toBe(true);
    }
  });
});

describe('strict arguments', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['create_flowchart', { name: 'Graph' }, 'name and subfolder'],
    ['delete_flowchart', { name: 'Graph' }, 'name'],
    ['add_flowchart_node', { flowchartName: 'Graph', caption: 'N', x: 0, y: 0 }, 'flowchartName, caption, nodeType, x, y, width, height, isStart, enabled, valueType, outputs, commentText, commentHtml, font, fontSize, bold, italic and fontColor'],
    ['update_flowchart_node', { flowchartName: 'Graph', nodeSid: 1, caption: 'N' }, 'flowchartName, nodeSid, caption, nodeType, tags, isStart, enabled, parentIndex, x, y, width, height, valueType, commentText, commentHtml, font, fontSize, bold, italic and fontColor'],
    ['delete_flowchart_node', { flowchartName: 'Graph', nodeSid: 1 }, 'flowchartName and nodeSid'],
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
