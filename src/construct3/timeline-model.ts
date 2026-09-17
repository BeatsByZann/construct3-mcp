/**
 * Track kinds, track and property-track folders, and custom eases inside
 * timeline files.
 *
 * Sampled from 22 Construct r495.2 example packages and C3-ACE (2026-09-17):
 * - Track kinds: 381 `instance-track`, 10 `value-track` (solar-system,
 *   synth-sunset, perseverance), 1 `audio-track` (synth-sunset) and 5 tracks
 *   with no `type` at all (timeline-basics, timeline-instances,
 *   timeline-drawing, move-along-path; projects saved by r168-r184). The
 *   untyped tracks are an older instance-track form: they carry
 *   `worldInstance` but no `objectType`, `project` or `resizeMode`, and their
 *   property keyframes have no `resultMode` and often no `rValue`/`aValue`.
 *   No sample shows the same timeline before and after an upgrade, so these
 *   tools read such tracks but never rewrite their values.
 * - A value track has one property track, `value`, with
 *   `source: { type: 'value', uid: 'value' }`; its keyframes carry `value`,
 *   `rValue` and `aValue` (all equal in 32 of 32 samples) and no `resultMode`
 *   or `pathMode`. The track, its property track and its master keyframes
 *   have no `resultMode`/`pathMode`/`resizeMode` keys.
 * - An audio track has one property track, `audioSource`, with
 *   `source: { type: 'audio', uid: 'audio' }`, no keyframes, and a
 *   `sourceAdapter` whose `audioProjectFile` is a verbatim copy of the file's
 *   `rootFileFolders` entry and whose `audioType` names that root folder
 *   ("music" in the sample). The audio track keeps `resultMode` but has no
 *   `pathMode`/`resizeMode`.
 * - Folders: `tracksRoot` and each track's `propertyTracksRoot` are folders.
 *   A track or property track moved into a subfolder is removed from
 *   `tracks`/`propertyTracks` and stored whole in the subfolder's `items`
 *   (robotic-loader: 12 tracks in 3 folders with `tracks` empty;
 *   tasty-cappuccino: behavior property tracks in "Sine"/"Sine2" folders).
 *   Those property-track folders are the editor's own: each carries
 *   `ownerId: "behavior"` and `ownerUid: <behavior name>` after `subfolders`.
 *   The root folders' own `items` were empty in every sample.
 * - Custom eases (tasty-cappuccino): `timelines/transitions/<name>.json`
 *   holding `{ name, linear, purpose, transitionKeyframes }`, registered in
 *   the first, nameless subfolder of the project.c3proj `timelines` container
 *   (every sampled project has that nameless folder, empty or not). Each
 *   timeline that uses the ease embeds a copy in `transitionsData` as
 *   `{ folders: [], json: <ease file> }`; timelines that do not use it carry
 *   no entry.
 */

import type {
  Timeline,
  TimelineFolder,
  TimelineKeyframe,
  TimelinePropertyKeyframe,
  TimelinePropertyTrack,
} from './types.js';

// ─── Folders ───────────────────────────────────────────────

/** A new track or property-track folder, keys in the sampled order. */
export function timelineFolder(name: string): TimelineFolder {
  return {
    enabled: true,
    interpolationMode: 'default',
    resultMode: 'default',
    ease: 'default',
    pathMode: 'default',
    resizeMode: 'default',
    expanded: true,
    name,
    items: [],
    subfolders: [],
  };
}

export function isTimelineFolder(value: unknown): value is TimelineFolder {
  return !!value && typeof value === 'object'
    && Array.isArray((value as TimelineFolder).items)
    && Array.isArray((value as TimelineFolder).subfolders);
}

/** Split "A/B" into ["A", "B"]; '' and '/' address the root. */
export function splitFolderPath(path: string | undefined): string[] {
  if (!path) return [];
  return path.split('/').filter(part => part.length > 0);
}

/** The folder at `path` below `root`, or undefined. */
export function findFolder(root: TimelineFolder, path: string | undefined): TimelineFolder | undefined {
  let current: TimelineFolder = root;
  for (const part of splitFolderPath(path)) {
    const next = (current.subfolders as unknown[]).find(
      (sf): sf is TimelineFolder => isTimelineFolder(sf) && sf.name === part,
    );
    if (!next) return undefined;
    current = next;
  }
  return current;
}

// ─── Track kinds ───────────────────────────────────────────

export type TrackKind = 'instance-track' | 'value-track' | 'audio-track' | 'legacy-instance-track' | 'unknown';

/** Any track object; fields beyond these are preserved untouched. */
export interface AnyTrack {
  type?: string;
  worldInstance?: number;
  name?: string;
  keyframes?: TimelineKeyframe[];
  propertyTracks?: TimelinePropertyTrack[];
  propertyTracksRoot?: TimelineFolder;
  [key: string]: unknown;
}

export function trackKind(track: unknown): TrackKind {
  if (!track || typeof track !== 'object') return 'unknown';
  const t = track as AnyTrack;
  if (t.type === 'instance-track' || t.type === 'value-track' || t.type === 'audio-track') return t.type;
  if (t.type === undefined && typeof t.worldInstance === 'number') return 'legacy-instance-track';
  return 'unknown';
}

/** Where a track lives: the array holding it and the folder path ('' for `tracks`). */
export interface TrackLocation {
  track: AnyTrack;
  list: unknown[];
  folderPath: string;
}

function walkFolderItems<T>(
  folder: TimelineFolder,
  prefix: string,
  accept: (item: unknown) => item is T,
  out: Array<{ item: T; list: unknown[]; folderPath: string }>,
  depth = 0,
): void {
  if (depth > 32) return;
  for (const sf of folder.subfolders as unknown[]) {
    if (!isTimelineFolder(sf)) continue;
    const path = prefix ? `${prefix}/${sf.name}` : sf.name;
    for (const item of sf.items) {
      if (accept(item)) out.push({ item, list: sf.items, folderPath: path });
    }
    walkFolderItems(sf, path, accept, out, depth + 1);
  }
}

const isObject = (item: unknown): item is AnyTrack => !!item && typeof item === 'object';

/** Every track: `tracks` first, then the tracks stored in `tracksRoot` folders. */
export function listTracks(data: Timeline): TrackLocation[] {
  const out: TrackLocation[] = [];
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  for (const track of tracks) {
    if (isObject(track)) out.push({ track, list: tracks, folderPath: '' });
  }
  if (isTimelineFolder(data.tracksRoot)) {
    for (const item of data.tracksRoot.items) {
      if (isObject(item)) out.push({ track: item, list: data.tracksRoot.items, folderPath: '' });
    }
    const nested: Array<{ item: AnyTrack; list: unknown[]; folderPath: string }> = [];
    walkFolderItems(data.tracksRoot, '', isObject, nested);
    for (const { item, list, folderPath } of nested) out.push({ track: item, list, folderPath });
  }
  return out;
}

/** The instance track (typed or legacy) animating `uid`. */
export function findTrackByUid(data: Timeline, uid: number): TrackLocation | undefined {
  return listTracks(data).find(loc => {
    const kind = trackKind(loc.track);
    return (kind === 'instance-track' || kind === 'legacy-instance-track') && loc.track.worldInstance === uid;
  });
}

/** The value or audio track called `name`. */
export function findTrackByName(data: Timeline, name: string): TrackLocation | undefined {
  return listTracks(data).find(loc => {
    const kind = trackKind(loc.track);
    return (kind === 'value-track' || kind === 'audio-track') && loc.track.name === name;
  });
}

/** Where a property track lives inside its track. */
export interface PropertyTrackLocation {
  propertyTrack: TimelinePropertyTrack;
  list: unknown[];
  folderPath: string;
}

const isPropertyTrack = (item: unknown): item is TimelinePropertyTrack =>
  !!item && typeof item === 'object' && typeof (item as TimelinePropertyTrack).property === 'string';

/** Every property track of a track: `propertyTracks` first, then those in folders. */
export function listPropertyTracks(track: AnyTrack): PropertyTrackLocation[] {
  const out: PropertyTrackLocation[] = [];
  const direct = Array.isArray(track.propertyTracks) ? track.propertyTracks : [];
  for (const pt of direct) {
    if (isPropertyTrack(pt)) out.push({ propertyTrack: pt, list: direct, folderPath: '' });
  }
  if (isTimelineFolder(track.propertyTracksRoot)) {
    for (const item of track.propertyTracksRoot.items) {
      if (isPropertyTrack(item)) out.push({ propertyTrack: item, list: track.propertyTracksRoot.items, folderPath: '' });
    }
    const nested: Array<{ item: TimelinePropertyTrack; list: unknown[]; folderPath: string }> = [];
    walkFolderItems(track.propertyTracksRoot, '', isPropertyTrack, nested);
    for (const { item, list, folderPath } of nested) out.push({ propertyTrack: item, list, folderPath });
  }
  return out;
}

/** A readable summary of every track, for list_timeline_tracks. */
export function summarizeTracks(data: Timeline): Array<Record<string, unknown>> {
  return listTracks(data).map(({ track, folderPath }) => {
    const kind = trackKind(track);
    const summary: Record<string, unknown> = { kind, folder: folderPath };
    if (kind === 'instance-track' || kind === 'legacy-instance-track') {
      summary.instanceUid = track.worldInstance;
      if (typeof track.objectType === 'string') summary.objectType = track.objectType;
    } else if (typeof track.name === 'string') {
      summary.name = track.name;
    } else if (typeof track.type === 'string') {
      summary.type = track.type;
    }
    summary.enabled = track.enabled;
    summary.keyframeTimes = (track.keyframes ?? []).map(kf => kf.time);
    summary.propertyTracks = listPropertyTracks(track).map(({ propertyTrack, folderPath: ptFolder }) => ({
      property: propertyTrack.property,
      sourceType: propertyTrack.source?.type,
      folder: ptFolder,
      keyframeCount: Array.isArray(propertyTrack.propertyKeyframes) ? propertyTrack.propertyKeyframes.length : 0,
    }));
    if (kind === 'legacy-instance-track') {
      summary.note = 'Untyped instance track from an older Construct release. Tools can remove, move or re-flag it, '
        + 'but refuse to change its values; open and save it in the Construct 3 editor first.';
    }
    if (kind === 'audio-track') {
      const adapter = listPropertyTracks(track)[0]?.propertyTrack.sourceAdapter as Record<string, unknown> | undefined;
      const file = adapter?.audioProjectFile as { name?: unknown } | undefined;
      summary.audioFile = file?.name;
      summary.audioType = adapter?.audioType;
      summary.audioStartOffset = adapter?.audioStartOffset;
      summary.audioTag = adapter?.audioTag;
    }
    return summary;
  });
}

// ─── Value and audio tracks ────────────────────────────────

/** A master keyframe on a value or audio track: no `pathMode` (42 of 42 samples). */
export function createPlainMasterKeyframe(time: number): TimelineKeyframe {
  return { time, tags: '', enabled: true, ease: 'default' } as TimelineKeyframe;
}

/** A value-track property keyframe, keys in the sampled order. */
export function createValueKeyframe(time: number, value: number, ease = 'default'): TimelinePropertyKeyframe {
  return {
    time,
    enabled: true,
    ease,
    value,
    rValue: value,
    aValue: value,
    addons: [],
  } as unknown as TimelinePropertyKeyframe;
}

export function createValueTrack(name: string, projectId: string): AnyTrack {
  return {
    type: 'value-track',
    name,
    project: projectId,
    enabled: true,
    interpolationMode: 'default',
    ease: 'default',
    initialVisibility: true,
    id: '',
    keyframes: [],
    propertyTracks: [{
      property: 'value',
      source: { type: 'value', uid: 'value' },
      enabled: true,
      interpolationMode: 'default',
      ease: 'default',
      propertyKeyframes: [],
    } as unknown as TimelinePropertyTrack],
    propertyTracksRoot: timelineFolder('Property Track Folder'),
  };
}

/** The file entry an audio track copies, and the root folder it came from. */
export interface AudioFileRef {
  entry: Record<string, unknown>;
  audioType: 'sound' | 'music';
}

export function createAudioSourceAdapter(file: AudioFileRef, startOffset: number, tag: string): Record<string, unknown> {
  return {
    audioProjectFile: structuredClone(file.entry),
    audioStartOffset: startOffset,
    audioTag: tag,
    audioType: file.audioType,
  };
}

export function createAudioTrack(
  name: string,
  projectId: string,
  file: AudioFileRef,
  startOffset: number,
  tag: string,
): AnyTrack {
  return {
    type: 'audio-track',
    name,
    project: projectId,
    enabled: true,
    interpolationMode: 'default',
    resultMode: 'default',
    ease: 'default',
    initialVisibility: true,
    id: '',
    keyframes: [],
    propertyTracks: [{
      property: 'audioSource',
      source: { type: 'audio', uid: 'audio' },
      enabled: true,
      propertyKeyframes: [],
      sourceAdapter: createAudioSourceAdapter(file, startOffset, tag),
    } as unknown as TimelinePropertyTrack],
    propertyTracksRoot: timelineFolder('Property Track Folder'),
  };
}

// ─── Custom eases ──────────────────────────────────────────

/** Directory under timelines/ that holds custom ease files. */
export const EASES_DIRECTORY = 'transitions';

export interface EaseKeyframe {
  x: number;
  y: number;
  sax: number;
  say: number;
  eax: number;
  eay: number;
  se: boolean;
  ee: boolean;
  sm: string;
}

export interface CustomEase {
  name: string;
  linear: boolean;
  purpose: string;
  transitionKeyframes: EaseKeyframe[];
  [key: string]: unknown;
}

export interface EasePointInput {
  x: number;
  y: number;
  startHandle?: { x: number; y: number };
  endHandle?: { x: number; y: number };
}

/**
 * Build ease keyframes. The sample's first point has `se: true, ee: false`
 * and its last `se: false, ee: true`, with the handle offsets relative to the
 * point (the last point's incoming handle is at x -0.355). Middle points get
 * both handles enabled; no sample has a middle point.
 */
export function buildEaseKeyframes(points: EasePointInput[]): EaseKeyframe[] {
  return points.map((p, i) => ({
    x: p.x,
    y: p.y,
    sax: p.startHandle?.x ?? 0,
    say: p.startHandle?.y ?? 0,
    eax: p.endHandle?.x ?? 0,
    eay: p.endHandle?.y ?? 0,
    se: i < points.length - 1,
    ee: i > 0,
    sm: 'cubic',
  }));
}

/** Problems with ease points, or null. */
export function checkEasePoints(points: EasePointInput[]): string | null {
  if (points.length < 2) return 'An ease needs at least two points.';
  const first = points[0];
  const last = points[points.length - 1];
  if (first.x !== 0 || first.y !== 0) return 'The first ease point must be at x 0, y 0.';
  if (last.x !== 1 || last.y !== 1) return 'The last ease point must be at x 1, y 1.';
  for (let i = 1; i < points.length; i++) {
    if (!(points[i].x > points[i - 1].x)) return `Ease point x values must increase strictly (point ${i} has x ${points[i].x}).`;
  }
  if (first.endHandle) return 'The first ease point has no incoming handle; give startHandle only.';
  if (last.startHandle) return 'The last ease point has no outgoing handle; give endHandle only.';
  return null;
}

export function createCustomEase(name: string, points: EasePointInput[], linear: boolean, purpose: string): CustomEase {
  return { name, linear, purpose, transitionKeyframes: buildEaseKeyframes(points) };
}

const BUILTIN_EASE = /^(default|noease|linear|ease(in|out|inout)[a-z]+)$/i;

/** True for a name that is, or looks like, one of Construct's own ease names. */
export function isBuiltinEaseName(name: string): boolean {
  return BUILTIN_EASE.test(name);
}

type ContainerFolder = { name?: string; items: string[]; subfolders: ContainerFolder[] };

/** The nameless first subfolder of the project `timelines` container, which lists custom eases. */
export function easesFolder(container: { subfolders?: unknown[] } | undefined): ContainerFolder | undefined {
  const first = container?.subfolders?.[0] as ContainerFolder | undefined;
  if (!first || typeof first !== 'object' || !Array.isArray(first.items)) return undefined;
  return typeof first.name === 'string' && first.name !== '' ? undefined : first;
}

/** The eases folder, created at index 0 when missing. */
export function ensureEasesFolder(container: { items: string[]; subfolders: unknown[] }): ContainerFolder {
  const existing = easesFolder(container);
  if (existing) return existing;
  const created: ContainerFolder = { items: [], subfolders: [] };
  container.subfolders.unshift(created);
  return created;
}

/** Every `ease` string in a timeline, outside `transitionsData`. */
export function referencedEases(data: Timeline): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 64 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (depth === 0 && key === 'transitionsData') continue;
      if (key === 'ease' && typeof entry === 'string') names.add(entry);
      else walk(entry, depth + 1);
    }
  };
  walk(data, 0);
  return names;
}

interface TransitionEntry { folders: unknown[]; json: CustomEase }

/**
 * Keep `transitionsData` holding a copy of every custom ease the timeline
 * uses: add or refresh the copies of used eases, and drop copies of project
 * eases the timeline no longer uses. Entries naming an ease the project does
 * not register are left alone. Returns true when anything changed.
 */
export function syncTransitionsData(data: Timeline, eases: Map<string, CustomEase>): boolean {
  const used = referencedEases(data);
  const before = JSON.stringify(data.transitionsData ?? []);
  const entries = (Array.isArray(data.transitionsData) ? data.transitionsData : []) as TransitionEntry[];
  const kept = entries.filter(entry => {
    const name = entry?.json?.name;
    return typeof name !== 'string' || !eases.has(name) || used.has(name);
  });
  for (const name of used) {
    const ease = eases.get(name);
    if (!ease) continue;
    const existing = kept.find(entry => entry?.json?.name === name);
    if (existing) existing.json = structuredClone(ease);
    else kept.push({ folders: [], json: structuredClone(ease) });
  }
  const changed = JSON.stringify(kept) !== before;
  if (changed || data.transitionsData !== undefined) data.transitionsData = kept;
  return changed;
}
