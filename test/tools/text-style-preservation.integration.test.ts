/**
 * The flowchart, container, rename, duplicate-timeline and tilemap brush tools
 * write project JSON in the text style of the file they overwrite (line
 * endings, trailing whitespace, BOM), and give a new file the style of
 * project.c3proj. Before, each of them wrote tab-indented JSON with LF line
 * endings and no BOM whatever the file had, so a CRLF or BOM file became a
 * whole-file diff and lost its BOM.
 *
 * Test projects are restyled explicitly after copying, so the results do not
 * depend on how git checked out the fixtures (core.autocrlf).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerFlowchartTools } from '../../src/tools/flowchart-tools.js';
import { registerContainerTools } from '../../src/tools/container-tools.js';
import { registerRenameTools } from '../../src/tools/rename-tools.js';
import { registerStructureTools } from '../../src/tools/structure-tools.js';
import { registerTilemapBrushTools, brushFileText } from '../../src/tools/tilemap-brush-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');
const BOM = '\uFEFF';

type Eol = '\n' | '\r\n';

interface Style {
  eol: Eol;
  /** Exact text after the closing bracket (default: none). */
  trailing?: string;
  bom?: boolean;
}

const CRLF_BOM: Style = { eol: '\r\n', trailing: '\r\n', bom: true };

let tmpDir: string;
let server: MockServer;

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

const read = (...segments: string[]) => readFile(join(tmpDir, ...segments), 'utf-8');

/** Rewrite a file's text in the given style; `indent` re-indents its JSON (default: keep the fixture's tabs). */
async function restyle(rel: string[], style: Style, indent?: string): Promise<void> {
  let text = (await read(...rel)).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (indent !== undefined) text = JSON.stringify(JSON.parse(text), null, indent || undefined);
  const out = (style.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text) + (style.trailing ?? '');
  await writeFile(join(tmpDir, ...rel), (style.bom ? BOM : '') + out, 'utf-8');
}

/** Assert the exact line endings, trailing whitespace and BOM of a file's text. */
function expectStyle(text: string, style: Style): void {
  expect(text.startsWith(BOM)).toBe(style.bom === true);
  const body = text.replace(/^\uFEFF/, '');
  const closed = body.replace(/\s+$/, '');
  expect(body.slice(closed.length)).toBe(style.trailing ?? '');
  const crlf = (closed.match(/\r\n/g) || []).length;
  const bareLf = (closed.match(/\n/g) || []).length - crlf;
  if (style.eol === '\r\n') {
    expect(bareLf).toBe(0);
    expect(crlf).toBeGreaterThan(0);
  } else {
    expect(crlf).toBe(0);
  }
}

const parseText = (text: string) => JSON.parse(text.replace(/^\uFEFF/, ''));

async function boot(): Promise<void> {
  resetProjectIndex();
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  const deps = { server, reader, writer, idGen } as any;
  registerFlowchartTools(deps);
  registerContainerTools(deps);
  registerRenameTools(deps);
  registerStructureTools(deps);
  registerTilemapBrushTools(deps);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-style-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('flowchart tools keep the text style', () => {
  it('create_flowchart keeps project.c3proj\'s style and gives the new flowchart the same style', async () => {
    await restyle(['project.c3proj'], CRLF_BOM);
    await boot();

    const created = parseResult(await server.callTool('create_flowchart', { name: 'Graph' }));
    expect(created.success).toBe(true);

    const project = await read('project.c3proj');
    expectStyle(project, CRLF_BOM);
    expect(parseText(project).flowcharts.items).toEqual(['Graph']);

    const flowchart = await read('flowcharts', 'Graph.json');
    expectStyle(flowchart, CRLF_BOM);
    expect(parseText(flowchart).name).toBe('Graph');
  });

  it('add_flowchart_node keeps the CRLF, BOM and trailing newline of an existing flowchart', async () => {
    await boot();
    expect(parseResult(await server.callTool('create_flowchart', { name: 'Graph' })).success).toBe(true);
    const own: Style = { eol: '\r\n', trailing: '\n', bom: true };
    await restyle(['flowcharts', 'Graph.json'], own);

    const added = parseResult(await server.callTool('add_flowchart_node', {
      flowchartName: 'Graph', caption: 'Root', x: 0, y: 0, isStart: true,
    }));
    expect(added.success).toBe(true);

    const flowchart = await read('flowcharts', 'Graph.json');
    expectStyle(flowchart, own);
    expect(parseText(flowchart).nodes).toHaveLength(1);
    expect(parseText(flowchart).nodes[0].c).toBe('Root');
  });

  it('a new flowchart in an LF project is LF, with no BOM and no trailing newline', async () => {
    await restyle(['project.c3proj'], { eol: '\n' });
    await boot();
    expect(parseResult(await server.callTool('create_flowchart', { name: 'Graph' })).success).toBe(true);

    expectStyle(await read('flowcharts', 'Graph.json'), { eol: '\n' });
    expectStyle(await read('project.c3proj'), { eol: '\n' });
  });
});

describe('container tools keep the text style', () => {
  it('create_container keeps project.c3proj\'s CRLF, BOM and trailing newline', async () => {
    await restyle(['project.c3proj'], CRLF_BOM);
    await boot();

    const result = parseResult(await server.callTool('create_container', { members: ['PlayerShip', 'Tiles'] }));
    expect(result.success).toBe(true);

    const project = await read('project.c3proj');
    expectStyle(project, CRLF_BOM);
    expect(parseText(project).containers).toEqual([
      { members: ['Player', 'Enemy'] },
      { members: ['PlayerShip', 'Tiles'] },
    ]);
  });

  it('create_container keeps an LF project LF', async () => {
    await restyle(['project.c3proj'], { eol: '\n' });
    await boot();
    expect(parseResult(await server.callTool('create_container', { members: ['PlayerShip', 'Tiles'] })).success).toBe(true);
    expectStyle(await read('project.c3proj'), { eol: '\n' });
  });
});

describe('rename tools keep the text style', () => {
  it('rename_layout keeps the style of project.c3proj and of the timeline it rewrites', async () => {
    await restyle(['project.c3proj'], CRLF_BOM);
    const timelineStyle: Style = { eol: '\r\n', trailing: '\n', bom: true };
    await restyle(['timelines', 'Intro.json'], timelineStyle);
    await boot();

    const result = parseResult(await server.callTool('rename_layout', { name: 'Level 1', newName: 'Stage 1' }));
    expect(result.success).toBe(true);

    const project = await read('project.c3proj');
    expectStyle(project, CRLF_BOM);
    expect(parseText(project).firstLayout).toBe('Stage 1');

    const timeline = await read('timelines', 'Intro.json');
    expectStyle(timeline, timelineStyle);
    expect(parseText(timeline).startOnLayout).toBe('Stage 1');
  });

  it('rename_layout still finds and rewrites a BOM timeline in an LF project, keeping it LF', async () => {
    await restyle(['project.c3proj'], { eol: '\n' });
    const timelineStyle: Style = { eol: '\n', bom: true };
    await restyle(['timelines', 'Intro.json'], timelineStyle);
    await boot();

    expect(parseResult(await server.callTool('rename_layout', { name: 'Level 1', newName: 'Stage 1' })).success).toBe(true);

    const timeline = await read('timelines', 'Intro.json');
    expectStyle(timeline, timelineStyle);
    expect(parseText(timeline).startOnLayout).toBe('Stage 1');
    expectStyle(await read('project.c3proj'), { eol: '\n' });
  });
});

describe('duplicate_timeline keeps the text style', () => {
  it('reads a BOM source and gives the copy the style of project.c3proj', async () => {
    await restyle(['project.c3proj'], CRLF_BOM);
    await restyle(['timelines', 'Intro.json'], { eol: '\n', bom: true });
    await boot();
    const source = parseText(await read('timelines', 'Intro.json'));

    const result = await server.callTool('duplicate_timeline', { timelineName: 'Intro', newName: 'Intro2' });
    expect(result.isError).not.toBe(true);

    const copy = await read('timelines', 'Intro2.json');
    expectStyle(copy, CRLF_BOM);
    expect(parseText(copy)).toEqual({ ...source, name: 'Intro2' });
    // The source is left as it was.
    expectStyle(await read('timelines', 'Intro.json'), { eol: '\n', bom: true });
    expectStyle(await read('project.c3proj'), CRLF_BOM);
    expect(parseText(await read('project.c3proj')).timelines.items).toContain('Intro2');
  });

  it('a copy in an LF project is LF, with no BOM and no trailing newline', async () => {
    await restyle(['project.c3proj'], { eol: '\n' });
    await boot();
    expect((await server.callTool('duplicate_timeline', { timelineName: 'Intro', newName: 'Intro2' })).isError).not.toBe(true);
    expectStyle(await read('timelines', 'Intro2.json'), { eol: '\n' });
  });
});

describe('tilemap brush tools keep the text style', () => {
  const BRUSH = ['tilemapBrushes', 'objectTypes', 'Tiles.brush.json'];
  const auto16 = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, null]];
  const addPatch = () => server.callTool('add_tilemap_brush', {
    objectName: 'Tiles', name: 'Patchy', type: 'patch', data: { width: 1, height: 1, data: [[1]] },
  });

  it('keeps a compact brush file compact and keeps its BOM and trailing newline', async () => {
    await restyle(BRUSH, { eol: '\n', trailing: '\r\n', bom: true });
    await boot();

    expect(parseResult(await addPatch()).success).toBe(true);

    const text = await read(...BRUSH);
    expect(text.startsWith(BOM)).toBe(true);
    expect(text.endsWith(']\r\n')).toBe(true);
    expect(text.replace(/\s+$/, '')).not.toMatch(/[\r\n]/);
    const list = parseText(text);
    expect(list).toHaveLength(2);
    expect(list[0].data).toEqual(auto16);
    expect(list[1].name).toBe('Patchy');
  });

  it('keeps an indented CRLF brush file indented and CRLF', async () => {
    await restyle(BRUSH, CRLF_BOM, '\t');
    await boot();

    expect(parseResult(await addPatch()).success).toBe(true);

    const text = await read(...BRUSH);
    expectStyle(text, CRLF_BOM);
    expect(text.replace(/^\uFEFF/, '')).toContain('\r\n\t{\r\n\t\t"name": "Brush 0"');
    expect(parseText(text)).toHaveLength(2);
  });

  it('keeps the indent string of a space-indented brush file', async () => {
    await restyle(BRUSH, { eol: '\n', trailing: '\n' }, '  ');
    await boot();

    expect(parseResult(await addPatch()).success).toBe(true);

    const text = await read(...BRUSH);
    expectStyle(text, { eol: '\n', trailing: '\n' });
    expect(text).toContain('\n  {\n    "name": "Brush 0"');
    expect(parseText(text)).toHaveLength(2);
  });

  it('writes a new brush file compact, as Construct 3 does, in a CRLF project', async () => {
    await restyle(['project.c3proj'], { eol: '\r\n' });
    await boot();

    const result = parseResult(await server.callTool('add_tilemap_brush', {
      objectName: 'Player', name: 'Odd', type: 'auto16', data: auto16,
    }));
    expect(result.success).toBe(true);

    const text = await read('tilemapBrushes', 'objectTypes', 'Actors', 'Player.brush.json');
    expect(text).toBe(JSON.stringify([{ name: 'Odd', type: 'auto16', data: auto16 }]));
  });

  it('brushFileText: a compact file with a trailing newline stays one line', () => {
    const text = brushFileText([{ name: 'A', type: 'patch', data: [] } as any], '[]\r\n');
    expect(text).toBe('[{"name":"A","type":"patch","data":[]}]\r\n');
  });
});

describe('plain CRLF files (no BOM, no trailing newline) stay CRLF', () => {
  const CRLF: Style = { eol: '\r\n' };

  it('add_flowchart_node', async () => {
    await boot();
    expect(parseResult(await server.callTool('create_flowchart', { name: 'Graph' })).success).toBe(true);
    await restyle(['flowcharts', 'Graph.json'], CRLF);
    expect(parseResult(await server.callTool('add_flowchart_node', {
      flowchartName: 'Graph', caption: 'Root', x: 0, y: 0, isStart: true,
    })).success).toBe(true);
    const text = await read('flowcharts', 'Graph.json');
    expectStyle(text, CRLF);
    expect(parseText(text).nodes).toHaveLength(1);
  });

  it('create_container', async () => {
    await restyle(['project.c3proj'], CRLF);
    await boot();
    expect(parseResult(await server.callTool('create_container', { members: ['PlayerShip', 'Tiles'] })).success).toBe(true);
    const text = await read('project.c3proj');
    expectStyle(text, CRLF);
    expect(parseText(text).containers).toHaveLength(2);
  });

  it('rename_layout', async () => {
    await restyle(['project.c3proj'], CRLF);
    await restyle(['timelines', 'Intro.json'], CRLF);
    await boot();
    expect(parseResult(await server.callTool('rename_layout', { name: 'Level 1', newName: 'Stage 1' })).success).toBe(true);
    const timeline = await read('timelines', 'Intro.json');
    expectStyle(timeline, CRLF);
    expect(parseText(timeline).startOnLayout).toBe('Stage 1');
    expectStyle(await read('project.c3proj'), CRLF);
  });

  it('duplicate_timeline gives the copy the project\'s CRLF', async () => {
    await restyle(['project.c3proj'], CRLF);
    await boot();
    expect((await server.callTool('duplicate_timeline', { timelineName: 'Intro', newName: 'Intro2' })).isError).not.toBe(true);
    expectStyle(await read('timelines', 'Intro2.json'), CRLF);
  });

  it('add_tilemap_brush on an indented file', async () => {
    await restyle(['tilemapBrushes', 'objectTypes', 'Tiles.brush.json'], CRLF, '\t');
    await boot();
    expect(parseResult(await server.callTool('add_tilemap_brush', {
      objectName: 'Tiles', name: 'Patchy', type: 'patch', data: { width: 1, height: 1, data: [[1]] },
    })).success).toBe(true);
    const text = await read('tilemapBrushes', 'objectTypes', 'Tiles.brush.json');
    expectStyle(text, CRLF);
    expect(parseText(text)).toHaveLength(2);
  });
});
