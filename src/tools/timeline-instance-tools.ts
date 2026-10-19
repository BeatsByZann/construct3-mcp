/**
 * Instance track tools: add_timeline_track, remove_timeline_track,
 * add_property_track, remove_property_track, set_keyframe, delete_keyframe
 * and update_track. An instance track animates one world instance of a
 * layout; each animated property is a property track with its keyframes at
 * the master keyframe times. Registered from registerTimelineTools, whose
 * toolkit supplies file access and track selection.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import { toolResult, toolError } from './shared.js';
import type {
  Instance,
  Layout,
  ObjectType,
  Timeline,
  TimelineInstanceTrack,
  TimelineKeyframe,
  TimelinePropertyKeyframe,
  TimelinePropertyTrack,
} from '../construct3/types.js';
import { findInstanceByUid } from '../construct3/layers.js';
import { describeReadFailure } from '../construct3/analyzers/unscanned-uses.js';
import {
  WORLD_PROPERTIES,
  resolveTimelineProperty,
  specForExistingTrack,
  valuesFor,
  checkValue,
  addVirtualPositionKey,
  trackRank,
  type PropertySpec,
  type KeyframeValues,
  type TimelineValue,
} from '../construct3/timeline-properties.js';
import {
  timelineFolder,
  trackKind,
  listPropertyTracks,
  findTrackByUid,
  findTrackByName,
  createPlainMasterKeyframe,
  createValueKeyframe,
  mergeAudioSourceAdapter,
  folderChainResultMode,
  sameTime,
  easeWarnings,
  type AnyTrack,
} from '../construct3/timeline-model.js';
import { keyframeMode, refreshModeValues, folderModeError } from '../construct3/timeline-result-modes.js';
import { refuse, invalidName, readFailure, relativeMessage, caseHint } from './timeline-writes.js';
import { trackSelectorShape, type ErrorResult, type TimelineToolkit } from './timeline-kit.js';
import { withProjectSync } from './project-sync.js';

/**
 * The refusal for a property name that matches no world property, instance
 * variable or plugin property. Construct 3 cannot open a project whose
 * property track has such a name, so no track is written for it.
 */
function unknownPropertyRefusal(name: string, instance: Instance, objectType: ObjectType | undefined): ErrorResult {
  const unreadable = objectType === undefined
    ? ` The object type "${instance.type}" could not be read, so its instance variables and plugin properties are not known.`
    : '';
  return refuse(
    `Property "${name}" matches no world property, instance variable or plugin property of instance UID ${instance.uid} ("${instance.type}"), ` +
    `and Construct 3 cannot open a project whose property track has such a name.${unreadable} ` +
    `World properties: ${Object.keys(WORLD_PROPERTIES).join(', ')}.`,
  );
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

/** A master keyframe as the editor writes one on an instance track. */
function createMasterKeyframe(time: number): TimelineKeyframe {
  return {
    time,
    tags: '',
    enabled: true,
    ease: 'default',
    pathMode: 'default',
  };
}

/** A property keyframe holding `values`, with the addons its property rule gives. */
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

/** A property track with no keyframes yet. */
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

/** An instance track for the instance `uid` of `objectType`, with no keyframes or property tracks yet. */
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
  return times.map(time => createPropertyKeyframe(time, spec, valuesFor(spec, spec.base as TimelineValue, mode)));
}

/** The instance with this UID in any layout, with the layout that holds it. */
function findInstanceAnywhere(
  layouts: Map<string, Layout>,
  uid: number,
): { instance: Instance; layoutName: string } | undefined {
  for (const [layoutName, layout] of layouts) {
    const instance = findInstanceByUid(layout, uid)?.instance;
    if (instance) return { instance, layoutName };
  }
  return undefined;
}

/**
 * Register the instance track tools.
 * @param deps The server, reader, writer and id generator.
 * @param kit The toolkit registerTimelineTools builds: timeline access, saving and track selection.
 */
export function registerTimelineInstanceTools(deps: MutationToolDeps, kit: TimelineToolkit): void {
  const server = withProjectSync(deps.server, deps.reader);
  const { reader } = deps;

  const { save } = kit;

  /** The world instance with this UID, searched across every layout, and its object type. */
  async function requireWorldInstance(uid: number): Promise<
    { ok: true; instance: Instance; objectType?: ObjectType } | { ok: false; error: ErrorResult }
  > {
    const located = findInstanceAnywhere(await reader.readAllLayouts(), uid);
    if (!located) {
      // The bulk read skips a layout it cannot read: the instance may be in it
      const unreadable = [...reader.getReadFailures('layouts')].map(([name, failure]) =>
        `layout "${name}" (${reader.getEntityRelativePath('layouts', name)}: ${describeReadFailure(failure.code)})`);
      if (unreadable.length > 0) {
        return {
          ok: false,
          error: refuse(`Instance UID ${uid} was not found in the layouts that could be read, and ${unreadable.join(', ')} could not be read, so its current property values cannot be read. Fix or restore ${unreadable.length === 1 ? 'it' : 'them'} first.`),
        };
      }
      return {
        ok: false,
        error: refuse(`Instance UID ${uid} was not found in any layout, so its current property values cannot be read. Remove the stale track with remove_timeline_track.`),
      };
    }
    if (!located.instance.world) {
      return {
        ok: false,
        error: refuse(`Instance UID ${uid} in layout "${located.layoutName}" is not a world instance.`),
      };
    }
    return { ok: true, instance: located.instance, objectType: await readObjectTypeSafe(located.instance.type) };
  }

  /** The object type, or undefined when its file cannot be read (only world properties are then known). */
  async function readObjectTypeSafe(name: string): Promise<ObjectType | undefined> {
    try {
      return await reader.readObjectType(name);
    } catch {
      return undefined;
    }
  }

  /** Resolve property names for new tracks; an unknown name, or a known property whose current value is unreadable, is an error. */
  function resolveNewProperties(
    properties: string[],
    instance: Instance,
    objectType: ObjectType | undefined,
  ): { ok: true; specs: PropertySpec[] } | { ok: false; error: ErrorResult } {
    const specs: PropertySpec[] = [];
    for (const name of properties) {
      const resolved = resolveTimelineProperty(name, instance, objectType);
      if (!resolved.ok) return { ok: false, error: refuse(resolved.error) };
      const spec = resolved.spec;
      if (!spec.verified) return { ok: false, error: unknownPropertyRefusal(name, instance, objectType) };
      if (spec.base === undefined) {
        return { ok: false, error: refuse(`Cannot read the current value of "${spec.property}" for instance UID ${instance.uid}${spec.property.startsWith('offsetScale') ? ' (its object type has no frame size to divide by)' : ''}.`) };
      }
      if (specs.some(other => other.property === spec.property && other.source.type === spec.source.type)) {
        return { ok: false, error: refuse(`Duplicate property "${name}" in properties; each property track must appear once.`) };
      }
      specs.push(spec);
    }
    return { ok: true, specs };
  }

  /** The refusal for a layout name that is not registered, with the nearest names. */
  function layoutNotFound(name: string): ErrorResult {
    const suggestions = reader.findNearestName(name, 'layouts');
    const hint = suggestions.length > 0
      ? `\nDid you mean: ${suggestions.join(', ')}?`
      : '\nUse list_layouts to see all available names.';
    return refuse(`Layout "${name}" not found.${hint}`);
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
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        // Only a registered layout is read: a file under layouts/ that is not registered is not a layout
        const layoutNames = await reader.listLayouts();
        if (!layoutNames.includes(args.layoutName)) {
          const hint = caseHint(args.layoutName, layoutNames);
          return hint ? refuse(`Layout "${args.layoutName}" not found. ${hint}`) : layoutNotFound(args.layoutName);
        }
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch (readError) {
          // The reader wraps the file system error; its cause names the code or the parse text, without a path
          const cause = readError instanceof Error && readError.cause !== undefined ? readError.cause : readError;
          return refuse(`Layout "${args.layoutName}" is registered but its file ${reader.getEntityRelativePath('layouts', args.layoutName)} could not be read (${readFailure(cause)}).`);
        }

        const instance = findInstanceByUid(layout, args.instanceUid)?.instance;
        if (!instance) {
          return refuse(`Instance UID ${args.instanceUid} not found in layout "${args.layoutName}". Use get_layout_details to list its instances.`);
        }
        if (!instance.world) {
          return refuse(`Instance UID ${args.instanceUid} ("${instance.type}") is not a world instance of layout "${args.layoutName}"; an instance track can only animate a world instance.`);
        }

        // Tracks can sit in track folders, and older files hold untyped tracks.
        const existingTrack = findTrackByUid(data, args.instanceUid);
        if (existingTrack) {
          const where = existingTrack.folderPath ? ` (in track folder "${existingTrack.folderPath}")` : '';
          const legacy = trackKind(existingTrack.track) === 'legacy-instance-track' ? ' an untyped (older) track' : ' a track';
          return refuse(`Instance UID ${args.instanceUid} already has${legacy} in timeline "${args.timelineName}"${where}. Extend it with add_property_track or set_keyframe.`);
        }

        const rootMode = folderChainResultMode(data.tracksRoot, '');
        if (rootMode) {
          return refuse(`The timeline's track root folder has result mode "${rootMode}". No fixture holds a folder with a non-default result mode, so the values Construct would store are not known here; set it back to "default" in the Construct 3 editor first.`);
        }

        const instanceType = await readObjectTypeSafe(instance.type);
        const resolved = resolveNewProperties(args.properties, instance, instanceType);
        if (!resolved.ok) return resolved.error;

        const times = [...new Set(args.keyframeTimes)].sort((a, b) => a - b);
        const outOfRange = times.find(t => t < 0 || t > data.totalTime);
        if (outOfRange !== undefined) {
          return refuse(`Keyframe time ${outOfRange} is outside the timeline's [0, ${data.totalTime}] range. Raise totalTime with update_timeline first.`);
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

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(
          args.timelineName,
          'track-added',
          saved.backupPath,
        ));
      } catch (error) {
        console.error('[add_timeline_track] failed:', error);
        return toolError(`Error adding timeline track: ${relativeMessage(error, reader.getProjectDir())}`);
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
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const found = kit.selectTrack(data, args.timelineName, args, true);
        if (!found.ok) return found.error;

        found.loc.list.splice(found.loc.list.indexOf(found.loc.track), 1);

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(args.timelineName, 'track-removed', saved.backupPath));
      } catch (error) {
        console.error('[remove_timeline_track] failed:', error);
        return toolError(`Error removing timeline track: ${relativeMessage(error, reader.getProjectDir())}`);
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
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const found = kit.selectTrack(data, args.timelineName, { instanceUid: args.instanceUid }, false);
        if (!found.ok) return found.error;
        const track = found.loc.track as unknown as TimelineInstanceTrack;

        const folderProblem = folderModeError(data, found.loc);
        if (folderProblem) return refuse(folderProblem);

        const located = await requireWorldInstance(args.instanceUid);
        if (!located.ok) return located.error;

        const resolved = resolveNewProperties([args.property], located.instance, located.objectType);
        if (!resolved.ok) return resolved.error;
        const spec = resolved.specs[0];

        const duplicate = listPropertyTracks(track).find(({ propertyTrack: pt }) =>
          pt.property === spec.property && pt.source?.type === spec.source.type);
        if (duplicate) {
          const where = duplicate.folderPath ? ` (in property track folder "${duplicate.folderPath}")` : '';
          return refuse(`Property track "${args.property}" already exists on the track for instance UID ${args.instanceUid}${where}. Use set_keyframe to change its values.`);
        }

        const propertyTrack = createPropertyTrack(spec);
        const times = track.keyframes.map(kf => kf.time).sort((a, b) => a - b);
        propertyTrack.propertyKeyframes = currentKeyframes(data, track, propertyTrack, spec, times);
        attachPropertyTrack(track, spec, propertyTrack, located.instance, located.objectType);

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(
          args.timelineName,
          'property-track-added',
          saved.backupPath,
        ));
      } catch (error) {
        console.error('[add_property_track] failed:', error);
        return toolError(`Error adding property track: ${relativeMessage(error, reader.getProjectDir())}`);
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
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const found = kit.selectTrack(data, args.timelineName, { instanceUid: args.instanceUid }, true);
        if (!found.ok) return found.error;
        const { track } = found.loc;

        const located = findPropertyTrack(track, args.property);
        if (!located) {
          const existing = listPropertyTracks(track).map(({ propertyTrack }) => propertyTrack.property);
          const hint = existing.length > 0
            ? ` Property tracks present: ${existing.join(', ')}.`
            : ' The track has no property tracks.';
          return refuse(`Property track "${args.property}" not found on the track for instance UID ${args.instanceUid}.${hint}`);
        }
        located.list.splice(located.list.indexOf(located.propertyTrack), 1);

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(args.timelineName, 'property-track-removed', saved.backupPath));
      } catch (error) {
        console.error('[remove_property_track] failed:', error);
        return toolError(`Error removing property track: ${relativeMessage(error, reader.getProjectDir())}`);
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
      })).optional().describe('Per-property values, e.g. { "offsetX": { "absolute": 400 }, "offsetOpacity": { "relative": -0.5 }, "tag": { "absolute": "done" } }, or { "value": { "absolute": 2, "ease": "easeinoutsine" } } for a value track. Numbers take absolute or relative; the stored values follow the result mode in force. A name matching no world property, instance variable or plugin property is refused for a new property track; an existing track with such a name needs both absolute and relative numbers'),
      ease: z.string().max(100).optional().describe('Master keyframe ease name (a new keyframe gets "default")'),
      enabled: z.boolean().optional().describe('Master keyframe enabled flag'),
      tags: z.string().max(500).optional().describe('Master keyframe tags string'),
    },
    async (args) => {
      try {
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const found = kit.selectTrack(data, args.timelineName, args, false);
        if (!found.ok) return found.error;
        const { track } = found.loc;
        const trackLabel = args.trackName !== undefined ? `track "${args.trackName}"` : `the track for instance UID ${args.instanceUid}`;

        if (args.time < 0 || args.time > data.totalTime) {
          return refuse(`Keyframe time ${args.time} is outside the timeline's [0, ${data.totalTime}] range. Raise totalTime with update_timeline first.`);
        }

        const entries = Object.entries(args.values ?? {});
        if (entries.length > 32) {
          return refuse(`Too many properties in values: ${entries.length} (max 32).`);
        }
        const eases = await kit.loadEases();
        const easeNames = [args.ease, ...entries.map(([, input]) => input.ease)];

        if (found.kind === 'audio-track') {
          if (entries.length > 0) {
            return refuse(`${trackLabel} is an audio track: it has master keyframes only, so give no values.`);
          }
        }

        if (found.kind === 'value-track') {
          const valueTrack = listPropertyTracks(track).find(({ propertyTrack }) => propertyTrack.property === 'value')?.propertyTrack;
          if (!valueTrack) return refuse(`Value track "${args.trackName}" has no "value" property track.`);
          const bad = entries.find(([name]) => name !== 'value');
          if (bad) return refuse(`A value track has only the "value" property; "${bad[0]}" is not accepted.`);
          const input = args.values?.value;
          if (input && input.relative !== undefined) return refuse('A value track stores absolute values only; give "absolute".');
          if (input && input.absolute !== undefined && (typeof input.absolute !== 'number' || !Number.isFinite(input.absolute))) {
            return refuse('A value track keyframe needs a number.');
          }
          const current = valueTrack.propertyKeyframes.find(kf => sameTime(kf.time, args.time));
          if (!current && input?.absolute === undefined) {
            return refuse(`${trackLabel} has no keyframe at time ${args.time}; give values.value.absolute to create one.`);
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
          const saved = await save(opened);
          if (!saved.ok) return saved.error;
          return toolResult(kit.writeResult(args.timelineName, existed ? 'keyframe-updated' : 'keyframe-created', saved.backupPath, easeWarnings(easeNames, eases)));
        }

        if (found.kind === 'audio-track') {
          const { master, existed } = ensureMaster(track, args.time, true);
          if (args.ease !== undefined) master.ease = args.ease;
          if (args.enabled !== undefined) master.enabled = args.enabled;
          if (args.tags !== undefined) master.tags = args.tags;
          const saved = await save(opened);
          if (!saved.ok) return saved.error;
          return toolResult(kit.writeResult(args.timelineName, existed ? 'keyframe-updated' : 'keyframe-created', saved.backupPath, easeWarnings(easeNames, eases)));
        }

        // selectTrack answers only instance, value and audio tracks here (an untyped track is refused there)
        const instanceTrack = track as unknown as TimelineInstanceTrack;
        const uid = instanceTrack.worldInstance;
        const folderProblem = folderModeError(data, found.loc);
        if (folderProblem) return refuse(folderProblem);

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
          if (!lookup.ok) return refuse(lookup.error);
          const spec = lookup.spec;
          // A new property track needs a name Construct 3 knows; an existing one is edited as stored
          if (!existing && !spec.verified) return unknownPropertyRefusal(name, located!.instance, located!.objectType);

          if (!spec.verified) {
            if (typeof input.absolute !== 'number' || input.relative === undefined) {
              return refuse(`Property "${name}" matches no world property, instance variable or plugin property of the instance, so its absolute and relative values cannot be related: supply both "absolute" and "relative" as numbers. ${propertyNameHelp}.`);
            }
            resolved.push({ spec, existing, absolute: input.absolute, relative: input.relative, ease: input.ease });
            continue;
          }

          if (spec.kind === 'number') {
            if (typeof spec.base !== 'number') {
              return refuse(`Cannot read the current value of "${spec.property}" for instance UID ${uid}.`);
            }
            if (input.absolute !== undefined) {
              const problem = checkValue(spec, input.absolute);
              if (problem) return refuse(problem);
              resolved.push({ spec, existing, absolute: input.absolute, ease: input.ease });
            } else if (input.relative !== undefined) {
              resolved.push({ spec, existing, absolute: spec.base + input.relative, ease: input.ease });
            } else {
              return refuse(`Property "${name}" needs an "absolute" or a "relative" value.`);
            }
          } else {
            if (input.relative !== undefined) {
              return refuse(`Property "${name}" is a ${spec.kind === 'color' ? 'color' : spec.kind}; give "absolute" only.`);
            }
            const problem = input.absolute === undefined ? `Property "${name}" needs an "absolute" value.` : checkValue(spec, input.absolute);
            if (problem) return refuse(problem);
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

        const warnings: string[] = [];
        if (createdTracks.length > 0) {
          warnings.push(`Created property track(s) ${createdTracks.join(', ')} on the track for instance UID ${uid}; they hold a keyframe only at the times set so far.`);
        }
        warnings.push(...easeWarnings(easeNames, eases));

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(
          args.timelineName,
          existed ? 'keyframe-updated' : 'keyframe-created',
          saved.backupPath,
          warnings,
        ));
      } catch (error) {
        console.error('[set_keyframe] failed:', error);
        return toolError(`Error setting keyframe: ${relativeMessage(error, reader.getProjectDir())}`);
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
        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const found = kit.selectTrack(data, args.timelineName, args, true);
        if (!found.ok) return found.error;
        const { track } = found.loc;
        const trackLabel = args.trackName !== undefined ? `Track "${args.trackName}"` : `The track for instance UID ${args.instanceUid}`;

        let action: string;
        if (args.property !== undefined) {
          if (found.kind === 'value-track' || found.kind === 'audio-track') {
            return refuse(`${trackLabel} is ${found.kind === 'audio-track' ? 'an audio track' : 'a value track'}; its property keyframes follow its master keyframes, so delete the master keyframe instead (omit "property").`);
          }
          const located = findPropertyTrack(track, args.property);
          if (!located) {
            return refuse(`Property track "${args.property}" not found on the track for instance UID ${args.instanceUid}.`);
          }
          const keyframes = located.propertyTrack.propertyKeyframes;
          const index = keyframes.findIndex(kf => sameTime(kf.time, args.time));
          if (index === -1) {
            return refuse(`Property track "${args.property}" has no keyframe at time ${args.time}.`);
          }
          keyframes.splice(index, 1);
          action = 'property-keyframe-deleted';
        } else {
          const keyframes = track.keyframes ?? [];
          const index = keyframes.findIndex(kf => sameTime(kf.time, args.time));
          if (index === -1) {
            const times = keyframes.map(kf => kf.time);
            return refuse(`${trackLabel} has no master keyframe at time ${args.time}. Keyframe times: ${times.join(', ')}.`);
          }
          if (keyframes.length <= 1) {
            return refuse(`Refusing to delete the last master keyframe of ${trackLabel.charAt(0).toLowerCase()}${trackLabel.slice(1)}: a track with no keyframes is not a valid track. Use remove_timeline_track to remove the whole track.`);
          }
          // add_audio_track writes an audio track with a keyframe at 0; deleting
          // it here would leave a track the editor may have to rewrite.
          if (found.kind === 'audio-track' && sameTime(args.time, 0)) {
            return refuse(`${trackLabel} is an audio track, which needs its keyframe at time 0. Delete a later keyframe, or remove_timeline_track to remove the whole track.`);
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

        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(args.timelineName, action, saved.backupPath));
      } catch (error) {
        console.error('[delete_keyframe] failed:', error);
        return toolError(`Error deleting keyframe: ${relativeMessage(error, reader.getProjectDir())}`);
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
          return refuse('No updates provided. Specify at least one of: enabled, ease, interpolationMode, resultMode, pathMode, initialVisibility, name, audioFile, audioStartOffset, audioTag.');
        }

        const opened = await kit.openTimeline(args.timelineName, refuse);
        if (!opened.ok) return opened.error;
        const { data } = opened;

        const found = kit.selectTrack(data, args.timelineName, args, true);
        if (!found.ok) return found.error;
        const { track } = found.loc;
        const kind = found.kind;

        const named = kind === 'value-track' || kind === 'audio-track';
        if (args.resultMode !== undefined && (kind === 'value-track' || kind === 'legacy-instance-track')) {
          return refuse(kind === 'value-track'
            ? 'A value track has no result mode.'
            : 'Changing the result mode of an untyped (older) track would leave its stored values stale; open and save the timeline in the Construct 3 editor first.');
        }
        if (args.resultMode !== undefined && kind === 'instance-track') {
          const folderProblem = folderModeError(data, found.loc);
          if (folderProblem) return refuse(folderProblem);
        }
        if (args.pathMode !== undefined && named) return refuse(`${kind === 'audio-track' ? 'An audio track' : 'A value track'} has no path mode.`);
        if (args.name !== undefined && !named) return refuse('Only value and audio tracks have a name.');
        const audioArgs = args.audioFile !== undefined || args.audioStartOffset !== undefined || args.audioTag !== undefined;
        if (audioArgs && kind !== 'audio-track') return refuse('audioFile, audioStartOffset and audioTag apply to audio tracks only.');

        const warnings: string[] = [];
        if (args.name !== undefined && args.name !== track.name) {
          const nameProblem = invalidName(args.name);
          if (nameProblem) return refuse(nameProblem);
          if (findTrackByName(data, args.name)) {
            return refuse(`Timeline "${args.timelineName}" already has a value or audio track named "${args.name}".`);
          }
        }
        if (kind === 'audio-track' && audioArgs) {
          const audio = listPropertyTracks(track).find(({ propertyTrack }) => propertyTrack.property === 'audioSource')?.propertyTrack;
          if (!audio) return refuse(`Audio track "${args.trackName}" has no audioSource property track.`);
          const adapter = (audio.sourceAdapter ?? {}) as Record<string, unknown>;
          if (args.audioFile !== undefined) {
            const file = kit.findAudioFile(args.audioFile, args.audioFolder);
            if (!file.ok) return file.error;
            warnings.push(...file.warnings);
            audio.sourceAdapter = mergeAudioSourceAdapter(adapter, {
              audioProjectFile: structuredClone(file.file.entry),
              audioProjectFilePath: file.file.path,
              audioType: file.file.audioType,
            });
          }
          const patch: Record<string, unknown> = {};
          if (args.audioStartOffset !== undefined) patch.audioStartOffset = args.audioStartOffset;
          if (args.audioTag !== undefined) patch.audioTag = args.audioTag;
          audio.sourceAdapter = mergeAudioSourceAdapter((audio.sourceAdapter ?? {}) as Record<string, unknown>, patch);
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

        warnings.push(...easeWarnings([args.ease], await kit.loadEases()));
        const saved = await save(opened);
        if (!saved.ok) return saved.error;
        return toolResult(kit.writeResult(args.timelineName, 'track-updated', saved.backupPath, warnings));
      } catch (error) {
        console.error('[update_track] failed:', error);
        return toolError(`Error updating track: ${relativeMessage(error, reader.getProjectDir())}`);
      }
    }
  );
}
