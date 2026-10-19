/**
 * Timeline tools: create_timeline, update_timeline, delete_timeline,
 * list_timelines, get_timeline_details, and the toolkit (./timeline-kit.ts)
 * the track and ease tool files share.
 *
 * The project.c3proj timelines container tracks their names. Construct 3
 * mirrors its project-bar folders on disk: a timeline at the root is stored
 * in timelines/<name>.json, one in folder "A" > "B" in
 * timelines/A/B/<name>.json. The container's first-level subfolder without a
 * name is the editor's Transitions folder (see timeline-folders.ts): its items
 * are transitions, the custom eases timelines reference by name, stored in
 * timelines/transitions/<name>.json (see ../construct3/timeline-model.ts).
 * A nameless folder anywhere else is malformed: its names are not listed or
 * resolved, and create_timeline refuses them so they are not registered
 * twice. The timeline tools list transitions but never read, change or
 * delete them; the ease tools (list_eases, update_ease, delete_ease) do.
 * JSON shape confirmed against the timeline kept as `test/fixtures/timeline-sample`.
 * Property rules are in ../construct3/timeline-properties.ts.
 */

import { z } from 'zod';
import { relative, sep } from 'path';
import type { MutationToolDeps } from './shared.js';
import type { Timeline, TimelineFolder, WriteResult } from '../construct3/types.js';
import { newProjectFolder } from '../construct3/project-writer.js';
import { toolResult, toolError, folderCaseClashError } from './shared.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { existingSpelling, findFileIgnoringCase } from '../construct3/atomic-write.js';
import { findFolderPathClash, nameKey } from '../construct3/names.js';
import { parseJsonText } from '../construct3/json-format.js';
import { StaleFileError, type FileState } from '../construct3/disk-state.js';
import {
  TRANSITIONS_DIR,
  isNamelessFolder,
  transitionsFolderIndex,
  type ProjectFolderNode,
} from '../construct3/timeline-folders.js';
import {
  timelineFolder,
  listTracks,
  findTrackByUid,
  findTrackByName,
  trackKind,
  syncTransitionsData,
  easeWarnings,
  audioProjectFilePath,
  type CustomEase,
} from '../construct3/timeline-model.js';
import { listRegisteredFileEntries } from '../construct3/registered-file-entries.js';
import { refreshModeValues, legacyTracksFollowingTimeline, folderModeError } from '../construct3/timeline-result-modes.js';
import { loadCustomEases } from '../construct3/ease-params.js';
import {
  refuse,
  invalidName,
  invalidSubfolder,
  readFailure,
  relativeMessage,
  caseHint,
  writeJsonFile,
  jsonFileText,
  readFileForWrite,
  rollBackToolCall,
  type ChangedFile,
} from './timeline-writes.js';
import {
  type ContainerFolder,
  type ErrorForm,
  type ErrorResult,
  type TimelineLookup,
  type TimelineToolkit,
  type TrackSelection,
  type TrackSelectorArgs,
} from './timeline-kit.js';
import { withProjectSync } from './project-sync.js';
import { registerTimelineInstanceTools } from './timeline-instance-tools.js';
import { registerTimelineTrackTools } from './timeline-track-tools.js';

export type { Timeline, TimelineFolder };

type Writer = MutationToolDeps['writer'];

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

/** A parsed file is a timeline only when it has a `tracks` array; an ease file has none. */
function isTimelineData(data: unknown): data is Timeline {
  return !!data && typeof data === 'object' && Array.isArray((data as Timeline).tracks);
}

// ─── Locating timeline files ───────────────────────────────

interface TimelineLocation {
  kind: 'timeline' | 'transition';
  /** Named project-bar folders from the timelines root, outermost first. */
  folders: string[];
}

type TimelineFolderNode = ProjectFolderNode;

function folderItems(folder: TimelineFolderNode): string[] {
  return Array.isArray(folder.items) ? folder.items.filter((i): i is string => typeof i === 'string') : [];
}

function folderSubfolders(folder: TimelineFolderNode): TimelineFolderNode[] {
  return Array.isArray(folder.subfolders) ? folder.subfolders as TimelineFolderNode[] : [];
}

/** Every item name in a folder and all its subfolders. */
function allFolderItems(folder: TimelineFolderNode, into: Set<string>, depth = 0): void {
  if (depth > 50) return;
  for (const item of folderItems(folder)) into.add(item);
  for (const sub of folderSubfolders(folder)) allFolderItems(sub, into, depth + 1);
}

/**
 * Map every name in the project.c3proj timelines container to where it lives,
 * in project-bar order. Timelines and transitions are kept apart. Names the
 * tools cannot resolve to a file are collected in `unresolved`: those in a
 * nameless folder other than the Transitions folder (malformed, reported by
 * validate_project) and those in folders inside the Transitions folder.
 */
function locateTimelines(container: TimelineFolderNode | undefined): {
  timelines: Map<string, TimelineLocation>;
  transitions: Map<string, TimelineLocation>;
  unresolved: Set<string>;
} {
  const timelines = new Map<string, TimelineLocation>();
  const transitions = new Map<string, TimelineLocation>();
  const unresolved = new Set<string>();
  const transitionsFolder = container ? folderSubfolders(container)[transitionsFolderIndex(container)] : undefined;
  const walk = (folder: TimelineFolderNode, folders: string[]) => {
    for (const item of folderItems(folder)) {
      if (!timelines.has(item)) timelines.set(item, { kind: 'timeline', folders });
    }
    for (const sub of folderSubfolders(folder)) {
      if (sub === transitionsFolder) {
        for (const item of folderItems(sub)) {
          if (!transitions.has(item)) transitions.set(item, { kind: 'transition', folders: [] });
        }
        for (const inner of folderSubfolders(sub)) allFolderItems(inner, unresolved);
      } else if (!isNamelessFolder(sub)) {
        walk(sub, [...folders, sub.name as string]);
      } else {
        allFolderItems(sub, unresolved);
      }
    }
  };
  if (container) walk(container, []);
  return { timelines, transitions, unresolved };
}

function unresolvedRefusal(name: string): string {
  return `"${name}" is registered in project.c3proj in a timelines folder the timeline tools cannot resolve: ` +
    'a folder without a name that is not the editor\'s Transitions folder (only the first unnamed folder directly under timelines is), ' +
    'or a folder inside the Transitions folder. Run validate_project and fix the folder in project.c3proj first.';
}

/** Folders below timelines/ that hold the file for this location. */
function locationDirs(location: TimelineLocation): string[] {
  return location.kind === 'transition' ? [TRANSITIONS_DIR] : location.folders;
}

/** Absolute path of the file for a located name, confined to timelines/. */
function locatedFilePath(projectDir: string, name: string, location: TimelineLocation): string {
  const timelinesDir = resolveProjectPath(projectDir, 'timelines');
  return resolveProjectPath(timelinesDir, ...locationDirs(location), `${name}.json`);
}

/** Project-relative path of the file for a located name, for messages. */
function locatedFileLabel(name: string, location: TimelineLocation): string {
  return ['timelines', ...locationDirs(location), `${name}.json`].join('/');
}

/** Whether two project-bar folder paths are the same folder (names compared ignoring case). */
function sameFolders(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((folder, i) => nameKey(folder) === nameKey(b[i]));
}

function transitionRefusal(name: string): string {
  return `"${name}" is a transition (a custom ease in timelines/${TRANSITIONS_DIR}/), not a timeline. ` +
    'The timeline tools do not read, change or delete transitions; use list_eases, update_ease or delete_ease.';
}

/** Add a timeline name to project.c3proj timelines container. */
async function addTimelineToProject(writer: Writer, name: string, subfolder?: string): Promise<void> {
  await writer.updateProject(project => {
    // The nameless first folder is the editor's Transitions folder, which every saved project has
    if (!project.timelines) project.timelines = { items: [], subfolders: [{ items: [], subfolders: [] }] };
    const container = project.timelines;
    if (subfolder) {
      const parts = subfolder.split('/');
      let cur: ContainerFolder = container as ContainerFolder;
      for (const part of parts) {
        let found = cur.subfolders.find(sf => sf.name === part);
        if (!found) {
          // Same key order as the editor writes (items, subfolders, name)
          found = newProjectFolder(part) as ContainerFolder;
          cur.subfolders.push(found);
        }
        cur = found;
      }
      if (!cur.items.includes(name)) cur.items.push(name);
    } else if (!container.items.includes(name)) {
      container.items.push(name);
    }
  });
}

/**
 * Remove a timeline name from the project.c3proj timelines container, from
 * exactly the named folder it was located in (never from the Transitions folder).
 */
async function removeTimelineFromProject(writer: Writer, name: string, folders: string[]): Promise<void> {
  await writer.updateProject(project => {
    let folder: TimelineFolderNode | undefined = project.timelines;
    for (const folderName of folders) {
      folder = folder && folderSubfolders(folder).find(sf => !isNamelessFolder(sf) && sf.name === folderName);
    }
    const items = folder && Array.isArray(folder.items) ? folder.items as unknown[] : [];
    const idx = items.indexOf(name);
    if (idx === -1) {
      throw new Error(`"${name}" is not registered in ${['timelines', ...folders].join('/')} of project.c3proj`);
    }
    items.splice(idx, 1);
  });
}

type LoadResult =
  | { ok: true; filePath: string; data: Timeline; text: string; state: FileState }
  | {
    ok: false;
    reason: 'unreadable' | 'not-a-timeline';
    filePath: string;
    detail?: string;
    /** The file does not exist. */
    missing?: boolean;
  };

/**
 * Read a located timeline from its file, as the file is spelled on disk, once:
 * its text and the state taken before the text come with the data. A root
 * timeline missing from timelines/ is also looked for in
 * timelines/transitions/, but a file there is used only when it really is a
 * timeline: that directory holds the transitions (custom eases).
 */
async function loadTimeline(projectDir: string, name: string, location: TimelineLocation): Promise<LoadResult> {
  const primary = await existingSpelling(locatedFilePath(projectDir, name, location));
  let data: unknown;
  let read: { text: string; state: FileState } | null = null;
  let detail: string | undefined;
  let missing = false;
  try {
    const file = await readFileForWrite(primary);
    if (file === null) {
      detail = 'ENOENT';
      missing = true;
    } else {
      read = file;
      data = parseJsonText(file.text);
    }
  } catch (e: unknown) {
    detail = readFailure(e);
    missing = detail === 'ENOENT';
  }
  if (read !== null && data !== undefined) {
    return isTimelineData(data)
      ? { ok: true, filePath: primary, data, text: read.text, state: read.state }
      : { ok: false, reason: 'not-a-timeline', filePath: primary };
  }
  if (location.folders.length === 0) {
    const fallback = await existingSpelling(timelineFilePath(projectDir, name, TRANSITIONS_DIR));
    try {
      const file = await readFileForWrite(fallback);
      const other = file === null ? undefined : parseJsonText(file.text);
      if (file !== null && isTimelineData(other)) return { ok: true, filePath: fallback, data: other, text: file.text, state: file.state };
    } catch (e: unknown) {
      // Missing, or not JSON: not there either. Any other failure is that file's own, and is reported
      const reason = readFailure(e);
      if (e instanceof SyntaxError || reason === 'ENOENT') return { ok: false, reason: 'unreadable', filePath: primary, detail, missing };
      return { ok: false, reason: 'unreadable', filePath: fallback, detail: reason, missing: false };
    }
  }
  return { ok: false, reason: 'unreadable', filePath: primary, detail, missing };
}

// ─── Registration ──────────────────────────────────────────

export function registerTimelineTools({ server: mcpServer, reader, writer, idGen }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);

  const projectLabel = (filePath: string) => relative(reader.getProjectDir(), filePath).split(sep).join('/');
  const timelinesContainer = () => reader.getProject().timelines as unknown as ContainerFolder | undefined;
  const timelineNames = () => [...locateTimelines(timelinesContainer()).timelines.keys()];

  /**
   * Where a registered timeline is stored; a transition, a name in an
   * unresolvable folder, an unknown name and a name in another letter case
   * are refused. `fail` is `refuse` for a write tool, `toolError` for a
   * read-only one.
   */
  function findTimeline(
    timelineName: string,
    notFound: () => ErrorResult,
    fail: ErrorForm,
  ): { ok: true; location: TimelineLocation } | { ok: false; error: ErrorResult } {
    const { timelines, transitions, unresolved } = locateTimelines(timelinesContainer());
    const location = timelines.get(timelineName) ?? transitions.get(timelineName);
    if (!location) {
      if (unresolved.has(timelineName)) return { ok: false, error: fail(unresolvedRefusal(timelineName)) };
      const hint = caseHint(timelineName, [...timelines.keys(), ...transitions.keys()]);
      if (hint) return { ok: false, error: fail(`Timeline "${timelineName}" not found. ${hint}`) };
      return { ok: false, error: notFound() };
    }
    if (location.kind === 'transition') return { ok: false, error: fail(transitionRefusal(timelineName)) };
    return { ok: true, location };
  }

  /** A registered timeline read with its text and state (see findTimeline for `fail`). */
  async function resolveTimeline(timelineName: string, notFound: () => ErrorResult, fail: ErrorForm): Promise<TimelineLookup> {
    const found = findTimeline(timelineName, notFound, fail);
    if (!found.ok) return found;
    const projectDir = reader.getProjectDir();
    let loaded: LoadResult;
    try {
      loaded = await loadTimeline(projectDir, timelineName, found.location);
    } catch (e: unknown) {
      return { ok: false, error: fail(`Timeline "${timelineName}": ${relativeMessage(e, projectDir)}`) };
    }
    if (!loaded.ok) {
      const label = projectLabel(loaded.filePath);
      return {
        ok: false,
        error: fail(loaded.reason === 'not-a-timeline'
          ? `Timeline "${timelineName}" is registered in the project but its file ${label} holds no tracks, so it is not a timeline (a custom ease file looks like this; see list_eases).`
          : `Timeline "${timelineName}" is registered in the project but its file ${label} could not be read${loaded.detail ? ` (${loaded.detail})` : ''}.`),
      };
    }
    return { ok: true, filePath: loaded.filePath, data: loaded.data, text: loaded.text, state: loaded.state };
  }

  /** Resolve a registered timeline's file and parsed contents; `fail` words the refusals. */
  function openTimeline(timelineName: string, fail: ErrorForm): Promise<TimelineLookup> {
    return resolveTimeline(timelineName, () =>
      fail(`Timeline "${timelineName}" not found. Use list_timelines to see available timelines.`), fail);
  }

  function loadEases(): Promise<Map<string, CustomEase>> {
    return loadCustomEases(reader.getProjectDir(), timelinesContainer());
  }

  function easeFilePath(name: string): string {
    return resolveProjectPath(reader.getProjectDir(), 'timelines', TRANSITIONS_DIR, `${name}.json`);
  }

  /** The text a timeline file is written with once its custom-ease copies are in step with `eases`. */
  async function timelineText(filePath: string, data: Timeline, eases: Map<string, CustomEase>): Promise<string> {
    syncTransitionsData(data, eases);
    return jsonFileText(filePath, data, reader.getProjectPath());
  }

  /** Sync the timeline's custom-ease copies and write it; the write is refused when the file is no longer in the `expected` state. */
  async function saveTimeline(filePath: string, data: Timeline, expected: FileState): Promise<string | undefined> {
    syncTransitionsData(data, await loadEases());
    return writeJsonFile(writer, filePath, data, reader.getProjectPath(), expected);
  }

  /** Save an opened timeline; a file changed on disk since it was read is refused with the writer's text. */
  async function save(
    opened: Extract<TimelineLookup, { ok: true }>,
  ): Promise<{ ok: true; backupPath: string | undefined } | { ok: false; error: ErrorResult }> {
    try {
      return { ok: true, backupPath: await saveTimeline(opened.filePath, opened.data, opened.state) };
    } catch (error) {
      if (error instanceof StaleFileError) return { ok: false, error: toolError(relativeMessage(error, reader.getProjectDir())) };
      throw error;
    }
  }

  function writeResult(
    timelineName: string,
    action: string,
    backupPath: string | undefined,
    warnings: string[] = [],
  ): WriteResult {
    const result: WriteResult = {
      success: true,
      entity: timelineName,
      category: 'timeline',
      action,
      ...(backupPath === undefined ? {} : { backupFile: backupPath }),
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  function selectTrack(data: Timeline, timelineName: string, args: TrackSelectorArgs, allowLegacy: boolean): TrackSelection {
    if ((args.instanceUid === undefined) === (args.trackName === undefined)) {
      return { ok: false, error: refuse('Give exactly one of instanceUid (an instance track) or trackName (a value or audio track).') };
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
          error: refuse(`Timeline "${timelineName}" has no track for instance UID ${uid}.${hint} Add one with add_timeline_track.`),
        };
      }
      const kind = trackKind(loc.track);
      if (kind === 'legacy-instance-track' && !allowLegacy) {
        return {
          ok: false,
          error: refuse(`The track for instance UID ${uid} in timeline "${timelineName}" is an untyped track saved by an older Construct release. ` +
            'This tool would have to rewrite its keyframe values, and no fixture shows how Construct upgrades them; open and save the timeline in the Construct 3 editor first.'),
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
      return { ok: false, error: refuse(`Timeline "${timelineName}" has no value or audio track named "${name}".${hint}`) };
    }
    return { ok: true, loc, kind: trackKind(loc.track) };
  }

  /**
   * A registered sound or music file by name, with the audioProjectFilePath
   * Construct would store for it when the project's export structure is
   * known. Refused when the name is not registered or is registered in both
   * families and `folder` does not choose.
   */
  function findAudioFile(name: string, folder?: 'sound' | 'music') {
    const project = reader.getProject();
    const folders: Array<'sound' | 'music'> = folder ? [folder] : ['sound', 'music'];
    const matches: Array<{ entry: Record<string, unknown>; audioType: 'sound' | 'music'; subfolder?: string }> = [];
    for (const f of folders) {
      for (const { entry, subfolder } of listRegisteredFileEntries(project, f)) {
        if (entry.name === name) matches.push({ entry: entry as unknown as Record<string, unknown>, audioType: f, subfolder });
      }
    }
    if (matches.length === 0) {
      return {
        ok: false as const,
        error: refuse(`Audio file "${name}" is not registered in the project's ${folders.join(' or ')} files. Import it into Sounds or Music in the Construct 3 editor first.`),
      };
    }
    if (matches.length > 1) {
      const where = matches.map(m => `${m.audioType}${m.subfolder ? '/' + m.subfolder : ''}`).join(', ');
      return {
        ok: false as const,
        error: refuse(`Audio file "${name}" is registered more than once (${where}); pass audioFolder to choose sound or music.`),
      };
    }
    const warnings: string[] = [];
    const type = matches[0].entry.type;
    if (typeof type !== 'string' || !type.startsWith('audio/')) {
      warnings.push(`"${name}" is registered with type "${String(type)}", not an audio type.`);
    }
    const structure = (project as unknown as { properties?: { exportFileStructure?: unknown } }).properties?.exportFileStructure;
    const path = audioProjectFilePath(name, structure, matches[0].subfolder);
    if (path === undefined) {
      warnings.push(`The project's export file structure is ${structure === undefined ? 'not set' : `"${String(structure)}"`}, and the path Construct would store for an audio file in it is not known here, so no audioProjectFilePath was written; check the track in the Construct 3 editor.`);
    }
    return { ok: true as const, file: { entry: matches[0].entry, audioType: matches[0].audioType, path }, warnings };
  }

  async function allTimelines() {
    const timelines: Array<{ name: string; filePath: string; data: Timeline; text: string; state: FileState }> = [];
    const unreadable: string[] = [];
    for (const name of timelineNames()) {
      const opened = await openTimeline(name, toolError);
      if (opened.ok) timelines.push({ name, filePath: opened.filePath, data: opened.data, text: opened.text, state: opened.state });
      else unreadable.push(name);
    }
    return { timelines, unreadable };
  }

  /** The toolkit the track and ease tool files are registered with. */
  const kit: TimelineToolkit = {
    openTimeline,
    saveTimeline,
    save,
    timelineText,
    writeResult,
    selectTrack,
    loadEases,
    allTimelines,
    timelineNames,
    easeFilePath,
    projectContainer: timelinesContainer,
    findAudioFile,
  };

  // ─── list_timelines ───────────────────────────────────────

  server.tool(
    'list_timelines',
    'List all timelines in the project (root and subfolders). Transitions (custom eases) are listed separately; list_eases describes them.',
    {},
    async () => {
      try {
        const { timelines, transitions } = locateTimelines(timelinesContainer());
        const names = [...timelines.keys()];
        return toolResult({ timelines: names, count: names.length, transitions: [...transitions.keys()] });
      } catch (error) {
        console.error('[list_timelines] failed:', error);
        return toolError(`Error listing timelines: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );

  // ─── get_timeline_details ─────────────────────────────────

  server.tool(
    'get_timeline_details',
    'Get full details of a timeline including its tracks and settings (the raw file)',
    {
      name: z.string().max(200).describe('Timeline name'),
    },
    async (args) => {
      try {
        const opened = await resolveTimeline(args.name, () => {
          const names = timelineNames();
          const hint = names.length > 0 ? `\nAvailable timelines: ${names.slice(0, 5).join(', ')}` : '\nNo timelines found in this project.';
          return toolError(`Timeline "${args.name}" not found.${hint}`);
        }, toolError);
        if (!opened.ok) return opened.error;
        return toolResult(opened.data);
      } catch (error) {
        console.error('[get_timeline_details] failed:', error);
        return toolError(`Error getting timeline details: ${relativeMessage(error, reader.getProjectDir())}`);
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
      subfolder: z.string().max(500).optional().describe('Project-bar folder within timelines/, "/"-separated, stored as the same subfolder on disk (e.g. "UI" or "Cutscenes/Intro"). "transitions" is refused: Construct keeps custom eases (transitions) in timelines/transitions/'),
    },
    async (args) => {
      try {
        const nameProblem = invalidName(args.name);
        if (nameProblem) return refuse(nameProblem);
        if (args.subfolder) {
          const subfolderProblem = invalidSubfolder(args.subfolder);
          if (subfolderProblem) return refuse(subfolderProblem);
          if (args.subfolder.split('/')[0].toLowerCase() === TRANSITIONS_DIR) {
            return refuse(`Subfolder "${args.subfolder}" is refused: Construct stores custom eases (transitions) in timelines/${TRANSITIONS_DIR}/, so a timeline file there would sit among the ease files. Choose another folder name.`);
          }
        }

        const container = timelinesContainer();
        const { timelines, transitions, unresolved } = locateTimelines(container);
        if (timelines.has(args.name)) {
          return refuse(`Timeline "${args.name}" already exists.`);
        }
        if (transitions.has(args.name)) {
          return refuse(`"${args.name}" is already the name of a transition (custom ease) in this project; choose another timeline name.`);
        }
        if (unresolved.has(args.name)) {
          return refuse(`${unresolvedRefusal(args.name)} Creating it again would register the name twice.`);
        }
        if (args.subfolder) {
          const folderClash = findFolderPathClash(container, args.subfolder);
          if (folderClash) return refuse(folderCaseClashError(args.subfolder, folderClash));
        }

        // The editor compares timeline names exactly (projectResources.js r495.2),
        // so a case variant in another folder is allowed, with a note. In the same
        // folder both would be stored in one file on Windows and macOS.
        const folders = args.subfolder ? args.subfolder.split('/') : [];
        const warnings: string[] = [];
        for (const [existing, location] of [...timelines, ...transitions]) {
          if (nameKey(existing) !== nameKey(args.name)) continue;
          const existingFile = locatedFileLabel(existing, location);
          if (location.kind === 'timeline' && sameFolders(location.folders, folders)) {
            return refuse(
              `"${args.name}" differs only in case from the existing timeline "${existing}" in the same folder. ` +
              `On Windows and macOS both names are the same file (${existingFile}), which creating this timeline would overwrite. Choose a different name.`,
            );
          }
          warnings.push(
            `"${args.name}" differs only in case from the existing ${location.kind} "${existing}" (${existingFile}). ` +
            'Construct 3 compares timeline names exactly and the files are in different folders, so both are kept.',
          );
        }

        const data = createTimeline(args.name, args.totalTime);
        data.loop = args.loop;
        data.pingPong = args.pingPong;
        data.repeatCount = args.repeatCount;
        data.startOnLayout = args.startOnLayout;
        data.ignoreSystemTimescale = args.ignoreSystemTimescale;

        // Never replace a file on create, also not one whose name differs only in case
        const filePath = timelineFilePath(reader.getProjectDir(), args.name, args.subfolder);
        const onDisk = await findFileIgnoringCase(filePath);
        if (onDisk) {
          return refuse(
            `The file ${projectLabel(onDisk)} already exists: it is not a registered timeline, or it is registered under a name ` +
            'that differs only in case. It was left unchanged. Choose another name, or, if the file is a leftover of a ' +
            'deleted timeline, check it and remove it first.',
          );
        }
        // project.c3proj changed on disk since it was loaded: refused before any write
        await writer.assertProjectFileCurrent();
        const changed: ChangedFile[] = [{ path: filePath, before: null }];
        try {
          // null: the file must still be absent; one created since the check above is refused, not overwritten
          await writeJsonFile(writer, filePath, data, reader.getProjectPath(), null);
          await addTimelineToProject(writer, args.name, args.subfolder);
        } catch (error) {
          return toolError(`Error creating timeline: ${await rollBackToolCall(writer, reader.getProjectDir(), error, changed)}`);
        }
        await reader.reloadProject();

        return toolResult(writeResult(args.name, 'created', undefined, warnings));
      } catch (error) {
        console.error('[create_timeline] failed:', error);
        return toolError(`Error creating timeline: ${relativeMessage(error, reader.getProjectDir())}`);
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
          return refuse('No updates provided. Specify at least one of: totalTime, loop, pingPong, repeatCount, startOnLayout, ignoreSystemTimescale, enabled, ease, interpolationMode, resultMode, pathMode, transformWithSceneGraph.');
        }

        // Read and write back the one file the timeline is stored in
        const opened = await openTimeline(args.name, refuse);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        if (args.resultMode !== undefined && args.resultMode !== data.resultMode) {
          const legacy = legacyTracksFollowingTimeline(data);
          if (legacy.length > 0) {
            return refuse(`The untyped (older) track(s) for instance UID ${legacy.join(', ')} take their result mode from the timeline, and changing it would leave their stored values stale. Open and save the timeline in the Construct 3 editor first.`);
          }
          for (const loc of listTracks(data)) {
            if (trackKind(loc.track) !== 'instance-track') continue;
            const problem = folderModeError(data, loc);
            if (problem) return refuse(problem);
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
        if (args.resultMode !== undefined) {
          data.resultMode = args.resultMode;
          refreshModeValues(data);
        }
        if (args.pathMode !== undefined) data.pathMode = args.pathMode;
        if (args.transformWithSceneGraph !== undefined) data.transformWithSceneGraph = args.transformWithSceneGraph;

        const warnings = easeWarnings([args.ease], await loadEases());
        let backupPath: string | undefined;
        try {
          backupPath = await saveTimeline(filePath, data, opened.state);
        } catch (error) {
          // The writer's text says the file was not written and the change on disk is kept
          if (error instanceof StaleFileError) return toolError(relativeMessage(error, reader.getProjectDir()));
          throw error;
        }
        return toolResult(writeResult(args.name, 'updated', backupPath, warnings));
      } catch (error) {
        console.error('[update_timeline] failed:', error);
        return toolError(`Error updating timeline: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );

  // ─── delete_timeline ──────────────────────────────────────

  server.tool(
    'delete_timeline',
    'Delete a timeline: backs up its file to <file>.bak, deletes the file and removes the timeline from project.c3proj. '
      + 'A registered timeline whose file is missing is only removed from project.c3proj.',
    {
      name: z.string().max(200).describe('Timeline name to delete'),
    },
    async (args) => {
      try {
        const found = findTimeline(args.name, () =>
          refuse(`Timeline "${args.name}" not found. Use list_timelines to see available timelines.`), refuse);
        if (!found.ok) return found.error;
        const { location } = found;
        const projectDir = reader.getProjectDir();

        // Only delete a file that really is this timeline; a transition (custom
        // ease) file of the same name in timelines/transitions/ is left alone.
        let loaded: LoadResult;
        try {
          loaded = await loadTimeline(projectDir, args.name, location);
        } catch (e: unknown) {
          // A registered name that resolves outside timelines/ is refused before anything is touched
          return refuse(`Timeline "${args.name}": ${relativeMessage(e, projectDir)}`);
        }
        if (!loaded.ok && loaded.reason === 'not-a-timeline') {
          return refuse(`Timeline "${args.name}" is registered but its file ${projectLabel(loaded.filePath)} holds no tracks, so it was not deleted. Check it with get_timeline_details.`);
        }
        if (!loaded.ok && !loaded.missing) {
          return refuse(`Timeline "${args.name}" is registered but its file ${projectLabel(loaded.filePath)} could not be read (${loaded.detail ?? 'unreadable'}), so it was not deleted. Check it with get_timeline_details.`);
        }

        // project.c3proj changed on disk since it was loaded: refused before any change
        await writer.assertProjectFileCurrent();
        const filePath = loaded.filePath;
        const fileLabel = projectLabel(filePath);
        const changed: ChangedFile[] = loaded.ok ? [{ path: filePath, before: loaded.text }] : [];
        let backupPath: string | undefined;
        try {
          // The state read for the lookup: a timeline saved since is refused under the file's lock, not deleted
          backupPath = await writer.deleteFile(filePath, { expected: loaded.ok ? loaded.state : null });
          await removeTimelineFromProject(writer, args.name, location.folders);
        } catch (error) {
          return toolError(`Error deleting timeline: ${await rollBackToolCall(writer, projectDir, error, changed)}`);
        }
        await reader.reloadProject();

        if (backupPath === undefined) {
          // A registration whose file is gone: only the registration was removed
          return toolResult(writeResult(args.name, 'deregistered', undefined, [
            `The file ${fileLabel} was not found, so no file was removed; "${args.name}" was only removed from project.c3proj.`,
          ]));
        }
        return toolResult(writeResult(args.name, 'deleted', backupPath));
      } catch (error) {
        console.error('[delete_timeline] failed:', error);
        return toolError(`Error deleting timeline: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );

  registerTimelineInstanceTools({ server, reader, writer, idGen }, kit);
  registerTimelineTrackTools({ server, reader, writer, idGen }, kit);
}
