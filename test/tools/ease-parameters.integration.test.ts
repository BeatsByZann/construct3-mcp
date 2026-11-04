/**
 * Custom eases named by event-sheet ACE parameters (Tween actions): the ease
 * tools refresh and list the embedded copies, and keep a project.c3proj,
 * ease file or ease parameter that starts with a byte order mark as it was.
 *
 * Construct r495.2 saves `ease: "Bouncy"` as `{ name, json: [{ folders: [], json: <ease file> }] }`;
 * the shape is `easeParameterRoundtrip` in test/fixtures/timeline-kinds/shapes-r495.json.
 * The copy in a sheet is written by the test, not by an event tool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { easeParameterValue } from '../../src/construct3/ease-params.js';
import type { CustomEase } from '../../src/construct3/timeline-model.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

/** An event sheet, or one of its blocks or actions, read back from disk: the parts the tests navigate. */
interface SheetJson {
  events: Array<{
    sid: number;
    actions: Array<{ parameters: { ease: { name: string; json: Array<{ json: CustomEase }> } } }>;
  }>;
}

/** An ease file read back from disk. */
interface EaseJson {
  name: string;
  linear: boolean;
  transitionKeyframes: unknown[];
}

const POINTS = [
  { x: 0, y: 0, startHandle: { x: 0.2, y: 0.6 } },
  { x: 0.5, y: 0.9, startHandle: { x: 0.1, y: 0 }, endHandle: { x: -0.1, y: 0 } },
  { x: 1, y: 1, endHandle: { x: -0.2, y: 0 } },
];

/** A Tween action whose ease parameter is `ease`. */
function tween(ease: unknown, sid: number) {
  return {
    id: 'tween-one-property', objectClass: 'Sprite', behaviorType: 'Tween', sid,
    parameters: { tags: '"Custom"', property: 'offsetX', 'end-value': 'Self.X + 50', time: '1', ease, 'destroy-on-complete': 'no' },
  };
}

describe('custom eases in event parameters (real project on disk)', () => {
  let tmpDir: string;
  let server: MockServer;
  let nextSid = 800000000000001;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-ease-params-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    await load();
    await ok('create_ease', { name: 'Bouncy', points: POINTS });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  /** Load the project in the temp folder with the tools these cases call. */
  async function load() {
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerTimelineTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
    registerQueryTools(server as unknown as McpServer, reader);
    registerAnalysisTools(server as unknown as McpServer, reader);
  }

  async function ok(name: string, args: Record<string, unknown>) {
    const result = await server.callTool(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text) as Record<string, unknown> & { eases: Array<Record<string, unknown>> };
  }

  async function sheet(): Promise<SheetJson> {
    return JSON.parse(await readFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), 'utf-8')) as SheetJson;
  }

  async function easeFile(): Promise<EaseJson> {
    return JSON.parse(await readFile(join(tmpDir, 'timelines', 'transitions', 'Bouncy.json'), 'utf-8')) as EaseJson;
  }

  /** Append an every-tick block whose Tween action holds the saved copy of `ease`, writing the sheet straight to disk. */
  async function embedInSheet(ease: CustomEase, sheetName = 'MainSheet') {
    const path = join(tmpDir, 'eventSheets', `${sheetName}.json`);
    const data = JSON.parse(await readFile(path, 'utf-8')) as { events: unknown[] };
    data.events.push({
      eventType: 'block',
      conditions: [{ id: 'every-tick', objectClass: 'System', sid: nextSid++ }],
      actions: [tween(easeParameterValue(ease), nextSid++)],
      sid: nextSid++,
    });
    await writeFile(path, JSON.stringify(data, null, '\t'), 'utf-8');
  }

  it('refreshes embedded copies when the ease changes, and lists the sheets that use it', async () => {
    await embedInSheet(await easeFile() as unknown as CustomEase);
    const listed = await ok('list_eases', {});
    expect(listed.eases[0].usedByEventSheets).toEqual(['MainSheet']);

    const result = await ok('update_ease', { name: 'Bouncy', linear: true });
    expect(result.eventSheetsRefreshed).toEqual(['MainSheet']);
    const events = (await sheet()).events;
    const action = events[events.length - 1].actions[0];
    expect(action.parameters.ease.json[0].json.linear).toBe(true);
    expect(action.parameters.ease.json[0].json).toEqual(await easeFile());
  });

  it('refuses to delete an ease embedded in an event parameter, and warns about the copy when forced', async () => {
    await embedInSheet(await easeFile() as unknown as CustomEase);
    const refused = await server.callTool('delete_ease', { name: 'Bouncy' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('event sheet "MainSheet"');

    const forced = await ok('delete_ease', { name: 'Bouncy', force: true });
    expect((forced.warnings as string[]).join(' ')).toContain('embedded copy');
  });

  // ─── files saved with a byte order mark ──────────────────

  /** Put a byte order mark in front of a project file, as some editors and tools save them. */
  async function addBom(...segments: string[]): Promise<void> {
    const path = join(tmpDir, ...segments);
    await writeFile(path, '\uFEFF' + await readFile(path, 'utf-8'), 'utf-8');
  }

  async function hasBom(...segments: string[]): Promise<boolean> {
    return (await readFile(join(tmpDir, ...segments), 'utf-8')).startsWith('\uFEFF');
  }

  it('create_ease and delete_ease work on a project.c3proj that starts with a BOM, and keep the BOM', async () => {
    await addBom('project.c3proj');
    await ok('create_ease', { name: 'Second', points: POINTS });
    expect(await hasBom('project.c3proj')).toBe(true);
    expect((await ok('list_eases', {})).eases.map(e => e.name)).toEqual(['Bouncy', 'Second']);

    await ok('delete_ease', { name: 'Second' });
    expect(await hasBom('project.c3proj')).toBe(true);
    expect((await ok('list_eases', {})).eases.map(e => e.name)).toEqual(['Bouncy']);
  });

  it('create_ease writes a new ease file in the text style of project.c3proj, not of an existing ease file', async () => {
    const projectFile = join(tmpDir, 'project.c3proj');
    await writeFile(projectFile, '\uFEFF' + (await readFile(projectFile, 'utf-8')).replace(/\r?\n/g, '\r\n'), 'utf-8');
    // The existing ease file, the other place a style could come from, is LF with no BOM.
    const bouncy = join(tmpDir, 'timelines', 'transitions', 'Bouncy.json');
    await writeFile(bouncy, (await readFile(bouncy, 'utf-8')).replace(/\r\n/g, '\n'), 'utf-8');
    await ok('create_ease', { name: 'Third', points: POINTS });
    const text = await readFile(join(tmpDir, 'timelines', 'transitions', 'Third.json'), 'utf-8');
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain('\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('list_eases and update_ease read an ease file that starts with a BOM, and keep the BOM', async () => {
    await addBom('timelines', 'transitions', 'Bouncy.json');

    const listed = await ok('list_eases', {});
    expect(listed.eases[0].error).toBeUndefined();
    expect(listed.eases[0].points).toHaveLength(3);

    await embedInSheet(JSON.parse((await readFile(join(tmpDir, 'timelines', 'transitions', 'Bouncy.json'), 'utf-8')).replace(/^\uFEFF/, '')) as CustomEase);
    await ok('update_ease', { name: 'Bouncy', linear: true });
    expect(await hasBom('timelines', 'transitions', 'Bouncy.json')).toBe(true);
    const events = (await sheet()).events;
    expect(events[events.length - 1].actions[0].parameters.ease.json[0].json.linear).toBe(true);
  });
});
