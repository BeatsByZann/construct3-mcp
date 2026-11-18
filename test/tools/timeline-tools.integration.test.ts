/**
 * Real-filesystem tests for the timeline track and keyframe tools.
 *
 * The unit tests pin the guards that fire before any I/O. These prove the
 * on-disk outcome through the real reader: the track and keyframe shape,
 * which is compared key-for-key against a timeline saved by the Construct 3
 * r495.2 editor (test/fixtures/timeline-sample), and the value/aValue rule,
 * which is compared against the fixture instance's layout position.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, readdir, writeFile, mkdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';
import type { Timeline, TimelineInstanceTrack } from '../../src/construct3/types.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const SAMPLE_PATH = join(__dirname, '..', 'fixtures', 'timeline-sample', 'Timeline 1.json');

/** The fixture's only world instance: Sprite uid 0 at (100, 200). */
const SPRITE_UID = 0;
const SPRITE_X = 100;
const SPRITE_Y = 200;

/** The parts of a layout file these tests change. */
interface LayoutJson {
  name: string;
  layers: Array<{ instances: Array<{ uid: number }> }>;
  'nonworld-instances'?: unknown[];
}

/** The parts of project.c3proj these tests change. */
interface ProjectJson {
  timelines: { items: string[]; subfolders: unknown[] };
  layouts: { items: string[] };
  rootFileFolders: Record<'sound' | 'music', { items: unknown[] }>;
}

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Replace every leaf with its type name and every array with the shape of its
 * first element, so two files can be compared key-for-key without depending on
 * how many keyframes each one happens to hold.
 */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shapeOf(entry);
    }
    return out;
  }
  return typeof value;
}

describe('timeline track and keyframe tools (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let server: MockServer;
  let sample: Timeline;

  /** Load the project in `tmpDir` and register the tools on a fresh server. */
  async function boot() {
    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerTimelineTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
  }

  beforeEach(async () => {
    sample = JSON.parse(await readFile(SAMPLE_PATH, 'utf-8')) as Timeline;
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-timeline-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    await boot();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  /** The bytes of every file under the project folder, by project-relative path. */
  async function snapshot(dir = tmpDir): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(files, await snapshot(path));
      else files[relative(tmpDir, path).split('\\').join('/')] = await readFile(path, 'utf-8');
    }
    return files;
  }

  /** Read a timeline straight off disk, bypassing the tools. */
  async function onDisk(name = 'Move'): Promise<Timeline> {
    return JSON.parse(await readFile(join(tmpDir, 'timelines', `${name}.json`), 'utf-8')) as Timeline;
  }

  async function firstTrack(name = 'Move'): Promise<TimelineInstanceTrack> {
    return (await onDisk(name)).tracks[0] as TimelineInstanceTrack;
  }

  async function createTimeline(totalTime = 5) {
    const created = parseResult(await server.callTool('create_timeline', { name: 'Move', totalTime }));
    expect(created.success).toBe(true);
  }

  async function addTrack(args: Record<string, unknown> = {}) {
    return server.callTool('add_timeline_track', {
      timelineName: 'Move',
      layoutName: 'Layout 1',
      instanceUid: SPRITE_UID,
      ...args,
    });
  }

  /** Create "Move" and give it a default two-property track at time 0. */
  async function withTrack(args: Record<string, unknown> = {}) {
    await createTimeline();
    const result = parseResult(await addTrack(args));
    expect(result.success).toBe(true);
    return result;
  }

  /** Rewrite project.c3proj on disk; call boot() afterwards to load the change. */
  async function patchProject(patch: (project: ProjectJson) => void) {
    const path = join(tmpDir, 'project.c3proj');
    const project = JSON.parse(await readFile(path, 'utf-8')) as ProjectJson;
    patch(project);
    await writeFile(path, JSON.stringify(project, null, '\t'), 'utf-8');
  }

  /** Rewrite the timeline "Move" on disk. */
  async function patchTimeline(patch: (timeline: Timeline) => void) {
    const path = join(tmpDir, 'timelines', 'Move.json');
    const timeline = JSON.parse(await readFile(path, 'utf-8')) as Timeline;
    patch(timeline);
    await writeFile(path, JSON.stringify(timeline, null, '\t'), 'utf-8');
  }

  /** Rewrite Layout 1 on disk and drop the reader's layout cache. */
  async function patchLayout(patch: (layout: LayoutJson) => void) {
    const path = join(tmpDir, 'layouts', 'Layout 1.json');
    const layout = JSON.parse(await readFile(path, 'utf-8')) as LayoutJson;
    patch(layout);
    await writeFile(path, JSON.stringify(layout, null, '\t'), 'utf-8');
    reader.invalidateCaches();
  }

  // ─── shape ────────────────────────────────────────────────

  it('creates a timeline file whose top-level keys match the r495.2 sample', async () => {
    await createTimeline();
    expect(Object.keys(await onDisk())).toEqual(Object.keys(sample));
  });

  it('writes an instance track shaped key-for-key like the r495.2 sample', async () => {
    await withTrack({ keyframeTimes: [0, 1] });

    const data = await onDisk();
    const sampleTrack = sample.tracks[0] as TimelineInstanceTrack;
    const track = data.tracks[0] as TimelineInstanceTrack;

    // Whole-file shape, compared against the Construct-saved sample.
    expect(shapeOf(data)).toEqual(shapeOf(sample));

    // Key order, which the shape comparison above does not pin.
    expect(Object.keys(track)).toEqual(Object.keys(sampleTrack));
    expect(Object.keys(track.virtualPosition)).toEqual(Object.keys(sampleTrack.virtualPosition));
    expect(Object.keys(track.keyframes[0])).toEqual(Object.keys(sampleTrack.keyframes[0]));
    expect(Object.keys(track.propertyTracks[0])).toEqual(Object.keys(sampleTrack.propertyTracks[0]));
    expect(Object.keys(track.propertyTracks[0].propertyKeyframes[0]))
      .toEqual(Object.keys(sampleTrack.propertyTracks[0].propertyKeyframes[0]));

    // Constants Construct wrote, taken from the sample rather than restated.
    expect(track.type).toBe(sampleTrack.type);
    expect(track.enabled).toBe(sampleTrack.enabled);
    expect(track.interpolationMode).toBe(sampleTrack.interpolationMode);
    expect(track.resultMode).toBe(sampleTrack.resultMode);
    expect(track.ease).toBe(sampleTrack.ease);
    expect(track.pathMode).toBe(sampleTrack.pathMode);
    expect(track.resizeMode).toBe(sampleTrack.resizeMode);
    expect(track.initialVisibility).toBe(sampleTrack.initialVisibility);
    expect(track.id).toBe(sampleTrack.id);
    expect(track.virtualPosition).toEqual(sampleTrack.virtualPosition);
    expect(track.propertyTracksRoot).toEqual(sampleTrack.propertyTracksRoot);

    // Identity fields come from this project, not from the sample.
    expect(track.worldInstance).toBe(SPRITE_UID);
    expect(track.objectType).toBe('Sprite');
    expect(track.project).toBe(reader.getProject().uniqueId);

    // Master keyframes.
    expect(track.keyframes.map(kf => kf.time)).toEqual([0, 1]);
    expect(track.keyframes[0].tags).toBe(sampleTrack.keyframes[0].tags);
    expect(track.keyframes[0].enabled).toBe(sampleTrack.keyframes[0].enabled);
    expect(track.keyframes[0].ease).toBe(sampleTrack.keyframes[0].ease);
    expect(track.keyframes[0].pathMode).toBe(sampleTrack.keyframes[0].pathMode);

    // Property tracks and the cubic-bezier addons block Construct writes.
    const sampleX = sampleTrack.propertyTracks[0];
    const x = track.propertyTracks[0];
    expect(track.propertyTracks.map(pt => pt.property)).toEqual(['offsetX', 'offsetY']);
    expect(x.source).toEqual({ type: 'world-instance', uid: SPRITE_UID });
    expect(x.enabled).toBe(sampleX.enabled);
    expect(x.interpolationMode).toBe(sampleX.interpolationMode);
    expect(x.resultMode).toBe(sampleX.resultMode);
    expect(x.ease).toBe(sampleX.ease);
    expect(x.pathMode).toBe(sampleX.pathMode);
    for (const keyframe of x.propertyKeyframes) {
      expect(keyframe.addons).toEqual(sampleX.propertyKeyframes[0].addons);
      expect(keyframe.enabled).toBe(sampleX.propertyKeyframes[0].enabled);
      expect(keyframe.resultMode).toBe(sampleX.propertyKeyframes[0].resultMode);
      expect(keyframe.ease).toBe(sampleX.propertyKeyframes[0].ease);
      expect(keyframe.pathMode).toBe(sampleX.propertyKeyframes[0].pathMode);
    }
  });

  it('holds the instance position as aValue and 0 as the relative value', async () => {
    await withTrack({ keyframeTimes: [0, 2] });
    const track = await firstTrack();

    // The sample's offsetX keyframe carries value 0 / aValue 324 for an
    // instance at x 324; the fixture instance sits at (100, 200).
    for (const keyframe of track.propertyTracks[0].propertyKeyframes) {
      expect(keyframe.value).toBe(0);
      expect(keyframe.rValue).toBe(0);
      expect(keyframe.aValue).toBe(SPRITE_X);
    }
    for (const keyframe of track.propertyTracks[1].propertyKeyframes) {
      expect(keyframe.aValue).toBe(SPRITE_Y);
    }
  });

  it('backs the timeline file up before every track write', async () => {
    await withTrack();
    await expect(stat(join(tmpDir, 'timelines', 'Move.json.bak'))).resolves.toBeTruthy();
  });

  it('leaves get_timeline_details returning the raw file', async () => {
    await withTrack();
    const details = parseResult(await server.callTool('get_timeline_details', { name: 'Move' }));
    expect(details).toEqual(await onDisk());
  });

  // ─── add_timeline_track guards ────────────────────────────

  it('refuses a second track for the same instance', async () => {
    await withTrack();
    const result = await addTrack();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already has a track');
    expect((await onDisk()).tracks).toHaveLength(1);
  });

  it('refuses an instance that is not a world instance', async () => {
    await patchLayout(layout => {
      layout['nonworld-instances'] = [
        { type: 'Keyboard', uid: 7, sid: 500000000000009, properties: {} },
      ];
    });
    await createTimeline();
    const result = await addTrack({ instanceUid: 7 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a world instance');
    expect((await onDisk()).tracks).toHaveLength(0);
  });

  it('refuses an unknown instance UID', async () => {
    await createTimeline();
    const result = await addTrack({ instanceUid: 99 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found in layout');
  });

  it('refuses an unknown layout', async () => {
    await createTimeline();
    const result = await addTrack({ layoutName: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Layout "Ghost" not found');
  });

  it('refuses a keyframe time beyond totalTime', async () => {
    await createTimeline(3);
    const result = await addTrack({ keyframeTimes: [0, 4] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside the timeline');
    expect((await onDisk()).tracks).toHaveLength(0);
  });

  it('refuses a duplicate property name', async () => {
    await createTimeline();
    const result = await addTrack({ properties: ['offsetX', 'offsetX'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Duplicate property');
  });

  it('refuses a property name that matches no known property, writing no track', async () => {
    await createTimeline();
    const result = await addTrack({ properties: ['offsetX', 'width'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Property "width" matches no world property');
    expect((await onDisk()).tracks).toHaveLength(0);
  });

  // ─── set_keyframe ─────────────────────────────────────────

  async function setKeyframe(args: Record<string, unknown>) {
    return server.callTool('set_keyframe', {
      timelineName: 'Move',
      instanceUid: SPRITE_UID,
      ...args,
    });
  }

  it('derives the relative value from the instance position', async () => {
    await withTrack();
    const result = parseResult(await setKeyframe({ time: 1, values: { offsetX: { absolute: 400 } } }));
    expect(result.success).toBe(true);

    const track = await firstTrack();
    const keyframe = track.propertyTracks[0].propertyKeyframes.find(kf => kf.time === 1)!;
    expect(keyframe.aValue).toBe(400);
    expect(keyframe.value).toBe(400 - SPRITE_X);
    expect(keyframe.rValue).toBe(400 - SPRITE_X);
  });

  it('derives the absolute value from a relative value', async () => {
    await withTrack();
    await setKeyframe({ time: 1, values: { offsetY: { relative: 50 } } });

    const track = await firstTrack();
    const keyframe = track.propertyTracks[1].propertyKeyframes.find(kf => kf.time === 1)!;
    expect(keyframe.value).toBe(50);
    expect(keyframe.rValue).toBe(50);
    expect(keyframe.aValue).toBe(SPRITE_Y + 50);
  });

  it('creates the master keyframe once and keeps keyframes sorted by time', async () => {
    await withTrack();
    await setKeyframe({ time: 3, values: { offsetX: { absolute: 300 } } });
    await setKeyframe({ time: 1, values: { offsetX: { absolute: 200 } } });
    const updated = parseResult(await setKeyframe({ time: 1, values: { offsetX: { absolute: 250 } } }));
    expect(updated.action).toBe('keyframe-updated');

    const track = await firstTrack();
    expect(track.keyframes.map(kf => kf.time)).toEqual([0, 1, 3]);
    expect(track.propertyTracks[0].propertyKeyframes.map(kf => kf.time)).toEqual([0, 1, 3]);
    expect(track.propertyTracks[0].propertyKeyframes[1].aValue).toBe(250);
    // The offsetY track is untouched: only the properties named are written.
    expect(track.propertyTracks[1].propertyKeyframes.map(kf => kf.time)).toEqual([0]);
  });

  it('applies ease, enabled and tags to the master keyframe', async () => {
    await withTrack();
    await setKeyframe({ time: 2, ease: 'easeinout', enabled: false, tags: 'stop' });
    const track = await firstTrack();
    const master = track.keyframes.find(kf => kf.time === 2)!;
    expect(master.ease).toBe('easeinout');
    expect(master.enabled).toBe(false);
    expect(master.tags).toBe('stop');
  });

  it('creates a missing property track with the sample keyframe shape', async () => {
    await withTrack({ properties: ['offsetX'] });
    const result = parseResult(await setKeyframe({ time: 1, values: { offsetY: { absolute: 260 } } }));
    expect(result.warnings.join(' ')).toContain('Created property track');

    const track = await firstTrack();
    const added = track.propertyTracks.find(pt => pt.property === 'offsetY')!;
    const sampleKeyframe = (sample.tracks[0] as TimelineInstanceTrack)
      .propertyTracks[0].propertyKeyframes[0];
    expect(Object.keys(added.propertyKeyframes[0])).toEqual(Object.keys(sampleKeyframe));
    expect(added.propertyKeyframes[0].addons).toEqual(sampleKeyframe.addons);
    expect(added.propertyKeyframes[0].value).toBe(60);
  });

  it('refuses a keyframe time outside the timeline', async () => {
    await withTrack();
    const result = await setKeyframe({ time: 9, values: { offsetX: { absolute: 1 } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside the timeline');
    expect((await firstTrack()).keyframes).toHaveLength(1);
  });

  it('refuses a position property with neither absolute nor relative', async () => {
    await withTrack();
    const result = await setKeyframe({ time: 1, values: { offsetX: {} } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('needs an "absolute" or a "relative" value');
    expect((await firstTrack()).keyframes).toHaveLength(1);
  });

  it('refuses a property name that matches nothing, however many values it is given, and writes no track', async () => {
    await withTrack();
    const before = await snapshot();
    for (const input of [{ absolute: 90 }, { absolute: 90, relative: 15 }]) {
      const result = await setKeyframe({ time: 1, values: { angle: input } });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Property "angle" matches no world property, instance variable or plugin property');
      expect(result.content[0].text).toContain('offsetAngle');
      expect(result.content[0].text).toMatch(/Nothing was changed\.$/);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('edits an existing property track whose name matches nothing, storing the values as given', async () => {
    await withTrack();
    await patchTimeline(timeline => {
      const track = timeline.tracks[0] as TimelineInstanceTrack;
      const copy = structuredClone(track.propertyTracks[0]);
      copy.property = 'angle';
      track.propertyTracks.push(copy);
    });
    await boot();
    const result = parseResult(await setKeyframe({ time: 1, values: { angle: { absolute: 90, relative: 15 } } }));
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.warnings ?? [])).not.toContain('match no world property');
    const track = await firstTrack();
    const keyframe = track.propertyTracks.find(pt => pt.property === 'angle')!.propertyKeyframes.find(kf => kf.time === 1)!;
    expect(keyframe.value).toBe(15);
    expect(keyframe.rValue).toBe(15);
    expect(keyframe.aValue).toBe(90);
  });

  it('refuses add_timeline_track and add_property_track for a property name that matches nothing, writing nothing', async () => {
    await createTimeline();
    const empty = await snapshot();
    const track = await addTrack({ properties: ['offsetX', 'angle'] });
    expect(track.isError).toBe(true);
    expect(track.content[0].text).toContain('Property "angle" matches no world property, instance variable or plugin property');
    expect(track.content[0].text).toContain('offsetAngle');
    expect(track.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(empty);

    expect(parseResult(await addTrack()).success).toBe(true);
    const tracked = await snapshot();
    const property = await server.callTool('add_property_track', { timelineName: 'Move', instanceUid: SPRITE_UID, property: 'angle' });
    expect(property.isError).toBe(true);
    expect(property.content[0].text).toContain('Property "angle" matches no world property, instance variable or plugin property');
    expect(property.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(tracked);
  });

  it('refuses a position keyframe once the instance is gone from every layout', async () => {
    await withTrack();
    await patchLayout(layout => { layout.layers[0].instances = []; });
    const result = await setKeyframe({ time: 1, values: { offsetX: { absolute: 400 } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('was not found in any layout');
  });

  it('refuses a keyframe on an instance with no track', async () => {
    await withTrack();
    const result = await setKeyframe({ instanceUid: 42, time: 1, values: { offsetX: { absolute: 1 } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('has no track for instance UID 42');
  });

  // ─── delete_keyframe ──────────────────────────────────────

  async function deleteKeyframe(args: Record<string, unknown>) {
    return server.callTool('delete_keyframe', {
      timelineName: 'Move',
      instanceUid: SPRITE_UID,
      ...args,
    });
  }

  it('deletes the master keyframe and every property keyframe at that time', async () => {
    await withTrack({ keyframeTimes: [0, 1, 2] });
    const result = parseResult(await deleteKeyframe({ time: 1 }));
    expect(result.action).toBe('keyframe-deleted');

    const track = await firstTrack();
    expect(track.keyframes.map(kf => kf.time)).toEqual([0, 2]);
    for (const propertyTrack of track.propertyTracks) {
      expect(propertyTrack.propertyKeyframes.map(kf => kf.time)).toEqual([0, 2]);
    }
  });

  it('refuses to delete the last remaining master keyframe', async () => {
    await withTrack();
    const result = await deleteKeyframe({ time: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('last master keyframe');

    const track = await firstTrack();
    expect(track.keyframes).toHaveLength(1);
    expect(track.propertyTracks[0].propertyKeyframes).toHaveLength(1);
  });

  it('refuses a time with no master keyframe', async () => {
    await withTrack({ keyframeTimes: [0, 1] });
    const result = await deleteKeyframe({ time: 4 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no master keyframe at time 4');
  });

  it('deletes only the named property keyframe', async () => {
    await withTrack({ keyframeTimes: [0, 1] });
    const result = parseResult(await deleteKeyframe({ time: 1, property: 'offsetX' }));
    expect(result.action).toBe('property-keyframe-deleted');

    const track = await firstTrack();
    expect(track.keyframes.map(kf => kf.time)).toEqual([0, 1]);
    expect(track.propertyTracks[0].propertyKeyframes.map(kf => kf.time)).toEqual([0]);
    expect(track.propertyTracks[1].propertyKeyframes.map(kf => kf.time)).toEqual([0, 1]);
  });

  it('refuses an unknown property track or a property keyframe that is not there', async () => {
    await withTrack({ keyframeTimes: [0, 1] });
    const unknown = await deleteKeyframe({ time: 1, property: 'angle' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('not found on the track');

    const missing = await deleteKeyframe({ time: 4, property: 'offsetX' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('no keyframe at time 4');
  });

  // ─── property tracks ──────────────────────────────────────

  it('fills a new property track at every existing master keyframe time', async () => {
    await withTrack({ properties: ['offsetX'], keyframeTimes: [0, 2, 4] });
    const result = parseResult(await server.callTool('add_property_track', {
      timelineName: 'Move', instanceUid: SPRITE_UID, property: 'offsetY',
    }));
    expect(result.action).toBe('property-track-added');

    const track = await firstTrack();
    const added = track.propertyTracks[1];
    expect(added.property).toBe('offsetY');
    expect(added.propertyKeyframes.map(kf => kf.time)).toEqual([0, 2, 4]);
    for (const keyframe of added.propertyKeyframes) {
      expect(keyframe.value).toBe(0);
      expect(keyframe.aValue).toBe(SPRITE_Y);
    }
  });

  it('refuses a duplicate property track', async () => {
    await withTrack();
    const result = await server.callTool('add_property_track', {
      timelineName: 'Move', instanceUid: SPRITE_UID, property: 'offsetX',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
    expect((await firstTrack()).propertyTracks).toHaveLength(2);
  });

  it('removes a property track, and refuses one that is not there', async () => {
    await withTrack();
    const removed = parseResult(await server.callTool('remove_property_track', {
      timelineName: 'Move', instanceUid: SPRITE_UID, property: 'offsetY',
    }));
    expect(removed.action).toBe('property-track-removed');
    expect((await firstTrack()).propertyTracks.map(pt => pt.property)).toEqual(['offsetX']);

    const again = await server.callTool('remove_property_track', {
      timelineName: 'Move', instanceUid: SPRITE_UID, property: 'offsetY',
    });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain('not found on the track');
  });

  // ─── track removal and update ─────────────────────────────

  it('removes the whole instance track, and refuses an untracked instance', async () => {
    await withTrack();
    const removed = parseResult(await server.callTool('remove_timeline_track', {
      timelineName: 'Move', instanceUid: SPRITE_UID,
    }));
    expect(removed.action).toBe('track-removed');
    expect((await onDisk()).tracks).toEqual([]);

    const again = await server.callTool('remove_timeline_track', {
      timelineName: 'Move', instanceUid: SPRITE_UID,
    });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain('has no track for instance UID 0');
  });

  it('updates the track playback fields', async () => {
    await withTrack();
    const result = parseResult(await server.callTool('update_track', {
      timelineName: 'Move',
      instanceUid: SPRITE_UID,
      enabled: false,
      ease: 'easeinout',
      interpolationMode: 'step',
      resultMode: 'absolute',
      pathMode: 'line',
      initialVisibility: false,
    }));
    expect(result.action).toBe('track-updated');

    const track = await firstTrack();
    expect(track.enabled).toBe(false);
    expect(track.ease).toBe('easeinout');
    expect(track.interpolationMode).toBe('step');
    expect(track.resultMode).toBe('absolute');
    expect(track.pathMode).toBe('line');
    expect(track.initialVisibility).toBe(false);
    // Keyframes and property tracks survive the update.
    expect(track.keyframes).toHaveLength(1);
    expect(track.propertyTracks).toHaveLength(2);
  });

  it('updates the new timeline-level playback fields', async () => {
    await createTimeline();
    const result = parseResult(await server.callTool('update_timeline', {
      name: 'Move',
      ease: 'easeoutback',
      interpolationMode: 'step',
      resultMode: 'absolute',
      pathMode: 'catmullrom',
      transformWithSceneGraph: false,
    }));
    expect(result.action).toBe('updated');

    const data = await onDisk();
    expect(data.ease).toBe('easeoutback');
    expect(data.interpolationMode).toBe('step');
    expect(data.resultMode).toBe('absolute');
    expect(data.pathMode).toBe('catmullrom');
    expect(data.transformWithSceneGraph).toBe(false);
  });

  // ─── what a new instance track holds ──────────────────────

  it('names the object type of a new instance track in objectType', async () => {
    await withTrack();
    const track = await firstTrack();
    expect(track.objectType).toBe('Sprite');
    expect(track.worldInstance).toBe(SPRITE_UID);
  });

  // ─── refusals change nothing ──────────────────────────────

  it('refuses add_timeline_track calls without changing any file', async () => {
    await createTimeline();
    const refused: Array<[string, Record<string, unknown>]> = [
      ['an unknown layout', { layoutName: 'Ghost' }],
      ['an unknown instance UID', { instanceUid: 99 }],
      ['a time beyond totalTime', { keyframeTimes: [0, 99] }],
    ];
    const before = await snapshot();
    for (const [label, args] of refused) {
      const result = await addTrack(args);
      expect(result.isError, label).toBe(true);
      expect(result.content[0].text, label).toMatch(/Nothing was changed\.$/);
      expect(await snapshot(), label).toEqual(before);
    }

    // With the instance tracked, a second track for it is refused the same way
    expect(parseResult(await addTrack()).success).toBe(true);
    const tracked = await snapshot();
    const second = await addTrack();
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(tracked);
  });

  it('refuses track, property and keyframe calls without changing any file', async () => {
    await withTrack({ keyframeTimes: [0, 1] });
    const calls: Array<[string, string, Record<string, unknown>]> = [
      ['set_keyframe', 'a time outside the timeline', { time: 9, values: { offsetX: { absolute: 1 } } }],
      ['set_keyframe', 'a position without a value', { time: 1, values: { offsetX: {} } }],
      ['set_keyframe', 'a property that needs both values', { time: 1, values: { angle: { absolute: 90 } } }],
      ['set_keyframe', 'an untracked instance', { instanceUid: 42, time: 1 }],
      ['set_keyframe', 'both an instance UID and a track name', { trackName: 'Level', time: 1 }],
      ['delete_keyframe', 'a time with no keyframe', { time: 4 }],
      ['delete_keyframe', 'a property that is not there', { time: 1, property: 'angle' }],
      ['delete_keyframe', 'a property keyframe that is not there', { time: 4, property: 'offsetX' }],
      ['add_property_track', 'a duplicate property track', { property: 'offsetX' }],
      ['add_property_track', 'an untracked instance', { instanceUid: 42, property: 'offsetWidth' }],
      ['remove_property_track', 'a property track that is not there', { property: 'angle' }],
      ['remove_timeline_track', 'an untracked instance', { instanceUid: 42 }],
      ['update_track', 'no updates', {}],
      ['update_track', 'a name on an instance track', { name: 'Other' }],
      ['update_track', 'an audio field on an instance track', { audioTag: 'x' }],
    ];
    const before = await snapshot();
    for (const [tool, label, args] of calls) {
      const result = await server.callTool(tool, { timelineName: 'Move', instanceUid: SPRITE_UID, ...args });
      expect(result.isError, `${tool}: ${label}`).toBe(true);
      expect(result.content[0].text, `${tool}: ${label}`).toMatch(/Nothing was changed\.$/);
      expect(await snapshot(), `${tool}: ${label}`).toEqual(before);
    }

    // A tracked instance that is gone from every layout cannot give its values
    await patchLayout(layout => { layout.layers[0].instances = []; });
    const gone = await snapshot();
    for (const [tool, args] of [
      ['set_keyframe', { time: 1, values: { offsetX: { absolute: 1 } } }],
      ['add_property_track', { property: 'offsetWidth' }],
    ] as const) {
      const result = await server.callTool(tool, { timelineName: 'Move', instanceUid: SPRITE_UID, ...args });
      expect(result.isError, tool).toBe(true);
      expect(result.content[0].text, tool).toContain('was not found in any layout');
      expect(result.content[0].text, tool).toMatch(/Nothing was changed\.$/);
      expect(await snapshot(), tool).toEqual(gone);
    }
  });

  it('refuses a layout name in another letter case, and a layout file that is not registered', async () => {
    await createTimeline();
    await cp(join(tmpDir, 'layouts', 'Layout 1.json'), join(tmpDir, 'layouts', 'Loose.json'));
    const before = await snapshot();

    const cased = await addTrack({ layoutName: 'layout 1' });
    expect(cased.isError).toBe(true);
    expect(cased.content[0].text).toContain('Did you mean "Layout 1"?');
    expect(cased.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);

    const loose = await addTrack({ layoutName: 'Loose' });
    expect(loose.isError).toBe(true);
    expect(loose.content[0].text).toContain('Layout "Loose" not found');
    expect(loose.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a registered layout whose file cannot be read, naming no absolute path', async () => {
    await createTimeline();
    const layoutPath = join(tmpDir, 'layouts', 'Layout 1.json');

    await writeFile(layoutPath, '{ not json', 'utf-8');
    reader.invalidateCaches();
    const invalid = await snapshot();
    const broken = await addTrack();
    expect(broken.isError).toBe(true);
    expect(broken.content[0].text).toContain('layouts/Layout 1.json could not be read');
    expect(broken.content[0].text).not.toContain(tmpDir);
    expect(broken.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(invalid);

    await rm(layoutPath);
    reader.invalidateCaches();
    const removed = await snapshot();
    const gone = await addTrack();
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toContain('layouts/Layout 1.json could not be read (ENOENT)');
    expect(gone.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(removed);
  });

  // ─── a failing write ──────────────────────────────────────

  it('leaves the timeline as it was when the write fails, and words the error project-relative', async () => {
    await createTimeline();
    const before = await snapshot();
    // The unexpected-error path logs the cause; this case is meant to reach it
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(writer, 'replaceFile').mockRejectedValueOnce(
      new Error(`EACCES: permission denied, open '${join(tmpDir, 'timelines', 'Move.json')}'`),
    );

    const result = await addTrack();
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('Error adding timeline track:');
    expect(text).toContain('timelines/Move.json');
    expect(text).not.toContain(tmpDir);
    expect(text).not.toContain(tmpDir.split('\\').join('/'));
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to overwrite a timeline saved on disk after its read', async () => {
    await withTrack();
    const outside = '{ "outside": "a save made by another program" }';
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      if (path.split('\\').join('/').endsWith('/timelines/Move.json')) await writeFile(path, outside, 'utf-8');
      return replaceFile(path, content, options);
    });

    const result = await setKeyframe({ time: 1, values: { offsetX: { absolute: 400 } } });
    expect(result.isError).toBe(true);
    // The writer's text is the answer: it names the file and says the change on disk is kept
    expect(result.content[0].text.startsWith('timelines/Move.json was changed on disk')).toBe(true);
    expect(result.content[0].text).toContain('so that change is kept');
    expect(await readFile(join(tmpDir, 'timelines', 'Move.json'), 'utf-8')).toBe(outside);
  });

  // ─── an instance in another layout ────────────────────────

  it('finds an instance of a layout other than the first', async () => {
    const layout = JSON.parse(await readFile(join(tmpDir, 'layouts', 'Layout 1.json'), 'utf-8')) as LayoutJson;
    layout.name = 'Layout 2';
    layout.layers[0].instances[0].uid = 50;
    await writeFile(join(tmpDir, 'layouts', 'Layout 2.json'), JSON.stringify(layout, null, '\t'), 'utf-8');
    await patchProject(project => { project.layouts.items.push('Layout 2'); });
    await boot();
    await createTimeline();

    const added = parseResult(await addTrack({ layoutName: 'Layout 2', instanceUid: 50, properties: ['offsetX'] }));
    expect(added.success).toBe(true);
    const property = parseResult(await server.callTool('add_property_track', {
      timelineName: 'Move', instanceUid: 50, property: 'offsetY',
    }));
    expect(property.success).toBe(true);
    const keyframe = parseResult(await setKeyframe({ instanceUid: 50, time: 1, values: { offsetY: { absolute: 260 } } }));
    expect(keyframe.success).toBe(true);
  });

  // ─── result mode changes ──────────────────────────────────

  it('refuses a timeline result mode change while an untyped track follows the timeline', async () => {
    await withTrack();
    await patchTimeline(timeline => { delete (timeline.tracks[0] as { type?: string }).type; });
    const before = await snapshot();

    const result = await server.callTool('update_timeline', { name: 'Move', resultMode: 'absolute' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('untyped (older) track(s) for instance UID 0');
    expect(result.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a timeline result mode change while a track folder holds a result mode of its own', async () => {
    await withTrack();
    await patchTimeline(timeline => { (timeline.tracksRoot as unknown as { resultMode: string }).resultMode = 'absolute'; });
    const before = await snapshot();

    const result = await server.callTool('update_timeline', { name: 'Move', resultMode: 'relative' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('has result mode "absolute"');
    expect(result.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
  });

  it('follows a timeline result mode change in the stored values of an instance track', async () => {
    await withTrack();
    const changed = await server.callTool('update_timeline', { name: 'Move', resultMode: 'absolute' });
    expect(changed.isError).not.toBe(true);
    // Under "absolute" the stored value is the absolute one
    for (const keyframe of (await firstTrack()).propertyTracks[0].propertyKeyframes) {
      expect(keyframe.value).toBe(SPRITE_X);
    }
  });
});

describe('update_track on value and audio tracks (real project on disk)', () => {
  let tmpDir: string;
  let server: MockServer;

  const keyframe = (time: number) => ({ time, tags: '', enabled: true, ease: 'default' });

  /** A timeline holding a value track "Volume" and an audio track "Voice". */
  async function mixTimeline(): Promise<Timeline> {
    const sample = JSON.parse(await readFile(SAMPLE_PATH, 'utf-8')) as Timeline;
    return {
      ...sample,
      name: 'Mix',
      tracks: [
        {
          type: 'value-track',
          name: 'Volume',
          enabled: true,
          interpolationMode: 'default',
          ease: 'default',
          keyframes: [keyframe(0)],
          propertyTracks: [{ property: 'value', source: { type: 'value', uid: 'value' }, propertyKeyframes: [] }],
        },
        {
          type: 'audio-track',
          name: 'Voice',
          enabled: true,
          keyframes: [keyframe(0)],
          propertyTracks: [{ property: 'audioSource', source: { type: 'audio', uid: 'audio' }, sourceAdapter: {}, propertyKeyframes: [] }],
        },
      ],
    } as unknown as Timeline;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-timeline-audio-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    await mkdir(join(tmpDir, 'timelines'), { recursive: true });
    await writeFile(join(tmpDir, 'timelines', 'Mix.json'), JSON.stringify(await mixTimeline(), null, '\t'), 'utf-8');
    const projectPath = join(tmpDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf-8')) as ProjectJson;
    project.timelines = { items: ['Mix'], subfolders: [{ items: [], subfolders: [] }] };
    const file = (name: string, type: string, sid: number) => ({ name, type, sid });
    project.rootFileFolders.sound.items.push(file('Voice.ogg', 'audio/ogg', 100000000000011), file('Both.ogg', 'audio/ogg', 100000000000012));
    project.rootFileFolders.music.items.push(file('Both.ogg', 'audio/ogg', 100000000000013));
    await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
    await boot();
  });

  /** Load the project in `tmpDir` on a fresh server. */
  async function boot() {
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerTimelineTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
  }

  /** Rewrite project.c3proj, then load the project on a fresh server. */
  async function patchAndBoot(patch: (project: Record<string, unknown>) => void) {
    const projectPath = join(tmpDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf-8')) as Record<string, unknown>;
    patch(project);
    await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
    await boot();
  }

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function mixOnDisk(): Promise<string> {
    return readFile(join(tmpDir, 'timelines', 'Mix.json'), 'utf-8');
  }

  it('renames a value track, and refuses a name Construct cannot use', async () => {
    const before = await mixOnDisk();
    const refused = await server.callTool('update_track', { timelineName: 'Mix', trackName: 'Volume', name: 'bad/name' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Name must start with a letter');
    expect(refused.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await mixOnDisk()).toBe(before);

    const renamed = parseResult(await server.callTool('update_track', { timelineName: 'Mix', trackName: 'Volume', name: 'Level' }));
    expect(renamed.action).toBe('track-updated');
    const data = JSON.parse(await mixOnDisk()) as Timeline;
    expect((data.tracks[0] as { name?: string }).name).toBe('Level');
  });

  it('refuses an audio file that is not registered, and one registered as both sound and music', async () => {
    const before = await mixOnDisk();
    const missing = await server.callTool('update_track', { timelineName: 'Mix', trackName: 'Voice', audioFile: 'Ghost.ogg' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('"Ghost.ogg" is not registered');
    expect(missing.content[0].text).toMatch(/Nothing was changed\.$/);

    const both = await server.callTool('update_track', { timelineName: 'Mix', trackName: 'Voice', audioFile: 'Both.ogg' });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain('registered more than once');
    expect(both.content[0].text).toContain('audioFolder');
    expect(both.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await mixOnDisk()).toBe(before);
  });

  it('keeps the subfolder of a nested registration in audioProjectFilePath', async () => {
    await patchAndBoot(project => {
      const sound = (project.rootFileFolders as Record<string, { subfolders: unknown[] }>).sound;
      sound.subfolders.push({
        name: 'Voices',
        items: [],
        subfolders: [{ name: 'Intro', items: [{ name: 'Nested.ogg', type: 'audio/ogg', sid: 100000000000014 }], subfolders: [] }],
      });
    });
    const result = await server.callTool('update_track', { timelineName: 'Mix', trackName: 'Voice', audioFile: 'Nested.ogg' });
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(await mixOnDisk()) as Timeline;
    const adapter = (data.tracks[1] as unknown as { propertyTracks: Array<{ sourceAdapter: Record<string, unknown> }> })
      .propertyTracks[0].sourceAdapter;
    expect(adapter.audioProjectFilePath).toBe('media/Voices/Intro/Nested.ogg');
  });

  it('warns about a file that is not an audio type, and about an export structure whose path is not known', async () => {
    await patchAndBoot(project => {
      const sound = (project.rootFileFolders as Record<string, { items: unknown[] }>).sound;
      sound.items.push({ name: 'Notes.txt', type: 'text/plain', sid: 100000000000015 });
      (project.properties as Record<string, unknown>).exportFileStructure = 'flat';
    });
    const result = parseResult(await server.callTool('update_track', { timelineName: 'Mix', trackName: 'Voice', audioFile: 'Notes.txt' }));
    expect(result.success).toBe(true);
    const warnings = result.warnings.join(' ');
    expect(warnings).toContain('"Notes.txt" is registered with type "text/plain", not an audio type');
    expect(warnings).toContain('export file structure is "flat"');
    const data = JSON.parse(await mixOnDisk()) as Timeline;
    const adapter = (data.tracks[1] as unknown as { propertyTracks: Array<{ sourceAdapter: Record<string, unknown> }> })
      .propertyTracks[0].sourceAdapter;
    expect(adapter).not.toHaveProperty('audioProjectFilePath');
  });

  it('points an audio track at a registered file', async () => {
    const result = parseResult(await server.callTool('update_track', {
      timelineName: 'Mix', trackName: 'Voice', audioFile: 'Voice.ogg', audioStartOffset: 0.5, audioTag: 'line',
    }));
    expect(result.action).toBe('track-updated');
    const data = JSON.parse(await mixOnDisk()) as Timeline;
    const adapter = (data.tracks[1] as unknown as { propertyTracks: Array<{ sourceAdapter: Record<string, unknown> }> })
      .propertyTracks[0].sourceAdapter;
    expect(adapter).toMatchObject({
      audioProjectFile: { name: 'Voice.ogg' },
      audioProjectFilePath: 'media/Voice.ogg',
      audioStartOffset: 0.5,
      audioTag: 'line',
      audioType: 'sound',
    });
  });
});
