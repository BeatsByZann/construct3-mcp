/**
 * Change-journal coverage for tools that write outside the project writer,
 * and the guards that keep revert_last_change from restoring a wrong state:
 * a validation panel found that create_timeline, create_ease and
 * create_flowchart refreshed project.c3proj.bak without a journal entry, so
 * the next revert restored that newer backup and reported the previous call
 * as reverted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSession } from '../../src/construct3/project-session.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { clearJournal, clearStamps } from '../../src/construct3/change-journal.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerSessionTools } from '../../src/tools/session-tools.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import { registerFlowchartTools } from '../../src/tools/flowchart-tools.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerFileTools } from '../../src/tools/file-tools.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { registerStructureTools } from '../../src/tools/structure-tools.js';
import { registerContainerTools } from '../../src/tools/container-tools.js';
import { registerTilemapBrushTools } from '../../src/tools/tilemap-brush-tools.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let tmpDir: string;
let server: MockServer;
let session: ProjectSession;

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
const parse = (result: Result) => JSON.parse(result.content[0].text);
const projectPath = () => join(tmpDir, 'project.c3proj');
const project = async (): Promise<any> => JSON.parse(await readFile(projectPath(), 'utf-8'));

async function ok(name: string, args: Record<string, unknown>): Promise<Result> {
  const result = await server.callTool(name, args);
  expect(result.isError, result.content[0].text).toBeFalsy();
  return result;
}

async function start(fixture: string): Promise<void> {
  resetProjectIndex();
  clearJournal();
  clearStamps();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-journal-coverage-'));
  await cp(join(FIXTURE_DIR, '..', fixture), tmpDir, { recursive: true });
  session = await ProjectSession.start(projectPath());
  server = new MockServer();
  session.install(server as any);
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(session.reader, idGen);
  const deps = { server, reader: session.reader, writer, idGen } as any;
  registerProjectTools(deps);
  registerTimelineTools(deps);
  registerFlowchartTools(deps);
  registerObjectTools(deps);
  registerFileTools(deps);
  registerRuntimeTools(deps);
  registerStructureTools(deps);
  registerContainerTools(deps);
  registerTilemapBrushTools(deps);
  registerAnimationTools(deps);
  registerSessionTools(server as any, session, idGen);
}

beforeEach(async () => { await start('minimal-project'); });

/** Every project file with its SHA-256, backups and temp files aside. */
async function snapshot(dir = tmpDir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, prefix: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (e.isDirectory()) await walk(join(d, e.name), rel + '/');
      else if (!/\.(bak|tmp)$/.test(e.name)) out[rel] = createHash('sha256').update(await readFile(join(d, e.name))).digest('hex');
    }
  };
  await walk(dir, '');
  return out;
}

afterEach(async () => {
  clearJournal();
  clearStamps();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('revert_last_change after a tool that used to write outside the journal', () => {
  it.each([
    ['create_timeline', { name: 'T1' }, (p: any) => JSON.stringify(p.timelines ?? {}).includes('"T1"'), 'timelines/T1.json'],
    ['create_ease', { name: 'E1', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, (p: any) => JSON.stringify(p.timelines ?? {}).includes('"E1"'), 'timelines/transitions/E1.json'],
    ['create_flowchart', { name: 'F1' }, (p: any) => JSON.stringify(p.flowcharts ?? {}).includes('"F1"'), 'flowcharts/F1.json'],
  ] as const)('undoes %s itself, not the call before it', async (tool, args, registered, file) => {
    await ok('update_project_properties', { properties: { zFar: 9000 } });
    const made = await ok(tool, args);
    expect(made.content.at(-1)!.text).toMatch(/^Changed \d+ file\(s\): .*project\.c3proj/);
    expect(registered(await project())).toBe(true);
    expect(existsSync(join(tmpDir, file))).toBe(true);

    const reverted = parse(await ok('revert_last_change', {}));
    expect(reverted.reverted.tool).toBe(tool);
    const after = await project();
    expect(registered(after)).toBe(false);
    expect(after.properties.zFar).toBe(9000);
    expect(existsSync(join(tmpDir, file))).toBe(false);
  });
});

describe('revert_last_change after a delete or a move outside the project writer', () => {
  it.each([
    ['delete_timeline', 'create_timeline', { name: 'T1' }, 'timelines/T1.json', (p: any) => JSON.stringify(p.timelines ?? {}).includes('"T1"')],
    ['delete_flowchart', 'create_flowchart', { name: 'F1' }, 'flowcharts/F1.json', (p: any) => JSON.stringify(p.flowcharts ?? {}).includes('"F1"')],
    ['deregister_project_file', 'create_data_file', { name: 'levels.json', kind: 'json', content: '{}' }, 'files/levels.json', (p: any) => JSON.stringify(p.rootFileFolders ?? {}).includes('"levels.json"')],
  ] as const)('restores what %s removed', async (remove, make, args, file, registered) => {
    await ok(make, args);
    const content = await readFile(join(tmpDir, file), 'utf-8');
    await ok(remove, { name: args.name });
    expect(existsSync(join(tmpDir, file))).toBe(false);
    expect(registered(await project())).toBe(false);

    const reverted = parse(await ok('revert_last_change', {}));
    expect(reverted.reverted.tool).toBe(remove);
    expect(await readFile(join(tmpDir, file), 'utf-8')).toBe(content);
    expect(registered(await project())).toBe(true);
  });

  it('moves a Project Bar item and its file back', async () => {
    const before = await readFile(projectPath(), 'utf-8');
    await ok('move_project_item', { category: 'layout', name: 'Layout 1', folder: 'Levels' });
    expect(existsSync(join(tmpDir, 'layouts', 'Levels', 'Layout 1.json'))).toBe(true);
    expect(existsSync(join(tmpDir, 'layouts', 'Layout 1.json'))).toBe(false);

    await ok('revert_last_change', {});
    expect(existsSync(join(tmpDir, 'layouts', 'Layout 1.json'))).toBe(true);
    expect(existsSync(join(tmpDir, 'layouts', 'Levels', 'Layout 1.json'))).toBe(false);
    expect(await readFile(projectPath(), 'utf-8')).toBe(before);
  });
});

describe('revert_last_change returns every file to its state before the call', () => {
  const EASE = { name: 'E1', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
  // A 1x1 opaque PNG.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const BRUSH = { objectName: 'Tiles', name: 'Patchy', type: 'patch', data: { width: 2, height: 2, data: [[1, 2], [3, 4]] } };
  it.each([
    ['minimal-project', [], ['unregister_addon', { type: 'plugin', id: 'Sprite', force: true }]],
    ['minimal-project', [], ['create_container', { members: ['Sprite'] }]],
    ['minimal-project', [], ['register_addon', { type: 'plugin', id: 'Gamepad', name: 'Gamepad' }]],
    ['minimal-project', [['create_object', { name: 'Hero', pluginId: 'Sprite' }]], ['duplicate_object_type', { objectName: 'Hero', newName: 'Hero2' }]],
    ['minimal-project', [['create_timeline', { name: 'T1' }]], ['duplicate_timeline', { timelineName: 'T1', newName: 'T2' }]],
    ['minimal-project', [['create_ease', EASE]], ['delete_ease', { name: 'E1' }]],
    ['minimal-project', [['inject_runtime_bridge', {}]], ['remove_runtime_bridge', {}]],
    ['minimal-project', [], ['register_project_file', { sourcePath: '@source', folder: 'general' }]],
    ['rename-project', [], ['add_tilemap_brush', BRUSH]],
    ['minimal-project', [['create_object', { name: 'Hero', pluginId: 'Sprite' }]], ['replace_sprite_image', { objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, pngBase64: PNG }]],
    ['minimal-project', [['create_object', { name: 'Floor', pluginId: 'TiledBg' }]], ['replace_object_image', { objectName: 'Floor', pngBase64: PNG }]],
  ] as Array<[string, Array<[string, Record<string, unknown>]>, [string, Record<string, unknown>]]>)('%s: %j then %j', async (fixture, setup, [tool, args]) => {
    if (fixture !== 'minimal-project') {
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
      await start(fixture);
    }
    for (const [name, a] of setup) await ok(name, a);
    let callArgs = args;
    if (args.sourcePath === '@source') {
      const source = join(tmpDir, 'source.txt');
      await writeFile(source, 'hello', 'utf-8');
      callArgs = { ...args, sourcePath: source };
    }
    const before = await snapshot();
    await ok(tool, callArgs);
    expect(await snapshot()).not.toEqual(before);

    const reverted = parse(await ok('revert_last_change', {}));
    expect(reverted.reverted.tool).toBe(tool);
    expect(reverted.notRestored).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });
});

describe('revert_last_change refuses to restore a wrong state', () => {
  it('when a file the call wrote was changed afterwards by something the journal does not record', async () => {
    await ok('update_project_properties', { properties: { zFar: 9000 } });
    const edited = (await readFile(projectPath(), 'utf-8')).replace('"zFar": 9000', '"zFar": 7000');
    await writeFile(projectPath(), edited, 'utf-8');

    const refused = await server.callTool('revert_last_change', {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('changed after that call by something the change journal does not record');
    expect(refused.content[0].text).toContain('project.c3proj');
    expect(await readFile(projectPath(), 'utf-8')).toBe(edited);
  });

  it('when the backup the call left was replaced afterwards', async () => {
    await ok('update_project_properties', { properties: { zFar: 9000 } });
    await writeFile(projectPath() + '.bak', await readFile(projectPath(), 'utf-8'), 'utf-8');

    const refused = await server.callTool('revert_last_change', {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('project.c3proj.bak');
  });
});

describe('one backup per file per call', () => {
  it('keeps the state from before the call when the call writes project.c3proj twice', async () => {
    // A new plugin is registered in usedAddons, then the object is added to the tree: two writes.
    const before = await readFile(projectPath(), 'utf-8');
    expect(before).not.toContain('"Keyboard"');
    await ok('create_object', { name: 'Keys', pluginId: 'Keyboard' });
    expect(await readFile(projectPath(), 'utf-8')).toContain('"Keyboard"');

    await ok('revert_last_change', {});
    expect(await readFile(projectPath(), 'utf-8')).toBe(before);
  });
});

describe('every file a call changes is named in its result', () => {
  it.each([
    ['register_addon', { type: 'plugin', id: 'Gamepad', name: 'Gamepad' }, ['project.c3proj']],
    ['create_data_file', { name: 'levels.json', kind: 'json', content: '{}' }, ['files/levels.json', 'project.c3proj']],
    ['inject_runtime_bridge', {}, ['scripts/c3-runtime-bridge.js', 'project.c3proj']],
  ] as const)('%s', async (tool, args, files) => {
    const result = await ok(tool, args);
    const line = result.content.map(c => c.text).find(t => t.startsWith('Changed '));
    expect(line, JSON.stringify(result.content)).toBeDefined();
    for (const file of files) expect(line).toContain(file);
  });
});
