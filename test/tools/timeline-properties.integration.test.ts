/**
 * Property tracks checked against the Construct 3 r495.2 editor's own output
 * (test/fixtures/timeline-properties). The fixture's timeline holds the
 * offsetX/offsetY track as this server wrote it; adding the same properties
 * the editor added must reproduce the editor's saved track exactly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import type { Timeline, TimelineInstanceTrack } from '../../src/construct3/types.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'timeline-properties');
const BOX = 1;

/** The editor's picker order in the sampling session. */
const EDITOR_ADD_ORDER = [
  'offsetZElevation', 'offsetWidth', 'offsetHeight', 'offsetAngle', 'offsetOpacity', 'offsetColor',
  'offsetScaleX', 'offsetScaleY', 'initial-animation', 'initial-frame', 'enable-collisions', 'hp', 'tag', 'on',
];

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe('timeline property tracks against the r495.2 editor', () => {
  let tmpDir: string;
  let server: MockServer;
  let expected: Timeline;

  beforeEach(async () => {
    expected = JSON.parse(await readFile(join(FIXTURE_DIR, 'expected-Sampling-r495.json'), 'utf-8'));
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-timeline-props-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
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

  async function track(): Promise<TimelineInstanceTrack> {
    const data = JSON.parse(await readFile(join(tmpDir, 'timelines', 'Sampling.json'), 'utf-8')) as Timeline;
    return data.tracks[0] as TimelineInstanceTrack;
  }

  function expectedTrack(): TimelineInstanceTrack {
    return expected.tracks[0] as TimelineInstanceTrack;
  }

  it('reproduces the editor track when the same properties are added in the same order', async () => {
    for (const property of EDITOR_ADD_ORDER) {
      const result = await server.callTool('add_property_track', { timelineName: 'Sampling', instanceUid: BOX, property });
      expect(result.isError, `${property}: ${result.content[0].text}`).not.toBe(true);
      expect(parseResult(result).warnings).toBeUndefined();
    }
    const written = await track();
    expect(written).toEqual(expectedTrack());
    // Key order too, so a re-save by the editor changes nothing.
    expect(JSON.stringify(written)).toBe(JSON.stringify(expectedTrack()));
    expect(JSON.stringify(written.propertyTracks.map(pt => pt.property)))
      .toBe(JSON.stringify(expectedTrack().propertyTracks.map(pt => pt.property)));
    expect(Object.keys(written.virtualPosition)).toEqual(Object.keys(expectedTrack().virtualPosition));
  });

  it('puts tracks in the editor order whatever order they are added in', async () => {
    for (const property of [...EDITOR_ADD_ORDER].reverse()) {
      await server.callTool('add_property_track', { timelineName: 'Sampling', instanceUid: BOX, property });
    }
    expect(await track()).toEqual(expectedTrack());
  });

  it('builds the same property tracks through add_timeline_track', async () => {
    await writeFile(join(tmpDir, 'timelines', 'Sampling.json'), JSON.stringify({ ...expected, tracks: [] }, null, '\t'));
    await boot();
    const result = await server.callTool('add_timeline_track', {
      timelineName: 'Sampling', layoutName: 'Start', instanceUid: BOX,
      properties: ['offsetX', 'offsetY', ...EDITOR_ADD_ORDER], keyframeTimes: [0, 1],
    });
    expect(result.isError).not.toBe(true);
    const written = await track();
    expect(written.propertyTracks).toEqual(expectedTrack().propertyTracks);
    expect(written.virtualPosition).toEqual(expectedTrack().virtualPosition);
  });

  it('stores numbers as offsets under the default result mode and as values under absolute', async () => {
    await server.callTool('add_property_track', { timelineName: 'Sampling', instanceUid: BOX, property: 'offsetWidth' });
    await server.callTool('add_property_track', { timelineName: 'Sampling', instanceUid: BOX, property: 'hp' });
    const set = await server.callTool('set_keyframe', {
      timelineName: 'Sampling', instanceUid: BOX, time: 1,
      values: { offsetWidth: { absolute: 80 }, hp: { relative: -2 }, offsetAngle: { absolute: 1.5 } },
    });
    expect(set.isError).not.toBe(true);
    let t = await track();
    const at1 = (name: string) => t.propertyTracks.find(pt => pt.property === name)!.propertyKeyframes.find(kf => kf.time === 1)!;
    expect(at1('offsetWidth')).toMatchObject({ value: 30, rValue: 30, aValue: 80 });
    expect(at1('hp')).toMatchObject({ value: -2, rValue: -2, aValue: 5 });
    expect(at1('offsetAngle')).toMatchObject({ value: 1, rValue: 1, aValue: 1.5 });
    expect(at1('offsetAngle').addons).toEqual([{ id: 'angle', data: { direction: 'closest', revolutions: 0 } }]);

    const update = await server.callTool('update_track', { timelineName: 'Sampling', instanceUid: BOX, resultMode: 'absolute' });
    expect(update.isError).not.toBe(true);
    t = await track();
    // Existing keyframes follow the new mode, as the r495.2 editor rewrote them on save.
    const at0 = (name: string) => t.propertyTracks.find(pt => pt.property === name)!.propertyKeyframes.find(kf => kf.time === 0)!;
    expect(at0('offsetWidth')).toMatchObject({ value: 50, rValue: 0, aValue: 50 });
    expect(at0('hp')).toMatchObject({ value: 7, rValue: 0, aValue: 7 });
    await server.callTool('set_keyframe', { timelineName: 'Sampling', instanceUid: BOX, time: 1, values: { offsetWidth: { absolute: 90 } } });
    t = await track();
    expect(at1('offsetWidth')).toMatchObject({ value: 90, rValue: 40, aValue: 90 });
  });

  it('recomputes values when the timeline result mode changes', async () => {
    const result = await server.callTool('update_timeline', { name: 'Sampling', resultMode: 'absolute' });
    expect(result.isError).not.toBe(true);
    let t = await track();
    expect(t.propertyTracks[0].propertyKeyframes[0]).toMatchObject({ value: 324, rValue: 0, aValue: 324 });
    await server.callTool('update_timeline', { name: 'Sampling', resultMode: 'default' });
    t = await track();
    expect(t.propertyTracks[0].propertyKeyframes[0]).toMatchObject({ value: 0, rValue: 0, aValue: 324 });
  });

  it('stores strings, booleans and colors as the value itself', async () => {
    const result = await server.callTool('set_keyframe', {
      timelineName: 'Sampling', instanceUid: BOX, time: 1,
      values: { tag: { absolute: 'done' }, on: { absolute: false }, offsetColor: { absolute: [1, 0, 0, 0.5] }, 'initial-animation': { absolute: 'Walk' } },
    });
    expect(result.isError).not.toBe(true);
    const t = await track();
    const kf = (name: string) => t.propertyTracks.find(pt => pt.property === name)!.propertyKeyframes[0];
    expect(kf('tag')).toMatchObject({ value: 'done', rValue: 'done', aValue: 'done', pathMode: 'none', addons: [] });
    expect(kf('on')).toMatchObject({ value: false, rValue: false, aValue: false });
    expect(kf('offsetColor')).toMatchObject({ value: [1, 0, 0, 0.5], aValue: [1, 0, 0, 0.5] });
    expect(kf('offsetColor')).not.toHaveProperty('rValue');
    const anim = t.propertyTracks.find(pt => pt.property === 'initial-animation')!;
    expect(anim.source).toEqual({ type: 'plugin', uid: 'Sprite' });
    expect(anim.sourceAdapter).toEqual({ up: { sf: 'beginning' } });
    expect(anim.propertyKeyframes[0].addons).toEqual([{ id: 'initial-animation', data: { sf: 'default' } }]);
    expect(t.virtualPosition).toHaveProperty('offsetColor', [0, 0, 0, 1]);
  });

  it('rejects values of the wrong kind and relative values for non-numbers', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ tag: { absolute: 3 } }, 'needs a string'],
      [{ on: { absolute: 'yes' } }, 'needs true or false'],
      [{ offsetWidth: { absolute: 'wide' } }, 'needs a number'],
      [{ tag: { relative: 1 } }, 'give "absolute" only'],
      [{ offsetColor: { absolute: 0.5 } }, 'needs [r, g, b, a]'],
      [{ 'var:initial-frame': { absolute: 1 } }, 'no instance variable named "initial-frame"'],
    ];
    const before = await readFile(join(tmpDir, 'timelines', 'Sampling.json'), 'utf-8');
    for (const [values, message] of cases) {
      const result = await server.callTool('set_keyframe', { timelineName: 'Sampling', instanceUid: BOX, time: 1, values });
      expect(result.isError, JSON.stringify(values)).toBe(true);
      expect(result.content[0].text).toContain(message);
    }
    expect(await readFile(join(tmpDir, 'timelines', 'Sampling.json'), 'utf-8')).toBe(before);
  });

  it('still accepts an unsampled name with a warning and both numbers', async () => {
    const added = parseResult(await server.callTool('add_property_track', { timelineName: 'Sampling', instanceUid: BOX, property: 'offsetOriginX' }));
    expect(added.warnings.join(' ')).toContain('offsetOriginX');
    const refused = await server.callTool('set_keyframe', { timelineName: 'Sampling', instanceUid: BOX, time: 1, values: { offsetOriginX: { absolute: 1 } } });
    expect(refused.isError).toBe(true);
    const ok = await server.callTool('set_keyframe', { timelineName: 'Sampling', instanceUid: BOX, time: 1, values: { offsetOriginX: { absolute: 1, relative: 0.5 } } });
    expect(ok.isError).not.toBe(true);
    const t = await track();
    expect(t.propertyTracks.at(-1)!.propertyKeyframes.find(kf => kf.time === 1)).toMatchObject({ value: 0.5, rValue: 0.5, aValue: 1 });
  });
});
