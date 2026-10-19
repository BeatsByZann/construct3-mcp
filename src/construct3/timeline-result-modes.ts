/**
 * Result modes of timeline tracks: which mode is in force for a keyframe, how
 * stored values follow a mode change, and which tracks the tools must not
 * recompute.
 */

import { effectiveResultMode } from './timeline-properties.js';
import {
  listPropertyTracks,
  listTracks,
  trackFolderResultMode,
  trackKind,
  type AnyTrack,
  type TrackLocation,
} from './timeline-model.js';
import type { Timeline, TimelinePropertyKeyframe, TimelinePropertyTrack } from './types.js';

/** Result mode in force for a keyframe, from the keyframe out to the timeline. */
export function keyframeMode(
  data: Timeline,
  track: AnyTrack,
  propertyTrack: TimelinePropertyTrack | undefined,
  keyframe: TimelinePropertyKeyframe | undefined,
): string {
  return effectiveResultMode(keyframe?.resultMode, propertyTrack?.resultMode, track.resultMode, data.resultMode);
}

/**
 * Recompute each numeric keyframe's `value` after a result mode changed: the
 * editor stores `aValue` there under "absolute" and `rValue` otherwise, and
 * rewrites stale values when it saves. Only typed instance tracks are
 * touched; untyped (legacy) tracks keep their stored values.
 */
export function refreshModeValues(data: Timeline): void {
  for (const { track } of listTracks(data)) {
    if (trackKind(track) !== 'instance-track') continue;
    for (const { propertyTrack } of listPropertyTracks(track)) {
      for (const keyframe of propertyTrack.propertyKeyframes ?? []) {
        if (typeof keyframe.aValue === 'number' && typeof keyframe.rValue === 'number') {
          keyframe.value = keyframeMode(data, track, propertyTrack, keyframe) === 'absolute' ? keyframe.aValue : keyframe.rValue;
        }
      }
    }
  }
}

/**
 * Why a stored-value computation must not run: a folder with a non-default
 * result mode governs the track, and its effect on stored values is not known
 * here.
 */
export function folderModeError(data: Timeline, loc: TrackLocation): string | null {
  const mode = trackFolderResultMode(data, loc.track, loc.folderPath);
  if (!mode) return null;
  return `A track or property-track folder holding this track has result mode "${mode}". No fixture holds a folder with a non-default result mode, so the values Construct would store are not known here; set the folder back to "default" in the Construct 3 editor first.`;
}

/**
 * Untyped (older) tracks whose values follow the timeline's result mode:
 * neither the track nor a property track sets its own mode. An untyped track
 * that sets "relative" or "absolute" on the track keeps valid values when the
 * timeline-level mode changes.
 */
export function legacyTracksFollowingTimeline(data: Timeline): number[] {
  const uids: number[] = [];
  for (const { track } of listTracks(data)) {
    if (trackKind(track) !== 'legacy-instance-track') continue;
    const follows = listPropertyTracks(track).some(({ propertyTrack }) =>
      effectiveResultMode(propertyTrack.resultMode, track.resultMode) === 'default'
      || (propertyTrack.propertyKeyframes ?? []).some(kf => effectiveResultMode(kf.resultMode, propertyTrack.resultMode, track.resultMode) === 'default'));
    if (follows) uids.push(track.worldInstance as number);
  }
  return uids;
}
