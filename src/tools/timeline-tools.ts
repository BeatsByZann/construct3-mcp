/**
 * Timeline tools: create_timeline, update_timeline, delete_timeline,
 * list_timelines, get_timeline_details, and the track/keyframe editors
 * add_timeline_track, remove_timeline_track, add_property_track,
 * remove_property_track, set_keyframe, delete_keyframe, update_track.
 * Value and audio tracks, track folders and custom eases are registered from
 * ./timeline-track-tools.ts and ./timeline-ease-tools.ts.
 *
 * Timeline JSON files live in projectDir/timelines/[subfolder/]<name>.json.
 * The project.c3proj timelines container tracks their names; its first,
 * nameless subfolder lists custom eases, whose files live in
 * timelines/transitions/ (see ../construct3/timeline-model.ts).
 * JSON shape validated against a Construct 3 r495.2 timeline with an
 * instance track (test/fixtures/timeline-sample) and 22 r495.2 example
 * packages. Property rules are in ../construct3/timeline-properties.ts.
 */

import { z } from 'zod';
import { readFile, writeFile, mkdir, copyFile, unlink, rename, stat } from 'fs/promises';
import { dirname } from 'path';
import type { MutationToolDeps } from './shared.js';
import type {
  WriteResult,
  Instance,
  Layout,
  ObjectType,
  Timeline,
  TimelineFolder,
  TimelineInstanceTrack,
  TimelineKeyframe,
  TimelinePropertyKeyframe,
  TimelinePropertyTrack,
} from '../construct3/types.js';
import { validateName, validateSubfolder, toolResult, toolError, notFoundError } from './shared.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { collectInstances } from '../construct3/layout-walk.js';
import {
  WORLD_PROPERTIES,
  resolveTimelineProperty,
  specForExistingTrack,
  effectiveResultMode,
  valuesFor,
  checkValue,
  addVirtualPositionKey,
  trackRank,
  type PropertySpec,
  type KeyframeValues,
  type TimelineValue,
} from '../construct3/timeline-properties.js';
import {
  EASES_DIRECTORY,
  timelineFolder,
  easesFolder,
  trackKind,
  listTracks,
  listPropertyTracks,
  findTrackByUid,
  findTrackByName,
  createPlainMasterKeyframe,
  createValueKeyframe,
  createAudioSourceAdapter,
  syncTransitionsData,
  isBuiltinEaseName,
  type AnyTrack,
  type TrackKind,
  type TrackLocation,
  type CustomEase,
  type AudioFileRef,
} from '../construct3/timeline-model.js';
import { listFileEntries } from '../construct3/file-registration.js';
import { registerTimelineTrackTools } from './timeline-track-tools.js';
import { registerTimelineEaseTools } from './timeline-ease-tools.js';

export type { Timeline, TimelineFolder };

// ─── Template factory ──────────────────────────────────────

function createTimeline(name: string, totalTime = 5): Timeline {
  return {
    name,
    enabled: true,
    interpolationMode: 'default',
    resultMode: 'default',
    ease: 'noease',
    pathMode: 'line',
    resizeMode: 'size',
    playheadTime: 1,
    totalTime,
    stepTime: 0.1,
    useStepTime: true,
    showingInterpolationModes: false,
    showingResultModes: false,
    showingEases: false,
    showingPathModes: false,
    scale: 1,
    loop: false,
    pingPong: false,
    repeatCount: 1,
    startOnLayout: '',
    transformWithSceneGraph: true,
    ignoreSystemTimescale: true,
    tracks: [],
    tracksRoot: timelineFolder('Track Folder'),
    nestedTimelinesRoot: timelineFolder('Timelines'),
    nestedData: {},
    childrenNestedData: {},
    transitionsData: [],
  };
}

// ─── Helpers ───────────────────────────────────────────────

function timelineFilePath(projectDir: string, name: string, subfolder?: string): string {
  if (subfolder) {
    return resolveProjectPath(projectDir, 'timelines', ...subfolder.split('/'), `${name}.json`);
  }
  return resolveProjectPath(projectDir, 'timelines', `${name}.json`);
}

async function readJson<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

/** A parsed file is a timeline only when it has a `tracks` array; an ease file has none. */
function isTimelineData(data: unknown): data is Timeline {
  return !!data && typeof data === 'object' && Array.isArray((data as Timeline).tracks);
}

/** Write JSON with tab indentation through a temp file and a rename. */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, '\t');
  const tmpPath = filePath + '.tmp';
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, json, 'utf-8');
  try {
    await rename(tmpPath, filePath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(filePath);
      await rename(tmpPath, filePath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

/** Copy filePath to filePath.bak when it exists; returns the backup path. */
export async function backupFile(filePath: string): Promise<string> {
  const bak = filePath + '.bak';
  try {
    await stat(filePath);
    await copyFile(filePath, bak);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') return bak;
    throw e;
  }
  return bak;
}

type ContainerFolder = { name?: string; items: string[]; subfolders: ContainerFolder[] };

/** A new `timelines` container, with the nameless eases folder every r495 project has. */
function newTimelinesContainer(): ContainerFolder {
  return { items: [], subfolders: [{ items: [], subfolders: [] }] };
}

/** User subfolders of the timelines container: every subfolder except the eases folder. */
function timelineSubfolders(container: ContainerFolder): ContainerFolder[] {
  const eases = easesFolder(container);
  return (container.subfolders ?? []).filter(sf => sf !== eases);
}

/** Add a timeline name to project.c3proj timelines container. */
async function addTimelineToProject(
  projectPath: string,
  name: string,
  subfolder?: string,
): Promise<void> {
  const project = await readJson<Record<string, unknown>>(projectPath);
  if (!project.timelines) project.timelines = newTimelinesContainer();
  const container = project.timelines as ContainerFolder;

  if (subfolder) {
    let cur: ContainerFolder = container;
    for (const part of subfolder.split('/')) {
      let found = cur.subfolders.find(sf => sf.name === part);
      if (!found) {
        found = { items: [], subfolders: [], name: part };
        cur.subfolders.push(found);
      }
      cur = found;
    }
    if (!cur.items.includes(name)) cur.items.push(name);
  } else {
    if (!container.items.includes(name)) container.items.push(name);
  }

  await atomicWriteJson(projectPath, project);
}

/** Remove a timeline name from project.c3proj timelines container, never touching the eases folder. */
async function removeTimelineFromProject(projectPath: string, name: string): Promise<void> {
  const project = await readJson<Record<string, unknown>>(projectPath);
  if (!project.timelines) return;
  const container = project.timelines as ContainerFolder;

  const idx = container.items.indexOf(name);
  if (idx !== -1) {
    container.items.splice(idx, 1);
  } else {
    const removeFromSubfolders = (subfolders: ContainerFolder[]): boolean => {
      for (const sf of subfolders) {
        const i = sf.items.indexOf(name);
        if (i !== -1) { sf.items.splice(i, 1); return true; }
        if (removeFromSubfolders(sf.subfolders)) return true;
      }
      return false;
    };
    removeFromSubfolders(timelineSubfolders(container));
  }

  await atomicWriteJson(projectPath, project);
}

/** Collect all timeline names from a timelines container (root and user subfolders, not eases). */
function collectTimelineNames(container: ContainerFolder | undefined): string[] {
  if (!container) return [];
  const names: string[] = [...container.items];
  const walk = (subfolders: ContainerFolder[]) => {
    for (const sf of subfolders) {
      names.push(...sf.items);
      walk(sf.subfolders);
    }
  };
  walk(timelineSubfolders(container));
  return names;
}

/** Folder path of a registered timeline ('' for the root), or null. */
function locateTimeline(container: ContainerFolder | undefined, name: string): string | null {
  if (!container) return null;
  if (container.items.includes(name)) return '';
  const walk = (subfolders: ContainerFolder[], prefix: string): string | null => {
    for (const sf of subfolders) {
      const path = prefix ? `${prefix}/${sf.name}` : String(sf.name);
      if (sf.items.includes(name)) return path;
      const deeper = walk(sf.subfolders, path);
      if (deeper !== null) return deeper;
    }
    return null;
  };
  return walk(timelineSubfolders(container), '');
}

/** Custom ease names registered in the project. */
export function registeredEaseNames(container: ContainerFolder | undefined): string[] {
  return easesFolder(container)?.items.slice() ?? [];
}

type LoadResult =
  | { ok: true; filePath: string; data: Timeline }
  | { ok: false; reason: 'unreadable' | 'not-a-timeline'; filePath?: string };

/**
 * Read a timeline at its registered folder. A root timeline missing from
 * timelines/ is also looked for in timelines/transitions/, but a file there
 * is used only when it really is a timeline: that directory holds eases.
 */
async function loadTimeline(projectDir: string, name: string, subfolder: string): Promise<LoadResult> {
  const primary = timelineFilePath(projectDir, name, subfolder || undefined);
  let data: unknown;
  try {
    data = await readJson<unknown>(primary);
  } catch {
    data = undefined;
  }
  if (data !== undefined) {
    return isTimelineData(data)
      ? { ok: true, filePath: primary, data }
      : { ok: false, reason: 'not-a-timeline', filePath: primary };
  }
  if (subfolder === '') {
    const fallback = timelineFilePath(projectDir, name, EASES_DIRECTORY);
    try {
      const other = await readJson<unknown>(fallback);
      if (isTimelineData(other)) return { ok: true, filePath: fallback, data: other };
    } catch { /* not there either */ }
  }
  return { ok: false, reason: 'unreadable' };
}

/** True when a timeline subfolder would be timelines/transitions/, where eases live. */
function reservedTransitionsFolder(subfolder: string): boolean {
  return subfolder.split('/')[0].toLowerCase() === EASES_DIRECTORY;
}

// ─── Track and keyframe helpers ────────────────────────────

/** Keyframe times are floats; compare them with a tolerance. */
const TIME_EPSILON = 1e-9;

export function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) < TIME_EPSILON;
}

/** Warn about property names that matched no sampled rule. */
function unverifiedPropertyWarnings(specs: PropertySpec[]): string[] {
  const unverified = specs.filter(spec => !spec.verified).map(spec => spec.property);
  if (unverified.length === 0) return [];
  return [
    `Property name(s) ${unverified.join(', ')} match no world property, instance variable or plugin property ` +
    `sampled from Construct (world properties: ${Object.keys(WORLD_PROPERTIES).join(', ')}); check the track in the Construct 3 editor.`,
  ];
}

/** Warn about ease names that are neither built-in nor a custom ease of the project. */
export function easeWarnings(names: Array<string | undefined>, eases: Map<string, CustomEase>): string[] {
  const unknown = names.filter((n): n is string => typeof n === 'string' && !isBuiltinEaseName(n) && !eases.has(n));
  if (unknown.length === 0) return [];
  return [`Ease name(s) ${[...new Set(unknown)].join(', ')} are not Construct ease names and match no custom ease in this project (see list_eases).`];
}

/**
 * Find a property track by name, in `propertyTracks` or a property-track
 * folder. `var:` and `plugin:` prefixes select the instance-variable or
 * plugin track when a world, variable and plugin property share a name.
 */
function findPropertyTrack(
  track: AnyTrack,
  property: string,
): { propertyTrack: TimelinePropertyTrack; list: unknown[] } | undefined {
  let sourceType: string | undefined;
  let bare = property;
  if (property.startsWith('var:')) { sourceType = 'instance-variable'; bare = property.slice(4); }
  else if (property.startsWith('plugin:')) { sourceType = 'plugin'; bare = property.slice(7); }
  return listPropertyTracks(track).find(({ propertyTrack: pt }) => pt.property === bare
    && (sourceType === undefined || pt.source?.type === sourceType));
}

function createMasterKeyframe(time: number): TimelineKeyframe {
  return {
    time,
    tags: '',
    enabled: true,
    ease: 'default',
    pathMode: 'default',
  };
}

function createPropertyKeyframe(
  time: number,
  spec: PropertySpec,
  values: KeyframeValues,
): TimelinePropertyKeyframe {
  const keyframe: Record<string, unknown> = {
    time,
    enabled: true,
    resultMode: 'default',
    ease: 'default',
    pathMode: spec.pathMode,
    value: values.value,
  };
  if (values.rValue !== undefined) keyframe.rValue = values.rValue;
  keyframe.aValue = values.aValue;
  keyframe.addons = spec.addons();
  return keyframe as TimelinePropertyKeyframe;
}

function createPropertyTrack(spec: PropertySpec): TimelinePropertyTrack {
  return {
    property: spec.property,
    source: { ...spec.source },
    enabled: true,
    interpolationMode: 'default',
    resultMode: 'default',
    ease: 'default',
    pathMode: spec.pathMode,
    propertyKeyframes: [],
    ...spec.trackExtras,
  };
}

function createInstanceTrack(
  uid: number,
  objectType: string,
  projectId: string,
): TimelineInstanceTrack {
  return {
    type: 'instance-track',
    worldInstance: uid,
    objectType,
    project: projectId,
    enabled: true,
    interpolationMode: 'default',
    resultMode: 'default',
    ease: 'default',
    pathMode: 'default',
    resizeMode: 'default',
    initialVisibility: true,
    id: '',
    virtualPosition: {
      useColor: true,
      colorSet: false,
      relativeFlags: 16383,
      version: 1,
    },
    keyframes: [],
    propertyTracks: [],
    propertyTracksRoot: timelineFolder('Property Track Folder'),
  };
}

/** Add a property track to an instance track, keeping virtualPosition in step as the editor does. */
function attachPropertyTrack(
  track: TimelineInstanceTrack,
  spec: PropertySpec,
  propertyTrack: TimelinePropertyTrack,
  instance: Instance,
  objectType: ObjectType | undefined,
): void {
  const at = track.propertyTracks.findIndex(pt => trackRank(pt, instance, objectType) > spec.order);
  if (at === -1) track.propertyTracks.push(propertyTrack);
  else track.propertyTracks.splice(at, 0, propertyTrack);
  if (spec.virtualKey) {
    track.virtualPosition = addVirtualPositionKey(
      track.virtualPosition as unknown as Record<string, unknown>,
      spec.virtualKey,
      spec.kind,
    ) as unknown as TimelineInstanceTrack['virtualPosition'];
  }
}

/** Result mode in force for a keyframe, from the keyframe out to the timeline. */
function keyframeMode(
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
function refreshModeValues(data: Timeline): void {
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

/** Insert or update a property keyframe at `time`, keeping the list sorted. */
function setPropertyKeyframe(
  data: Timeline,
  track: AnyTrack,
  propertyTrack: TimelinePropertyTrack,
  spec: PropertySpec,
  time: number,
  absolute: TimelineValue,
): TimelinePropertyKeyframe {
  const existing = propertyTrack.propertyKeyframes.find(kf => sameTime(kf.time, time));
  const values = valuesFor(spec, absolute, keyframeMode(data, track, propertyTrack, existing));
  if (existing) {
    existing.value = values.value;
    if (values.rValue !== undefined) existing.rValue = values.rValue;
    existing.aValue = values.aValue;
    return existing;
  }
  const created = createPropertyKeyframe(time, spec, values);
  propertyTrack.propertyKeyframes.push(created);
  propertyTrack.propertyKeyframes.sort((a, b) => a.time - b.time);
  return created;
}

/** Keyframes holding the instance's current value at each time. */
function currentKeyframes(
  data: Timeline,
  track: AnyTrack,
  propertyTrack: TimelinePropertyTrack,
  spec: PropertySpec,
  times: number[],
): TimelinePropertyKeyframe[] {
  const mode = keyframeMode(data, track, propertyTrack, undefined);
  if (!spec.verified) {
    return times.map(time => createPropertyKeyframe(time, spec, { value: 0, rValue: 0, aValue: 0 }));
  }
  return times.map(time => createPropertyKeyframe(time, spec, valuesFor(spec, spec.base as TimelineValue, mode)));
}

/** The instance with this UID in any layout, with the layout that holds it. */
function findInstanceAnywhere(
  layouts: Map<string, Layout>,
  uid: number,
): { instance: Instance; layoutName: string } | undefined {
  for (const [layoutName, layout] of layouts) {
    const instance = collectInstances(layout).find(inst => inst.uid === uid);
    if (instance) return { instance, layoutName };
  }
  return undefined;
}

// ─── Shared toolkit for the timeline tool files ────────────

type ErrorResult = ReturnType<typeof toolError>;

export type TimelineLookup =
  | { ok: true; filePath: string; data: Timeline }
  | { ok: false; error: ErrorResult };

export type TrackSelection =
  | { ok: true; loc: TrackLocation; kind: TrackKind }
  | { ok: false; error: ErrorResult };

export interface TrackSelectorArgs {
  instanceUid?: number;
  trackName?: string;
}

export interface TimelineToolkit {
  openTimeline(timelineName: string): Promise<TimelineLookup>;
  saveTimeline(filePath: string, data: Timeline): Promise<string>;
  writeResult(timelineName: string, action: string, backupPath: string, warnings?: string[]): WriteResult;
  selectTrack(data: Timeline, timelineName: string, args: TrackSelectorArgs, allowLegacy: boolean): TrackSelection;
  loadEases(): Promise<Map<string, CustomEase>>;
  allTimelines(): Promise<Array<{ name: string; filePath: string; data: Timeline }>>;
  timelineNames(): string[];
  easeFilePath(name: string): string;
  projectContainer(): ContainerFolder | undefined;
  findAudioFile(name: string, folder?: 'sound' | 'music'): { ok: true; file: AudioFileRef; warnings: string[] } | { ok: false; error: ErrorResult };
}

/** Zod fields that address one track: an instance track by UID or a value/audio track by name. */
export const trackSelectorShape = {
  instanceUid: z.number().int().min(0).optional().describe('UID of the animated instance (instance tracks)'),
  trackName: z.string().min(1).max(200).optional().describe('Name of a value or audio track; give this instead of instanceUid'),
};

// ─── Registration ──────────────────────────────────────────

export function registerTimelineTools(deps: MutationToolDeps) {
  const { server, reader } = deps;

  function timelinesContainer(): ContainerFolder | undefined {
    return reader.getProject().timelines as unknown as ContainerFolder | undefined;
  }

  async function resolveTimeline(timelineName: string, notFound: () => ErrorResult): Promise<TimelineLookup> {
    const subfolder = locateTimeline(timelinesContainer(), timelineName);
    if (subfolder === null) return { ok: false, error: notFound() };
    let loaded: LoadResult;
    try {
      loaded = await loadTimeline(reader.getProjectDir(), timelineName, subfolder);
    } catch (e: unknown) {
      return { ok: false, error: toolError(`Timeline "${timelineName}": ${e instanceof Error ? e.message : String(e)}`) };
    }
    if (!loaded.ok) {
      return {
        ok: false,
        error: toolError(loaded.reason === 'not-a-timeline'
          ? `Timeline "${timelineName}" is registered in the project but its file holds no tracks, so it is not a timeline (a custom ease file looks like this; see list_eases).`
          : `Timeline "${timelineName}" is registered in the project but its file could not be read.`),
      };
    }
    return { ok: true, filePath: loaded.filePath, data: loaded.data };
  }

  /** Resolve a registered timeline's file and parsed contents. */
  function openTimeline(timelineName: string): Promise<TimelineLookup> {
    return resolveTimeline(timelineName, () =>
      toolError(`Timeline "${timelineName}" not found. Use list_timelines to see available timelines.`));
  }

  async function loadEases(): Promise<Map<string, CustomEase>> {
    const eases = new Map<string, CustomEase>();
    for (const name of registeredEaseNames(timelinesContainer())) {
      try {
        const ease = await readJson<CustomEase>(easeFilePath(name));
        if (ease && typeof ease === 'object' && Array.isArray(ease.transitionKeyframes)) eases.set(name, ease);
      } catch { /* unreadable ease files are reported by list_eases */ }
    }
    return eases;
  }

  function easeFilePath(name: string): string {
    return resolveProjectPath(reader.getProjectDir(), 'timelines', EASES_DIRECTORY, `${name}.json`);
  }

  /** Back up the timeline file, sync its custom-ease copies, then replace it. */
  async function saveTimeline(filePath: string, data: Timeline): Promise<string> {
    syncTransitionsData(data, await loadEases());
    const backupPath = await backupFile(filePath);
    await atomicWriteJson(filePath, data);
    return backupPath;
  }

  function writeResult(
    timelineName: string,
    action: string,
    backupPath: string,
    warnings: string[] = [],
  ): WriteResult {
    const result: WriteResult = {
      success: true,
      entity: timelineName,
      category: 'timeline',
      action,
      backupFile: backupPath,
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  function selectTrack(data: Timeline, timelineName: string, args: TrackSelectorArgs, allowLegacy: boolean): TrackSelection {
    if ((args.instanceUid === undefined) === (args.trackName === undefined)) {
      return { ok: false, error: toolError('Give exactly one of instanceUid (an instance track) or trackName (a value or audio track).') };
    }
    if (args.instanceUid !== undefined) {
      const uid = args.instanceUid;
      const loc = findTrackByUid(data, uid);
      if (!loc) {
        const uids = listTracks(data)
          .filter(l => ['instance-track', 'legacy-instance-track'].includes(trackKind(l.track)))
          .map(l => l.track.worldInstance);
        const hint = uids.length > 0
          ? ` Tracked instance UIDs: ${uids.join(', ')}.`
          : ' The timeline has no instance tracks.';
        return {
          ok: false,
          error: toolError(`Timeline "${timelineName}" has no track for instance UID ${uid}.${hint} Add one with add_timeline_track.`),
        };
      }
      const kind = trackKind(loc.track);
      if (kind === 'legacy-instance-track' && !allowLegacy) {
        return {
          ok: false,
          error: toolError(`The track for instance UID ${uid} in timeline "${timelineName}" is an untyped track saved by an older Construct release. ` +
            'This tool would have to rewrite its keyframe values, and no sample shows how Construct upgrades them; open and save the timeline in the Construct 3 editor first.'),
        };
      }
      return { ok: true, loc, kind };
    }
    const name = args.trackName as string;
    const loc = findTrackByName(data, name);
    if (!loc) {
      const names = listTracks(data)
        .filter(l => ['value-track', 'audio-track'].includes(trackKind(l.track)))
        .map(l => `"${String(l.track.name)}"`);
      const hint = names.length > 0 ? ` Value and audio tracks: ${names.join(', ')}.` : ' The timeline has no value or audio tracks.';
      return { ok: false, error: toolError(`Timeline "${timelineName}" has no value or audio track named "${name}".${hint}`) };
    }
    return { ok: true, loc, kind: trackKind(loc.track) };
  }

  async function allTimelines(): Promise<Array<{ name: string; filePath: string; data: Timeline }>> {
    const out: Array<{ name: string; filePath: string; data: Timeline }> = [];
    for (const name of collectTimelineNames(timelinesContainer())) {
      const opened = await openTimeline(name);
      if (opened.ok) out.push({ name, filePath: opened.filePath, data: opened.data });
    }
    return out;
  }

  function findAudioFile(name: string, folder?: 'sound' | 'music') {
    const project = reader.getProject();
    const folders: Array<'sound' | 'music'> = folder ? [folder] : ['sound', 'music'];
    const matches: Array<{ entry: Record<string, unknown>; audioType: 'sound' | 'music'; subfolder?: string }> = [];
    for (const f of folders) {
      for (const { entry, subfolder } of listFileEntries(project, f)) {
        if (entry.name === name) matches.push({ entry: entry as unknown as Record<string, unknown>, audioType: f, subfolder });
      }
    }
    if (matches.length === 0) {
      return {
        ok: false as const,
        error: toolError(`Audio file "${name}" is not registered in the project's ${folders.join(' or ')} files. Import it into Sounds or Music first (register_project_file).`),
      };
    }
    if (matches.length > 1) {
      const where = matches.map(m => `${m.audioType}${m.subfolder ? '/' + m.subfolder : ''}`).join(', ');
      return {
        ok: false as const,
        error: toolError(`Audio file "${name}" is registered more than once (${where}); pass audioFolder to choose sound or music.`),
      };
    }
    const warnings: string[] = [];
    const type = matches[0].entry.type;
    if (typeof type !== 'string' || !type.startsWith('audio/')) {
      warnings.push(`"${name}" is registered with type "${String(type)}", not an audio type.`);
    }
    return { ok: true as const, file: { entry: matches[0].entry, audioType: matches[0].audioType }, warnings };
  }

  const toolkit: TimelineToolkit = {
    openTimeline,
    saveTimeline,
    writeResult,
    selectTrack,
    loadEases,
    allTimelines,
    timelineNames: () => collectTimelineNames(timelinesContainer()),
    easeFilePath,
    projectContainer: timelinesContainer,
    findAudioFile,
  };

  // ─── list_timelines ───────────────────────────────────────

  server.tool(
    'list_timelines',
    'List all timelines in the project (custom eases are listed by list_eases)',
    {},
    async () => {
      try {
        const names = collectTimelineNames(timelinesContainer());
        return toolResult({ timelines: names, count: names.length });
      } catch (error) {
        console.error('[list_timelines] failed:', error);
        return toolError(`Error listing timelines: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── get_timeline_details ─────────────────────────────────

  server.tool(
    'get_timeline_details',
    'Get full details of a timeline including its tracks and settings (the raw file; list_timeline_tracks summarizes the tracks)',
    {
      name: z.string().max(200).describe('Timeline name'),
    },
    async (args) => {
      try {
        const opened = await resolveTimeline(args.name, () => {
          const names = collectTimelineNames(timelinesContainer());
          const hint = names.length > 0 ? `\nAvailable timelines: ${names.slice(0, 5).join(', ')}` : '\nNo timelines found in this project.';
          return toolError(`Timeline "${args.name}" not found.${hint}`);
        });
        if (!opened.ok) return opened.error;
        return toolResult(opened.data);
      } catch (error) {
        console.error('[get_timeline_details] failed:', error);
        return toolError(`Error getting timeline details: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── create_timeline ──────────────────────────────────────

  server.tool(
    'create_timeline',
    'Create a new timeline in the project',
    {
      name: z.string().max(200).describe('Timeline name'),
      totalTime: z.number().positive().optional().default(5).describe('Total duration in seconds (default: 5)'),
      loop: z.boolean().optional().default(false).describe('Loop the timeline (default: false)'),
      pingPong: z.boolean().optional().default(false).describe('Ping-pong playback (default: false)'),
      repeatCount: z.number().int().min(1).optional().default(1).describe('Repeat count when not looping (default: 1)'),
      startOnLayout: z.string().max(200).optional().default('').describe('Layout name to auto-start on (default: empty = no auto-start)'),
      ignoreSystemTimescale: z.boolean().optional().default(true).describe('Ignore system timescale (default: true)'),
      subfolder: z.string().max(500).optional().describe('Timeline folder, stored as the same subfolder of timelines/ (e.g. "Cutscenes/Intro"). "transitions" is refused: Construct keeps custom eases in timelines/transitions/'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder !== undefined) {
          validateSubfolder(args.subfolder);
          if (reservedTransitionsFolder(args.subfolder)) {
            return toolError(`Subfolder "${args.subfolder}" is refused: Construct stores custom eases in timelines/${EASES_DIRECTORY}/, so a timeline file there would sit among the ease files. Choose another folder name.`);
          }
        }

        const container = timelinesContainer();
        const existing = collectTimelineNames(container);
        if (existing.includes(args.name)) {
          return toolError(`Timeline "${args.name}" already exists.`);
        }
        if (registeredEaseNames(container).includes(args.name)) {
          return toolError(`"${args.name}" is already the name of a custom ease in this project; choose another timeline name.`);
        }

        const data = createTimeline(args.name, args.totalTime);
        data.loop = args.loop;
        data.pingPong = args.pingPong;
        data.repeatCount = args.repeatCount;
        data.startOnLayout = args.startOnLayout;
        data.ignoreSystemTimescale = args.ignoreSystemTimescale;

        const filePath = timelineFilePath(reader.getProjectDir(), args.name, args.subfolder);
        const backupPath = await backupFile(filePath);
        await atomicWriteJson(filePath, data);

        // timelines is not a writer-managed category, so project.c3proj is
        // rewritten here and the reader reloaded.
        const projectPath = reader.getProjectPath();
        await backupFile(projectPath);
        await addTimelineToProject(projectPath, args.name, args.subfolder);
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'timeline',
          action: 'created',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_timeline] failed:', error);
        return toolError(`Error creating timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_timeline ──────────────────────────────────────

  server.tool(
    'update_timeline',
    'Update properties of an existing timeline',
    {
      name: z.string().max(200).describe('Timeline name'),
      totalTime: z.number().positive().optional().describe('New total duration in seconds'),
      loop: z.boolean().optional().describe('Loop setting'),
      pingPong: z.boolean().optional().describe('Ping-pong playback'),
      repeatCount: z.number().int().min(1).optional().describe('Repeat count'),
      startOnLayout: z.string().max(200).optional().describe('Auto-start layout name (empty string = none)'),
      ignoreSystemTimescale: z.boolean().optional().describe('Ignore system timescale'),
      enabled: z.boolean().optional().describe('Enable/disable the timeline'),
      ease: z.string().max(100).optional().describe('Timeline-level ease name (e.g. "noease") or a custom ease name; unknown names are written with a warning'),
      interpolationMode: z.string().max(100).optional().describe('Timeline-level interpolation mode (e.g. "default")'),
      resultMode: z.string().max(100).optional().describe('Timeline-level result mode (e.g. "default")'),
      pathMode: z.string().max(100).optional().describe('Timeline-level path mode (e.g. "line")'),
      transformWithSceneGraph: z.boolean().optional().describe('Apply timeline values through scene-graph parents'),
    },
    async (args) => {
      try {
        const hasUpdates = args.totalTime !== undefined || args.loop !== undefined ||
          args.pingPong !== undefined || args.repeatCount !== undefined ||
          args.startOnLayout !== undefined || args.ignoreSystemTimescale !== undefined ||
          args.enabled !== undefined || args.ease !== undefined ||
          args.interpolationMode !== undefined || args.resultMode !== undefined ||
          args.pathMode !== undefined || args.transformWithSceneGraph !== undefined;

        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: totalTime, loop, pingPong, repeatCount, startOnLayout, ignoreSystemTimescale, enabled, ease, interpolationMode, resultMode, pathMode, transformWithSceneGraph.');
        }

        const opened = await resolveTimeline(args.name, () =>
          toolError(`Timeline "${args.name}" not found. Use list_timelines to see available timelines.`));
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        if (args.totalTime !== undefined) data.totalTime = args.totalTime;
        if (args.loop !== undefined) data.loop = args.loop;
        if (args.pingPong !== undefined) data.pingPong = args.pingPong;
        if (args.repeatCount !== undefined) data.repeatCount = args.repeatCount;
        if (args.startOnLayout !== undefined) data.startOnLayout = args.startOnLayout;
        if (args.ignoreSystemTimescale !== undefined) data.ignoreSystemTimescale = args.ignoreSystemTimescale;
        if (args.enabled !== undefined) data.enabled = args.enabled;
        if (args.ease !== undefined) data.ease = args.ease;
        if (args.interpolationMode !== undefined) data.interpolationMode = args.interpolationMode;
        if (args.resultMode !== undefined) {
          data.resultMode = args.resultMode;
          refreshModeValues(data);
        }
        if (args.pathMode !== undefined) data.pathMode = args.pathMode;
        if (args.transformWithSceneGraph !== undefined) data.transformWithSceneGraph = args.transformWithSceneGraph;

        const warnings = easeWarnings([args.ease], await loadEases());
        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(args.name, 'updated', backupPath, warnings));
      } catch (error) {
        console.error('[update_timeline] failed:', error);
        return toolError(`Error updating timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_timeline ──────────────────────────────────────

  server.tool(
    'delete_timeline',
    'Delete a timeline from the project',
    {
      name: z.string().max(200).describe('Timeline name to delete'),
    },
    async (args) => {
      try {
        const subfolder = locateTimeline(timelinesContainer(), args.name);
        if (subfolder === null) {
          return toolError(`Timeline "${args.name}" not found. Use list_timelines to see available timelines.`);
        }

        // Only delete a file that really is this timeline; an ease file of the
        // same name in timelines/transitions/ is left alone.
        const loaded = await loadTimeline(reader.getProjectDir(), args.name, subfolder);
        const filePath = loaded.ok
          ? loaded.filePath
          : loaded.filePath ?? timelineFilePath(reader.getProjectDir(), args.name, subfolder || undefined);
        if (!loaded.ok && loaded.reason === 'not-a-timeline') {
          return toolError(`Timeline "${args.name}" is registered but its file holds no tracks, so it was not deleted. Check it with get_timeline_details.`);
        }
        const backupPath = await backupFile(filePath);
        try {
          await unlink(filePath);
        } catch (e: unknown) {
          if (!(e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT')) throw e;
        }

        const projectPath = reader.getProjectPath();
        await backupFile(projectPath);
        await removeTimelineFromProject(projectPath, args.name);
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'timeline',
          action: 'deleted',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_timeline] failed:', error);
        return toolError(`Error deleting timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── Track editing helpers (closure over reader) ──────────

  /** The world instance with this UID, searched across every layout, and its object type. */
  async function requireWorldInstance(uid: number): Promise<
    { ok: true; instance: Instance; objectType?: ObjectType } | { ok: false; error: ErrorResult }
  > {
    const located = findInstanceAnywhere(await reader.readAllLayouts(), uid);
    if (!located) {
      return {
        ok: false,
        error: toolError(`Instance UID ${uid} was not found in any layout, so its current property values cannot be read. Remove the stale track with remove_timeline_track.`),
      };
    }
    if (!located.instance.world) {
      return {
        ok: false,
        error: toolError(`Instance UID ${uid} in layout "${located.layoutName}" is not a world instance.`),
      };
    }
    return { ok: true, instance: located.instance, objectType: await readObjectTypeSafe(located.instance.type) };
  }

  async function readObjectTypeSafe(name: string): Promise<ObjectType | undefined> {
    try {
      return await reader.readObjectType(name);
    } catch {
      return undefined;
    }
  }

  /** Resolve property names for new tracks; a known property whose current value is unreadable is an error. */
  function resolveNewProperties(
    properties: string[],
    instance: Instance,
    objectType: ObjectType | undefined,
  ): { ok: true; specs: PropertySpec[] } | { ok: false; error: ErrorResult } {
    const specs: PropertySpec[] = [];
    for (const name of properties) {
      const resolved = resolveTimelineProperty(name, instance, objectType);
      if (!resolved.ok) return { ok: false, error: toolError(resolved.error) };
      const spec = resolved.spec;
      if (spec.verified && spec.base === undefined) {
        return { ok: false, error: toolError(`Cannot read the current value of "${spec.property}" for instance UID ${instance.uid}${spec.property.startsWith('offsetScale') ? ' (its object type has no frame size to divide by)' : ''}.`) };
      }
      if (specs.some(other => other.property === spec.property && other.source.type === spec.source.type)) {
        return { ok: false, error: toolError(`Duplicate property "${name}" in properties; each property track must appear once.`) };
      }
      specs.push(spec);
    }
    return { ok: true, specs };
  }

  const propertyNameHelp = `World properties: ${Object.keys(WORLD_PROPERTIES).join(', ')}. Instance variable names and plugin property ids (e.g. "initial-animation") are also accepted; prefix "var:" or "plugin:" when a name is both`;

  // ─── add_timeline_track ───────────────────────────────────

  server.tool(
    'add_timeline_track',
    'Add an instance track for one world instance of a layout to a timeline, with master keyframes and one property track per property holding the instance\'s current value (value and audio tracks: add_value_track, add_audio_track)',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      layoutName: z.string().max(200).describe('Layout that holds the instance'),
      instanceUid: z.number().int().min(0).describe('UID of the world instance to animate'),
      properties: z.array(z.string().min(1).max(100)).max(32).optional().default(['offsetX', 'offsetY'])
        .describe(`Properties to animate (default: ["offsetX","offsetY"]). ${propertyNameHelp}`),
      keyframeTimes: z.array(z.number().min(0)).min(1).max(200).optional().default([0])
        .describe('Master keyframe times in seconds, each within [0, totalTime] (default: [0])'),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError(
            'Layout',
            args.layoutName,
            reader.findNearestName(args.layoutName, 'layouts'),
            'list_layouts',
          );
        }

        const instance = collectInstances(layout).find(inst => inst.uid === args.instanceUid);
        if (!instance) {
          return toolError(`Instance UID ${args.instanceUid} not found in layout "${args.layoutName}". Use get_layout_details to list its instances.`);
        }
        if (!instance.world) {
          return toolError(`Instance UID ${args.instanceUid} ("${instance.type}") is not a world instance of layout "${args.layoutName}"; an instance track can only animate a world instance.`);
        }

        // Tracks can sit in track folders, and older files hold untyped tracks.
        const existingTrack = findTrackByUid(data, args.instanceUid);
        if (existingTrack) {
          const where = existingTrack.folderPath ? ` (in track folder "${existingTrack.folderPath}")` : '';
          const legacy = trackKind(existingTrack.track) === 'legacy-instance-track' ? ' an untyped (older) track' : ' a track';
          return toolError(`Instance UID ${args.instanceUid} already has${legacy} in timeline "${args.timelineName}"${where}. Extend it with add_property_track or set_keyframe.`);
        }

        const instanceType = await readObjectTypeSafe(instance.type);
        const resolved = resolveNewProperties(args.properties, instance, instanceType);
        if (!resolved.ok) return resolved.error;

        const times = [...new Set(args.keyframeTimes)].sort((a, b) => a - b);
        const outOfRange = times.find(t => t < 0 || t > data.totalTime);
        if (outOfRange !== undefined) {
          return toolError(`Keyframe time ${outOfRange} is outside the timeline's [0, ${data.totalTime}] range. Raise totalTime with update_timeline first.`);
        }

        const track = createInstanceTrack(
          args.instanceUid,
          instance.type,
          reader.getProject().uniqueId,
        );
        track.keyframes = times.map(time => createMasterKeyframe(time));
        for (const spec of resolved.specs) {
          const propertyTrack = createPropertyTrack(spec);
          propertyTrack.propertyKeyframes = currentKeyframes(data, track, propertyTrack, spec, times);
          attachPropertyTrack(track, spec, propertyTrack, instance, instanceType);
        }
        data.tracks.push(track);

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(
          args.timelineName,
          'track-added',
          backupPath,
          unverifiedPropertyWarnings(resolved.specs),
        ));
      } catch (error) {
        console.error('[add_timeline_track] failed:', error);
        return toolError(`Error adding timeline track: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── remove_timeline_track ────────────────────────────────

  server.tool(
    'remove_timeline_track',
    'Remove a track with all of its property tracks and keyframes: an instance track by instanceUid (including untyped tracks from older releases) or a value/audio track by trackName, at the root or in a track folder',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      ...trackSelectorShape,
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = selectTrack(data, args.timelineName, args, true);
        if (!found.ok) return found.error;

        found.loc.list.splice(found.loc.list.indexOf(found.loc.track), 1);

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(args.timelineName, 'track-removed', backupPath));
      } catch (error) {
        console.error('[remove_timeline_track] failed:', error);
        return toolError(`Error removing timeline track: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_property_track ───────────────────────────────────

  server.tool(
    'add_property_track',
    'Add one property track to an existing instance track, with a keyframe holding the instance\'s current value at every existing master keyframe time',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      instanceUid: z.number().int().min(0).describe('UID of the animated instance'),
      property: z.string().min(1).max(100).describe(`Property to animate. ${propertyNameHelp}`),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = selectTrack(data, args.timelineName, { instanceUid: args.instanceUid }, false);
        if (!found.ok) return found.error;
        const track = found.loc.track as unknown as TimelineInstanceTrack;

        const located = await requireWorldInstance(args.instanceUid);
        if (!located.ok) return located.error;

        const resolved = resolveNewProperties([args.property], located.instance, located.objectType);
        if (!resolved.ok) return resolved.error;
        const spec = resolved.specs[0];

        const duplicate = listPropertyTracks(track).find(({ propertyTrack: pt }) =>
          pt.property === spec.property && pt.source?.type === spec.source.type);
        if (duplicate) {
          const where = duplicate.folderPath ? ` (in property track folder "${duplicate.folderPath}")` : '';
          return toolError(`Property track "${args.property}" already exists on the track for instance UID ${args.instanceUid}${where}. Use set_keyframe to change its values.`);
        }

        const propertyTrack = createPropertyTrack(spec);
        const times = track.keyframes.map(kf => kf.time).sort((a, b) => a - b);
        propertyTrack.propertyKeyframes = currentKeyframes(data, track, propertyTrack, spec, times);
        attachPropertyTrack(track, spec, propertyTrack, located.instance, located.objectType);

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(
          args.timelineName,
          'property-track-added',
          backupPath,
          unverifiedPropertyWarnings([spec]),
        ));
      } catch (error) {
        console.error('[add_property_track] failed:', error);
        return toolError(`Error adding property track: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── remove_property_track ────────────────────────────────

  server.tool(
    'remove_property_track',
    'Remove one property track, and all of its keyframes, from an instance track (also from a property track folder)',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      instanceUid: z.number().int().min(0).describe('UID of the animated instance'),
      property: z.string().min(1).max(100).describe('Property track name to remove ("var:" or "plugin:" prefix selects between tracks sharing a name)'),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = selectTrack(data, args.timelineName, { instanceUid: args.instanceUid }, true);
        if (!found.ok) return found.error;
        const { track } = found.loc;

        const located = findPropertyTrack(track, args.property);
        if (!located) {
          const existing = listPropertyTracks(track).map(({ propertyTrack }) => propertyTrack.property);
          const hint = existing.length > 0
            ? ` Property tracks present: ${existing.join(', ')}.`
            : ' The track has no property tracks.';
          return toolError(`Property track "${args.property}" not found on the track for instance UID ${args.instanceUid}.${hint}`);
        }
        located.list.splice(located.list.indexOf(located.propertyTrack), 1);

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(args.timelineName, 'property-track-removed', backupPath));
      } catch (error) {
        console.error('[remove_property_track] failed:', error);
        return toolError(`Error removing property track: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── set_keyframe ─────────────────────────────────────────

  const absoluteSchema = z.union([
    z.number(),
    z.string().max(10000),
    z.boolean(),
    z.array(z.number().min(0).max(1)).length(4),
  ]);

  /** Insert the master keyframe at `time` if missing; returns it and whether it existed. */
  function ensureMaster(track: AnyTrack, time: number, plain: boolean): { master: TimelineKeyframe; existed: boolean } {
    if (!Array.isArray(track.keyframes)) track.keyframes = [];
    const existing = track.keyframes.find(kf => sameTime(kf.time, time));
    if (existing) return { master: existing, existed: true };
    const master = plain ? createPlainMasterKeyframe(time) : createMasterKeyframe(time);
    track.keyframes.push(master);
    track.keyframes.sort((a, b) => a.time - b.time);
    return { master, existed: false };
  }

  server.tool(
    'set_keyframe',
    'Create or update the master keyframe at a time on a track, and the per-property keyframes at that time. Instance tracks take any animated property; a value track takes only "value"; an audio track has master keyframes only',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      ...trackSelectorShape,
      time: z.number().describe('Keyframe time in seconds, within [0, totalTime]'),
      values: z.record(z.object({
        absolute: absoluteSchema.optional().describe('Value of the property at this keyframe: a number, a string or boolean for such variables and plugin properties, or [r,g,b,a] for offsetColor'),
        relative: z.number().optional().describe('For a number property of an instance track: offset from the instance\'s own layout value'),
        ease: z.string().max(100).optional().describe('Ease of this property keyframe (a new one gets "default")'),
      })).optional().describe('Per-property values, e.g. { "offsetX": { "absolute": 400 }, "offsetOpacity": { "relative": -0.5 }, "tag": { "absolute": "done" } }, or { "value": { "absolute": 2, "ease": "easeinoutsine" } } for a value track. Numbers take absolute or relative; the stored values follow the result mode in force. A name matching no sampled property needs both absolute and relative numbers'),
      ease: z.string().max(100).optional().describe('Master keyframe ease name (a new keyframe gets "default")'),
      enabled: z.boolean().optional().describe('Master keyframe enabled flag'),
      tags: z.string().max(500).optional().describe('Master keyframe tags string'),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = selectTrack(data, args.timelineName, args, false);
        if (!found.ok) return found.error;
        const { track } = found.loc;
        const trackLabel = args.trackName !== undefined ? `track "${args.trackName}"` : `the track for instance UID ${args.instanceUid}`;

        if (args.time < 0 || args.time > data.totalTime) {
          return toolError(`Keyframe time ${args.time} is outside the timeline's [0, ${data.totalTime}] range. Raise totalTime with update_timeline first.`);
        }

        const entries = Object.entries(args.values ?? {});
        if (entries.length > 32) {
          return toolError(`Too many properties in values: ${entries.length} (max 32).`);
        }
        const eases = await loadEases();
        const easeNames = [args.ease, ...entries.map(([, input]) => input.ease)];

        if (found.kind === 'audio-track') {
          if (entries.length > 0) {
            return toolError(`${trackLabel} is an audio track: it has master keyframes only, so give no values.`);
          }
        }

        if (found.kind === 'value-track') {
          const valueTrack = listPropertyTracks(track).find(({ propertyTrack }) => propertyTrack.property === 'value')?.propertyTrack;
          if (!valueTrack) return toolError(`Value track "${args.trackName}" has no "value" property track.`);
          const bad = entries.find(([name]) => name !== 'value');
          if (bad) return toolError(`A value track has only the "value" property; "${bad[0]}" is not accepted.`);
          const input = args.values?.value;
          if (input && input.relative !== undefined) return toolError('A value track stores absolute values only; give "absolute".');
          if (input && input.absolute !== undefined && (typeof input.absolute !== 'number' || !Number.isFinite(input.absolute))) {
            return toolError('A value track keyframe needs a number.');
          }
          const current = valueTrack.propertyKeyframes.find(kf => sameTime(kf.time, args.time));
          if (!current && input?.absolute === undefined) {
            return toolError(`${trackLabel} has no keyframe at time ${args.time}; give values.value.absolute to create one.`);
          }
          const { master, existed } = ensureMaster(track, args.time, true);
          if (args.ease !== undefined) master.ease = args.ease;
          if (args.enabled !== undefined) master.enabled = args.enabled;
          if (args.tags !== undefined) master.tags = args.tags;
          if (current) {
            if (input?.absolute !== undefined) {
              current.value = input.absolute;
              current.rValue = input.absolute as number;
              current.aValue = input.absolute;
            }
            if (input?.ease !== undefined) current.ease = input.ease;
          } else {
            valueTrack.propertyKeyframes.push(createValueKeyframe(args.time, input!.absolute as number, input?.ease));
            valueTrack.propertyKeyframes.sort((a, b) => a.time - b.time);
          }
          const backupPath = await saveTimeline(filePath, data);
          return toolResult(writeResult(args.timelineName, existed ? 'keyframe-updated' : 'keyframe-created', backupPath, easeWarnings(easeNames, eases)));
        }

        if (found.kind === 'audio-track') {
          const { master, existed } = ensureMaster(track, args.time, true);
          if (args.ease !== undefined) master.ease = args.ease;
          if (args.enabled !== undefined) master.enabled = args.enabled;
          if (args.tags !== undefined) master.tags = args.tags;
          const backupPath = await saveTimeline(filePath, data);
          return toolResult(writeResult(args.timelineName, existed ? 'keyframe-updated' : 'keyframe-created', backupPath, easeWarnings(easeNames, eases)));
        }

        if (found.kind !== 'instance-track') {
          return toolError(`${trackLabel} has type "${String(track.type)}", which these tools do not edit.`);
        }
        const instanceTrack = track as unknown as TimelineInstanceTrack;
        const uid = instanceTrack.worldInstance;

        let located: { instance: Instance; objectType?: ObjectType } | undefined;
        if (entries.length > 0) {
          const result = await requireWorldInstance(uid);
          if (!result.ok) return result.error;
          located = result;
        }

        // Resolve every value before touching the timeline.
        const resolved: Array<{ spec: PropertySpec; existing?: TimelinePropertyTrack; absolute: TimelineValue; relative?: number; ease?: string }> = [];
        for (const [name, input] of entries) {
          const existing = findPropertyTrack(instanceTrack, name)?.propertyTrack;
          const lookup = existing
            ? specForExistingTrack(existing as { property: string; source: { type: string; uid: number | string } }, located!.instance, located!.objectType)
            : resolveTimelineProperty(name, located!.instance, located!.objectType);
          if (!lookup.ok) return toolError(lookup.error);
          const spec = lookup.spec;

          if (!spec.verified) {
            if (typeof input.absolute !== 'number' || input.relative === undefined) {
              return toolError(`Property "${name}" matches no sampled property, so its absolute and relative values cannot be related: supply both "absolute" and "relative" as numbers. ${propertyNameHelp}.`);
            }
            resolved.push({ spec, existing, absolute: input.absolute, relative: input.relative, ease: input.ease });
            continue;
          }

          if (spec.kind === 'number') {
            if (typeof spec.base !== 'number') {
              return toolError(`Cannot read the current value of "${spec.property}" for instance UID ${uid}.`);
            }
            if (input.absolute !== undefined) {
              const problem = checkValue(spec, input.absolute);
              if (problem) return toolError(problem);
              resolved.push({ spec, existing, absolute: input.absolute, ease: input.ease });
            } else if (input.relative !== undefined) {
              resolved.push({ spec, existing, absolute: spec.base + input.relative, ease: input.ease });
            } else {
              return toolError(`Property "${name}" needs an "absolute" or a "relative" value.`);
            }
          } else {
            if (input.relative !== undefined) {
              return toolError(`Property "${name}" is a ${spec.kind === 'color' ? 'color' : spec.kind}; give "absolute" only.`);
            }
            const problem = input.absolute === undefined ? `Property "${name}" needs an "absolute" value.` : checkValue(spec, input.absolute);
            if (problem) return toolError(problem);
            resolved.push({ spec, existing, absolute: input.absolute as TimelineValue, ease: input.ease });
          }
        }

        const { master, existed } = ensureMaster(instanceTrack, args.time, false);
        if (args.ease !== undefined) master.ease = args.ease;
        if (args.enabled !== undefined) master.enabled = args.enabled;
        if (args.tags !== undefined) master.tags = args.tags;

        const createdTracks: string[] = [];
        for (const { spec, existing, absolute, relative, ease } of resolved) {
          let propertyTrack = existing;
          if (!propertyTrack) {
            propertyTrack = createPropertyTrack(spec);
            attachPropertyTrack(instanceTrack, spec, propertyTrack, located!.instance, located!.objectType);
            createdTracks.push(spec.property);
          }
          let keyframe: TimelinePropertyKeyframe;
          if (!spec.verified) {
            const current = propertyTrack.propertyKeyframes.find(kf => sameTime(kf.time, args.time));
            const values = { value: relative as number, rValue: relative as number, aValue: absolute as number };
            if (current) {
              Object.assign(current, values);
              keyframe = current;
            } else {
              keyframe = createPropertyKeyframe(args.time, spec, values);
              propertyTrack.propertyKeyframes.push(keyframe);
              propertyTrack.propertyKeyframes.sort((a, b) => a.time - b.time);
            }
          } else {
            keyframe = setPropertyKeyframe(data, instanceTrack, propertyTrack, spec, args.time, absolute);
          }
          if (ease !== undefined) keyframe.ease = ease;
        }

        const warnings = unverifiedPropertyWarnings(resolved.map(r => r.spec));
        if (createdTracks.length > 0) {
          warnings.push(`Created property track(s) ${createdTracks.join(', ')} on the track for instance UID ${uid}; they hold a keyframe only at the times set so far.`);
        }
        warnings.push(...easeWarnings(easeNames, eases));

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(
          args.timelineName,
          existed ? 'keyframe-updated' : 'keyframe-created',
          backupPath,
          warnings,
        ));
      } catch (error) {
        console.error('[set_keyframe] failed:', error);
        return toolError(`Error setting keyframe: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_keyframe ──────────────────────────────────────

  server.tool(
    'delete_keyframe',
    'Delete the master keyframe at a time and every property keyframe at that time, or with "property" only that one property keyframe of an instance track',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      ...trackSelectorShape,
      time: z.number().describe('Time of the keyframe to delete, in seconds'),
      property: z.string().min(1).max(100).optional().describe('Delete only this property track keyframe of an instance track, leaving the master keyframe in place'),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = selectTrack(data, args.timelineName, args, true);
        if (!found.ok) return found.error;
        const { track } = found.loc;
        const trackLabel = args.trackName !== undefined ? `Track "${args.trackName}"` : `The track for instance UID ${args.instanceUid}`;

        let action: string;
        if (args.property !== undefined) {
          if (found.kind === 'value-track' || found.kind === 'audio-track') {
            return toolError(`${trackLabel} is a ${found.kind}; its property keyframes follow its master keyframes, so delete the master keyframe instead (omit "property").`);
          }
          const located = findPropertyTrack(track, args.property);
          if (!located) {
            return toolError(`Property track "${args.property}" not found on the track for instance UID ${args.instanceUid}.`);
          }
          const keyframes = located.propertyTrack.propertyKeyframes;
          const index = keyframes.findIndex(kf => sameTime(kf.time, args.time));
          if (index === -1) {
            return toolError(`Property track "${args.property}" has no keyframe at time ${args.time}.`);
          }
          keyframes.splice(index, 1);
          action = 'property-keyframe-deleted';
        } else {
          const keyframes = track.keyframes ?? [];
          const index = keyframes.findIndex(kf => sameTime(kf.time, args.time));
          if (index === -1) {
            const times = keyframes.map(kf => kf.time);
            return toolError(`${trackLabel} has no master keyframe at time ${args.time}. Keyframe times: ${times.join(', ')}.`);
          }
          if (keyframes.length <= 1) {
            return toolError(`Refusing to delete the last master keyframe of ${trackLabel.charAt(0).toLowerCase()}${trackLabel.slice(1)}: a track with no keyframes is not a valid track. Use remove_timeline_track to remove the whole track.`);
          }
          keyframes.splice(index, 1);
          for (const { propertyTrack } of listPropertyTracks(track)) {
            if (!Array.isArray(propertyTrack.propertyKeyframes)) continue;
            propertyTrack.propertyKeyframes = propertyTrack.propertyKeyframes.filter(
              kf => !sameTime(kf.time, args.time),
            );
          }
          action = 'keyframe-deleted';
        }

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(args.timelineName, action, backupPath));
      } catch (error) {
        console.error('[delete_keyframe] failed:', error);
        return toolError(`Error deleting keyframe: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_track ─────────────────────────────────────────

  server.tool(
    'update_track',
    'Update the playback properties of one track; value and audio tracks can also be renamed, and an audio track can be pointed at another registered audio file',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      ...trackSelectorShape,
      enabled: z.boolean().optional().describe('Enable/disable the track'),
      ease: z.string().max(100).optional().describe('Track ease name (e.g. "default")'),
      interpolationMode: z.string().max(100).optional().describe('Track interpolation mode (e.g. "default")'),
      resultMode: z.string().max(100).optional().describe('Track result mode (e.g. "default"); instance and audio tracks only'),
      pathMode: z.string().max(100).optional().describe('Track path mode (e.g. "default"); instance tracks only'),
      initialVisibility: z.boolean().optional().describe('Initial visibility applied when the timeline starts'),
      name: z.string().min(1).max(200).optional().describe('New name of a value or audio track'),
      audioFile: z.string().min(1).max(255).optional().describe('Audio track: registered sound or music file name to play'),
      audioFolder: z.enum(['sound', 'music']).optional().describe('Audio track: which project folder holds audioFile (needed only when both do)'),
      audioStartOffset: z.number().min(0).optional().describe('Audio track: offset into the audio file, in seconds'),
      audioTag: z.string().max(200).optional().describe('Audio track: tag given to the playing audio'),
    },
    async (args) => {
      try {
        const hasUpdates = args.enabled !== undefined || args.ease !== undefined ||
          args.interpolationMode !== undefined || args.resultMode !== undefined ||
          args.pathMode !== undefined || args.initialVisibility !== undefined ||
          args.name !== undefined || args.audioFile !== undefined ||
          args.audioStartOffset !== undefined || args.audioTag !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: enabled, ease, interpolationMode, resultMode, pathMode, initialVisibility, name, audioFile, audioStartOffset, audioTag.');
        }

        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = selectTrack(data, args.timelineName, args, true);
        if (!found.ok) return found.error;
        const { track } = found.loc;
        const kind = found.kind;

        const named = kind === 'value-track' || kind === 'audio-track';
        if (args.resultMode !== undefined && (kind === 'value-track' || kind === 'legacy-instance-track')) {
          return toolError(kind === 'value-track'
            ? 'A value track has no result mode.'
            : 'Changing the result mode of an untyped (older) track would leave its stored values stale; open and save the timeline in the Construct 3 editor first.');
        }
        if (args.pathMode !== undefined && named) return toolError(`A ${kind} has no path mode.`);
        if (args.name !== undefined && !named) return toolError('Only value and audio tracks have a name.');
        const audioArgs = args.audioFile !== undefined || args.audioStartOffset !== undefined || args.audioTag !== undefined;
        if (audioArgs && kind !== 'audio-track') return toolError('audioFile, audioStartOffset and audioTag apply to audio tracks only.');

        const warnings: string[] = [];
        if (args.name !== undefined && args.name !== track.name) {
          validateName(args.name);
          if (findTrackByName(data, args.name)) {
            return toolError(`Timeline "${args.timelineName}" already has a value or audio track named "${args.name}".`);
          }
        }
        if (kind === 'audio-track' && audioArgs) {
          const audio = listPropertyTracks(track).find(({ propertyTrack }) => propertyTrack.property === 'audioSource')?.propertyTrack;
          if (!audio) return toolError(`Audio track "${args.trackName}" has no audioSource property track.`);
          const adapter = (audio.sourceAdapter ?? {}) as Record<string, unknown>;
          if (args.audioFile !== undefined) {
            const file = findAudioFile(args.audioFile, args.audioFolder);
            if (!file.ok) return file.error;
            warnings.push(...file.warnings);
            const fresh = createAudioSourceAdapter(file.file, 0, '');
            adapter.audioProjectFile = fresh.audioProjectFile;
            adapter.audioType = fresh.audioType;
          }
          if (args.audioStartOffset !== undefined) adapter.audioStartOffset = args.audioStartOffset;
          if (args.audioTag !== undefined) adapter.audioTag = args.audioTag;
          audio.sourceAdapter = adapter;
        }

        if (args.name !== undefined) track.name = args.name;
        if (args.enabled !== undefined) track.enabled = args.enabled;
        if (args.ease !== undefined) track.ease = args.ease;
        if (args.interpolationMode !== undefined) track.interpolationMode = args.interpolationMode;
        if (args.resultMode !== undefined) {
          track.resultMode = args.resultMode;
          refreshModeValues(data);
        }
        if (args.pathMode !== undefined) track.pathMode = args.pathMode;
        if (args.initialVisibility !== undefined) track.initialVisibility = args.initialVisibility;

        warnings.push(...easeWarnings([args.ease], await loadEases()));
        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(args.timelineName, 'track-updated', backupPath, warnings));
      } catch (error) {
        console.error('[update_track] failed:', error);
        return toolError(`Error updating track: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTimelineTrackTools(deps, toolkit);
  registerTimelineEaseTools(deps, toolkit);
}
