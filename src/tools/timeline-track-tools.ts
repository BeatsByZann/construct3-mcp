/**
 * Timeline track tools beyond instance tracks: list_timeline_tracks,
 * add_value_track, add_audio_track, add_timeline_folder,
 * rename_timeline_folder, delete_timeline_folder and move_timeline_track.
 * Registered from registerTimelineTools, whose toolkit supplies file access
 * and track selection. Shapes and their sample counts are documented in
 * ../construct3/timeline-model.ts.
 *
 * Only track folders (`tracksRoot`) are edited. The one sampled kind of
 * property-track folder is created by the editor for behavior property
 * tracks and carries `ownerId: "behavior"` / `ownerUid: <behavior name>`;
 * no user-made property-track folder was sampled, so those folders are read
 * (tools find property tracks inside them) but never created or changed.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Timeline, TimelineFolder } from '../construct3/types.js';
import { validateName, toolResult, toolError } from './shared.js';
import {
  timelineFolder,
  isTimelineFolder,
  findFolder,
  splitFolderPath,
  findTrackByName,
  summarizeTracks,
  trackKind,
  folderChainResultMode,
  createValueTrack,
  createValueKeyframe,
  createAudioTrack,
  createPlainMasterKeyframe,
  type AnyTrack,
} from '../construct3/timeline-model.js';
import { easeWarnings, trackSelectorShape, type TimelineToolkit } from './timeline-tools.js';

const folderPathSchema = z.string().max(500)
  .describe('Slash-separated track folder path, e.g. "Doors" or "Doors/Left"; "" is the root');

function checkFolderName(name: string): string | null {
  if (name.length === 0 || name.length > 200) return 'Folder names must be 1 to 200 characters.';
  if (name.includes('/')) return 'Folder names cannot contain "/".';
  return null;
}

export function registerTimelineTrackTools({ server, reader }: MutationToolDeps, kit: TimelineToolkit) {
  type ErrorResult = ReturnType<typeof toolError>;

  /** The timeline's track root folder, created when an old file lacks it. */
  function trackRoot(data: Timeline): TimelineFolder {
    if (!isTimelineFolder(data.tracksRoot)) data.tracksRoot = timelineFolder('Track Folder');
    return data.tracksRoot;
  }

  function requireFolder(root: TimelineFolder, path: string): { ok: true; folder: TimelineFolder } | { ok: false; error: ErrorResult } {
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
      return { ok: false, error: toolError(`No track folder "${path}".${names.length > 0 ? ` Folders: ${names.join(', ')}.` : ' There are no folders yet; create one with add_timeline_folder.'}`) };
    }
    return { ok: true, folder };
  }

  function checkTimes(data: Timeline, times: number[]): ErrorResult | null {
    const outOfRange = times.find(t => t < 0 || t > data.totalTime);
    if (outOfRange === undefined) return null;
    return toolError(`Keyframe time ${outOfRange} is outside the timeline's [0, ${data.totalTime}] range. Raise totalTime with update_timeline first.`);
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
        const opened = await kit.openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const tracks = summarizeTracks(opened.data);
        return toolResult({ timeline: args.timelineName, tracks, count: tracks.length });
      } catch (error) {
        console.error('[list_timeline_tracks] failed:', error);
        return toolError(`Error listing timeline tracks: ${error instanceof Error ? error.message : String(error)}`);
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
        validateName(args.name);
        const opened = await kit.openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        if (findTrackByName(data, args.name)) {
          return toolError(`Timeline "${args.timelineName}" already has a value or audio track named "${args.name}".`);
        }
        const times = args.keyframes.map(k => k.time);
        if (new Set(times).size !== times.length) return toolError('Each keyframe time may appear once.');
        const rangeError = checkTimes(data, times);
        if (rangeError) return rangeError;

        const track = createValueTrack(args.name, reader.getProject().uniqueId);
        const sorted = [...args.keyframes].sort((a, b) => a.time - b.time);
        track.keyframes = sorted.map(k => createPlainMasterKeyframe(k.time));
        track.propertyTracks![0].propertyKeyframes = sorted.map(k => createValueKeyframe(k.time, k.value, k.ease));

        const placeError = placeTrack(data, track, args.folder);
        if (placeError) return placeError;

        const warnings = easeWarnings(args.keyframes.map(k => k.ease), await kit.loadEases());
        const backupPath = await kit.saveTimeline(filePath, data);
        return toolResult(kit.writeResult(args.timelineName, 'value-track-added', backupPath, warnings));
      } catch (error) {
        console.error('[add_value_track] failed:', error);
        return toolError(`Error adding value track: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_audio_track ──────────────────────────────────────

  server.tool(
    'add_audio_track',
    'Add an audio track that plays a sound or music file registered in the project. Based on one r495 sample (synth-sunset); check the result in the Construct 3 editor',
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
        const opened = await kit.openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const file = kit.findAudioFile(args.audioFile, args.audioFolder);
        if (!file.ok) return file.error;

        let name = args.name;
        if (name !== undefined) validateName(name);
        if (name === undefined) {
          let n = 1;
          while (findTrackByName(data, `Audio Track ${n}`)) n++;
          name = `Audio Track ${n}`;
        } else if (findTrackByName(data, name)) {
          return toolError(`Timeline "${args.timelineName}" already has a value or audio track named "${name}".`);
        }

        const times = [...new Set(args.keyframeTimes)].sort((a, b) => a - b);
        const rangeError = checkTimes(data, times);
        if (rangeError) return rangeError;

        const track = createAudioTrack(name, reader.getProject().uniqueId, file.file, args.audioStartOffset, args.audioTag);
        track.keyframes = times.map(t => createPlainMasterKeyframe(t));

        const placeError = placeTrack(data, track, args.folder);
        if (placeError) return placeError;

        const backupPath = await kit.saveTimeline(filePath, data);
        return toolResult({ ...kit.writeResult(args.timelineName, 'audio-track-added', backupPath, file.warnings), trackName: name });
      } catch (error) {
        console.error('[add_audio_track] failed:', error);
        return toolError(`Error adding audio track: ${error instanceof Error ? error.message : String(error)}`);
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
        if (nameProblem) return toolError(nameProblem);
        const opened = await kit.openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const parent = requireFolder(trackRoot(data), args.parentFolder ?? '');
        if (!parent.ok) return parent.error;
        if ((parent.folder.subfolders as unknown[]).some(sf => isTimelineFolder(sf) && sf.name === args.name)) {
          return toolError(`A track folder named "${args.name}" already exists there.`);
        }
        parent.folder.subfolders.push(timelineFolder(args.name));

        const warnings = splitFolderPath(args.parentFolder).length > 0
          ? ['Nested folders were not in the sampled projects (each sampled folder sits directly under the root); check the timeline in the Construct 3 editor.']
          : [];
        const backupPath = await kit.saveTimeline(filePath, data);
        return toolResult(kit.writeResult(args.timelineName, 'folder-added', backupPath, warnings));
      } catch (error) {
        console.error('[add_timeline_folder] failed:', error);
        return toolError(`Error adding timeline folder: ${error instanceof Error ? error.message : String(error)}`);
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
        if (nameProblem) return toolError(nameProblem);
        const parts = splitFolderPath(args.folder);
        if (parts.length === 0) return toolError('The root folder cannot be renamed.');
        const opened = await kit.openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const root = trackRoot(data);
        const target = requireFolder(root, args.folder);
        if (!target.ok) return target.error;
        const parent = findFolder(root, parts.slice(0, -1).join('/'))!;
        if ((parent.subfolders as unknown[]).some(sf => sf !== target.folder && isTimelineFolder(sf) && sf.name === args.newName)) {
          return toolError(`A track folder named "${args.newName}" already exists there.`);
        }
        target.folder.name = args.newName;

        const backupPath = await kit.saveTimeline(filePath, data);
        return toolResult(kit.writeResult(args.timelineName, 'folder-renamed', backupPath));
      } catch (error) {
        console.error('[rename_timeline_folder] failed:', error);
        return toolError(`Error renaming timeline folder: ${error instanceof Error ? error.message : String(error)}`);
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
        if (parts.length === 0) return toolError('The root folder cannot be deleted.');
        const opened = await kit.openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const root = trackRoot(data);
        const target = requireFolder(root, args.folder);
        if (!target.ok) return target.error;
        const parentPath = parts.slice(0, -1).join('/');
        const parent = findFolder(root, parentPath)!;

        const warnings: string[] = [];
        const itemCount = target.folder.items.length;
        const subCount = (target.folder.subfolders as unknown[]).length;
        if (!args.deleteContents) {
          // Tracks at the root live in `tracks`, not in the root folder's items.
          const rootList = parentPath === '' ? data.tracks : parent.items;
          for (const sf of target.folder.subfolders as unknown[]) {
            if (isTimelineFolder(sf) && (parent.subfolders as unknown[]).some(other => isTimelineFolder(other) && other !== target.folder && other.name === sf.name)) {
              return toolError(`Cannot move subfolder "${sf.name}" up: the parent already has a folder of that name. Rename one first or pass deleteContents.`);
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

        const backupPath = await kit.saveTimeline(filePath, data);
        return toolResult(kit.writeResult(args.timelineName, 'folder-deleted', backupPath, warnings));
      } catch (error) {
        console.error('[delete_timeline_folder] failed:', error);
        return toolError(`Error deleting timeline folder: ${error instanceof Error ? error.message : String(error)}`);
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
        const opened = await kit.openTimeline(args.timelineName);
        if (!opened.ok) return opened.error;
        const { filePath, data } = opened;

        const found = kit.selectTrack(data, args.timelineName, args, true);
        if (!found.ok) return found.error;
        const { loc } = found;
        const destination = splitFolderPath(args.folder).join('/');
        if (loc.folderPath === destination && (destination !== '' || loc.list === data.tracks)) {
          return toolError(`The track is already in ${destination ? `track folder "${destination}"` : 'the root'}.`);
        }

        // A folder's result mode could change which stored value is in force; none was sampled.
        if (trackKind(loc.track) !== 'value-track') {
          const mode = folderChainResultMode(data.tracksRoot, loc.folderPath) ?? folderChainResultMode(data.tracksRoot, destination);
          if (mode) {
            return toolError(`A track folder on the way has result mode "${mode}". No sampled folder had a non-default result mode, so moving this track could change its values in ways the tools cannot check; move it in the Construct 3 editor.`);
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

        const backupPath = await kit.saveTimeline(filePath, data);
        return toolResult(kit.writeResult(args.timelineName, 'track-moved', backupPath));
      } catch (error) {
        console.error('[move_timeline_track] failed:', error);
        return toolError(`Error moving timeline track: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
