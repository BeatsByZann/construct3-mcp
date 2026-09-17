import { describe, it, expect } from 'vitest';
import {
  trackKind,
  listTracks,
  findTrackByUid,
  findTrackByName,
  listPropertyTracks,
  easesFolder,
  ensureEasesFolder,
  checkEasePoints,
  buildEaseKeyframes,
  referencedEases,
  syncTransitionsData,
  isBuiltinEaseName,
  timelineFolder,
  type CustomEase,
} from '../../src/construct3/timeline-model.js';
import type { Timeline } from '../../src/construct3/types.js';

function timeline(overrides: Record<string, unknown> = {}): Timeline {
  return {
    name: 'T', ease: 'default', tracks: [], tracksRoot: timelineFolder('Track Folder'),
    transitionsData: [], ...overrides,
  } as unknown as Timeline;
}

const EASE: CustomEase = {
  name: 'Swoop', linear: false, purpose: 'any',
  transitionKeyframes: buildEaseKeyframes([{ x: 0, y: 0 }, { x: 1, y: 1 }]),
};

describe('track kinds', () => {
  it('tells typed tracks from untyped (legacy) instance tracks', () => {
    expect(trackKind({ type: 'instance-track', worldInstance: 1 })).toBe('instance-track');
    expect(trackKind({ type: 'value-track', name: 'v' })).toBe('value-track');
    expect(trackKind({ type: 'audio-track', name: 'a' })).toBe('audio-track');
    expect(trackKind({ worldInstance: 3, keyframes: [] })).toBe('legacy-instance-track');
    expect(trackKind({ type: 'nested-timeline-track' })).toBe('unknown');
    expect(trackKind(null)).toBe('unknown');
  });

  it('lists tracks at the root and inside track folders', () => {
    const folder = { ...timelineFolder('Doors'), items: [{ type: 'instance-track', worldInstance: 27 }] };
    const data = timeline({
      tracks: [{ type: 'value-track', name: 'Zoom' }, { worldInstance: 5 }],
      tracksRoot: { ...timelineFolder('Track Folder'), subfolders: [folder] },
    });
    expect(listTracks(data).map(l => [l.folderPath, l.track.worldInstance ?? l.track.name])).toEqual([
      ['', 'Zoom'], ['', 5], ['Doors', 27],
    ]);
    expect(findTrackByUid(data, 27)?.list).toBe(folder.items);
    expect(findTrackByUid(data, 5)?.track).toEqual({ worldInstance: 5 });
    expect(findTrackByName(data, 'Zoom')?.folderPath).toBe('');
    expect(findTrackByName(data, 'Doors')).toBeUndefined();
  });

  it('lists property tracks inside property-track folders', () => {
    const inFolder = { property: 'magnitude', source: { type: 'behavior', uid: 'Sine' } };
    const track = {
      propertyTracks: [{ property: 'offsetX', source: { type: 'world-instance', uid: 1 } }],
      propertyTracksRoot: { ...timelineFolder('Property Track Folder'), subfolders: [{ ...timelineFolder('Sine'), items: [inFolder], ownerId: 'behavior', ownerUid: 'Sine' }] },
    };
    expect(listPropertyTracks(track as any).map(l => [l.propertyTrack.property, l.folderPath])).toEqual([
      ['offsetX', ''], ['magnitude', 'Sine'],
    ]);
  });
});

describe('custom eases', () => {
  it('finds the eases folder only when the first subfolder is nameless', () => {
    const eases = { items: ['Swoop'], subfolders: [] };
    expect(easesFolder({ subfolders: [eases, { name: 'A', items: [], subfolders: [] }] })).toBe(eases);
    expect(easesFolder({ subfolders: [{ name: 'transitions', items: ['x'], subfolders: [] }] })).toBeUndefined();
    expect(easesFolder({ subfolders: [] })).toBeUndefined();

    const container = { items: [], subfolders: [{ name: 'A', items: [], subfolders: [] }] as unknown[] };
    const created = ensureEasesFolder(container);
    expect(container.subfolders[0]).toBe(created);
    expect(created).toEqual({ items: [], subfolders: [] });
  });

  it('builds ease keyframes with handle flags as sampled', () => {
    expect(buildEaseKeyframes([{ x: 0, y: 0, startHandle: { x: 0.4, y: 1.3 } }, { x: 1, y: 1, endHandle: { x: -0.3, y: 0 } }])).toEqual([
      { x: 0, y: 0, sax: 0.4, say: 1.3, eax: 0, eay: 0, se: true, ee: false, sm: 'cubic' },
      { x: 1, y: 1, sax: 0, say: 0, eax: -0.3, eay: 0, se: false, ee: true, sm: 'cubic' },
    ]);
  });

  it('checks ease points', () => {
    expect(checkEasePoints([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    expect(checkEasePoints([{ x: 0.1, y: 0 }, { x: 1, y: 1 }])).toContain('first');
    expect(checkEasePoints([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }])).toContain('increase');
    expect(checkEasePoints([{ x: 0, y: 0 }, { x: 1, y: 1, startHandle: { x: 1, y: 1 } }])).toContain('outgoing');
  });

  it('recognizes built-in ease names', () => {
    for (const name of ['default', 'noease', 'linear', 'easeinoutsine', 'easeOutBack']) expect(isBuiltinEaseName(name)).toBe(true);
    for (const name of ['Swoop', 'LightOutBack', 'ease']) expect(isBuiltinEaseName(name)).toBe(false);
  });

  it('collects ease names outside transitionsData', () => {
    const data = timeline({
      ease: 'noease',
      tracks: [{ keyframes: [{ ease: 'Swoop' }] }],
      transitionsData: [{ folders: [], json: { ...EASE, name: 'Other', ease: 'Hidden' } }],
    });
    expect([...referencedEases(data)].sort()).toEqual(['Swoop', 'default', 'noease']);
  });

  it('adds, refreshes and drops ease copies in transitionsData', () => {
    const eases = new Map([['Swoop', EASE]]);
    const data = timeline({ tracks: [{ keyframes: [{ ease: 'Swoop' }] }] });
    expect(syncTransitionsData(data, eases)).toBe(true);
    expect(data.transitionsData).toEqual([{ folders: [], json: EASE }]);
    expect((data.transitionsData[0] as any).json).not.toBe(EASE);

    const changed = { ...EASE, linear: true };
    expect(syncTransitionsData(data, new Map([['Swoop', changed]]))).toBe(true);
    expect((data.transitionsData[0] as any).json.linear).toBe(true);
    expect(syncTransitionsData(data, new Map([['Swoop', changed]]))).toBe(false);

    // No longer used: the copy of a registered ease goes; unknown entries stay.
    (data.tracks[0] as any).keyframes[0].ease = 'default';
    data.transitionsData.push({ folders: [], json: { ...EASE, name: 'Unregistered' } });
    syncTransitionsData(data, eases);
    expect((data.transitionsData as any[]).map(e => e.json.name)).toEqual(['Unregistered']);
  });

  it('leaves a file without transitionsData alone when no ease is used', () => {
    const data = timeline();
    delete (data as any).transitionsData;
    expect(syncTransitionsData(data, new Map([['Swoop', EASE]]))).toBe(false);
    expect('transitionsData' in data).toBe(false);
  });
});
