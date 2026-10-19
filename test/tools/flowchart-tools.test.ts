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
    for (const name of ['list_flowcharts', 'get_flowchart_details', 'create_flowchart', 'delete_flowchart']) {
      expect(project.server.hasTool(name), `${name} should be registered`).toBe(true);
    }
  });
});

describe('strict arguments', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['create_flowchart', { name: 'Graph' }, 'name and subfolder'],
    ['delete_flowchart', { name: 'Graph' }, 'name'],
  ];
  for (const [tool, args, takes] of cases) {
    it(`${tool} refuses an argument it does not take`, async () => {
      await expect(project.server.callTool(tool, { ...args, bogus: 1 }))
        .rejects.toThrow(new RegExp(`Unknown key\\(s\\)[\\s\\S]*${tool} takes ${takes}\\.`));
    });
  }
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
