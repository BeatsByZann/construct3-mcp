/**
 * Timeline track tools beyond instance tracks: list_timeline_tracks,
 * add_value_track, add_audio_track, add_timeline_folder,
 * rename_timeline_folder, delete_timeline_folder and move_timeline_track.
 * Registered from registerTimelineTools, whose toolkit supplies file access
 * and track selection. The shapes are documented in
 * ../construct3/timeline-model.ts and pinned by the fixtures.
 *
 * Only track folders (`tracksRoot`) are edited. The one kind of
 * property-track folder the fixtures hold is created by the editor for
 * behavior property tracks and carries `ownerId: "behavior"` /
 * `ownerUid: <behavior name>`; no fixture holds a user-made property-track
 * folder, so those folders are read (tools find property tracks inside them)
 * but never created or changed.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Timeline, TimelineFolder } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import { StaleFileError } from '../construct3/disk-state.js';
import {
  timelineFolder,
  isTimelineFolder,
  findFolder,
  splitFolderPath,
  findTrackByName,
  listTracks,
  summarizeTracks,
  trackKind,
  folderChainResultMode,
  createValueTrack,
  createValueKeyframe,
  createAudioTrack,
  createPlainMasterKeyframe,
  easeWarnings,
  type AnyTrack,
} from '../construct3/timeline-model.js';
import { refuse, invalidName, relativeMessage } from './timeline-writes.js';
import { trackSelectorShape, type ErrorResult, type TimelineLookup, type TimelineToolkit } from './timeline-kit.js';
import { withProjectSync } from './project-sync.js';

/** An opened timeline: the successful form of a lookup. */
type OpenedTimeline = Extract<TimelineLookup, { ok: true }>;

const folderPathSchema = z.string().max(500)
  .describe('Slash-separated track folder path, e.g. "Doors" or "Doors/Left"; "" is the root');

/** The problem with a folder name, or null for a usable one. */
function checkFolderName(name: string): string | null {
  if (name.length === 0 || name.length > 200) return 'Folder names must be 1 to 200 characters.';
  if (name.includes('/')) return 'Folder names cannot contain "/".';
  return null;
}

/**
 * Register the value track, audio track and track folder tools.
 * @param deps The server, reader, writer and id generator.
 * @param kit The toolkit registerTimelineTools builds: timeline access, saving and track selection.
 */
export function registerTimelineTrackTools(deps: MutationToolDeps, kit: TimelineToolkit): void {
  const server = withProjectSync(deps.server, deps.reader);
  const { reader } = deps;

  /** Save the timeline; a file changed on disk since it was read is refused with the writer's text. */
  async function save(
    opened: OpenedTimeline,
  ): Promise<{ ok: true; backupPath: string | undefined } | { ok: false; error: ErrorResult }> {
    try {
      return { ok: true, backupPath: await kit.saveTimeline(opened.filePath, opened.data, opened.state) };
    } catch (error) {
      if (error instanceof StaleFileError) return { ok: false, error: toolError(relativeMessage(error, reader.getProjectDir())) };
      throw error;
    }
  }

  /** The timeline's track root folder, created when an old file lacks it. */
  function trackRoot(data: Timeline): TimelineFolder {
    if (!isTimelineFolder(data.tracksRoot)) data.tracksRoot = timelineFolder('Track Folder');
    return data.tracksRoot;
  }

  /** The track folder at `path`, or a refusal that lists the folders there are. */
  function requireFolder(
    root: TimelineFolder,
    path: string,
  ): { ok: true; folder: TimelineFolder } | { ok: false; error: ErrorResult } {
    const folder = findFolder(root, path);
    if (!folder) {
      const names: string[] = [];
      const walk = (f: TimelineFolder, prefix: string) => {
        for (const sf of f.subfolders as unknown[]) {
          if (!isTimelineFolder(sf)) continue;
          const p = prefix ? `${prefix}/${sf.name}` : sf.name;
          names.push(`"${p}"`);
          walk(sf, p);
        }
      };
      walk(root, '');
      return {
        ok: false,
        error: refuse(`No track folder "${path}".${names.length > 0 ? ` Folders: ${names.join(', ')}.` : ' There are no folders yet; create one with add_timeline_folder.'}`),
      };
    }
    return { ok: true, folder };
  }

  /** A refusal when a keyframe time lies outside the timeline, or null. */
  function checkTimes(data: Timeline, times: number[]): ErrorResult | null {
    const outOfRange = times.find(t => t < 0 || t > data.totalTime);
    if (outOfRange === undefined) return null;
    return refuse(`Keyframe time ${outOfRange} is outside the timeline's [0, ${data.totalTime}] range. Raise totalTime with update_timeline first.`);
  }

  /** Put a new track at the root (`tracks`) or into a track folder. */
  function placeTrack(data: Timeline, track: AnyTrack, folder: string | undefined): ErrorResult | null {
    if (!folder) {
      data.tracks.push(track);
      return null;
    }
    const target = requireFolder(trackRoot(data), folder);
    if (!target.ok) return target.error;
    target.folder.items.push(track);
    return null;
  }

  // ─── list_timeline_tracks ─────────────────────────────────

  server.tool(
    'list_timeline_tracks',
    'Summarize every track of a timeline: kind (instance-track, value-track, audio-track, or legacy-instance-track for untyped tracks from older releases), instance UID or name, track folder, keyframe times and property tracks',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
    },
    async (args) => {
      try {
        const opened = await kit.openTimeline(args.timelineName, toolError);
        if (!opened.ok) return opened.error;
        const tracks = summarizeTracks(opened.data);
        return toolResult({ timeline: args.timelineName, tracks, count: tracks.length });
      } catch (error) {
        console.error('[list_timeline_tracks] failed:', error);
        return toolError(`Error listing timeline tracks: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );

  // ─── add_value_track ──────────────────────────────────────

  server.tool(
    'add_value_track',
    'Add a value track (a named number animated over time, read at runtime by name) with one keyframe per given time',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      name: z.string().min(1).max(200).describe('Track name, unique among the timeline\'s value and audio tracks'),
      keyframes: z.array(z.object({
        time: z.number().min(0).describe('Keyframe time in seconds, within [0, totalTime]'),
        value: z.number().describe('Value at this time'),
        ease: z.string().max(100).optional().describe('Ease of the value keyframe (default: "default")'),
      })).min(1).max(200).optional().default([{ time: 0, value: 0 }])
        .describe('Keyframes (default: one keyframe of value 0 at time 0)'),
      folder: z.string().max(500).optional().describe('Track folder to put the track in (default: the root)'),
    },
    async (args) => {
      try {
        const nameProblem = invalidName(args.name);
        if (nameProblem) return refuse(nameProblem);
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        if (findTrackByName(data, args.name)) {
          return refuse(`Timeline "${args.timelineName}" already has a value or audio track named "${args.name}".`);
        }
        const times = args.keyframes.map(k => k.time);
        if (new Set(times).size !== times.length) return refuse('Each keyframe time may appear once.');
        const rangeError = checkTimes(data, times);
        if (rangeError) return rangeError;

        const track = createValueTrack(args.name, reader.getProject().uniqueId);
        const sorted = [...args.keyframes].sort((a, b) => a.time - b.time);
        track.keyframes = sorted.map(k => createPlainMasterKeyframe(k.time));
        track.propertyTracks![0].propertyKeyframes = sorted.map(k => createValueKeyframe(k.time, k.value, k.ease));

        const placeError = placeTrack(data, track, args.folder);
        if (placeError) return placeError;

        const warnings = easeWarnings(args.keyframes.map(k => k.ease), await kit.loadEases());
        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(args.timelineName, 'value-track-added', saved.backupPath, warnings));
      } catch (error) {
        console.error('[add_value_track] failed:', error);
        return toolError(`Error adding value track: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );

  // ─── add_audio_track ──────────────────────────────────────

  server.tool(
    'add_audio_track',
    'Add an audio track that plays a sound or music file registered in the project. The track follows the shape of an audio track saved by Construct r495.2; check the result in the Construct 3 editor',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      audioFile: z.string().min(1).max(255).describe('File name of a registered sound or music file, e.g. "Theme.webm"'),
      audioFolder: z.enum(['sound', 'music']).optional().describe('Project folder holding audioFile (needed only when both hold that name)'),
      name: z.string().min(1).max(200).optional().describe('Track name (default: "Audio Track N", the next free number)'),
      audioStartOffset: z.number().min(0).optional().default(0).describe('Offset into the audio file, in seconds (default: 0)'),
      audioTag: z.string().max(200).optional().default('').describe('Tag given to the playing audio (default: empty)'),
      keyframeTimes: z.array(z.number().min(0)).min(1).max(200).optional().default([0])
        .describe('Master keyframe times in seconds (default: [0])'),
      folder: z.string().max(500).optional().describe('Track folder to put the track in (default: the root)'),
    },
    async (args) => {
      try {
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const file = kit.findAudioFile(args.audioFile, args.audioFolder);
        if (!file.ok) return file.error;

        let name = args.name;
        if (name !== undefined) {
          const nameProblem = invalidName(name);
          if (nameProblem) return refuse(nameProblem);
        }
        if (name === undefined) {
          let n = 1;
          while (findTrackByName(data, `Audio Track ${n}`)) n++;
          name = `Audio Track ${n}`;
        } else if (findTrackByName(data, name)) {
          return refuse(`Timeline "${args.timelineName}" already has a value or audio track named "${name}".`);
        }

        const times = [...new Set(args.keyframeTimes)].sort((a, b) => a - b);
        const rangeError = checkTimes(data, times);
        if (rangeError) return rangeError;
        // An audio track saved by the editor starts with a keyframe at 0, and a
        // lone keyframe written at 1s was moved back to 0 on load (r495.2).
        if (times[0] !== 0) {
          return refuse('An audio track needs its first keyframe at time 0 (Construct moves it there on load). Include 0 in keyframeTimes.');
        }

        const track = createAudioTrack(name, reader.getProject().uniqueId, file.file, args.audioStartOffset, args.audioTag);
        track.keyframes = times.map(t => createPlainMasterKeyframe(t));

        const placeError = placeTrack(data, track, args.folder);
        if (placeError) return placeError;

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult({ ...kit.writeResult(args.timelineName, 'audio-track-added', saved.backupPath, file.warnings), trackName: name });
      } catch (error) {
        console.error('[add_audio_track] failed:', error);
        return toolError(`Error adding audio track: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );

  // ─── add_timeline_folder ──────────────────────────────────

  server.tool(
    'add_timeline_folder',
    'Create a track folder in a timeline',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      name: z.string().min(1).max(200).describe('Folder name, unique among its sibling folders'),
      parentFolder: folderPathSchema.optional().describe('Folder to create it in (default: the root folder)'),
    },
    async (args) => {
      try {
        const nameProblem = checkFolderName(args.name);
        if (nameProblem) return refuse(nameProblem);
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const parent = requireFolder(trackRoot(data), args.parentFolder ?? '');
        if (!parent.ok) return parent.error;
        if ((parent.folder.subfolders as unknown[]).some(sf => isTimelineFolder(sf) && sf.name === args.name)) {
          return refuse(`A track folder named "${args.name}" already exists there.`);
        }
        parent.folder.subfolders.push(timelineFolder(args.name));

        const warnings = splitFolderPath(args.parentFolder).length > 0
          ? ['No fixture holds a track folder nested inside another folder, so how Construct stores one is not known here; check the timeline in the Construct 3 editor.']
          : [];
        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(args.timelineName, 'folder-added', saved.backupPath, warnings));
      } catch (error) {
        console.error('[add_timeline_folder] failed:', error);
        return toolError(`Error adding timeline folder: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );

  // ─── rename_timeline_folder ───────────────────────────────

  server.tool(
    'rename_timeline_folder',
    'Rename a track folder',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      folder: folderPathSchema.describe('Path of the folder to rename'),
      newName: z.string().min(1).max(200).describe('New folder name'),
    },
    async (args) => {
      try {
        const nameProblem = checkFolderName(args.newName);
        if (nameProblem) return refuse(nameProblem);
        const parts = splitFolderPath(args.folder);
        if (parts.length === 0) return refuse('The root folder cannot be renamed.');
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const root = trackRoot(data);
        const target = requireFolder(root, args.folder);
        if (!target.ok) return target.error;
        const parent = findFolder(root, parts.slice(0, -1).join('/'))!;
        if ((parent.subfolders as unknown[]).some(sf => sf !== target.folder && isTimelineFolder(sf) && sf.name === args.newName)) {
          return refuse(`A track folder named "${args.newName}" already exists there.`);
        }
        target.folder.name = args.newName;

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(args.timelineName, 'folder-renamed', saved.backupPath));
      } catch (error) {
        console.error('[rename_timeline_folder] failed:', error);
        return toolError(`Error renaming timeline folder: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );

  // ─── delete_timeline_folder ───────────────────────────────

  server.tool(
    'delete_timeline_folder',
    'Delete a track folder. Its tracks and subfolders move to the parent folder unless deleteContents is true',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      folder: folderPathSchema.describe('Path of the folder to delete'),
      deleteContents: z.boolean().optional().default(false)
        .describe('Also delete the tracks and subfolders inside it (default: false, which moves them to the parent)'),
    },
    async (args) => {
      try {
        const parts = splitFolderPath(args.folder);
        if (parts.length === 0) return refuse('The root folder cannot be deleted.');
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const root = trackRoot(data);
        const target = requireFolder(root, args.folder);
        if (!target.ok) return target.error;
        const parentPath = parts.slice(0, -1).join('/');
        const parent = findFolder(root, parentPath)!;

        const warnings: string[] = [];
        const itemCount = target.folder.items.length;
        const subCount = (target.folder.subfolders as unknown[]).length;
        // The result mode in force for each track before its folder is promoted (a value track is exempt, as in move_timeline_track)
        const modeBefore = new Map<AnyTrack, string | undefined>();
        if (!args.deleteContents) {
          for (const loc of listTracks(data)) {
            if (trackKind(loc.track) !== 'value-track') modeBefore.set(loc.track, folderChainResultMode(data.tracksRoot, loc.folderPath));
          }
          // Tracks at the root live in `tracks`, not in the root folder's items.
          const rootList = parentPath === '' ? data.tracks : parent.items;
          for (const sf of target.folder.subfolders as unknown[]) {
            if (isTimelineFolder(sf) && (parent.subfolders as unknown[]).some(other => isTimelineFolder(other) && other !== target.folder && other.name === sf.name)) {
              return refuse(`Cannot move subfolder "${sf.name}" up: the parent already has a folder of that name. Rename one first or pass deleteContents.`);
            }
          }
          rootList.push(...target.folder.items);
          parent.subfolders.push(...(target.folder.subfolders as unknown[]));
          if (itemCount + subCount > 0) {
            warnings.push(`Moved ${itemCount} item(s) and ${subCount} subfolder(s) to ${parentPath ? `"${parentPath}"` : 'the root'}.`);
          }
        } else if (itemCount + subCount > 0) {
          warnings.push(`Deleted ${itemCount} item(s) and ${subCount} subfolder(s) with the folder.`);
        }
        parent.subfolders.splice((parent.subfolders as unknown[]).indexOf(target.folder), 1);

        // The data is changed in memory only: a refusal here leaves the file as it is
        for (const loc of listTracks(data)) {
          if (!modeBefore.has(loc.track)) continue;
          const after = folderChainResultMode(data.tracksRoot, loc.folderPath);
          if (after !== modeBefore.get(loc.track)) {
            return refuse(`Deleting track folder "${args.folder}" would move a track out of a folder with result mode "${modeBefore.get(loc.track) ?? after}". ` +
              'No fixture holds a folder with a non-default result mode, so the values Construct would store are not known here; move the track or delete the folder in the Construct 3 editor, or pass deleteContents to delete the tracks with it.');
          }
        }

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(args.timelineName, 'folder-deleted', saved.backupPath, warnings));
      } catch (error) {
        console.error('[delete_timeline_folder] failed:', error);
        return toolError(`Error deleting timeline folder: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );

  // ─── move_timeline_track ──────────────────────────────────

  server.tool(
    'move_timeline_track',
    'Move a track into a track folder, or back to the root with folder ""; the track keeps all of its keyframes',
    {
      timelineName: z.string().max(200).describe('Timeline name'),
      ...trackSelectorShape,
      folder: folderPathSchema.describe('Destination track folder'),
    },
    async (args) => {
      try {
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const found = kit.selectTrack(data, args.timelineName, args, true);
        if (!found.ok) return found.error;
        const { loc } = found;
        const destination = splitFolderPath(args.folder).join('/');
        if (loc.folderPath === destination && (destination !== '' || loc.list === data.tracks)) {
          return refuse(`The track is already in ${destination ? `track folder "${destination}"` : 'the root'}.`);
        }

        // A folder's result mode could change which stored value is in force; no fixture holds one.
        if (trackKind(loc.track) !== 'value-track') {
          const mode = folderChainResultMode(data.tracksRoot, loc.folderPath) ?? folderChainResultMode(data.tracksRoot, destination);
          if (mode) {
            return refuse(`A track folder on the way has result mode "${mode}". No fixture holds a folder with a non-default result mode, so moving this track could change its values in ways the tools cannot check; move it in the Construct 3 editor.`);
          }
        }

        let list: unknown[];
        if (destination === '') {
          list = data.tracks;
        } else {
          const target = requireFolder(trackRoot(data), destination);
          if (!target.ok) return target.error;
          list = target.folder.items;
        }
        loc.list.splice(loc.list.indexOf(loc.track), 1);
        list.push(loc.track);

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(args.timelineName, 'track-moved', saved.backupPath));
      } catch (error) {
        console.error('[move_timeline_track] failed:', error);
        return toolError(`Error moving timeline track: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );
}
