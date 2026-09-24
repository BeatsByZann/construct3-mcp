/**
 * Real-filesystem tests for value tracks, audio tracks, track and
 * property-track folders, custom eases and untyped (legacy) tracks.
 *
 * Shapes are compared, key order included, against
 * test/fixtures/timeline-kinds/shapes-r495.json, which holds the key order and
 * leaf types (no values) of Construct r495.2 example packages: solar-system
 * (value track), synth-sunset (audio track), robotic-loader (track folder),
 * tasty-cappuccino (property-track folder, custom ease, transitionsData,
 * project timelines container) and timeline-basics (untyped track).
 * test/fixtures/timeline-kinds/Legacy.json is the timeline-basics structure
 * cut down to one track with neutral values.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, stat, mkdir, copyFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const KINDS_DIR = join(__dirname, '..', 'fixtures', 'timeline-kinds');

const SOUND = { name: 'Beep.webm', type: 'audio/webm; codecs=opus', sid: 700000000000001, 'file-info': { purpose: 'none' } };
const SUB_SOUND = { name: 'Blip.webm', type: 'audio/webm; codecs=opus', sid: 700000000000003, 'file-info': { purpose: 'none' } };
const MUSIC = { name: 'Theme.webm', type: 'audio/webm; codecs=opus', sid: 700000000000002, 'file-info': { purpose: 'none' } };

type Json = any;

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

/** Key order and leaf types, arrays reduced to their first element (as the fixture was built). */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = shapeOf(entry);
    return out;
  }
  return typeof value;
}

/** Order-sensitive shape comparison. */
function expectShape(actual: unknown, expected: unknown) {
  expect(JSON.stringify(shapeOf(actual))).toBe(JSON.stringify(expected));
}

describe('timeline value/audio tracks, folders, eases and legacy tracks (real project on disk)', () => {
  let tmpDir: string;
  let server: MockServer;
  let shapes: Json;

  beforeEach(async () => {
    shapes = JSON.parse(await readFile(join(KINDS_DIR, 'shapes-r495.json'), 'utf-8'));
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-timeline-kinds-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const projectPath = join(tmpDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf-8'));
    project.rootFileFolders.sound.items.push(SOUND);
    project.rootFileFolders.sound.subfolders.push({ items: [SUB_SOUND], subfolders: [], name: 'Sfx' });
    project.rootFileFolders.music.items.push(MUSIC);
    await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
    await boot();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function boot() {
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerTimelineTools({ server, reader, writer, idGen } as any);
  }

  async function call(name: string, args: Record<string, unknown>) {
    return server.callTool(name, args);
  }

  async function ok(name: string, args: Record<string, unknown>) {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
    return parseResult(result);
  }

  async function fails(name: string, args: Record<string, unknown>, text: string) {
    const result = await call(name, args);
    expect(result.isError, `${name} should fail`).toBe(true);
    expect(result.content[0].text).toContain(text);
  }

  async function onDisk(name = 'Move', ...folders: string[]): Promise<Json> {
    return JSON.parse(await readFile(join(tmpDir, 'timelines', ...folders, `${name}.json`), 'utf-8'));
  }

  async function projectJson(): Promise<Json> {
    return JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8'));
  }

  async function createMove() {
    await ok('create_timeline', { name: 'Move', totalTime: 5 });
  }

  // ─── value tracks ─────────────────────────────────────────

  describe('value tracks', () => {
    it('adds a value track shaped key-for-key like the r495 sample', async () => {
      await createMove();
      await ok('add_value_track', {
        timelineName: 'Move', name: 'Zoom',
        keyframes: [{ time: 1, value: 2 }, { time: 0, value: 0.5, ease: 'easeinoutsine' }],
      });
      const track = (await onDisk()).tracks[0];
      expectShape(track, shapes.valueTrack);
      expect(track.name).toBe('Zoom');
      expect(track.keyframes.map((k: Json) => k.time)).toEqual([0, 1]);
      expect(track.propertyTracks[0].source).toEqual({ type: 'value', uid: 'value' });
      expect(track.propertyTracks[0].propertyKeyframes).toEqual([
        { time: 0, enabled: true, ease: 'easeinoutsine', value: 0.5, rValue: 0.5, aValue: 0.5, addons: [] },
        { time: 1, enabled: true, ease: 'default', value: 2, rValue: 2, aValue: 2, addons: [] },
      ]);
    });

    it('refuses a duplicate value track name and out-of-range times', async () => {
      await createMove();
      await ok('add_value_track', { timelineName: 'Move', name: 'Zoom' });
      await fails('add_value_track', { timelineName: 'Move', name: 'Zoom' }, 'already has a value or audio track');
      await fails('add_value_track', { timelineName: 'Move', name: 'Late', keyframes: [{ time: 9, value: 1 }] }, 'outside the timeline');
    });

    it('sets, updates and deletes value keyframes by track name', async () => {
      await createMove();
      await ok('add_value_track', { timelineName: 'Move', name: 'Zoom' });

      await ok('set_keyframe', { timelineName: 'Move', trackName: 'Zoom', time: 2, values: { value: { absolute: 7 } }, tags: 'peak' });
      await ok('set_keyframe', { timelineName: 'Move', trackName: 'Zoom', time: 0, values: { value: { absolute: 3, ease: 'easeoutsine' } } });
      let track = (await onDisk()).tracks[0];
      expectShape(track, shapes.valueTrack);
      expect(track.keyframes).toEqual([
        { time: 0, tags: '', enabled: true, ease: 'default' },
        { time: 2, tags: 'peak', enabled: true, ease: 'default' },
      ]);
      expect(track.propertyTracks[0].propertyKeyframes.map((k: Json) => [k.time, k.value, k.rValue, k.aValue, k.ease]))
        .toEqual([[0, 3, 3, 3, 'easeoutsine'], [2, 7, 7, 7, 'default']]);

      await fails('set_keyframe', { timelineName: 'Move', trackName: 'Zoom', time: 1 }, 'give values.value.absolute');
      await fails('set_keyframe', { timelineName: 'Move', trackName: 'Zoom', time: 1, values: { offsetX: { absolute: 1 } } }, 'only the "value" property');
      await fails('set_keyframe', { timelineName: 'Move', trackName: 'Zoom', time: 1, values: { value: { relative: 1 } } }, 'absolute values only');
      await fails('delete_keyframe', { timelineName: 'Move', trackName: 'Zoom', time: 2, property: 'value' }, 'delete the master keyframe instead');

      await ok('delete_keyframe', { timelineName: 'Move', trackName: 'Zoom', time: 2 });
      track = (await onDisk()).tracks[0];
      expect(track.keyframes.map((k: Json) => k.time)).toEqual([0]);
      expect(track.propertyTracks[0].propertyKeyframes.map((k: Json) => k.time)).toEqual([0]);
    });

    it('renames a value track and refuses fields it does not have', async () => {
      await createMove();
      await ok('add_value_track', { timelineName: 'Move', name: 'Zoom' });
      await ok('add_value_track', { timelineName: 'Move', name: 'Blur' });
      await fails('update_track', { timelineName: 'Move', trackName: 'Zoom', name: 'Blur' }, 'already has a value or audio track named "Blur"');
      await fails('update_track', { timelineName: 'Move', trackName: 'Zoom', resultMode: 'absolute' }, 'no result mode');
      await fails('update_track', { timelineName: 'Move', trackName: 'Zoom', pathMode: 'line' }, 'no path mode');
      await fails('update_track', { timelineName: 'Move', instanceUid: 0, trackName: 'Zoom', enabled: false }, 'exactly one of');

      await ok('update_track', { timelineName: 'Move', trackName: 'Zoom', name: 'Scale', enabled: false });
      const track = (await onDisk()).tracks[0];
      expectShape(track, shapes.valueTrack);
      expect(track).toMatchObject({ name: 'Scale', enabled: false });

      await ok('remove_timeline_track', { timelineName: 'Move', trackName: 'Scale' });
      expect((await onDisk()).tracks.map((t: Json) => t.name)).toEqual(['Blur']);
    });
  });

  // ─── audio tracks ─────────────────────────────────────────

  describe('audio tracks', () => {
    it('keeps the keyframe at time 0 that Construct requires (A-T1)', async () => {
      await createMove();
      await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', name: 'Sfx', keyframeTimes: [0, 1.5] });
      await fails('delete_keyframe', { timelineName: 'Move', trackName: 'Sfx', time: 0 }, 'needs its keyframe at time 0');
      expect((await onDisk()).tracks[0].keyframes.map((k: Json) => k.time)).toEqual([0, 1.5]);
      await ok('delete_keyframe', { timelineName: 'Move', trackName: 'Sfx', time: 1.5 });
      expect((await onDisk()).tracks[0].keyframes.map((k: Json) => k.time)).toEqual([0]);
    });

    it('adds an audio track shaped like the r495 sample, copying the registered file entry', async () => {
      await createMove();
      const result = await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', keyframeTimes: [0, 1.5] });
      expect(result.trackName).toBe('Audio Track 1');
      const track = (await onDisk()).tracks[0];
      expectShape(track, shapes.audioTrackRoundtrip);
      expect(track.keyframes.map((k: Json) => k.time)).toEqual([0, 1.5]);
      const audio = track.propertyTracks[0];
      expect(audio.source).toEqual({ type: 'audio', uid: 'audio' });
      expect(audio.propertyKeyframes).toEqual([]);
      expect(audio.sourceAdapter).toEqual({ audioProjectFile: SOUND, audioProjectFilePath: 'media/Beep.webm', audioStartOffset: 0, audioTag: '', audioType: 'sound' });

      const second = await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Theme.webm', audioTag: 'bgm' });
      expect(second.trackName).toBe('Audio Track 2');
      expect((await onDisk()).tracks[1].propertyTracks[0].sourceAdapter).toMatchObject({ audioType: 'music', audioTag: 'bgm', audioProjectFile: MUSIC });
    });

    it('matches the r432 sample apart from the path key the r495 round trip added', async () => {
      const withoutPath = structuredClone(shapes.audioTrackRoundtrip);
      delete withoutPath.propertyTracks[0].sourceAdapter.audioProjectFilePath;
      expect(JSON.stringify(withoutPath)).toBe(JSON.stringify(shapes.audioTrack));
    });

    it('writes no file path for a project without the folders export structure', async () => {
      const projectPath = join(tmpDir, 'project.c3proj');
      const project = await projectJson();
      project.properties.exportFileStructure = 'flat';
      await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
      await boot();
      await createMove();
      const added = await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', name: 'Sfx' });
      expect(added.warnings.join(' ')).toContain('"flat"');
      const adapter = (await onDisk()).tracks[0].propertyTracks[0].sourceAdapter;
      expect(Object.keys(adapter)).toEqual(['audioProjectFile', 'audioStartOffset', 'audioTag', 'audioType']);
    });

    it('replaces a stale file path and keeps the adapter key order on partial updates', async () => {
      await createMove();
      await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', name: 'Sfx' });
      // An adapter saved before the path key existed, with the keys out of order.
      const path = join(tmpDir, 'timelines', 'Move.json');
      const data = await onDisk();
      data.tracks[0].propertyTracks[0].sourceAdapter = { audioTag: 'x', audioType: 'sound', audioProjectFile: SOUND, audioStartOffset: 0 };
      await writeFile(path, JSON.stringify(data, null, '\t'), 'utf-8');

      await ok('update_track', { timelineName: 'Move', trackName: 'Sfx', audioTag: 'y' });
      let adapter = (await onDisk()).tracks[0].propertyTracks[0].sourceAdapter;
      expect(Object.keys(adapter)).toEqual(['audioProjectFile', 'audioStartOffset', 'audioTag', 'audioType']);
      expect(adapter.audioTag).toBe('y');

      await ok('update_track', { timelineName: 'Move', trackName: 'Sfx', audioFile: 'Theme.webm' });
      adapter = (await onDisk()).tracks[0].propertyTracks[0].sourceAdapter;
      expect(adapter).toEqual({ audioProjectFile: MUSIC, audioProjectFilePath: 'media/Theme.webm', audioStartOffset: 0, audioTag: 'y', audioType: 'music' });
      expect(Object.keys(adapter)).toEqual(['audioProjectFile', 'audioProjectFilePath', 'audioStartOffset', 'audioTag', 'audioType']);

      const projectPath = join(tmpDir, 'project.c3proj');
      const project = await projectJson();
      project.properties.exportFileStructure = 'flat';
      await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
      await boot();
      await ok('update_track', { timelineName: 'Move', trackName: 'Sfx', audioFile: 'Beep.webm' });
      adapter = (await onDisk()).tracks[0].propertyTracks[0].sourceAdapter;
      expect('audioProjectFilePath' in adapter).toBe(false);
    });

    it('requires the audio file to be registered in the project', async () => {
      await createMove();
      await fails('add_audio_track', { timelineName: 'Move', audioFile: 'Missing.webm' }, 'is not registered');
      await fails('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', audioFolder: 'music' }, 'is not registered');
      expect((await onDisk()).tracks).toEqual([]);
    });

    it('re-points an audio track and keeps it to master keyframes', async () => {
      await createMove();
      await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', name: 'Sfx' });
      await ok('update_track', { timelineName: 'Move', trackName: 'Sfx', audioFile: 'Theme.webm', audioStartOffset: 2, resultMode: 'absolute' });
      const track = (await onDisk()).tracks[0];
      expectShape(track, shapes.audioTrackRoundtrip);
      expect(track.resultMode).toBe('absolute');
      expect(track.propertyTracks[0].sourceAdapter).toEqual({ audioProjectFile: MUSIC, audioProjectFilePath: 'media/Theme.webm', audioStartOffset: 2, audioTag: '', audioType: 'music' });

      await fails('set_keyframe', { timelineName: 'Move', trackName: 'Sfx', time: 1, values: { value: { absolute: 1 } } }, 'master keyframes only');
      await ok('set_keyframe', { timelineName: 'Move', trackName: 'Sfx', time: 3 });
      expect((await onDisk()).tracks[0].keyframes).toEqual([
        { time: 0, tags: '', enabled: true, ease: 'default' },
        { time: 3, tags: '', enabled: true, ease: 'default' },
      ]);
      await fails('update_track', { timelineName: 'Move', instanceUid: 5, audioTag: 'x' }, 'no track for instance UID 5');
    });
  });

  // ─── folders ──────────────────────────────────────────────

  describe('track and property-track folders', () => {
    it('moves tracks into a track folder the way the sample stores them', async () => {
      await createMove();
      await ok('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 0 });
      await ok('add_value_track', { timelineName: 'Move', name: 'Zoom' });
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'Group' });
      await ok('move_timeline_track', { timelineName: 'Move', instanceUid: 0, folder: 'Group' });

      const data = await onDisk();
      expect(data.tracks.map((t: Json) => t.type)).toEqual(['value-track']);
      expect(Object.keys(data.tracksRoot)).toEqual(Object.keys(shapes.tracksRootWithFolder));
      expect(data.tracksRoot.items).toEqual([]);
      const folder = data.tracksRoot.subfolders[0];
      expect(Object.keys(folder)).toEqual(Object.keys(shapes.tracksRootWithFolder.subfolders[0]));
      expect(folder.items.map((t: Json) => t.worldInstance)).toEqual([0]);

      const listed = await ok('list_timeline_tracks', { timelineName: 'Move' });
      expect(listed.tracks.map((t: Json) => [t.kind, t.folder])).toEqual([['value-track', ''], ['instance-track', 'Group']]);
    });

    it('finds a track inside a folder: no duplicate track, and keyframes edit in place', async () => {
      await createMove();
      await ok('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 0 });
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'Group' });
      await ok('move_timeline_track', { timelineName: 'Move', instanceUid: 0, folder: 'Group' });

      await fails('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 0 }, 'in track folder "Group"');
      await ok('set_keyframe', { timelineName: 'Move', instanceUid: 0, time: 2, values: { offsetX: { absolute: 150 } } });
      await ok('update_track', { timelineName: 'Move', instanceUid: 0, resultMode: 'absolute' });

      const data = await onDisk();
      expect(data.tracks).toEqual([]);
      const track = data.tracksRoot.subfolders[0].items[0];
      expect(track.resultMode).toBe('absolute');
      const x = track.propertyTracks[0].propertyKeyframes.find((k: Json) => k.time === 2);
      // Under "absolute" the stored value is the absolute one.
      expect(x).toMatchObject({ value: 150, rValue: 50, aValue: 150 });
    });

    it('renames and deletes a track folder, moving its tracks back to the root', async () => {
      await createMove();
      await ok('add_value_track', { timelineName: 'Move', name: 'Zoom', folder: undefined });
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'Group' });
      await fails('add_timeline_folder', { timelineName: 'Move', name: 'Group' }, 'already exists');
      await ok('add_value_track', { timelineName: 'Move', name: 'Inner', folder: 'Group' });
      await ok('rename_timeline_folder', { timelineName: 'Move', folder: 'Group', newName: 'Renamed' });
      await fails('move_timeline_track', { timelineName: 'Move', trackName: 'Zoom', folder: 'Group' }, 'No track folder "Group"');

      const result = await ok('delete_timeline_folder', { timelineName: 'Move', folder: 'Renamed' });
      expect(result.warnings.join(' ')).toContain('Moved 1 item');
      const data = await onDisk();
      expect(data.tracks.map((t: Json) => t.name)).toEqual(['Zoom', 'Inner']);
      expect(data.tracksRoot.subfolders).toEqual([]);
    });

    it('deletes a folder with its contents when asked', async () => {
      await createMove();
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'Group' });
      await ok('add_value_track', { timelineName: 'Move', name: 'Inner', folder: 'Group' });
      await ok('delete_timeline_folder', { timelineName: 'Move', folder: 'Group', deleteContents: true });
      const data = await onDisk();
      expect(data.tracks).toEqual([]);
      expect(data.tracksRoot.subfolders).toEqual([]);
    });

    it('finds property tracks inside the editor owner folders', async () => {
      await createMove();
      await ok('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 0, keyframeTimes: [0, 1] });
      // Put offsetY where the editor keeps behavior property tracks: an owner
      // folder with the sampled keys (tasty-cappuccino "Sine").
      const path = join(tmpDir, 'timelines', 'Move.json');
      const data = await onDisk();
      const track = data.tracks[0];
      const offsetY = track.propertyTracks.splice(1, 1)[0];
      track.propertyTracksRoot.subfolders.push({
        enabled: true, interpolationMode: 'default', resultMode: 'default', ease: 'default',
        pathMode: 'default', resizeMode: 'default', expanded: true, name: 'Owned',
        items: [offsetY], subfolders: [], ownerId: 'behavior', ownerUid: 'Owned',
      });
      expect(Object.keys(track.propertyTracksRoot.subfolders[0])).toEqual(Object.keys(shapes.propertyTracksRootWithFolder.subfolders[0]));
      await writeFile(path, JSON.stringify(data, null, '\t'), 'utf-8');

      const listed = await ok('list_timeline_tracks', { timelineName: 'Move' });
      expect(listed.tracks[0].propertyTracks.map((pt: Json) => [pt.property, pt.folder])).toEqual([['offsetX', ''], ['offsetY', 'Owned']]);

      await fails('add_property_track', { timelineName: 'Move', instanceUid: 0, property: 'offsetY' }, 'in property track folder "Owned"');
      await ok('set_keyframe', { timelineName: 'Move', instanceUid: 0, time: 1, values: { offsetY: { absolute: 260 } } });
      await ok('delete_keyframe', { timelineName: 'Move', instanceUid: 0, time: 0 });
      await ok('update_track', { timelineName: 'Move', instanceUid: 0, resultMode: 'absolute' });

      const after = (await onDisk()).tracks[0];
      expect(after.propertyTracks.map((pt: Json) => pt.property)).toEqual(['offsetX']);
      const y = after.propertyTracksRoot.subfolders[0].items[0];
      expect(y.propertyKeyframes.map((k: Json) => [k.time, k.value, k.aValue])).toEqual([[1, 260, 260]]);
      expect(after.propertyTracksRoot.subfolders[0]).toMatchObject({ ownerId: 'behavior', ownerUid: 'Owned' });

      await ok('remove_property_track', { timelineName: 'Move', instanceUid: 0, property: 'offsetY' });
      expect((await onDisk()).tracks[0].propertyTracksRoot.subfolders[0].items).toEqual([]);
    });
  });

  // ─── custom eases ─────────────────────────────────────────

  describe('custom eases', () => {
    const POINTS = [
      { x: 0, y: 0, startHandle: { x: 0.433, y: 1.329 } },
      { x: 1, y: 1, endHandle: { x: -0.355, y: 0.009 } },
    ];

    it('creates an ease file and registration shaped like the r495 sample', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      const ease = JSON.parse(await readFile(join(tmpDir, 'timelines', 'transitions', 'Swoop.json'), 'utf-8'));
      expectShape(ease, shapes.ease);
      expect(ease).toEqual({
        name: 'Swoop', linear: false, purpose: 'any',
        transitionKeyframes: [
          { x: 0, y: 0, sax: 0.433, say: 1.329, eax: 0, eay: 0, se: true, ee: false, sm: 'cubic' },
          { x: 1, y: 1, sax: 0, say: 0, eax: -0.355, eay: 0.009, se: false, ee: true, sm: 'cubic' },
        ],
      });
      const timelines = (await projectJson()).timelines;
      expect(timelines.subfolders[0]).toEqual({ items: ['Swoop'], subfolders: [] });

      await ok('create_timeline', { name: 'Move' });
      expectShape((await projectJson()).timelines, shapes.projectTimelines);
      expect((await ok('list_timelines', {})).timelines).toEqual(['Move']);
      const listed = await ok('list_eases', {});
      expect(listed.eases.map((e: Json) => [e.name, e.usedBy])).toEqual([['Swoop', []]]);
    });

    it('gives a project without a timelines container the nameless eases folder', async () => {
      const projectPath = join(tmpDir, 'project.c3proj');
      const project = await projectJson();
      delete project.timelines;
      await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
      await boot();
      await ok('create_timeline', { name: 'Move' });
      expect((await projectJson()).timelines).toEqual({ items: ['Move'], subfolders: [{ items: [], subfolders: [] }] });
    });

    it('refuses bad ease names and points', async () => {
      await fails('create_ease', { name: 'easeinoutsine', points: POINTS }, "Construct's own ease names");
      await fails('create_ease', { name: 'Bad', points: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }] }, 'last ease point');
      await fails('create_ease', { name: 'Bad', points: [{ x: 0, y: 0, endHandle: { x: 1, y: 1 } }, { x: 1, y: 1 }] }, 'no incoming handle');
      await ok('create_timeline', { name: 'Move' });
      await fails('create_ease', { name: 'Move', points: POINTS }, 'name of a timeline');
    });

    it('copies a used ease into the timeline and keeps the copy in step', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      await createMove();
      const update = await ok('update_timeline', { name: 'Move', ease: 'Swoop' });
      expect(update.warnings).toBeUndefined();

      let data = await onDisk();
      expectShape(data.transitionsData, shapes.transitionsData);
      expect(data.transitionsData).toEqual([{ folders: [], json: JSON.parse(await readFile(join(tmpDir, 'timelines', 'transitions', 'Swoop.json'), 'utf-8')) }]);

      const changed = await ok('update_ease', { name: 'Swoop', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
      expect(changed.timelinesRefreshed).toEqual(['Move']);
      data = await onDisk();
      expect(data.transitionsData[0].json.transitionKeyframes[0].sax).toBe(0);

      await fails('delete_ease', { name: 'Swoop' }, 'used by timeline(s) Move');

      await ok('update_timeline', { name: 'Move', ease: 'noease' });
      expect((await onDisk()).transitionsData).toEqual([]);

      await ok('delete_ease', { name: 'Swoop' });
      await expect(stat(join(tmpDir, 'timelines', 'transitions', 'Swoop.json'))).rejects.toThrow();
      expect((await projectJson()).timelines.subfolders[0]).toEqual({ items: [], subfolders: [] });
    });

    it('warns about an ease name that is neither built in nor custom', async () => {
      await createMove();
      const result = await ok('update_timeline', { name: 'Move', ease: 'Wobbly' });
      expect(result.warnings.join(' ')).toContain('Wobbly');
    });

    it('never stores a timeline among the ease files', async () => {
      await fails('create_timeline', { name: 'Move', subfolder: 'transitions' }, 'custom eases');
      await fails('create_timeline', { name: 'Move', subfolder: 'Transitions/Inner' }, 'custom eases');
      await expect(stat(join(tmpDir, 'timelines', 'transitions', 'Move.json'))).rejects.toThrow();
    });

    it('reads a timeline in a named folder from that folder', async () => {
      await ok('create_timeline', { name: 'Move', subfolder: 'Cutscenes/Intro' });
      const details = await ok('get_timeline_details', { name: 'Move' });
      expect(details).toEqual(await onDisk('Move', 'Cutscenes', 'Intro'));
      await ok('add_value_track', { timelineName: 'Move', name: 'Zoom' });
      expect((await onDisk('Move', 'Cutscenes', 'Intro')).tracks).toHaveLength(1);
      await ok('delete_timeline', { name: 'Move' });
      await expect(stat(join(tmpDir, 'timelines', 'Cutscenes', 'Intro', 'Move.json'))).rejects.toThrow();
    });

    it('does not read an ease file as a timeline, and leaves the ease registration alone', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      // A timeline registered under the same name, with no file of its own,
      // must not resolve to timelines/transitions/Swoop.json.
      const projectPath = join(tmpDir, 'project.c3proj');
      const project = await projectJson();
      project.timelines.subfolders.push({ items: ['Swoop'], subfolders: [], name: 'Other' });
      project.timelines.items.push('Swoop');
      await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
      await boot();

      await fails('get_timeline_details', { name: 'Swoop' }, 'could not be read');
      await fails('add_value_track', { timelineName: 'Swoop', name: 'Zoom' }, 'could not be read');

      await ok('delete_timeline', { name: 'Swoop' });
      await ok('delete_timeline', { name: 'Swoop' });
      const after = (await projectJson()).timelines;
      expect(after.items).toEqual([]);
      expect(after.subfolders[0]).toEqual({ items: ['Swoop'], subfolders: [] });
      await expect(stat(join(tmpDir, 'timelines', 'transitions', 'Swoop.json'))).resolves.toBeTruthy();
    });
  });

  // ─── untyped (legacy) tracks ──────────────────────────────

  describe('review follow-ups: folders, audio and eases', () => {
    const POINTS = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

    async function patchTimeline(patch: (data: Json) => void, name = 'Move') {
      const path = join(tmpDir, 'timelines', `${name}.json`);
      const data = await onDisk(name);
      patch(data);
      await writeFile(path, JSON.stringify(data, null, '\t'), 'utf-8');
    }

    async function rawTimeline(name = 'Move') {
      return readFile(join(tmpDir, 'timelines', `${name}.json`), 'utf-8');
    }

    it('refuses to move a subfolder up over a same-named folder, and moves nested contents to a non-root parent', async () => {
      await createMove();
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'A' });
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'C' });
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'B', parentFolder: 'A' });
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'C', parentFolder: 'A' });
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'D', parentFolder: 'A/B' });
      await ok('add_value_track', { timelineName: 'Move', name: 'Inner', folder: 'A/B' });

      const before = await rawTimeline();
      await fails('delete_timeline_folder', { timelineName: 'Move', folder: 'A' }, 'already has a folder of that name');
      expect(await rawTimeline()).toBe(before);

      await ok('delete_timeline_folder', { timelineName: 'Move', folder: 'A/B' });
      const data = await onDisk();
      expect(data.tracks).toEqual([]);
      const a = data.tracksRoot.subfolders.find((f: Json) => f.name === 'A');
      expect(a.items.map((t: Json) => t.name)).toEqual(['Inner']);
      expect(a.subfolders.map((f: Json) => f.name)).toEqual(['C', 'D']);
    });

    it('refuses a rename onto a sibling folder name', async () => {
      await createMove();
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'One' });
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'Two' });
      await fails('rename_timeline_folder', { timelineName: 'Move', folder: 'Two', newName: 'One' }, 'already exists');
      expect((await onDisk()).tracksRoot.subfolders.map((f: Json) => f.name)).toEqual(['One', 'Two']);
    });

    it('moves a value track out of a folder to the root', async () => {
      await createMove();
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'Group' });
      await ok('add_value_track', { timelineName: 'Move', name: 'Zoom', folder: 'Group' });
      await ok('move_timeline_track', { timelineName: 'Move', trackName: 'Zoom', folder: '' });
      const data = await onDisk();
      expect(data.tracks.map((t: Json) => t.name)).toEqual(['Zoom']);
      expect(data.tracksRoot.subfolders[0].items).toEqual([]);
      await fails('move_timeline_track', { timelineName: 'Move', trackName: 'Zoom', folder: '' }, 'already in the root');
    });

    it('writes nothing when a value track names a missing folder', async () => {
      await createMove();
      const before = await rawTimeline();
      await fails('add_value_track', { timelineName: 'Move', name: 'Zoom', folder: 'Nowhere' }, 'No track folder "Nowhere"');
      expect(await rawTimeline()).toBe(before);
    });

    it('refuses value computations under a folder with a non-default result mode', async () => {
      await createMove();
      await ok('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 0 });
      await ok('add_timeline_folder', { timelineName: 'Move', name: 'Group' });
      await ok('move_timeline_track', { timelineName: 'Move', instanceUid: 0, folder: 'Group' });
      await patchTimeline(data => { data.tracksRoot.subfolders[0].resultMode = 'absolute'; });
      const before = await rawTimeline();

      await fails('set_keyframe', { timelineName: 'Move', instanceUid: 0, time: 1, values: { offsetX: { absolute: 5 } } }, 'result mode "absolute"');
      await fails('add_property_track', { timelineName: 'Move', instanceUid: 0, property: 'offsetAngle' }, 'result mode "absolute"');
      await fails('update_track', { timelineName: 'Move', instanceUid: 0, resultMode: 'relative' }, 'result mode "absolute"');
      await fails('update_timeline', { name: 'Move', resultMode: 'absolute' }, 'result mode "absolute"');
      await fails('move_timeline_track', { timelineName: 'Move', instanceUid: 0, folder: '' }, 'result mode "absolute"');
      expect(await rawTimeline()).toBe(before);

      await patchTimeline(data => {
        data.tracksRoot.subfolders[0].items = [];
        data.tracksRoot.resultMode = 'relative';
      });
      await fails('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 0 }, 'result mode "relative"');
    });

    it('asks which folder to use when sound and music both hold the file, and validates the name', async () => {
      const projectPath = join(tmpDir, 'project.c3proj');
      const project = await projectJson();
      project.rootFileFolders.music.items.push({ ...SOUND, sid: 700000000000003 });
      await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
      await boot();
      await createMove();

      await fails('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm' }, 'registered more than once');
      await fails('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', audioFolder: 'music', name: 'Bad/Name' }, 'Name must start');
      await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', audioFolder: 'music' });
      expect((await onDisk()).tracks[0].propertyTracks[0].sourceAdapter).toMatchObject({ audioType: 'music', audioProjectFile: { sid: 700000000000003 } });
    });

    it('matches built-in ease names exactly', async () => {
      await ok('create_ease', { name: 'EaseOutSoft', points: POINTS });
      await fails('create_ease', { name: 'EASEOUTBACK', points: POINTS }, "Construct's own ease names");
      await createMove();
      const typo = await ok('update_timeline', { name: 'Move', ease: 'easeinsinee' });
      expect(typo.warnings.join(' ')).toContain('easeinsinee');
      const known = await ok('update_timeline', { name: 'Move', ease: 'easeinoutquint' });
      expect(known.warnings).toBeUndefined();
    });

    it('leaves timelines that do not use an ease byte-identical when it changes', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      await createMove();
      await ok('create_timeline', { name: 'Other' });
      await ok('update_timeline', { name: 'Move', ease: 'Swoop' });
      const other = await rawTimeline('Other');
      const result = await ok('update_ease', { name: 'Swoop', linear: true });
      expect(result.timelinesRefreshed).toEqual(['Move']);
      expect(await rawTimeline('Other')).toBe(other);
      await expect(stat(join(tmpDir, 'timelines', 'Other.json.bak'))).rejects.toThrow();
    });

    it('refuses to delete an ease named in an event sheet or script unless forced', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      const sheetPath = join(tmpDir, 'eventSheets', 'MainSheet.json');
      const sheet = JSON.parse(await readFile(sheetPath, 'utf-8'));
      sheet.events[0].actions[0].parameters.ease = 'Swoop';
      await writeFile(sheetPath, JSON.stringify(sheet, null, '\t'), 'utf-8');
      await boot();

      await fails('delete_ease', { name: 'Swoop' }, 'event sheet "MainSheet"');
      expect((await projectJson()).timelines.subfolders[0].items).toEqual(['Swoop']);

      sheet.events[0].actions[0].parameters.ease = 'Swooper';
      await writeFile(sheetPath, JSON.stringify(sheet, null, '\t'), 'utf-8');
      const projectPath = join(tmpDir, 'project.c3proj');
      const project = await projectJson();
      project.rootFileFolders.script.items.push({ name: 'tween.js', type: 'application/javascript', sid: 700000000000009, 'script-info': { purpose: 'import' } });
      await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
      await mkdir(join(tmpDir, 'scripts'), { recursive: true });
      await writeFile(join(tmpDir, 'scripts', 'tween.js'), 'tween.ease = "Swoop";\n', 'utf-8');
      await boot();

      await fails('delete_ease', { name: 'Swoop' }, 'script "scripts/tween.js"');
      const forced = await ok('delete_ease', { name: 'Swoop', force: true });
      expect(forced.warnings.join(' ')).toContain('force');
      expect((await projectJson()).timelines.subfolders[0].items).toEqual([]);
    });

    it('refuses to delete an ease while a registered timeline cannot be opened', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      await createMove();
      await writeFile(join(tmpDir, 'timelines', 'Move.json'), '{ not json', 'utf-8');
      await fails('delete_ease', { name: 'Swoop' }, 'Move could not be opened');
      await expect(stat(join(tmpDir, 'timelines', 'transitions', 'Swoop.json'))).resolves.toBeTruthy();
    });

    it('deregisters an ease before touching its file', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      const file = join(tmpDir, 'timelines', 'transitions', 'Swoop.json');
      await rm(file);
      await mkdir(file);
      const result = await call('delete_ease', { name: 'Swoop' });
      expect(result.isError).toBe(true);
      expect((await projectJson()).timelines.subfolders[0].items).toEqual([]);
    });
  });

  describe('untyped tracks from older releases', () => {
    async function withLegacy() {
      await mkdir(join(tmpDir, 'timelines'), { recursive: true });
      await copyFile(join(KINDS_DIR, 'Legacy.json'), join(tmpDir, 'timelines', 'Legacy.json'));
      const projectPath = join(tmpDir, 'project.c3proj');
      const project = await projectJson();
      project.timelines.items.push('Legacy');
      await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
      await boot();
      return readFile(join(tmpDir, 'timelines', 'Legacy.json'), 'utf-8');
    }

    it('fixture matches the sampled untyped track shape', async () => {
      const legacy = JSON.parse(await readFile(join(KINDS_DIR, 'Legacy.json'), 'utf-8'));
      expect(Object.keys(legacy)).toEqual(shapes.legacyTimelineKeys);
      expectShape(legacy.tracks[0], shapes.legacyTrack);
    });

    it('lists an untyped track as a legacy instance track', async () => {
      await withLegacy();
      const listed = await ok('list_timeline_tracks', { timelineName: 'Legacy' });
      expect(listed.tracks).toHaveLength(1);
      expect(listed.tracks[0]).toMatchObject({ kind: 'legacy-instance-track', instanceUid: 0, keyframeTimes: [0, 0.5] });
      expect(listed.tracks[0].propertyTracks).toEqual([{ property: 'offsetX', sourceType: 'world-instance', folder: '', keyframeCount: 2 }]);
    });

    it('refuses edits that would rewrite its values, and never adds a second track', async () => {
      const before = await withLegacy();
      await fails('add_timeline_track', { timelineName: 'Legacy', layoutName: 'Layout 1', instanceUid: 0 }, 'untyped (older) track');
      await fails('set_keyframe', { timelineName: 'Legacy', instanceUid: 0, time: 1, values: { offsetX: { absolute: 5 } } }, 'older Construct release');
      await fails('add_property_track', { timelineName: 'Legacy', instanceUid: 0, property: 'offsetY' }, 'older Construct release');
      await fails('update_track', { timelineName: 'Legacy', instanceUid: 0, resultMode: 'absolute' }, 'untyped (older) track');
      expect(await readFile(join(tmpDir, 'timelines', 'Legacy.json'), 'utf-8')).toBe(before);
    });

    it('changes the timeline result mode only when untyped tracks set their own', async () => {
      const before = JSON.parse(await withLegacy());
      await ok('update_timeline', { name: 'Legacy', resultMode: 'absolute' });
      expect((await onDisk('Legacy')).tracks).toEqual(before.tracks);

      const path = join(tmpDir, 'timelines', 'Legacy.json');
      const data = await onDisk('Legacy');
      data.tracks[0].resultMode = 'default';
      data.tracks[0].propertyTracks[0].resultMode = 'default';
      await writeFile(path, JSON.stringify(data, null, '\t'), 'utf-8');
      const raw = await readFile(path, 'utf-8');
      await fails('update_timeline', { name: 'Legacy', resultMode: 'relative' }, 'instance UID 0');
      expect(await readFile(path, 'utf-8')).toBe(raw);
    });

    it('still flags, moves and removes an untyped track without touching its values', async () => {
      const before = JSON.parse(await withLegacy());
      await ok('update_track', { timelineName: 'Legacy', instanceUid: 0, enabled: false });
      const after = await onDisk('Legacy');
      expect(after.tracks[0]).toEqual({ ...before.tracks[0], enabled: false });
      expect(after.transitionsData).toBeUndefined();

      await ok('remove_timeline_track', { timelineName: 'Legacy', instanceUid: 0 });
      expect((await onDisk('Legacy')).tracks).toEqual([]);
    });
  });
  describe('audio paths and keyframes from the live round trip', () => {
    it('keeps the Sounds subfolder in audioProjectFilePath', async () => {
      await createMove();
      await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Blip.webm', name: 'Sfx' });
      const track = (await onDisk()).tracks.find((t: Json) => t.name === 'Sfx');
      expect(track.propertyTracks[0].sourceAdapter.audioProjectFilePath).toBe('media/Sfx/Blip.webm');
    });

    it('requires an audio track keyframe at time 0', async () => {
      await createMove();
      await fails('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', keyframeTimes: [1] }, 'first keyframe at time 0');
      const before = await onDisk();
      expect(before.tracks.some((t: Json) => t.type === 'audio-track')).toBe(false);
      await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', keyframeTimes: [0, 1] });
      const track = (await onDisk()).tracks.find((t: Json) => t.type === 'audio-track');
      expect(track.keyframes.map((k: Json) => k.time)).toEqual([0, 1]);
    });
  });

});
