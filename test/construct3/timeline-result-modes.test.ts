import { describe, it, expect } from 'vitest';
import {
  keyframeMode,
  refreshModeValues,
  folderModeError,
  legacyTracksFollowingTimeline,
} from '../../src/construct3/timeline-result-modes.js';
import { listTracks, timelineFolder, type AnyTrack } from '../../src/construct3/timeline-model.js';
import type { Timeline, TimelinePropertyKeyframe, TimelinePropertyTrack } from '../../src/construct3/types.js';

/** A numeric keyframe whose stored `value` is `value`, with relative 5 and absolute 15. */
function keyframe(value: number, overrides: Record<string, unknown> = {}): TimelinePropertyKeyframe {
  return { time: 0, enabled: true, value, rValue: 5, aValue: 15, addons: [], ...overrides } as unknown as TimelinePropertyKeyframe;
}

function propertyTrack(keyframes: TimelinePropertyKeyframe[], overrides: Record<string, unknown> = {}): TimelinePropertyTrack {
  return { property: 'offsetX', source: { type: 'world-instance', uid: 1 }, propertyKeyframes: keyframes, ...overrides } as unknown as TimelinePropertyTrack;
}

function timeline(tracks: unknown[], overrides: Record<string, unknown> = {}): Timeline {
  return { name: 'T', resultMode: 'default', tracks, tracksRoot: timelineFolder('Track Folder'), ...overrides } as unknown as Timeline;
}

describe('keyframeMode', () => {
  it('takes the innermost mode that is set', () => {
    const data = timeline([], { resultMode: 'relative' });
    const track = { resultMode: 'absolute' } as AnyTrack;
    const property = propertyTrack([], { resultMode: 'relative' });
    expect(keyframeMode(data, track, property, keyframe(0, { resultMode: 'absolute' }))).toBe('absolute');
    expect(keyframeMode(data, track, property, keyframe(0))).toBe('relative');
    expect(keyframeMode(data, track, undefined, undefined)).toBe('absolute');
    expect(keyframeMode(data, {} as AnyTrack, undefined, undefined)).toBe('relative');
    expect(keyframeMode(timeline([]), {} as AnyTrack, undefined, undefined)).toBe('default');
  });
});

describe('refreshModeValues', () => {
  it('stores aValue under absolute and rValue otherwise on a typed track, and leaves an untyped track alone', () => {
    const typed = keyframe(0);
    const untyped = keyframe(99);
    const color = keyframe(0, { value: [0, 0, 0, 1], aValue: [1, 1, 1, 1], rValue: undefined });
    const text = keyframe(0, { value: 'a', aValue: 'b', rValue: 'b' });
    const data = timeline([
      { type: 'instance-track', worldInstance: 1, propertyTracks: [propertyTrack([typed, color, text])] },
      { worldInstance: 2, propertyTracks: [propertyTrack([untyped])] },
    ], { resultMode: 'absolute' });
    refreshModeValues(data);
    expect(typed.value).toBe(15);
    expect(untyped.value).toBe(99);
    expect(color.value).toEqual([0, 0, 0, 1]);
    expect(text.value).toBe('a');

    data.resultMode = 'relative';
    refreshModeValues(data);
    expect(typed.value).toBe(5);
    expect(untyped.value).toBe(99);
  });
});

describe('folderModeError', () => {
  it('names the folder mode for a track under a folder with a non-default mode, and is null for default', () => {
    const track = { type: 'instance-track', worldInstance: 1 };
    const folder = { ...timelineFolder('Group'), items: [track], resultMode: 'absolute' };
    const data = timeline([], { tracksRoot: { ...timelineFolder('Track Folder'), subfolders: [folder] } });
    const loc = listTracks(data)[0];
    expect(loc.folderPath).toBe('Group');
    expect(folderModeError(data, loc)).toContain('result mode "absolute"');

    folder.resultMode = 'default';
    expect(folderModeError(data, loc)).toBeNull();
  });
});

describe('legacyTracksFollowingTimeline', () => {
  it('lists an untyped track that sets no mode and not one that sets its own', () => {
    const following = { worldInstance: 4, propertyTracks: [propertyTrack([keyframe(0)])] };
    const own = { worldInstance: 5, resultMode: 'relative', propertyTracks: [propertyTrack([keyframe(0)])] };
    const typed = { type: 'instance-track', worldInstance: 6, propertyTracks: [propertyTrack([keyframe(0)])] };
    expect(legacyTracksFollowingTimeline(timeline([following, own, typed]))).toEqual([4]);
  });
});
