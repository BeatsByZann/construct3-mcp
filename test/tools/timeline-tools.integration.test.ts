/**
 * Real-filesystem tests for the timeline track and keyframe tools.
 *
 * The unit tests pin the guards that fire before any I/O. These prove the
 * on-disk outcome through the real reader: the track and keyframe shape,
 * which is compared key-for-key against a timeline saved by Construct 3
 * r495.2 (test/fixtures/timeline-sample), and the value/aValue rule, which
 * is compared against the fixture instance's layout position.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import type { Timeline, TimelineInstanceTrack } from '../../src/construct3/types.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const SAMPLE_PATH = join(__dirname, '..', 'fixtures', 'timeline-sample', 'Timeline 1.json');

/** The fixture's only world instance: Sprite uid 0 at (100, 200). */
const SPRITE_UID = 0;
const SPRITE_X = 100;
const SPRITE_Y = 200;

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
  let server: MockServer;
  let sample: Timeline;

  beforeEach(async () => {
    sample = JSON.parse(await readFile(SAMPLE_PATH, 'utf-8')) as Timeline;
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-timeline-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerTimelineTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

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

  /** Rewrite Layout 1 on disk and drop the reader's layout cache. */
  async function patchLayout(patch: (layout: any) => void) {
    const path = join(tmpDir, 'layouts', 'Layout 1.json');
    const layout = JSON.parse(await readFile(path, 'utf-8'));
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

  it('warns about a property name no Construct sample confirmed', async () => {
    await createTimeline();
    const result = parseResult(await addTrack({ properties: ['offsetX', 'width'] }));
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('width');
    const track = await firstTrack();
    expect(track.propertyTracks[1].propertyKeyframes[0].aValue).toBe(0);
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

  it('refuses an unverified property given only one value', async () => {
    await withTrack();
    const result = await setKeyframe({ time: 1, values: { angle: { absolute: 90 } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('supply both');
    expect((await firstTrack()).keyframes).toHaveLength(1);
  });

  it('stores an unverified property exactly as given', async () => {
    await withTrack();
    await setKeyframe({ time: 1, values: { angle: { absolute: 90, relative: 15 } } });
    const track = await firstTrack();
    const keyframe = track.propertyTracks.find(pt => pt.property === 'angle')!.propertyKeyframes[0];
    expect(keyframe.value).toBe(15);
    expect(keyframe.rValue).toBe(15);
    expect(keyframe.aValue).toBe(90);
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
});
