import { describe, it, expect } from 'vitest';
import {
  trackKind,
  listTracks,
  findTrackByUid,
  findTrackByName,
  listPropertyTracks,
  checkEasePoints,
  buildEaseKeyframes,
  referencedEases,
  syncTransitionsData,
  isBuiltinEaseName,
  clashesWithBuiltinEase,
  folderChainResultMode,
  timelineFolder,
  sameTime,
  easeWarnings,
  trackFolderResultMode,
  type AnyTrack,
  type CustomEase,
} from '../../src/construct3/timeline-model.js';
import { transitionsFolder, ensureTransitionsFolder } from '../../src/construct3/timeline-folders.js';
import type { Timeline, TimelineFolder } from '../../src/construct3/types.js';

function timeline(overrides: Record<string, unknown> = {}): Timeline {
  return {
    name: 'T', ease: 'default', tracks: [], tracksRoot: timelineFolder('Track Folder'),
    transitionsData: [], ...overrides,
  } as unknown as Timeline;
}

/** A `transitionsData` entry. */
interface TransitionEntry { folders: unknown[]; json: CustomEase }

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
    expect(listPropertyTracks(track as unknown as AnyTrack).map(l => [l.propertyTrack.property, l.folderPath])).toEqual([
      ['offsetX', ''], ['magnitude', 'Sine'],
    ]);
  });
});

describe('custom eases', () => {
  it('finds the Transitions folder as the first nameless first-level subfolder, wherever it sits', () => {
    const eases = { items: ['Swoop'], subfolders: [] };
    expect(transitionsFolder({ subfolders: [eases, { name: 'A', items: [], subfolders: [] }] })).toBe(eases);
    expect(transitionsFolder({ subfolders: [{ name: 'transitions', items: ['x'], subfolders: [] }] })).toBeUndefined();
    expect(transitionsFolder({ subfolders: [] })).toBeUndefined();
    expect(transitionsFolder(undefined)).toBeUndefined();

    // A named folder before the nameless one does not hide it
    expect(transitionsFolder({ subfolders: [{ name: 'A', items: [], subfolders: [] }, eases] })).toBe(eases);
    // A nameless folder without an items array is not usable as it is
    expect(transitionsFolder({ subfolders: [{ subfolders: [] }] })).toBeUndefined();

    const container = { items: [], subfolders: [{ name: 'A', items: [], subfolders: [] }] as unknown[] };
    const created = ensureTransitionsFolder(container);
    expect(container.subfolders[0]).toBe(created);
    expect(created).toEqual({ items: [], subfolders: [] });
  });

  it('reuses a Transitions folder that is not first instead of adding a second nameless folder', () => {
    const eases = { items: ['Swoop'], subfolders: [] };
    const container = { items: [], subfolders: [{ name: 'A', items: [], subfolders: [] }, eases] as unknown[] };
    expect(ensureTransitionsFolder(container)).toBe(eases);
    expect(container.subfolders).toHaveLength(2);

    const bare = { subfolders: [] };
    const noItems = { items: [], subfolders: [bare] as unknown[] };
    expect(ensureTransitionsFolder(noItems)).toBe(bare);
    expect(bare).toEqual({ subfolders: [], items: [] });
    expect(noItems.subfolders).toHaveLength(1);
  });

  it('builds ease keyframes with the handle flags the editor writes', () => {
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
    for (const name of ['default', 'noease', 'linear', 'easeinoutsine', 'easeinoutquad', 'easeoutbounce', 'easeoutelastic']) expect(isBuiltinEaseName(name)).toBe(true);
    for (const name of ['Swoop', 'LightOutBack', 'ease', 'easeOutBack', 'easeinsinee', 'EaseOutSoft']) expect(isBuiltinEaseName(name)).toBe(false);
    expect(clashesWithBuiltinEase('EaseOutBack')).toBe(true);
    expect(clashesWithBuiltinEase('EaseOutSoft')).toBe(false);
  });

  it('finds a non-default result mode on a folder chain', () => {
    const inner = { ...timelineFolder('B'), resultMode: 'relative' };
    const root = { ...timelineFolder('Track Folder'), subfolders: [{ ...timelineFolder('A'), subfolders: [inner] }] };
    expect(folderChainResultMode(root, 'A')).toBeUndefined();
    expect(folderChainResultMode(root, 'A/B')).toBe('relative');
    expect(folderChainResultMode({ ...root, resultMode: 'absolute' }, '')).toBe('absolute');
    expect(folderChainResultMode(undefined, 'A')).toBeUndefined();
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
    expect((data.transitionsData[0] as TransitionEntry).json).not.toBe(EASE);

    const changed = { ...EASE, linear: true };
    expect(syncTransitionsData(data, new Map([['Swoop', changed]]))).toBe(true);
    expect((data.transitionsData[0] as TransitionEntry).json.linear).toBe(true);
    expect(syncTransitionsData(data, new Map([['Swoop', changed]]))).toBe(false);

    // No longer used: the copy of a registered ease goes; unknown entries stay.
    (data.tracks[0] as { keyframes: Array<{ ease: string }> }).keyframes[0].ease = 'default';
    data.transitionsData.push({ folders: [], json: { ...EASE, name: 'Unregistered' } });
    syncTransitionsData(data, eases);
    expect((data.transitionsData as TransitionEntry[]).map(e => e.json.name)).toEqual(['Unregistered']);
  });

  it('leaves a file without transitionsData alone when no ease is used', () => {
    const data = timeline();
    delete (data as { transitionsData?: unknown }).transitionsData;
    expect(syncTransitionsData(data, new Map([['Swoop', EASE]]))).toBe(false);
    expect('transitionsData' in data).toBe(false);
  });

  it('warns about ease names that are neither built in nor registered', () => {
    expect(easeWarnings(['Bouncy', 'easeinsine', undefined], new Map())).toEqual([
      'Ease name(s) Bouncy are not Construct ease names and match no custom ease in this project (see list_eases).',
    ]);
    expect(easeWarnings(['Swoop', 'default'], new Map([['Swoop', EASE]]))).toEqual([]);
    expect(easeWarnings([undefined], new Map())).toEqual([]);
  });
});

describe('keyframe times', () => {
  it('treats times closer than a tolerance as the same time', () => {
    expect(sameTime(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameTime(0, 0.001)).toBe(false);
  });
});

/** A folder chain `f1` to `f<depth>`, each inside the one before, with `items` in the innermost. */
function nestedFolders(depth: number, items: unknown[], resultMode = 'default'): TimelineFolder {
  let inner: TimelineFolder = { ...timelineFolder(`f${depth}`), items, resultMode };
  for (let level = depth - 1; level >= 1; level--) {
    inner = { ...timelineFolder(`f${level}`), subfolders: [inner] };
  }
  return { ...timelineFolder('Track Folder'), subfolders: [inner] };
}

const DEEP_PATH = Array.from({ length: 40 }, (_, i) => `f${i + 1}`).join('/');

describe('deeply nested folders', () => {
  it('lists, finds and reads the result mode of a track 40 folders down', () => {
    const track = { type: 'value-track', name: 'Deep' };
    const data = timeline({ tracksRoot: nestedFolders(40, [track], 'absolute') });
    const listed = listTracks(data);
    expect(listed.map(l => [l.folderPath, l.track.name])).toEqual([[DEEP_PATH, 'Deep']]);
    expect(findTrackByName(data, 'Deep')?.folderPath).toBe(DEEP_PATH);
    expect(trackFolderResultMode(data, track as AnyTrack, DEEP_PATH)).toBe('absolute');
  });

  it('skips a subfolder entry that is not a folder', () => {
    const track = { type: 'value-track', name: 'Kept' };
    const root = { ...timelineFolder('Track Folder'), subfolders: [null, 'text', { ...timelineFolder('A'), items: [track] }] };
    expect(listTracks(timeline({ tracksRoot: root })).map(l => [l.folderPath, l.track.name])).toEqual([['A', 'Kept']]);
  });

  it('lists a property track 40 folders down', () => {
    const propertyTrack = { property: 'magnitude', source: { type: 'behavior', uid: 'Sine' } };
    const track = { propertyTracks: [], propertyTracksRoot: nestedFolders(40, [propertyTrack]) } as unknown as AnyTrack;
    expect(listPropertyTracks(track).map(l => [l.propertyTrack.property, l.folderPath])).toEqual([['magnitude', DEEP_PATH]]);
  });

  it('collects an ease named by a keyframe 40 and 80 folders down, and still skips transitionsData', () => {
    const tracksRoot = nestedFolders(40, [{ keyframes: [{ ease: 'Deep40' }] }]);
    tracksRoot.subfolders.push(...nestedFolders(80, [{ keyframes: [{ ease: 'Deep80' }] }]).subfolders);
    const data = timeline({
      tracksRoot,
      transitionsData: [{ folders: [], json: { ...EASE, name: 'Other', ease: 'Hidden' } }],
    });
    expect([...referencedEases(data)].sort()).toEqual(['Deep40', 'Deep80', 'default']);
  });
});
