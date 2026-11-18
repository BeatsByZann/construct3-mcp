/**
 * rename_object_type and timelines built with the timeline tools: the
 * "objectType" of every instance track of the renamed object type is
 * rewritten, in tracks[] and in track folders; a timeline whose only use of
 * the name was its tracks leaves possibleReferences, and one with another
 * value equal to the old name stays listed there. A dry run reports the same
 * and writes nothing. Checked on a temp copy of the minimal fixture with the
 * real reader, writer and ID generator; the instances, the instance variable
 * and the timelines added here are synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerObjectRenameTools } from '../../src/tools/object-rename.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface PropertyTrackJson { property: string; source: { type: string; uid: unknown }; [key: string]: unknown }
interface TrackJson { type?: string; objectType?: string; worldInstance?: number; propertyTracks?: PropertyTrackJson[]; [key: string]: unknown }
interface FolderJson { name: string; items: TrackJson[]; subfolders: FolderJson[]; [key: string]: unknown }
interface TimelineJson { tracks: TrackJson[]; tracksRoot: FolderJson; [key: string]: unknown }
interface UseJson { in: string; kind: string; [key: string]: unknown }
interface ToolData {
  isError?: boolean;
  text?: string;
  success?: boolean;
  dryRun?: boolean;
  filesToWrite?: string[];
  filesWritten?: string[];
  references?: UseJson[];
  possibleReferences?: UseJson[];
  warnings?: string[];
  [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const path = (...parts: string[]) => join(tmpDir, ...parts);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const writeJson = (file: string, data: unknown) => writeFile(file, JSON.stringify(data, null, '\t'));

/** Call a tool; its parsed result, or the error text. */
async function call(tool: string, args: Record<string, unknown>): Promise<ToolData> {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
}

/** Call a tool that must succeed. */
async function ok(tool: string, args: Record<string, unknown>): Promise<ToolData> {
  const data = await call(tool, args);
  expect(data.isError, `${tool} ${JSON.stringify(args)}: ${data.text}`).toBeUndefined();
  return data;
}

/** Every file of the project with its bytes, .bak files left out. */
async function snapshot(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!entry.name.endsWith('.bak')) files.set(relative(tmpDir, full).split('\\').join('/'), await readFile(full, 'utf8'));
    }
  };
  await walk(tmpDir);
  return files;
}

/** A world instance of Sprite on "Layout 1". */
const spriteInstance = (uid: number, sid: number) => ({
  type: 'Sprite', uid, sid, tags: '', properties: {}, instanceVariables: { Sprite: 0 }, behaviors: {}, world: { x: 10 * uid, y: 20, width: 64, height: 64 },
});

/** The timeline file of `name`. */
const timeline = (name: string) => readJson<TimelineJson>(path('timelines', `${name}.json`));

/** The instance tracks of a timeline, in tracks[] and in every track folder. */
function allTracks(data: TimelineJson): TrackJson[] {
  const inFolders = (folder: FolderJson): TrackJson[] => [...folder.items, ...folder.subfolders.flatMap(inFolders)];
  return [...data.tracks, ...inFolders(data.tracksRoot)];
}

/**
 * Timeline "Move": an instance track of Sprite UID 0 in tracks[] and one of
 * Sprite UID 1 moved into the track folder "Group".
 */
async function buildMove(): Promise<void> {
  await ok('create_timeline', { name: 'Move' });
  await ok('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 0, properties: ['offsetAngle'] });
  await ok('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 1, properties: ['offsetAngle'] });
  await ok('add_timeline_folder', { timelineName: 'Move', name: 'Group' });
  await ok('move_timeline_track', { timelineName: 'Move', instanceUid: 1, folder: 'Group' });
  const data = await timeline('Move');
  expect(data.tracks.map(t => t.worldInstance)).toEqual([0]);
  expect(data.tracksRoot.subfolders.map(f => f.name)).toEqual(['Group']);
  expect(data.tracksRoot.subfolders[0].items.map(t => [t.worldInstance, t.objectType])).toEqual([[1, 'Sprite']]);
}

/**
 * Timeline "MoveVar": an instance track of Sprite UID 2 with a property track
 * of the instance variable "Sprite", whose name equals the object type's.
 */
async function buildMoveVar(): Promise<void> {
  await ok('create_timeline', { name: 'MoveVar' });
  await ok('add_timeline_track', { timelineName: 'MoveVar', layoutName: 'Layout 1', instanceUid: 2, properties: ['offsetAngle', 'var:Sprite'] });
  const track = (await timeline('MoveVar')).tracks[0];
  expect(track.objectType).toBe('Sprite');
  expect(track.propertyTracks?.map(p => p.property)).toEqual(['offsetAngle', 'Sprite']);
}

/** The property track of the instance variable "Sprite" on the first track of a timeline. */
const variableTrack = (data: TimelineJson) => data.tracks[0].propertyTracks?.find(p => p.source.type === 'instance-variable');

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-rename-object-timelines-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  const layout = await readJson<{ layers: Array<{ instances: unknown[] }> }>(path('layouts', 'Layout 1.json'));
  layout.layers[0].instances.push(spriteInstance(1, 500000000000021), spriteInstance(2, 500000000000022));
  await writeJson(path('layouts', 'Layout 1.json'), layout);
  const sprite = await readJson<Record<string, unknown>>(path('objectTypes', 'Sprite.json'));
  sprite.instanceVariables = [{ name: 'Sprite', type: 'number', initialValue: 0, desc: '', sid: 600000000000001 }];
  await writeJson(path('objectTypes', 'Sprite.json'), sprite);
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  const deps = { server, reader, writer, idGen } as unknown as MutationToolDeps;
  registerTimelineTools(deps);
  registerObjectRenameTools(deps);
  resetProjectIndex();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('rename_object_type and timeline tracks', () => {
  it('(a) points the instance tracks in tracks[] and in a track folder at the new name, and lists the timeline as written only', async () => {
    await buildMove();

    const before = await snapshot();
    const dry = await ok('rename_object_type', { name: 'Sprite', newName: 'Player', dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.filesToWrite).toContain('timelines/Move.json');
    expect(dry.possibleReferences?.map(r => r.in) ?? []).not.toContain('timelines/Move.json');
    expect(await snapshot()).toEqual(before);

    const live = await ok('rename_object_type', { name: 'Sprite', newName: 'Player' });
    expect(live.success).toBe(true);
    expect(live.filesWritten).toContain('timelines/Move.json');
    expect(live.references).toContainEqual({ in: 'timelines/Move.json', kind: 'timeline track', tracks: 2, value: 'Sprite' });
    expect(live.possibleReferences?.map(r => r.in) ?? []).not.toContain('timelines/Move.json');
    const data = await timeline('Move');
    expect(data.tracks[0].objectType).toBe('Player');
    expect(data.tracksRoot.subfolders[0].items[0].objectType).toBe('Player');
    expect(allTracks(data).map(t => t.objectType)).toEqual(['Player', 'Player']);
  });

  it('(b) points the instance track at the new name, keeps an instance variable named like the object, and lists the timeline as written and as a possible reference', async () => {
    await buildMove();
    await buildMoveVar();

    const before = await snapshot();
    const dry = await ok('rename_object_type', { name: 'Sprite', newName: 'Player', dryRun: true });
    expect(dry.filesToWrite).toEqual(expect.arrayContaining(['timelines/Move.json', 'timelines/MoveVar.json']));
    expect(dry.possibleReferences?.map(r => r.in)).toContain('timelines/MoveVar.json');
    expect(dry.possibleReferences?.map(r => r.in)).not.toContain('timelines/Move.json');
    expect(await snapshot()).toEqual(before);

    const live = await ok('rename_object_type', { name: 'Sprite', newName: 'Player' });
    expect(live.filesWritten).toEqual(expect.arrayContaining(['timelines/Move.json', 'timelines/MoveVar.json']));
    expect(live.possibleReferences?.map(r => r.in)).toContain('timelines/MoveVar.json');
    expect(live.possibleReferences?.map(r => r.in)).not.toContain('timelines/Move.json');
    const data = await timeline('MoveVar');
    expect(data.tracks[0].objectType).toBe('Player');
    expect(variableTrack(data)?.property).toBe('Sprite');
    expect(variableTrack(data)?.source).toEqual({ type: 'instance-variable', uid: 'Sprite' });
  });

  it('puts the rewritten timelines back when a later write of the rename fails', async () => {
    await buildMove();
    await buildMoveVar();
    const before = await snapshot();
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('EBUSY'));
    const data = await call('rename_object_type', { name: 'Sprite', newName: 'Player' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back');
    expect(data.text).toContain('timelines/Move.json');
    expect(await snapshot()).toEqual(before);
  });
});
