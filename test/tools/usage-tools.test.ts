/**
 * get_project_properties and get_instance_counts, and the completeness
 * helpers every usage query shares, on a temp copy of the minimal fixture
 * with the real reader.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import type { UnscannedFile } from '../../src/construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../../src/construct3/raw-text-search.js';
import { registerUsageTools, completeness, partlyIndexed } from '../../src/tools/usage-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

type Category = 'objectTypes' | 'eventSheets' | 'layouts';

const OMITTED = 'Object types with no instance are not listed, because a file that could not be parsed leaves the list unreliable.';

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;

async function register(category: Category, name: string): Promise<void> {
  const path = join(tmpDir, 'project.c3proj');
  const project = JSON.parse(await readFile(path, 'utf-8'));
  project[category].items.push(name);
  await writeFile(path, JSON.stringify(project, null, '\t'));
}

async function addEntity(category: Category, name: string, data: unknown): Promise<void> {
  await register(category, name);
  await writeFile(join(tmpDir, category, `${name}.json`), JSON.stringify(data, null, '\t'));
}

const sprite = (name: string, sid: number) => ({
  name, 'plugin-id': 'Sprite', sid, isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [],
  animations: { items: [], subfolders: [] },
});

let nextUid = 100;
const instance = (type: string) => ({
  type, uid: nextUid++, sid: 800000000000000 + nextUid, properties: {}, instanceVariables: {}, behaviors: {},
  world: { x: 0, y: 0, width: 64, height: 64 },
});

const layer = (name: string, sid: number, instances: unknown[], subLayers: unknown[] = []) =>
  ({ name, sid, instances, subLayers, isInitiallyVisible: true });

/**
 * Enemy (2 instances) and Crate (none) join the fixture's Sprite (1 instance
 * on "Layout 1"); "Layout 2" holds 2 Sprites on Main, an Enemy on its
 * sub-layer HUD and a non-world Enemy.
 */
async function addInventory(): Promise<void> {
  await addEntity('objectTypes', 'Enemy', sprite('Enemy', 810000000000001));
  await addEntity('objectTypes', 'Crate', sprite('Crate', 810000000000002));
  await addEntity('layouts', 'Layout 2', {
    name: 'Layout 2',
    layers: [layer('Main', 820000000000001, [instance('Sprite'), instance('Sprite')], [layer('HUD', 820000000000002, [instance('Enemy')])])],
    'nonworld-instances': [{ type: 'Enemy', uid: nextUid++, sid: 820000000000003, properties: {}, instanceVariables: {}, behaviors: {} }],
    sid: 820000000000004,
    eventSheet: '',
    width: 1920,
    height: 1080,
  });
}

async function startServer(): Promise<void> {
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  server = new MockServer();
  registerUsageTools(server as never, reader);
  resetProjectIndex(reader);
}

async function raw(name: string, args: Record<string, unknown> = {}) {
  return server.callTool(name, args);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await raw(name, args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-usage-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('get_project_properties', () => {
  it('returns the properties bag and the top-level scalars, and none of the project\'s lists', async () => {
    await startServer();
    const project = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8'));
    const result = await call('get_project_properties');
    expect(result.properties).toEqual(project.properties);
    expect(result.topLevel).toMatchObject({ name: project.name, savedWithRelease: project.savedWithRelease });
    for (const key of ['objectTypes', 'layouts', 'eventSheets', 'families', 'timelines', 'flowcharts', 'rootFileFolders', 'usedAddons', 'containers', 'models3d']) {
      expect(result, key).not.toHaveProperty(key);
      expect(result.topLevel, key).not.toHaveProperty(key);
    }
    expect(result).not.toHaveProperty('success');
    expect(result).not.toHaveProperty('editorNote');
  });
});

describe('get_instance_counts', () => {
  it('counts per type and layout, sub-layers and non-world instances included, sorted by total then name', async () => {
    await addInventory();
    await startServer();
    const result = await call('get_instance_counts');
    expect(result.totalInstances).toBe(5);
    expect(result.objects).toEqual([
      { name: 'Sprite', total: 3, byLayout: [{ layout: 'Layout 2', instances: 2 }, { layout: 'Layout 1', instances: 1 }] },
      { name: 'Enemy', total: 2, byLayout: [{ layout: 'Layout 2', instances: 2 }] },
    ]);
    expect(result.notPlaced).toEqual(['Crate']);
    expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty('unscannedFiles');
    expect(result).not.toHaveProperty('success');
    expect(result).not.toHaveProperty('editorNote');
  });

  it('filters by object and layout in any letter case and answers with the registered spelling', async () => {
    await addInventory();
    await startServer();
    const byObject = await call('get_instance_counts', { objectName: 'sprite' });
    expect(byObject.objects).toEqual([
      { name: 'Sprite', total: 3, byLayout: [{ layout: 'Layout 2', instances: 2 }, { layout: 'Layout 1', instances: 1 }] },
    ]);
    expect(byObject.totalInstances).toBe(3);

    const byLayout = await call('get_instance_counts', { layoutName: 'LAYOUT 1' });
    expect(byLayout.objects).toEqual([{ name: 'Sprite', total: 1, byLayout: [{ layout: 'Layout 1', instances: 1 }] }]);
    expect(byLayout.notPlaced).toEqual(['Enemy', 'Crate']);
  });

  it('refuses an unknown object or layout and ends "Nothing was returned."', async () => {
    await startServer();
    for (const args of [{ objectName: 'Nope' }, { layoutName: 'Nope' }]) {
      const result = await raw('get_instance_counts', args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('"Nope" not found.');
      expect(result.content[0].text.endsWith(' Nothing was returned.')).toBe(true);
    }
  });

  it('leaves out an unparsable layout, says so, and withholds notPlaced until it parses again', async () => {
    await addInventory();
    const path = join(tmpDir, 'layouts', 'Layout 2.json');
    const good = await readFile(path, 'utf-8');
    await writeFile(path, '{ broken');
    await startServer();
    const broken = await call('get_instance_counts');
    expect(broken.complete).toBe(false);
    expect(broken.unscannedFiles).toEqual([
      expect.objectContaining({ file: 'layouts/Layout 2', textSearch: 'not-searched' }),
    ]);
    expect(broken.objects).toEqual([{ name: 'Sprite', total: 1, byLayout: [{ layout: 'Layout 1', instances: 1 }] }]);
    expect(broken).not.toHaveProperty('notPlaced');
    expect(broken.notPlacedOmitted).toBe(OMITTED);

    await writeFile(path, good);
    await reader.loadProject();
    resetProjectIndex(reader);
    const fixed = await call('get_instance_counts');
    expect(fixed.complete).toBe(true);
    expect(fixed).not.toHaveProperty('unscannedFiles');
    expect(fixed).not.toHaveProperty('notPlacedOmitted');
    expect(fixed.notPlaced).toEqual(['Crate']);
  });

  it('is complete when only a file it does not read is unparsable', async () => {
    await addEntity('eventSheets', 'Broken', { name: 'Broken', events: [], sid: 830000000000001 });
    await writeFile(join(tmpDir, 'eventSheets', 'Broken.json'), '{ broken');
    await startServer();
    const result = await call('get_instance_counts');
    expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty('unscannedFiles');
  });

  it('is incomplete when an object type file is unparsable, names it and withholds notPlaced', async () => {
    await addInventory();
    await writeFile(join(tmpDir, 'objectTypes', 'Enemy.json'), '{ broken');
    await startServer();
    const result = await call('get_instance_counts');
    expect(result.complete).toBe(false);
    expect(result.unscannedFiles).toEqual([
      expect.objectContaining({ file: 'objectTypes/Enemy', textSearch: 'not-searched' }),
    ]);
    expect(result.totalInstances).toBe(5);
    expect(result).not.toHaveProperty('notPlaced');
    expect(result.notPlacedOmitted).toBe(OMITTED);
  });

  it('describes notPlaced under layoutName in the tool description', async () => {
    await startServer();
    expect(server.getTool('get_instance_counts')?.description).toContain('with layoutName set, notPlaced lists the types with no instance on that layout');
  });

  it('get_project_properties returns a reader failure as an error', async () => {
    await startServer();
    vi.spyOn(reader, 'getProject').mockImplementation(() => { throw new Error('project gone'); });
    const props = await raw('get_project_properties');
    expect(props.isError).toBe(true);
    expect(props.content[0].text).toBe('Error reading project properties: project gone');
  });

  it('get_instance_counts returns a reader failure as an error', async () => {
    await startServer();
    vi.spyOn(reader, 'listObjectTypes').mockRejectedValue(new Error('listing failed'));
    resetProjectIndex(reader);
    const counts = await raw('get_instance_counts');
    expect(counts.isError).toBe(true);
    expect(counts.content[0].text).toBe('Error counting instances: listing failed');
  });
});

describe('registration', () => {
  it('registers the six usage tools', async () => {
    await startServer();
    for (const name of ['get_project_properties', 'get_instance_counts', 'search_project', 'find_behavior_usage', 'find_effect_usage', 'find_instance_variable_references']) {
      expect(server.hasTool(name), name).toBe(true);
    }
  });
});

describe('completeness', () => {
  const file = (category: UnscannedFile['category'], name: string): UnscannedFile =>
    ({ category, name, file: `${category}/${name}`, reason: 'not valid JSON' });
  const term = nameTerm('Enemy');
  const searcher = (found: Record<string, string[]>) => ({
    searchEntityTextRaw: vi.fn(async (category: string, name: string) => new Set(found[`${category}/${name}`] ?? [])),
  });

  it('reports every selected file as not-searched, in order, when there is nothing to search for', async () => {
    const r = searcher({});
    const result = await completeness(r as never, [file('layouts', 'B'), file('eventSheets', 'S'), file('layouts', 'A')], ['layouts'], []);
    expect(result.complete).toBe(false);
    expect(result.unscannedFiles).toEqual([
      { file: 'layouts/B', reason: 'not valid JSON', textSearch: 'not-searched' },
      { file: 'layouts/A', reason: 'not valid JSON', textSearch: 'not-searched' },
    ]);
    expect(r.searchEntityTextRaw).not.toHaveBeenCalled();
  });

  it('returns the search outcomes when there are terms', async () => {
    const r = searcher({ 'layouts/A': ['Enemy'] });
    const result = await completeness(r as never, [file('layouts', 'A'), file('layouts', 'B')], ['layouts'], [[term]]);
    expect(result.complete).toBe(false);
    expect(result.unscannedFiles?.map(u => [u.file, u.textSearch])).toEqual([
      ['layouts/A', 'possible-use'], ['layouts/B', 'no-match'],
    ]);
  });

  it('treats a group with no term as nothing to search for', async () => {
    const r = searcher({});
    const result = await completeness(r as never, [file('layouts', 'A')], ['layouts'], [[]]);
    expect(result.unscannedFiles).toEqual([{ file: 'layouts/A', reason: 'not valid JSON', textSearch: 'not-searched' }]);
    expect(r.searchEntityTextRaw).not.toHaveBeenCalled();
  });

  it('is incomplete for an extra list alone and returns the list under its key', async () => {
    const result = await completeness(searcher({}) as never, [], ['layouts'], [], { unreadableScripts: ['scripts/x.js'], scriptsNotWalked: [] });
    expect(result).toEqual({ complete: false, unreadableScripts: ['scripts/x.js'] });
    const sheets = await completeness(searcher({}) as never, [], ['layouts'], [], { partlyIndexedSheets: ['eventSheets/S'], scriptsNotWalked: ['scripts/d/'] });
    expect(sheets).toEqual({ complete: false, partlyIndexedSheets: ['eventSheets/S'], scriptsNotWalked: ['scripts/d/'] });
  });

  it('is complete with no files and no extras, and has no other keys', async () => {
    expect(await completeness(searcher({}) as never, [file('eventSheets', 'S')], ['layouts'], [])).toEqual({ complete: true });
  });
});

describe('partlyIndexed', () => {
  it('gives each sheet once as eventSheets/<name> and ignores other warnings', () => {
    const warnings = [
      'Event sheet "A": traversal limit reached (100000 nodes)',
      'Event sheet "A": max depth exceeded at block > block',
      'Event sheet "B": max depth exceeded at block',
      'Event sheet "Q"x": traversal limit reached (100000 nodes)',
      'Something else happened',
    ];
    expect(partlyIndexed({ warnings })).toEqual(['eventSheets/A', 'eventSheets/B', 'eventSheets/Q"x']);
    expect(partlyIndexed({ warnings: ['Something else happened'] })).toEqual([]);
    expect(partlyIndexed({ warnings: [] })).toEqual([]);
  });
});
