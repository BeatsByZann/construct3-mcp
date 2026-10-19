/**
 * What the timeline tool files share: the shapes of a timeline lookup and of
 * a track selection, the Zod fields that address one track, and the toolkit
 * registerTimelineTools builds for the files that edit tracks and eases.
 */

import { z } from 'zod';
import type { toolError } from './shared.js';
import type { Timeline, WriteResult } from '../construct3/types.js';
import type { CustomEase, TrackKind, TrackLocation } from '../construct3/timeline-model.js';
import type { FileState } from '../construct3/disk-state.js';

/** The error result of a tool call. */
export type ErrorResult = ReturnType<typeof toolError>;

/** How a lookup words its refusals: `refuse` for a write tool, `toolError` for a read-only one. */
export type ErrorForm = (message: string) => ErrorResult;

/** A folder of the project.c3proj `timelines` container. */
export interface ContainerFolder {
  name?: string;
  items: string[];
  subfolders: ContainerFolder[];
}

/** A registered timeline read with its raw text and the state of its file before that read. */
export type TimelineLookup =
  | { ok: true; filePath: string; data: Timeline; text: string; state: FileState }
  | { ok: false; error: ErrorResult };

/** The track a selector addresses, or why none does. */
export type TrackSelection =
  | { ok: true; loc: TrackLocation; kind: TrackKind }
  | { ok: false; error: ErrorResult };

/** The arguments that address one track. */
export interface TrackSelectorArgs {
  instanceUid?: number;
  trackName?: string;
}

/** Zod fields that address one track: an instance track by UID or a value/audio track by name. */
export const trackSelectorShape = {
  instanceUid: z.number().int().min(0).optional().describe('UID of the animated instance (instance tracks)'),
  trackName: z.string().min(1).max(200).optional().describe('Name of a value or audio track; give this instead of instanceUid'),
};

/** What the tool files that edit tracks and eases share with the timeline tools. */
export interface TimelineToolkit {
  /** A registered timeline's file read for a write; `fail` words its refusals. */
  openTimeline(timelineName: string, fail: ErrorForm): Promise<TimelineLookup>;
  /** Sync the timeline's custom-ease copies and write it, refused when its file changed since `expected`. The backup path, or undefined for a new file. */
  saveTimeline(filePath: string, data: Timeline, expected: FileState): Promise<string | undefined>;
  /** The text saveTimeline would write for `data`. */
  timelineText(filePath: string, data: Timeline, eases: Map<string, CustomEase>): Promise<string>;
  writeResult(timelineName: string, action: string, backupPath: string | undefined, warnings?: string[]): WriteResult;
  selectTrack(data: Timeline, timelineName: string, args: TrackSelectorArgs, allowLegacy: boolean): TrackSelection;
  loadEases(): Promise<Map<string, CustomEase>>;
  /** Every registered timeline that opens, and the names of those that do not. */
  allTimelines(): Promise<{
    timelines: Array<{ name: string; filePath: string; data: Timeline; text: string; state: FileState }>;
    unreadable: string[];
  }>;
  timelineNames(): string[];
  easeFilePath(name: string): string;
  projectContainer(): ContainerFolder | undefined;
}
