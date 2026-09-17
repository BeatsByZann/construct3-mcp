/**
 * Timeline tools: create_timeline, update_timeline, delete_timeline,
 * list_timelines, get_timeline_details, and the track/keyframe editors
 * add_timeline_track, remove_timeline_track, add_property_track,
 * remove_property_track, set_keyframe, delete_keyframe, update_track.
 *
 * Timeline JSON files live in projectDir/timelines/<name>.json.
 * The project.c3proj timelines container tracks their names.
 * JSON shape validated against production slot-game projects and against a
 * Construct 3 r495.2 timeline with an instance track
 * (test/fixtures/timeline-sample).
 */

import { z } from 'zod';
import { readFile, writeFile, mkdir, copyFile, unlink, rename, stat } from 'fs/promises';
import { dirname } from 'path';
import type { MutationToolDeps } from './shared.js';
import type {
  WriteResult,
  Instance,
  Layout,
  Timeline,
  TimelineFolder,
  TimelineInstanceTrack,
  TimelineKeyframe,
  TimelinePropertyKeyframe,
  TimelinePropertyTrack,
} from '../construct3/types.js';
import { validateName, toolResult, toolError, notFoundError } from './shared.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { collectInstances } from '../construct3/layout-walk.js';

export type { Timeline, TimelineFolder };

// ─── Template factory ──────────────────────────────────────

function timelineFolder(name: string): TimelineFolder {
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
    return resolveProjectPath(projectDir, 'timelines', subfolder, `${name}.json`);
  }
  return resolveProjectPath(projectDir, 'timelines', `${name}.json`);
}

async function readTimelineFile(filePath: string): Promise<Timeline> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as Timeline;
}

async function atomicWriteTimeline(filePath: string, data: Timeline): Promise<void> {
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

async function backupTimeline(filePath: string): Promise<string> {
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

/** Add a timeline name to project.c3proj timelines container. */
async function addTimelineToProject(
  projectPath: string,
  name: string,
  subfolder?: string,
): Promise<void> {
  const content = await readFile(projectPath, 'utf-8');
  const project = JSON.parse(content);

  if (!project.timelines) project.timelines = { items: [], subfolders: [] };
  const container = project.timelines;

  if (subfolder) {
    const parts = subfolder.split('/');
    type TFolder = { name?: string; items: string[]; subfolders: TFolder[] };
    let cur: TFolder = container as TFolder;
    for (const part of parts) {
      let found = (cur.subfolders as TFolder[]).find(sf => sf.name === part);
      if (!found) {
        found = { name: part, items: [], subfolders: [] };
        cur.subfolders.push(found);
      }
      cur = found;
    }
    if (!cur.items.includes(name)) cur.items.push(name);
  } else {
    if (!container.items.includes(name)) container.items.push(name);
  }

  const tmpPath = projectPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(project, null, '\t'), 'utf-8');
  try {
    await rename(tmpPath, projectPath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(projectPath);
      await rename(tmpPath, projectPath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

/** Remove a timeline name from project.c3proj timelines container. */
async function removeTimelineFromProject(projectPath: string, name: string): Promise<void> {
  const content = await readFile(projectPath, 'utf-8');
  const project = JSON.parse(content);

  if (!project.timelines) return;
  const container = project.timelines;

  // Remove from root
  const idx = container.items.indexOf(name);
  if (idx !== -1) {
    container.items.splice(idx, 1);
  } else {
    // Search subfolders recursively
    const removeFromSubfolders = (subfolders: Array<{ name: string; items: string[]; subfolders: unknown[] }>): boolean => {
      for (const sf of subfolders) {
        const i = sf.items.indexOf(name);
        if (i !== -1) { sf.items.splice(i, 1); return true; }
        if (removeFromSubfolders(sf.subfolders as Array<{ name: string; items: string[]; subfolders: unknown[] }>)) return true;
      }
      return false;
    };
    removeFromSubfolders(container.subfolders);
  }

  const tmpPath = projectPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(project, null, '\t'), 'utf-8');
  try {
    await rename(tmpPath, projectPath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(projectPath);
      await rename(tmpPath, projectPath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

/** Collect all timeline names from a timelines container (root + all subfolders). */
function collectTimelineNames(container: { items: string[]; subfolders: unknown[] }): string[] {
  const names: string[] = [...container.items];
  const walk = (subfolders: unknown[]) => {
    for (const sf of subfolders as Array<{ items: string[]; subfolders: unknown[] }>) {
      names.push(...sf.items);
      walk(sf.subfolders);
    }
  };
  walk(container.subfolders);
  return names;
}

// ─── Track and keyframe helpers ────────────────────────────

/** Keyframe times are floats; compare them with a tolerance. */
const TIME_EPSILON = 1e-9;

function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) < TIME_EPSILON;
}

/**
 * Property names whose relative `value` and absolute `aValue` the tools can
 * relate through the instance's layout position. Verified against a Construct
 * r495.2 timeline file: the offsetX track of an instance at x 324 carries
 * `value: 0, rValue: 0, aValue: 324`. Every other property name is accepted
 * as written but is unverified, so its two values must be supplied explicitly.
 */
const POSITION_PROPERTIES: Record<string, 'x' | 'y'> = {
  offsetX: 'x',
  offsetY: 'y',
};

function isPositionProperty(property: string): boolean {
  return Object.prototype.hasOwnProperty.call(POSITION_PROPERTIES, property);
}

/** The instance's own layout value for a position property, or undefined. */
function positionBase(property: string, instance: Instance): number | undefined {
  const axis = POSITION_PROPERTIES[property];
  if (axis === undefined) return undefined;
  const world = instance.world;
  if (!world) return undefined;
  return world[axis];
}

/** Warn about property names no Construct sample confirmed. */
function unverifiedPropertyWarnings(properties: string[]): string[] {
  const unverified = properties.filter(p => !isPositionProperty(p));
  if (unverified.length === 0) return [];
  return [
    `Property name(s) ${unverified.join(', ')} are not verified against a Construct sample ` +
    '(only offsetX and offsetY were observed); check the track in the Construct 3 editor.',
  ];
}

function isInstanceTrack(track: unknown): track is TimelineInstanceTrack {
  return !!track && typeof track === 'object'
    && (track as { type?: unknown }).type === 'instance-track';
}

function findInstanceTrack(data: Timeline, uid: number): TimelineInstanceTrack | undefined {
  return data.tracks.filter(isInstanceTrack).find(track => track.worldInstance === uid);
}

function findPropertyTrack(
  track: TimelineInstanceTrack,
  property: string,
): TimelinePropertyTrack | undefined {
  return track.propertyTracks.find(pt => pt.property === property);
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
  value: number,
  aValue: number,
): TimelinePropertyKeyframe {
  return {
    time,
    enabled: true,
    resultMode: 'default',
    ease: 'default',
    pathMode: 'default',
    value,
    rValue: value,
    aValue,
    addons: [
      {
        id: 'cubic-bezier',
        data: {
          startAnchor: null,
          startEnable: false,
          endAnchor: null,
          endEnable: false,
        },
      },
    ],
  };
}

function createPropertyTrack(property: string, uid: number): TimelinePropertyTrack {
  return {
    property,
    source: { type: 'world-instance', uid },
    enabled: true,
    interpolationMode: 'default',
    resultMode: 'default',
    ease: 'default',
    pathMode: 'default',
    propertyKeyframes: [],
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
      offsetX: 0,
      offsetY: 0,
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

/** Insert or update a property keyframe at `time`, keeping the list sorted. */
function setPropertyKeyframe(
  propertyTrack: TimelinePropertyTrack,
  time: number,
  value: number,
  aValue: number,
): void {
  const existing = propertyTrack.propertyKeyframes.find(kf => sameTime(kf.time, time));
  if (existing) {
    existing.value = value;
    existing.rValue = value;
    existing.aValue = aValue;
    return;
  }
  propertyTrack.propertyKeyframes.push(createPropertyKeyframe(time, value, aValue));
  propertyTrack.propertyKeyframes.sort((a, b) => a.time - b.time);
}

/**
 * The value pair to write for a property whose current state comes from the
 * layout. Position properties resolve to `value: 0` plus the instance's own
 * coordinate; anything else has no observed mapping, so both values are 0 and
 * the caller reports the property as unverified.
 */
function currentValuePair(property: string, instance: Instance): { value: number; aValue: number } {
  const base = positionBase(property, instance);
  if (base === undefined) return { value: 0, aValue: 0 };
  return { value: 0, aValue: base };
}

/** Locate a timeline file at the timelines root or in the transitions subfolder. */
async function loadTimeline(
  projectDir: string,
  name: string,
): Promise<{ filePath: string; data: Timeline } | null> {
  const rootPath = timelineFilePath(projectDir, name);
  try {
    return { filePath: rootPath, data: await readTimelineFile(rootPath) };
  } catch { /* try the transitions subfolder */ }
  const transPath = timelineFilePath(projectDir, name, 'transitions');
  try {
    return { filePath: transPath, data: await readTimelineFile(transPath) };
  } catch {
    return null;
  }
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

// ─── Registration ──────────────────────────────────────────

export function registerTimelineTools({ server, reader, writer }: MutationToolDeps) {
  // ─── list_timelines ───────────────────────────────────────

  server.tool(
    'list_timelines',
    'List all timelines in the project',
    {},
    async () => {
      try {
        const project = reader.getProject();
        const names = collectTimelineNames(project.timelines);
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
    'Get full details of a timeline including its tracks and settings',
    {
      name: z.string().max(200).describe('Timeline name'),
    },
    async (args) => {
      try {
        const project = reader.getProject();
        const names = collectTimelineNames(project.timelines);
        if (!names.includes(args.name)) {
          const hint = names.length > 0 ? `\nAvailable timelines: ${names.slice(0, 5).join(', ')}` : '\nNo timelines found in this project.';
          return toolError(`Timeline "${args.name}" not found.${hint}`);
        }

        const filePath = timelineFilePath(reader.getProjectDir(), args.name);
        let data: Timeline;
        try {
          data = await readTimelineFile(filePath);
        } catch {
          // Try transitions subfolder
          const transPath = timelineFilePath(reader.getProjectDir(), args.name, 'transitions');
          try {
            data = await readTimelineFile(transPath);
          } catch {
            return toolError(`Timeline "${args.name}" is registered in the project but its file could not be read.`);
          }
        }

        return toolResult(data);
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
      subfolder: z.string().max(500).optional().describe('Subfolder within timelines/ (e.g. "transitions")'),
    },
    async (args) => {
      try {
        validateName(args.name);

        const project = reader.getProject();
        const existing = collectTimelineNames(project.timelines);
        if (existing.includes(args.name)) {
          return toolError(`Timeline "${args.name}" already exists.`);
        }

        const data = createTimeline(args.name, args.totalTime);
        data.loop = args.loop;
        data.pingPong = args.pingPong;
        data.repeatCount = args.repeatCount;
        data.startOnLayout = args.startOnLayout;
        data.ignoreSystemTimescale = args.ignoreSystemTimescale;

        const filePath = timelineFilePath(reader.getProjectDir(), args.name, args.subfolder);
        const backupPath = await backupTimeline(filePath);
        await atomicWriteTimeline(filePath, data);

        // Register in project.c3proj (under lock via withProjectLock is internal to writer;
        // we use writer.addToProject which handles the lock — but timelines isn't a standard category.
        // We write project directly here, then reload via reader.
        const projectPath = reader.getProjectPath();
        await backupTimeline(projectPath);
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
      ease: z.string().max(100).optional().describe('Timeline-level ease name (e.g. "noease"); not validated against the project ease list'),
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

        const project = reader.getProject();
        const names = collectTimelineNames(project.timelines);
        if (!names.includes(args.name)) {
          return toolError(`Timeline "${args.name}" not found. Use list_timelines to see available timelines.`);
        }

        const filePath = timelineFilePath(reader.getProjectDir(), args.name);
        let data: Timeline;
        try {
          data = await readTimelineFile(filePath);
        } catch {
          const transPath = timelineFilePath(reader.getProjectDir(), args.name, 'transitions');
          try {
            data = await readTimelineFile(transPath);
          } catch {
            return toolError(`Timeline "${args.name}" file could not be read.`);
          }
        }

        if (args.totalTime !== undefined) data.totalTime = args.totalTime;
        if (args.loop !== undefined) data.loop = args.loop;
        if (args.pingPong !== undefined) data.pingPong = args.pingPong;
        if (args.repeatCount !== undefined) data.repeatCount = args.repeatCount;
        if (args.startOnLayout !== undefined) data.startOnLayout = args.startOnLayout;
        if (args.ignoreSystemTimescale !== undefined) data.ignoreSystemTimescale = args.ignoreSystemTimescale;
        if (args.enabled !== undefined) data.enabled = args.enabled;
        if (args.ease !== undefined) data.ease = args.ease;
        if (args.interpolationMode !== undefined) data.interpolationMode = args.interpolationMode;
        if (args.resultMode !== undefined) data.resultMode = args.resultMode;
        if (args.pathMode !== undefined) data.pathMode = args.pathMode;
        if (args.transformWithSceneGraph !== undefined) data.transformWithSceneGraph = args.transformWithSceneGraph;

        const backupPath = await backupTimeline(filePath);
        await atomicWriteTimeline(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'timeline',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
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
        const project = reader.getProject();
        const names = collectTimelineNames(project.timelines);
        if (!names.includes(args.name)) {
          return toolError(`Timeline "${args.name}" not found. Use list_timelines to see available timelines.`);
        }

        const filePath = timelineFilePath(reader.getProjectDir(), args.name);
        const backupPath = await backupTimeline(filePath);

        try {
          await unlink(filePath);
        } catch (e: unknown) {
          // Try transitions subfolder
          if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') {
            const transPath = timelineFilePath(reader.getProjectDir(), args.name, 'transitions');
            try { await unlink(transPath); } catch { /* already gone */ }
          }
        }

        const projectPath = reader.getProjectPath();
        await backupTimeline(projectPath);
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

  type TimelineLookup =
    | { ok: true; filePath: string; data: Timeline }
    | { ok: false; error: ReturnType<typeof toolError> };

  /** Resolve a registered timeline's file and parsed contents. */
  async function openTimeline(timelineName: string): Promise<TimelineLookup> {
    const project = reader.getProject();
    const names = collectTimelineNames(project.timelines);
    if (!names.includes(timelineName)) {
      return {
        ok: false,
        error: toolError(`Timeline "${timelineName}" not found. Use list_timelines to see available timelines.`),
      };
    }
    const loaded = await loadTimeline(reader.getProjectDir(), timelineName);
    if (!loaded) {
      return {
        ok: false,
        error: toolError(`Timeline "${timelineName}" is registered in the project but its file could not be read.`),
      };
    }
    return { ok: true, filePath: loaded.filePath, data: loaded.data };
  }

  type TrackLookup =
    | { ok: true; track: TimelineInstanceTrack }
    | { ok: false; error: ReturnType<typeof toolError> };

  /** Resolve the instance track animating `uid`. */
  function requireTrack(data: Timeline, timelineName: string, uid: number): TrackLookup {
    const track = findInstanceTrack(data, uid);
    if (!track) {
      const uids = data.tracks.filter(isInstanceTrack).map(t => t.worldInstance);
      const hint = uids.length > 0
        ? ` Tracked instance UIDs: ${uids.join(', ')}.`
        : ' The timeline has no instance tracks.';
      return {
        ok: false,
        error: toolError(`Timeline "${timelineName}" has no track for instance UID ${uid}.${hint} Add one with add_timeline_track.`),
      };
    }
    return { ok: true, track };
  }

  /** Back up the timeline file, then replace it through a temp file and a rename. */
  async function saveTimeline(filePath: string, data: Timeline): Promise<string> {
    const backupPath = await backupTimeline(filePath);
    await atomicWriteTimeline(filePath, data);
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

  /** The world instance with this UID, searched across every layout. */
  async function requireWorldInstance(uid: number): Promise<
    { ok: true; instance: Instance } | { ok: false; error: ReturnType<typeof toolError> }
  > {
    const located = findInstanceAnywhere(await reader.readAllLayouts(), uid);
    if (!located) {
      return {
        ok: false,
        error: toolError(`Instance UID ${uid} was not found in any layout, so the absolute and relative values of a position property cannot be related. Remove the stale track with remove_timeline_track, or set only non-position properties by supplying both their absolute and relative values.`),
      };
    }
    if (!located.instance.world) {
      return {
        ok: false,
        error: toolError(`Instance UID ${uid} in layout "${located.layoutName}" is not a world instance, so it has no position to relate keyframe values to.`),
      };
    }
    return { ok: true, instance: located.instance };
  }

  // ─── add_timeline_track ───────────────────────────────────

  server.tool(
    'add_timeline_track',
    'Add an instance track for one world instance of a layout to a timeline, with master keyframes and one property track per property',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      layoutName: z.string().max(200).describe('Layout that holds the instance'),
      instanceUid: z.number().int().min(0).describe('UID of the world instance to animate'),
      properties: z.array(z.string().min(1).max(100)).max(32).optional().default(['offsetX', 'offsetY'])
        .describe('Property track names (default: ["offsetX","offsetY"]). Only offsetX and offsetY are verified against a Construct sample'),
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

        if (findInstanceTrack(data, args.instanceUid)) {
          return toolError(`Instance UID ${args.instanceUid} already has a track in timeline "${args.timelineName}". Extend it with add_property_track or set_keyframe.`);
        }

        const properties = args.properties;
        const duplicate = properties.find((p, i) => properties.indexOf(p) !== i);
        if (duplicate !== undefined) {
          return toolError(`Duplicate property "${duplicate}" in properties; each property track name must appear once.`);
        }

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
        track.propertyTracks = properties.map(property => {
          const propertyTrack = createPropertyTrack(property, args.instanceUid);
          const pair = currentValuePair(property, instance);
          propertyTrack.propertyKeyframes = times.map(
            time => createPropertyKeyframe(time, pair.value, pair.aValue),
          );
          return propertyTrack;
        });
        data.tracks.push(track);

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(
          args.timelineName,
          'track-added',
          backupPath,
          unverifiedPropertyWarnings(properties),
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
    'Remove the instance track animating one instance, with all of its property tracks and keyframes',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      instanceUid: z.number().int().min(0).describe('UID of the animated instance'),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = requireTrack(data, args.timelineName, args.instanceUid);
        if (!found.ok) return found.error;

        data.tracks.splice(data.tracks.indexOf(found.track), 1);

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
    'Add one property track to an existing instance track, with a keyframe at every existing master keyframe time',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      instanceUid: z.number().int().min(0).describe('UID of the animated instance'),
      property: z.string().min(1).max(100).describe('Property name. Only offsetX and offsetY are verified against a Construct sample'),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = requireTrack(data, args.timelineName, args.instanceUid);
        if (!found.ok) return found.error;
        const { track } = found;

        if (findPropertyTrack(track, args.property)) {
          return toolError(`Property track "${args.property}" already exists on the track for instance UID ${args.instanceUid}. Use set_keyframe to change its values.`);
        }

        let instance: Instance | undefined;
        if (isPositionProperty(args.property)) {
          const located = await requireWorldInstance(args.instanceUid);
          if (!located.ok) return located.error;
          instance = located.instance;
        }

        const propertyTrack = createPropertyTrack(args.property, args.instanceUid);
        const pair = instance
          ? currentValuePair(args.property, instance)
          : { value: 0, aValue: 0 };
        propertyTrack.propertyKeyframes = track.keyframes
          .map(kf => kf.time)
          .sort((a, b) => a - b)
          .map(time => createPropertyKeyframe(time, pair.value, pair.aValue));
        track.propertyTracks.push(propertyTrack);

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(
          args.timelineName,
          'property-track-added',
          backupPath,
          unverifiedPropertyWarnings([args.property]),
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
    'Remove one property track, and all of its keyframes, from an instance track',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      instanceUid: z.number().int().min(0).describe('UID of the animated instance'),
      property: z.string().min(1).max(100).describe('Property track name to remove'),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = requireTrack(data, args.timelineName, args.instanceUid);
        if (!found.ok) return found.error;
        const { track } = found;

        const index = track.propertyTracks.findIndex(pt => pt.property === args.property);
        if (index === -1) {
          const existing = track.propertyTracks.map(pt => pt.property);
          const hint = existing.length > 0
            ? ` Property tracks present: ${existing.join(', ')}.`
            : ' The track has no property tracks.';
          return toolError(`Property track "${args.property}" not found on the track for instance UID ${args.instanceUid}.${hint}`);
        }
        track.propertyTracks.splice(index, 1);

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(args.timelineName, 'property-track-removed', backupPath));
      } catch (error) {
        console.error('[remove_property_track] failed:', error);
        return toolError(`Error removing property track: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── set_keyframe ─────────────────────────────────────────

  server.tool(
    'set_keyframe',
    'Create or update the master keyframe at a time on an instance track, and the per-property keyframes at that time',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      instanceUid: z.number().int().min(0).describe('UID of the animated instance'),
      time: z.number().describe('Keyframe time in seconds, within [0, totalTime]'),
      values: z.record(z.object({
        absolute: z.number().optional().describe('Absolute value of the property (written to aValue)'),
        relative: z.number().optional().describe('Value relative to the instance layout value (written to value and rValue)'),
      })).optional().describe('Per-property values, e.g. { "offsetX": { "absolute": 400 } }. For offsetX/offsetY give absolute or relative and the other is computed from the instance position; for any other property give both, because no mapping was observed'),
      ease: z.string().max(100).optional().describe('Master keyframe ease name (a new keyframe gets "default")'),
      enabled: z.boolean().optional().describe('Master keyframe enabled flag'),
      tags: z.string().max(500).optional().describe('Master keyframe tags string'),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = requireTrack(data, args.timelineName, args.instanceUid);
        if (!found.ok) return found.error;
        const { track } = found;

        if (args.time < 0 || args.time > data.totalTime) {
          return toolError(`Keyframe time ${args.time} is outside the timeline's [0, ${data.totalTime}] range. Raise totalTime with update_timeline first.`);
        }

        const entries = Object.entries(args.values ?? {});
        if (entries.length > 32) {
          return toolError(`Too many properties in values: ${entries.length} (max 32).`);
        }

        let instance: Instance | undefined;
        if (entries.some(([property]) => isPositionProperty(property))) {
          const located = await requireWorldInstance(args.instanceUid);
          if (!located.ok) return located.error;
          instance = located.instance;
        }

        // Resolve every value pair before touching the timeline.
        const resolved: Array<{ property: string; value: number; aValue: number }> = [];
        for (const [property, spec] of entries) {
          if (isPositionProperty(property)) {
            const base = instance ? positionBase(property, instance) : undefined;
            if (base === undefined) {
              return toolError(`Cannot resolve the instance position for property "${property}" of instance UID ${args.instanceUid}.`);
            }
            if (spec.absolute !== undefined) {
              resolved.push({ property, value: spec.absolute - base, aValue: spec.absolute });
            } else if (spec.relative !== undefined) {
              resolved.push({ property, value: spec.relative, aValue: base + spec.relative });
            } else {
              return toolError(`Property "${property}" needs an "absolute" or a "relative" value.`);
            }
          } else {
            if (spec.absolute === undefined || spec.relative === undefined) {
              return toolError(`Property "${property}" is not a verified position property, so its absolute and relative values cannot be related: supply both "absolute" and "relative". Only offsetX and offsetY were observed in a Construct sample.`);
            }
            resolved.push({ property, value: spec.relative, aValue: spec.absolute });
          }
        }

        const existingMaster = track.keyframes.find(kf => sameTime(kf.time, args.time));
        const master = existingMaster ?? createMasterKeyframe(args.time);
        if (!existingMaster) {
          track.keyframes.push(master);
          track.keyframes.sort((a, b) => a.time - b.time);
        }
        if (args.ease !== undefined) master.ease = args.ease;
        if (args.enabled !== undefined) master.enabled = args.enabled;
        if (args.tags !== undefined) master.tags = args.tags;

        const createdTracks: string[] = [];
        for (const { property, value, aValue } of resolved) {
          let propertyTrack = findPropertyTrack(track, property);
          if (!propertyTrack) {
            propertyTrack = createPropertyTrack(property, args.instanceUid);
            track.propertyTracks.push(propertyTrack);
            createdTracks.push(property);
          }
          setPropertyKeyframe(propertyTrack, args.time, value, aValue);
        }

        const warnings = unverifiedPropertyWarnings(resolved.map(r => r.property));
        if (createdTracks.length > 0) {
          warnings.push(`Created property track(s) ${createdTracks.join(', ')} on the track for instance UID ${args.instanceUid}; they hold a keyframe only at the times set so far.`);
        }

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(
          args.timelineName,
          existingMaster ? 'keyframe-updated' : 'keyframe-created',
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
    'Delete the master keyframe at a time and every property keyframe at that time, or with "property" only that one property keyframe',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      instanceUid: z.number().int().min(0).describe('UID of the animated instance'),
      time: z.number().describe('Time of the keyframe to delete, in seconds'),
      property: z.string().min(1).max(100).optional().describe('Delete only this property track keyframe, leaving the master keyframe in place'),
    },
    async (args) => {
      try {
        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = requireTrack(data, args.timelineName, args.instanceUid);
        if (!found.ok) return found.error;
        const { track } = found;

        let action: string;
        if (args.property !== undefined) {
          const propertyTrack = findPropertyTrack(track, args.property);
          if (!propertyTrack) {
            return toolError(`Property track "${args.property}" not found on the track for instance UID ${args.instanceUid}.`);
          }
          const index = propertyTrack.propertyKeyframes.findIndex(kf => sameTime(kf.time, args.time));
          if (index === -1) {
            return toolError(`Property track "${args.property}" has no keyframe at time ${args.time}.`);
          }
          propertyTrack.propertyKeyframes.splice(index, 1);
          action = 'property-keyframe-deleted';
        } else {
          const index = track.keyframes.findIndex(kf => sameTime(kf.time, args.time));
          if (index === -1) {
            const times = track.keyframes.map(kf => kf.time);
            return toolError(`The track for instance UID ${args.instanceUid} has no master keyframe at time ${args.time}. Keyframe times: ${times.join(', ')}.`);
          }
          if (track.keyframes.length <= 1) {
            return toolError(`Refusing to delete the last master keyframe of the track for instance UID ${args.instanceUid}: an instance track with no keyframes is not a valid track. Use remove_timeline_track to remove the whole track.`);
          }
          track.keyframes.splice(index, 1);
          for (const propertyTrack of track.propertyTracks) {
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
    'Update the playback properties of one instance track',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      instanceUid: z.number().int().min(0).describe('UID of the animated instance'),
      enabled: z.boolean().optional().describe('Enable/disable the track'),
      ease: z.string().max(100).optional().describe('Track ease name (e.g. "default")'),
      interpolationMode: z.string().max(100).optional().describe('Track interpolation mode (e.g. "default")'),
      resultMode: z.string().max(100).optional().describe('Track result mode (e.g. "default")'),
      pathMode: z.string().max(100).optional().describe('Track path mode (e.g. "default")'),
      initialVisibility: z.boolean().optional().describe('Initial visibility applied when the timeline starts'),
    },
    async (args) => {
      try {
        const hasUpdates = args.enabled !== undefined || args.ease !== undefined ||
          args.interpolationMode !== undefined || args.resultMode !== undefined ||
          args.pathMode !== undefined || args.initialVisibility !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: enabled, ease, interpolationMode, resultMode, pathMode, initialVisibility.');
        }

        const opened = await openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = requireTrack(data, args.timelineName, args.instanceUid);
        if (!found.ok) return found.error;
        const { track } = found;

        if (args.enabled !== undefined) track.enabled = args.enabled;
        if (args.ease !== undefined) track.ease = args.ease;
        if (args.interpolationMode !== undefined) track.interpolationMode = args.interpolationMode;
        if (args.resultMode !== undefined) track.resultMode = args.resultMode;
        if (args.pathMode !== undefined) track.pathMode = args.pathMode;
        if (args.initialVisibility !== undefined) track.initialVisibility = args.initialVisibility;

        const backupPath = await saveTimeline(filePath, data);
        return toolResult(writeResult(args.timelineName, 'track-updated', backupPath));
      } catch (error) {
        console.error('[update_track] failed:', error);
        return toolError(`Error updating track: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
