/**
 * revert_last_change after the tools that write project files outside
 * writeEntityFile (timelines, addons, images, the runtime bridge) and the
 * frame tools that rename images: the call reverts itself, not the call
 * before it, and every file returns to its state before the call. A call
 * whose own rollback put everything back records nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { getImageFileName } from '../../src/construct3/png-generator.js';
import { journalEntries } from '../../src/construct3/change-journal.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { withProjectSync } from '../../src/tools/project-sync.js';
import { toolError } from '../../src/tools/shared.js';
import { snapshotProject } from '../helpers/project-snapshot.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
// A 1x1 opaque PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HERO = { name: 'Hero', pluginId: 'Sprite' };
const FRAME = { objectName: 'Hero', animationName: 'Animation 1' };

let dir: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let runtime: { close(): Promise<void> };

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** Register the tools on a fresh server with `w` (a failing double when given). */
function register(w: Construct3ProjectWriter, idGen: IdGenerator): void {
  writer = w;
  server = new MockServer();
  registerQueryTools(server as never, reader);
  registerMutationTools(server as never, reader, w, idGen);
  runtime = registerRuntimeTools({ server: server as never, reader, writer: w });
}

async function ok(tool: string, args: Record<string, unknown> = {}): Promise<Result> {
  const result = await server.callTool(tool, args);
  expect(result.isError, `${tool}: ${result.content[0].text}`).toBeFalsy();
  return result;
}

const parse = (result: Result) => JSON.parse(result.content[0].text);
const image = (i: number) => `images/${getImageFileName('Hero', 'Animation 1', i, 'Sprite')}`;
const rel = (path: string) => join(dir, ...path.split('/'));
const entryIds = () => journalEntries(reader, 50).map(e => e.id);
const snapshot = () => snapshotProject(dir);

/** Every .bak file under the project, by project-relative path. */
async function backups(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name), prefix + e.name + '/');
      else if (e.name.endsWith('.bak')) out.push(prefix + e.name);
    }
  };
  await walk(dir, '');
  return out.sort();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-journal-coverage-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  register(new Construct3ProjectWriter(reader, idGen), idGen);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('revert_last_change returns every file to its state before the call', () => {
  it.each([
    ['register_addon', [], { type: 'plugin', id: 'Gamepad', name: 'Gamepad' }],
    ['unregister_addon', [], { type: 'plugin', id: 'Sprite', force: true }],
    ['create_timeline', [], { name: 'T1' }],
    ['update_timeline', [['create_timeline', { name: 'T1' }]], { name: 'T1', loop: true }],
    ['delete_timeline', [['create_timeline', { name: 'T1' }]], { name: 'T1' }],
    ['replace_sprite_image', [['create_object', HERO]], { ...FRAME, frameIndex: 0, pngBase64: PNG }],
    ['create_object', [], HERO],
    ['rename_animation', [['create_object', HERO]], { ...FRAME, newName: 'Run' }],
    ['add_frame_to_animation', [['create_object', HERO], ['add_frame_to_animation', FRAME]], { ...FRAME, index: 0 }],
    ['delete_frame_from_animation', [['create_object', HERO], ['add_frame_to_animation', FRAME]], { ...FRAME, frameIndex: 0 }],
    ['delete_object', [['create_object', HERO], ['add_frame_to_animation', FRAME]], { name: 'Hero', force: true }],
    ['add_animation_to_sprite', [['create_object', HERO]], { objectName: 'Hero', animationName: 'Run' }],
    ['inject_runtime_bridge', [], {}],
    ['remove_runtime_bridge', [['inject_runtime_bridge', {}]], {}],
  ] as Array<[string, Array<[string, Record<string, unknown>]>, Record<string, unknown>]>)('%s', async (tool, setup, args) => {
    for (const [name, a] of setup) await ok(name, a);
    const before = await snapshot();
    await ok(tool, args);
    expect(await snapshot()).not.toEqual(before);

    const reverted = parse(await ok('revert_last_change'));
    expect(reverted.reverted.tool).toBe(tool);
    expect(reverted.notRestored).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it('create_timeline reverts itself, not the call before it', async () => {
    await ok('update_project_metadata', { author: 'Before' });
    await ok('create_timeline', { name: 'T1' });
    expect(parse(await ok('revert_last_change')).reverted.tool).toBe('create_timeline');
    const project = JSON.parse(await readFile(rel('project.c3proj'), 'utf-8'));
    expect(JSON.stringify(project.timelines ?? {})).not.toContain('"T1"');
    expect(project.properties.author).toBe('Before');
  });

  it('rename_animation after replace_sprite_image: the first revert undoes the rename, and the second refuses because a later call backed the same file up', async () => {
    await ok('create_object', HERO);
    const original = await readFile(rel(image(0)));
    const initial = await snapshot();
    const initialBackups = await backups();

    await ok('replace_sprite_image', { ...FRAME, frameIndex: 0, pngBase64: PNG });
    const afterReplace = await snapshot();
    const replaceBackups = await backups();
    // The replace leaves a .bak for each file it wrote: the image (with its
    // old bytes), the object file (frame metadata) and project.c3proj, whose
    // .bak from create_object it overwrites
    expect(replaceBackups).toEqual([...new Set([...initialBackups, `${image(0)}.bak`, 'objectTypes/Hero.json.bak', 'project.c3proj.bak'])].sort());
    expect(await readFile(rel(`${image(0)}.bak`))).toEqual(original);

    await ok('rename_animation', { ...FRAME, newName: 'Run' });
    expect(await snapshot()).not.toEqual(afterReplace);
    // The rename moves the image files but leaves the .bak under its old name
    expect(await backups()).toEqual(replaceBackups);

    // The first revert undoes the rename, and only the rename
    expect(parse(await ok('revert_last_change')).reverted.tool).toBe('rename_animation');
    expect(await snapshot()).toEqual(afterReplace);
    expect(await backups()).toEqual(replaceBackups);

    // The second revert refuses: rename_animation backed up the object file
    // again, so the replace's backup no longer holds its pre-call state. Only
    // the most recent call that changed a file can be reverted, and nothing is restored
    const second = await server.callTool('revert_last_change', {});
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain('a later call backed the same file(s) up again');
    expect(await snapshot()).toEqual(afterReplace);
    expect(await backups()).toEqual(replaceBackups);
    expect(await readFile(rel(`${image(0)}.bak`))).toEqual(original);
  });
});

describe('list_changes after a frame tool', () => {
  it('shows delete_frame_from_animation\'s renames', async () => {
    await ok('create_object', HERO);
    await ok('add_frame_to_animation', FRAME);
    await ok('delete_frame_from_animation', { ...FRAME, frameIndex: 0 });
    const changes = parse(await ok('list_changes')).calls[0].changes;
    expect(changes).toEqual(expect.arrayContaining([
      { kind: 'move', file: `${image(0)}.bak`, from: image(0) },
      { kind: 'move', file: image(0), from: image(1) },
    ]));
  });
});

describe('every file a call changes is named in its result', () => {
  it.each([
    ['register_addon', { type: 'plugin', id: 'Gamepad', name: 'Gamepad' }, ['project.c3proj']],
    ['create_timeline', { name: 'T1' }, ['timelines/T1.json', 'project.c3proj']],
    ['inject_runtime_bridge', {}, ['scripts/c3-runtime-bridge.js', 'project.c3proj']],
  ] as Array<[string, Record<string, unknown>, string[]]>)('%s', async (tool, args, files) => {
    const result = await ok(tool, args);
    const line = result.content.map(c => c.text).find(t => t.startsWith('Changed ')) ?? '';
    for (const file of files) expect(line, JSON.stringify(result.content)).toContain(file);
  });
});

describe('a call whose own rollback put everything back records nothing', () => {
  it('a failed add_frame_to_animation, and the revert after it leaves the images alone', async () => {
    await ok('create_object', HERO);
    await ok('add_frame_to_animation', FRAME);
    await writeFile(rel(image(0)), 'artwork 0');
    await writeFile(rel(image(1)), 'artwork 1');
    // The call before the failing one changes only project.c3proj
    await ok('update_project_metadata', { author: 'Last good call' });
    const idGen = new IdGenerator();
    class FailingObjectWriter extends Construct3ProjectWriter {
      override async writeEntityFile(...args: Parameters<Construct3ProjectWriter['writeEntityFile']>): Promise<string> {
        if (args[0] === 'objectTypes') throw new Error('disk full');
        return super.writeEntityFile(...args);
      }
    }
    await runtime.close();
    register(new FailingObjectWriter(reader, idGen), idGen);
    const idsBefore = entryIds();
    const before = await snapshot();

    const failed = await server.callTool('add_frame_to_animation', { ...FRAME, index: 0 });
    expect(failed.isError).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(entryIds()).toEqual(idsBefore);

    const reverted = parse(await ok('revert_last_change'));
    expect(reverted.reverted.tool).toBe('update_project_metadata');
    expect(await readFile(rel(image(0)), 'utf-8')).toBe('artwork 0');
    expect(await readFile(rel(image(1)), 'utf-8')).toBe('artwork 1');
  });

  it('a refused inject_runtime_bridge over an existing bridge file', async () => {
    await mkdir(rel('scripts'), { recursive: true });
    await ok('inject_runtime_bridge', {});
    // An older bridge file whose entry was taken out by hand: the next inject rewrites both, so it reaches the project.c3proj step
    await writeFile(rel('scripts/c3-runtime-bridge.js'), '// an older bridge\n');
    const registered = JSON.parse(await readFile(rel('project.c3proj'), 'utf-8'));
    const scriptItems = registered.rootFileFolders.script.items as Array<{ name?: string }>;
    scriptItems.splice(scriptItems.findIndex(item => item?.name === 'c3-runtime-bridge.js'), 1);
    await writeFile(rel('project.c3proj'), JSON.stringify(registered, null, '\t'), 'utf-8');
    const idsBefore = entryIds();
    const before = await snapshot();
    // The editor saves project.c3proj right before the bridge's write of it
    const original = writer.assertProjectFileCurrent.bind(writer);
    let calls = 0;
    vi.spyOn(writer, 'assertProjectFileCurrent').mockImplementation(async () => {
      if (++calls === 2) {
        const project = JSON.parse(await readFile(rel('project.c3proj'), 'utf-8'));
        project.properties.author = 'Editor';
        await writeFile(rel('project.c3proj'), JSON.stringify(project, null, '\t'), 'utf-8');
      }
      return original();
    });

    const refused = await server.callTool('inject_runtime_bridge', {});
    expect(refused.isError).toBe(true);
    const after = await snapshot();
    expect(after['scripts/c3-runtime-bridge.js']).toBe(before['scripts/c3-runtime-bridge.js']);
    expect(entryIds()).toEqual(idsBefore);
  });
});

describe('a stale refusal after a tool\'s own write', () => {
  it('leaves that write in place, recorded, and revert_last_change puts it back', async () => {
    const timeline = rel('timelines/T.json');
    const synced = withProjectSync(server as never, reader) as unknown as MockServer;
    synced.tool('write_then_refused', 'test only', {}, async () => {
      await writer.replaceFile(timeline, '{"v":1}');
      const layout = (await reader.readAllLayouts()).get('Layout 1');
      // The editor saves the layout after the call read it
      await writeFile(rel('layouts/Layout 1.json'), (await readFile(rel('layouts/Layout 1.json'), 'utf-8')) + '\n');
      try {
        await writer.writeEntityFile('layouts', 'Layout 1', layout);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
      return toolError('expected a refusal');
    });
    const refused = await server.callTool('write_then_refused', {});
    expect(refused.content[0].text).toContain('was changed on disk after this server read it');
    expect(await readFile(timeline, 'utf-8')).toBe('{"v":1}');
    expect(journalEntries(reader)[0].changes.map(c => (c.kind === 'move' ? c.move.toLabel : c.file.label))).toEqual(['timelines/T.json']);

    parse(await ok('revert_last_change'));
    await expect(readFile(timeline, 'utf-8')).rejects.toThrow();
  });
});
