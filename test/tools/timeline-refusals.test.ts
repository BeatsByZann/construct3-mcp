/**
 * Every refusal of the timeline and ease tools, on a real project copy: the
 * text is the whole message, it ends with "Nothing was changed.", it names no
 * absolute path, and no file of the project (a .bak included) changes. The
 * read-only tools answer the same lookups as plain errors. A second test
 * covers broken and missing timeline files, a third the catch blocks that
 * word an unexpected failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, readdir, writeFile, realpath, copyFile, mkdir } from 'fs/promises';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const KINDS_DIR = join(__dirname, '..', 'fixtures', 'timeline-kinds');

const END = 'Nothing was changed.';
const SOUND = { name: 'Beep.webm', type: 'audio/webm; codecs=opus', sid: 700000000000001, 'file-info': { purpose: 'none' } };
const MUSIC_SAME_NAME = { name: 'Beep.webm', type: 'audio/webm; codecs=opus', sid: 700000000000002, 'file-info': { purpose: 'none' } };
const LINE = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

const NAME_RULE = 'Name must start with a letter or underscore and contain only alphanumeric characters, underscores, and spaces.';
const EXACTLY_ONE = 'Give exactly one of instanceUid (an instance track) or trackName (a value or audio track).';
const FOLDER_MODE = 'A track or property-track folder holding this track has result mode "absolute". No fixture holds a folder with a non-default result mode, so the values Construct would store are not known here; set the folder back to "default" in the Construct 3 editor first.';
const FOLDERS = 'Folders: "Group", "Other".';

const notFound = (name: string) => `Timeline "${name}" not found. Use list_timelines to see available timelines.`;
const caseHint = (name: string, registered: string) => `Timeline "${name}" not found. Names are matched with their letter case. Did you mean "${registered}"?`;
const outOfRange = (time: number) => `Keyframe time ${time} is outside the timeline's [0, 5] range. Raise totalTime with update_timeline first.`;
const transitionText = (name: string) => `"${name}" is a transition (a custom ease in timelines/transitions/), not a timeline. The timeline tools do not read, change or delete transitions; use list_eases, update_ease or delete_ease.`;
const unresolvedText = (name: string) => `"${name}" is registered in project.c3proj in a timelines folder the timeline tools cannot resolve: a folder without a name that is not the editor's Transitions folder (only the first unnamed folder directly under timelines is), or a folder inside the Transitions folder. Run validate_project and fix the folder in project.c3proj first.`;
const unknownProperty = (name: string) => `Property "${name}" matches no world property, instance variable or plugin property of instance UID 0 ("Sprite"), and Construct 3 cannot open a project whose property track has such a name. World properties: offsetX, offsetY, offsetZElevation, offsetWidth, offsetHeight, offsetAngle, offsetOpacity, offsetColor, offsetScaleX, offsetScaleY.`;
const noTrack =(timeline: string, uid: number, tracked: string) => `Timeline "${timeline}" has no track for instance UID ${uid}.${tracked} Add one with add_timeline_track.`;
const noEase = (name: string) => `Custom ease "${name}" not found. Use list_eases to see the project's custom eases.`;
const easeCaseHint = (name: string, registered: string) => `Custom ease "${name}" not found. Names are matched with their letter case. Did you mean "${registered}"?`;

/** A track, folder, timeline, layout or project read back from disk: the parts the tests navigate, the rest unknown. */
interface TrackJson {
  [key: string]: unknown;
  type?: string;
  name?: string;
  worldInstance?: number;
  propertyTracks?: unknown[];
}
interface FolderJson {
  [key: string]: unknown;
  resultMode?: string;
  items: TrackJson[];
  subfolders: FolderJson[];
}
interface TimelineJson {
  [key: string]: unknown;
  tracks: TrackJson[];
  tracksRoot: FolderJson;
}
interface LayoutJson {
  layers: Array<{ instances: Array<Record<string, unknown> & { uid?: number; world?: unknown }> }>;
}
interface ProjectJson {
  layouts: { items: string[] };
  timelines: { items: string[]; subfolders: Array<{ name?: string; items: string[]; subfolders: unknown[] }> };
  rootFileFolders: Record<string, { items: unknown[]; subfolders: unknown[] }>;
}
interface SheetJson {
  events: Array<{ actions: Array<{ parameters: Record<string, unknown> }> }>;
}
interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** One refusal: the tool, the arguments, the whole message before "Nothing was changed.", or a part of it (partial). */
interface Row {
  tool: string;
  kind: string;
  args: Record<string, unknown>;
  text: string;
  partial?: boolean;
  /** Changes the project on disk before the refusal is asked for. */
  prepare?: () => Promise<void>;
}

describe('timeline and ease tools: refusals (real project on disk)', () => {
  let tmpDir: string;
  let realDir: string;
  let server: MockServer;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;

  const file = (rel: string) => join(tmpDir, ...rel.split('/'));
  const slashed = (path: string) => path.replace(/\\/g, '/');

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-timeline-refusals-'));
    realDir = await realpath(tmpDir);
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    await editProject(project => { project.rootFileFolders.sound.items.push(SOUND); });
    // The way a Tween action in an event sheet names an ease
    const sheetPath = file('eventSheets/MainSheet.json');
    const sheet = JSON.parse(await readFile(sheetPath, 'utf-8')) as SheetJson;
    sheet.events[0].actions[0].parameters.ease = 'Bouncy';
    await writeFile(sheetPath, JSON.stringify(sheet, null, '\t'), 'utf-8');
    await boot();

    await ok('create_timeline', { name: 'Move', totalTime: 5 });
    await ok('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 0 });
    await ok('add_timeline_folder', { timelineName: 'Move', name: 'Group' });
    await ok('add_value_track', { timelineName: 'Move', name: 'Level', folder: 'Group' });
    await ok('add_timeline_folder', { timelineName: 'Move', name: 'Other' });
    await ok('create_ease', { name: 'Bouncy', points: LINE });
    await ok('create_ease', { name: 'Smooth', points: LINE });
    await ok('set_keyframe', { timelineName: 'Move', instanceUid: 0, time: 1, values: { offsetX: { absolute: 150, ease: 'Smooth' } } });
    await ok('create_timeline', { name: 'Spare', totalTime: 5 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function boot() {
    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerTimelineTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
  }

  function call(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
    return server.callTool(name, args);
  }

  async function ok(name: string, args: Record<string, unknown>) {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  /** SHA-256 of every file under the project folder (a .bak included), by project-relative path. */
  async function hashProject(dir = tmpDir): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(hashes, await hashProject(path));
      else hashes[slashed(relative(tmpDir, path))] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
    return hashes;
  }

  /** Every spelling of the project folder a message could hold. */
  function projectFolderForms(): string[] {
    return [...new Set([tmpDir, slashed(tmpDir), realDir, slashed(realDir)])];
  }

  function expectNoProjectFolder(text: string) {
    for (const form of projectFolderForms()) expect(text).not.toContain(form);
  }

  async function editProject(change: (project: ProjectJson) => void): Promise<void> {
    const path = file('project.c3proj');
    const project = JSON.parse(await readFile(path, 'utf-8')) as ProjectJson;
    change(project);
    await writeFile(path, JSON.stringify(project, null, '\t'), 'utf-8');
  }

  async function patchTimeline(name: string, change: (timeline: TimelineJson) => void): Promise<void> {
    const path = file(`timelines/${name}.json`);
    const timeline = JSON.parse(await readFile(path, 'utf-8')) as TimelineJson;
    change(timeline);
    await writeFile(path, JSON.stringify(timeline, null, '\t'), 'utf-8');
  }

  async function patchLayout(change: (layout: LayoutJson) => void): Promise<void> {
    const path = file('layouts/Layout 1.json');
    const layout = JSON.parse(await readFile(path, 'utf-8')) as LayoutJson;
    change(layout);
    await writeFile(path, JSON.stringify(layout, null, '\t'), 'utf-8');
    reader.invalidateCaches();
  }

  /** A timeline file with this text, registered in project.c3proj. */
  async function registerTimelineFile(name: string, text: string): Promise<void> {
    await writeFile(file(`timelines/${name}.json`), text, 'utf-8');
    await editProject(project => { project.timelines.items.push(name); });
  }

  const withHollow = () => registerTimelineFile('Hollow', '{ "name": "Hollow" }');
  const withRootMode = () => patchTimeline('Move', timeline => { timeline.tracksRoot.resultMode = 'absolute'; });
  const withAudio = async () => { await ok('add_audio_track', { timelineName: 'Move', audioFile: 'Beep.webm', name: 'Sfx', keyframeTimes: [0, 1.5] }); };
  const withBlur = async () => { await ok('add_value_track', { timelineName: 'Move', name: 'Blur' }); };
  const withoutFrames = async () => {
    const path = file('objectTypes/Sprite.json');
    const objectType = JSON.parse(await readFile(path, 'utf-8')) as { animations: { items: unknown[] } };
    objectType.animations.items = [];
    await writeFile(path, JSON.stringify(objectType, null, '\t'), 'utf-8');
  };
  const unreadableSprite = async () => {
    await writeFile(file('objectTypes/Sprite.json'), '{ not json', 'utf-8');
    reader.invalidateCaches();
  };
  const withLegacy = async () => {
    await copyFile(join(KINDS_DIR, 'Legacy.json'), file('timelines/Legacy.json'));
    await editProject(project => { project.timelines.items.push('Legacy'); });
  };
  const withoutWorld = () => patchLayout(layout => { delete layout.layers[0].instances[0].world; });

  const rows: Row[] = [];
  function row(tool: string, kind: string, args: Record<string, unknown>, text: string, options: { partial?: boolean; prepare?: () => Promise<void> } = {}) {
    rows.push({ tool, kind, args, text, ...options });
  }

  // ─── create_timeline ──────────────────────────────────────

  row('create_timeline', 'invalid name', { name: '1bad' }, NAME_RULE);
  row('create_timeline', 'empty name', { name: '' }, 'Name cannot be empty.');
  row('create_timeline', 'existing name', { name: 'Move' }, 'Timeline "Move" already exists.');
  row('create_timeline', 'case variant in the same folder', { name: 'move' },
    '"move" differs only in case from the existing timeline "Move" in the same folder. On Windows and macOS both names are the same file (timelines/Move.json), which creating this timeline would overwrite. Choose a different name.');
  row('create_timeline', 'name of a transition', { name: 'Smooth' },
    '"Smooth" is already the name of a transition (custom ease) in this project; choose another timeline name.');
  row('create_timeline', 'subfolder transitions', { name: 'Fresh', subfolder: 'transitions' },
    'Subfolder "transitions" is refused: Construct stores custom eases (transitions) in timelines/transitions/, so a timeline file there would sit among the ease files. Choose another folder name.');
  row('create_timeline', 'subfolder inside transitions in another letter case', { name: 'Fresh', subfolder: 'Transitions/Deep' },
    'Subfolder "Transitions/Deep" is refused: Construct stores custom eases (transitions) in timelines/transitions/, so a timeline file there would sit among the ease files. Choose another folder name.');
  row('create_timeline', 'subfolder with an empty segment', { name: 'Fresh', subfolder: 'a//b' }, 'Subfolder path contains invalid segments.');
  row('create_timeline', 'subfolder that leaves the folder', { name: 'Fresh', subfolder: '../x' },
    'Subfolder path contains invalid characters (use forward slashes only, no "..").');
  row('create_timeline', 'subfolder with a case clash', { name: 'Fresh', subfolder: 'ui' },
    'Subfolder "ui" differs only in case from the existing project-bar folder path "UI". Construct 3 treats sibling folder names that differ only in case as the same name, and on Windows and macOS they are the same directory. Use subfolder "UI".',
    { prepare: async () => { await ok('create_timeline', { name: 'InUi', subfolder: 'UI' }); } });
  row('create_timeline', 'file already on disk', { name: 'Stray' },
    'The file timelines/Stray.json already exists: it is not a registered timeline, or it is registered under a name that differs only in case. It was left unchanged. Choose another name, or, if the file is a leftover of a deleted timeline, check it and remove it first.',
    { prepare: () => writeFile(file('timelines/Stray.json'), '{}', 'utf-8') });
  row('create_timeline', 'name in a folder the tools cannot resolve', { name: 'Lost' }, `${unresolvedText('Lost')} Creating it again would register the name twice.`,
    { prepare: () => editProject(project => { project.timelines.subfolders.push({ items: ['Lost'], subfolders: [] }); }) });

  // ─── update_timeline ──────────────────────────────────────

  row('update_timeline', 'no updates', { name: 'Move' },
    'No updates provided. Specify at least one of: totalTime, loop, pingPong, repeatCount, startOnLayout, ignoreSystemTimescale, enabled, ease, interpolationMode, resultMode, pathMode, transformWithSceneGraph.');
  row('update_timeline', 'unknown timeline', { name: 'Nope', loop: true }, notFound('Nope'));
  row('update_timeline', 'case variant of a name', { name: 'move', loop: true }, caseHint('move', 'Move'));
  row('update_timeline', 'a transition', { name: 'Smooth', loop: true }, transitionText('Smooth'));
  row('update_timeline', 'name in a folder the tools cannot resolve', { name: 'Lost', loop: true }, unresolvedText('Lost'),
    { prepare: () => editProject(project => { project.timelines.subfolders.push({ items: ['Lost'], subfolders: [] }); }) });
  row('update_timeline', 'result mode while an untyped track follows the timeline', { name: 'Legacy', resultMode: 'absolute' },
    'The untyped (older) track(s) for instance UID 0 take their result mode from the timeline, and changing it would leave their stored values stale. Open and save the timeline in the Construct 3 editor first.',
    {
      prepare: async () => {
        await withLegacy();
        // The fixture track has modes of its own; with "default" it follows the timeline
        await patchTimeline('Legacy', timeline => {
          for (const track of timeline.tracks) {
            track.resultMode = 'default';
            for (const propertyTrack of track.propertyTracks as TrackJson[]) propertyTrack.resultMode = 'default';
          }
        });
      },
    });
  row('update_timeline', 'result mode with a folder that holds one', { name: 'Move', resultMode: 'absolute' }, FOLDER_MODE, { prepare: withRootMode });

  // ─── delete_timeline ──────────────────────────────────────

  row('delete_timeline', 'unknown timeline', { name: 'Nope' }, notFound('Nope'));
  row('delete_timeline', 'case variant of a name', { name: 'move' }, caseHint('move', 'Move'));
  row('delete_timeline', 'a transition', { name: 'Smooth' }, transitionText('Smooth'));
  row('delete_timeline', 'name in a folder the tools cannot resolve', { name: 'Lost' }, unresolvedText('Lost'),
    { prepare: () => editProject(project => { project.timelines.subfolders.push({ items: ['Lost'], subfolders: [] }); }) });
  row('delete_timeline', 'a registered name that leaves the timelines folder', { name: '../Evil' }, 'Timeline "../Evil": ',
    { partial: true, prepare: () => editProject(project => { project.timelines.items.push('../Evil'); }) });
  row('delete_timeline', 'a file without tracks', { name: 'Hollow' },
    'Timeline "Hollow" is registered but its file timelines/Hollow.json holds no tracks, so it was not deleted. Check it with get_timeline_details.', { prepare: withHollow });
  row('delete_timeline', 'a file that is not JSON', { name: 'Broken' },
    'Timeline "Broken" is registered but its file timelines/Broken.json could not be read (',
    { partial: true, prepare: () => registerTimelineFile('Broken', '{ broken') });

  // ─── add_timeline_track ───────────────────────────────────

  const addTrack = { timelineName: 'Spare', layoutName: 'Layout 1', instanceUid: 0 };
  row('add_timeline_track', 'unknown timeline', { ...addTrack, timelineName: 'Nope' }, notFound('Nope'));
  row('add_timeline_track', 'unknown layout', { ...addTrack, layoutName: 'Zzz' }, 'Layout "Zzz" not found.\nUse list_layouts to see all available names.');
  row('add_timeline_track', 'layout name in another letter case', { ...addTrack, layoutName: 'layout 1' },
    'Layout "layout 1" not found. Names are matched with their letter case. Did you mean "Layout 1"?');
  row('add_timeline_track', 'a layout whose file is gone', addTrack,
    'Layout "Layout 1" is registered but its file layouts/Layout 1.json could not be read (ENOENT).', { prepare: () => rm(file('layouts/Layout 1.json')) });
  row('add_timeline_track', 'unknown UID', { ...addTrack, instanceUid: 99 }, 'Instance UID 99 not found in layout "Layout 1". Use get_layout_details to list its instances.');
  row('add_timeline_track', 'instance that is not a world instance', { ...addTrack, instanceUid: 5 },
    'Instance UID 5 ("Sprite") is not a world instance of layout "Layout 1"; an instance track can only animate a world instance.',
    { prepare: () => patchLayout(layout => { layout.layers[0].instances.push({ type: 'Sprite', uid: 5, sid: 500000000000009, tags: '', properties: {}, instanceVariables: {}, behaviors: {} }); }) });
  row('add_timeline_track', 'second track for an instance', { ...addTrack, timelineName: 'Move' },
    'Instance UID 0 already has a track in timeline "Move". Extend it with add_property_track or set_keyframe.');
  row('add_timeline_track', 'root folder that holds a result mode', addTrack,
    'The timeline\'s track root folder has result mode "absolute". No fixture holds a folder with a non-default result mode, so the values Construct would store are not known here; set it back to "default" in the Construct 3 editor first.',
    { prepare: () => patchTimeline('Spare', timeline => { timeline.tracksRoot.resultMode = 'absolute'; }) });
  row('add_timeline_track', 'unknown instance variable', { ...addTrack, properties: ['var:nope'] }, '"Sprite" has no instance variable named "nope".');
  row('add_timeline_track', 'property whose value cannot be read', { ...addTrack, properties: ['offsetScaleX'] },
    'Cannot read the current value of "offsetScaleX" for instance UID 0 (its object type has no frame size to divide by).', { prepare: withoutFrames });
  row('add_timeline_track', 'property that matches nothing', { ...addTrack, properties: ['angle'] }, unknownProperty('angle'));
  row('add_timeline_track', 'property that matches nothing, next to a known one', { ...addTrack, properties: ['offsetX', 'mystery'] }, unknownProperty('mystery'));
  row('add_timeline_track', 'property that matches nothing, object type unreadable', { ...addTrack, properties: ['angle'] },
    'could not be read, so its instance variables and plugin properties are not known.', { partial: true, prepare: unreadableSprite });
  row('add_timeline_track', 'duplicate property', { ...addTrack, properties: ['offsetX', 'offsetX'] },
    'Duplicate property "offsetX" in properties; each property track must appear once.');
  row('add_timeline_track', 'time beyond the end', { ...addTrack, keyframeTimes: [9] }, outOfRange(9));

  // ─── remove_timeline_track ────────────────────────────────

  row('remove_timeline_track', 'unknown timeline', { timelineName: 'Nope', instanceUid: 0 }, notFound('Nope'));
  row('remove_timeline_track', 'instance with no track, others tracked', { timelineName: 'Move', instanceUid: 77 }, noTrack('Move', 77, ' Tracked instance UIDs: 0.'));
  row('remove_timeline_track', 'instance with no track, none tracked', { timelineName: 'Spare', instanceUid: 0 }, noTrack('Spare', 0, ' The timeline has no instance tracks.'));
  row('remove_timeline_track', 'neither instanceUid nor trackName', { timelineName: 'Move' }, EXACTLY_ONE);
  row('remove_timeline_track', 'both instanceUid and trackName', { timelineName: 'Move', instanceUid: 0, trackName: 'Level' }, EXACTLY_ONE);
  row('remove_timeline_track', 'unknown track name', { timelineName: 'Move', trackName: 'Nope' },
    'Timeline "Move" has no value or audio track named "Nope". Value and audio tracks: "Level".');

  // ─── add_property_track ───────────────────────────────────

  const addProperty = { timelineName: 'Move', instanceUid: 0, property: 'offsetWidth' };
  row('add_property_track', 'unknown timeline', { ...addProperty, timelineName: 'Nope' }, notFound('Nope'));
  row('add_property_track', 'instance with no track', { ...addProperty, instanceUid: 77 }, noTrack('Move', 77, ' Tracked instance UIDs: 0.'));
  row('add_property_track', 'an untyped track', { timelineName: 'Legacy', instanceUid: 0, property: 'offsetWidth' },
    'The track for instance UID 0 in timeline "Legacy" is an untyped track saved by an older Construct release. This tool would have to rewrite its keyframe values, and no fixture shows how Construct upgrades them; open and save the timeline in the Construct 3 editor first.',
    { prepare: withLegacy });
  row('add_property_track', 'folder that holds a result mode', addProperty, FOLDER_MODE, { prepare: withRootMode });
  row('add_property_track', 'instance that is not a world instance', addProperty, 'Instance UID 0 in layout "Layout 1" is not a world instance.', { prepare: withoutWorld });
  row('add_property_track', 'instance gone from every layout', addProperty,
    'Instance UID 0 was not found in any layout, so its current property values cannot be read. Remove the stale track with remove_timeline_track.',
    { prepare: () => patchLayout(layout => { layout.layers[0].instances = []; }) });
  row('add_property_track', 'a layout that is not JSON', addProperty,
    'Instance UID 0 was not found in the layouts that could be read, and layout "Layout 1" (layouts/Layout 1.json: not valid JSON) could not be read, so its current property values cannot be read. Fix or restore it first.',
    { prepare: async () => { await writeFile(file('layouts/Layout 1.json'), '{ broken', 'utf-8'); reader.invalidateCaches(); } });
  row('add_property_track', 'a layout whose file is gone', addProperty,
    'Instance UID 0 was not found in the layouts that could be read, and layout "Layout 1" (layouts/Layout 1.json: not found) could not be read, so its current property values cannot be read. Fix or restore it first.',
    { prepare: async () => { await rm(file('layouts/Layout 1.json')); reader.invalidateCaches(); } });
  row('add_property_track', 'unknown instance variable', { ...addProperty, property: 'var:nope' }, '"Sprite" has no instance variable named "nope".');
  row('add_property_track', 'property whose value cannot be read', { ...addProperty, property: 'offsetScaleX' },
    'Cannot read the current value of "offsetScaleX" for instance UID 0 (its object type has no frame size to divide by).', { prepare: withoutFrames });
  row('add_property_track', 'property that matches nothing', { ...addProperty, property: 'angle' }, unknownProperty('angle'));
  row('add_property_track', 'property that matches nothing, object type unreadable', { ...addProperty, property: 'angle' },
    'could not be read, so its instance variables and plugin properties are not known.', { partial: true, prepare: unreadableSprite });
  row('add_property_track', 'property track that exists', { ...addProperty, property: 'offsetX' },
    'Property track "offsetX" already exists on the track for instance UID 0. Use set_keyframe to change its values.');

  // ─── remove_property_track ────────────────────────────────

  row('remove_property_track', 'unknown timeline', { timelineName: 'Nope', instanceUid: 0, property: 'offsetX' }, notFound('Nope'));
  row('remove_property_track', 'instance with no track', { timelineName: 'Move', instanceUid: 77, property: 'offsetX' }, noTrack('Move', 77, ' Tracked instance UIDs: 0.'));
  row('remove_property_track', 'unknown property track', { timelineName: 'Move', instanceUid: 0, property: 'offsetWidth' },
    'Property track "offsetWidth" not found on the track for instance UID 0. Property tracks present: offsetX, offsetY.');

  // ─── set_keyframe ─────────────────────────────────────────

  const setOnMove = { timelineName: 'Move', instanceUid: 0, time: 2 };
  row('set_keyframe', 'unknown timeline', { ...setOnMove, timelineName: 'Nope' }, notFound('Nope'));
  row('set_keyframe', 'neither instanceUid nor trackName', { timelineName: 'Move', time: 2 }, EXACTLY_ONE);
  row('set_keyframe', 'both instanceUid and trackName', { ...setOnMove, trackName: 'Level' }, EXACTLY_ONE);
  row('set_keyframe', 'instance with no track', { ...setOnMove, instanceUid: 77 }, noTrack('Move', 77, ' Tracked instance UIDs: 0.'));
  row('set_keyframe', 'an untyped track', { timelineName: 'Legacy', instanceUid: 0, time: 1 },
    'The track for instance UID 0 in timeline "Legacy" is an untyped track saved by an older Construct release. This tool would have to rewrite its keyframe values, and no fixture shows how Construct upgrades them; open and save the timeline in the Construct 3 editor first.',
    { prepare: withLegacy });
  row('set_keyframe', 'time outside the timeline', { ...setOnMove, time: 9 }, outOfRange(9));
  row('set_keyframe', 'time below zero', { ...setOnMove, time: -1 }, outOfRange(-1));
  row('set_keyframe', 'more than 32 properties',
    { ...setOnMove, values: Object.fromEntries(Array.from({ length: 33 }, (_unused, i) => [`p${i}`, { absolute: 1 }])) },
    'Too many properties in values: 33 (max 32).');
  row('set_keyframe', 'values given to an audio track', { timelineName: 'Move', trackName: 'Sfx', time: 1, values: { value: { absolute: 1 } } },
    'track "Sfx" is an audio track: it has master keyframes only, so give no values.', { prepare: withAudio });
  row('set_keyframe', 'value track without a value property track', { timelineName: 'Move', trackName: 'Level', time: 1, values: { value: { absolute: 1 } } },
    'Value track "Level" has no "value" property track.',
    { prepare: () => patchTimeline('Move', timeline => { timeline.tracksRoot.subfolders[0].items[0].propertyTracks = []; }) });
  row('set_keyframe', 'value track given another property', { timelineName: 'Move', trackName: 'Level', time: 1, values: { offsetX: { absolute: 1 } } },
    'A value track has only the "value" property; "offsetX" is not accepted.');
  row('set_keyframe', 'value track given a relative value', { timelineName: 'Move', trackName: 'Level', time: 1, values: { value: { relative: 1 } } },
    'A value track stores absolute values only; give "absolute".');
  row('set_keyframe', 'value track given a value that is not a number', { timelineName: 'Move', trackName: 'Level', time: 1, values: { value: { absolute: 'x' } } },
    'A value track keyframe needs a number.');
  row('set_keyframe', 'value track with no keyframe at the time and no value', { timelineName: 'Move', trackName: 'Level', time: 2 },
    'track "Level" has no keyframe at time 2; give values.value.absolute to create one.');
  row('set_keyframe', 'folder that holds a result mode', setOnMove, FOLDER_MODE, { prepare: withRootMode });
  row('set_keyframe', 'instance gone from every layout', { ...setOnMove, values: { offsetX: { absolute: 1 } } },
    'Instance UID 0 was not found in any layout, so its current property values cannot be read. Remove the stale track with remove_timeline_track.',
    { prepare: () => patchLayout(layout => { layout.layers[0].instances = []; }) });
  row('set_keyframe', 'instance that is not a world instance', { ...setOnMove, values: { offsetX: { absolute: 1 } } },
    'Instance UID 0 in layout "Layout 1" is not a world instance.', { prepare: withoutWorld });
  row('set_keyframe', 'a layout whose file is gone', { ...setOnMove, values: { offsetX: { absolute: 1 } } },
    'Instance UID 0 was not found in the layouts that could be read, and layout "Layout 1" (layouts/Layout 1.json: not found) could not be read, so its current property values cannot be read. Fix or restore it first.',
    { prepare: async () => { await rm(file('layouts/Layout 1.json')); reader.invalidateCaches(); } });
  row('set_keyframe', 'unknown instance variable', { ...setOnMove, values: { 'var:nope': { absolute: 1 } } }, '"Sprite" has no instance variable named "nope".');
  row('set_keyframe', 'property whose value cannot be read', { ...setOnMove, values: { offsetScaleX: { absolute: 1 } } },
    'Cannot read the current value of "offsetScaleX" for instance UID 0.', { prepare: withoutFrames });
  row('set_keyframe', 'number property given text', { ...setOnMove, values: { offsetX: { absolute: 'x' } } }, '"offsetX" needs a number.');
  row('set_keyframe', 'number property with neither value', { ...setOnMove, values: { offsetX: {} } }, 'Property "offsetX" needs an "absolute" or a "relative" value.');
  row('set_keyframe', 'color given a relative value', { ...setOnMove, values: { offsetColor: { relative: 1 } } }, 'Property "offsetColor" is a color; give "absolute" only.');
  row('set_keyframe', 'color with no value', { ...setOnMove, values: { offsetColor: {} } }, 'Property "offsetColor" needs an "absolute" value.');
  row('set_keyframe', 'color given text', { ...setOnMove, values: { offsetColor: { absolute: 'x' } } }, '"offsetColor" needs [r, g, b, a] with each part from 0 to 1.');
  row('set_keyframe', 'property that matches nothing, given both values', { ...setOnMove, values: { angle: { absolute: 90, relative: 15 } } }, unknownProperty('angle'));
  row('set_keyframe', 'property that matches nothing, given one value', { ...setOnMove, values: { mystery: { absolute: 1 } } }, unknownProperty('mystery'));
  row('set_keyframe', 'property that matches nothing, next to a known one', { ...setOnMove, values: { offsetX: { absolute: 1 }, angle: { absolute: 90, relative: 15 } } }, unknownProperty('angle'));
  row('set_keyframe', 'property that matches nothing, object type unreadable', { ...setOnMove, values: { angle: { absolute: 90, relative: 15 } } },
    'could not be read, so its instance variables and plugin properties are not known.', { partial: true, prepare: unreadableSprite });

  // ─── delete_keyframe ──────────────────────────────────────

  row('delete_keyframe', 'unknown timeline', { timelineName: 'Nope', instanceUid: 0, time: 1 }, notFound('Nope'));
  row('delete_keyframe', 'neither instanceUid nor trackName', { timelineName: 'Move', time: 1 }, EXACTLY_ONE);
  row('delete_keyframe', 'instance with no track', { timelineName: 'Move', instanceUid: 77, time: 1 }, noTrack('Move', 77, ' Tracked instance UIDs: 0.'));
  row('delete_keyframe', 'property given for a value track', { timelineName: 'Move', trackName: 'Level', time: 0, property: 'value' },
    'Track "Level" is a value track; its property keyframes follow its master keyframes, so delete the master keyframe instead (omit "property").');
  row('delete_keyframe', 'property given for an audio track', { timelineName: 'Move', trackName: 'Sfx', time: 1.5, property: 'audioSource' },
    'Track "Sfx" is an audio track; its property keyframes follow its master keyframes, so delete the master keyframe instead (omit "property").', { prepare: withAudio });
  row('delete_keyframe', 'unknown property track', { timelineName: 'Move', instanceUid: 0, time: 1, property: 'offsetWidth' },
    'Property track "offsetWidth" not found on the track for instance UID 0.');
  row('delete_keyframe', 'property track with no keyframe at the time', { timelineName: 'Move', instanceUid: 0, time: 9, property: 'offsetX' },
    'Property track "offsetX" has no keyframe at time 9.');
  row('delete_keyframe', 'no master keyframe at the time', { timelineName: 'Move', instanceUid: 0, time: 9 },
    'The track for instance UID 0 has no master keyframe at time 9. Keyframe times: 0, 1.');
  row('delete_keyframe', 'last master keyframe', { timelineName: 'Move', trackName: 'Level', time: 0 },
    'Refusing to delete the last master keyframe of track "Level": a track with no keyframes is not a valid track. Use remove_timeline_track to remove the whole track.');
  row('delete_keyframe', 'audio track keyframe at time 0', { timelineName: 'Move', trackName: 'Sfx', time: 0 },
    'Track "Sfx" is an audio track, which needs its keyframe at time 0. Delete a later keyframe, or remove_timeline_track to remove the whole track.',
    { prepare: withAudio });

  // ─── update_track ─────────────────────────────────────────

  row('update_track', 'unknown timeline', { timelineName: 'Nope', instanceUid: 0, enabled: false }, notFound('Nope'));
  row('update_track', 'no updates', { timelineName: 'Move', instanceUid: 0 },
    'No updates provided. Specify at least one of: enabled, ease, interpolationMode, resultMode, pathMode, initialVisibility, name, audioFile, audioStartOffset, audioTag.');
  row('update_track', 'neither instanceUid nor trackName', { timelineName: 'Move', enabled: false }, EXACTLY_ONE);
  row('update_track', 'both instanceUid and trackName', { timelineName: 'Move', instanceUid: 0, trackName: 'Level', enabled: false }, EXACTLY_ONE);
  row('update_track', 'instance with no track', { timelineName: 'Move', instanceUid: 77, enabled: false }, noTrack('Move', 77, ' Tracked instance UIDs: 0.'));
  row('update_track', 'result mode on a value track', { timelineName: 'Move', trackName: 'Level', resultMode: 'absolute' }, 'A value track has no result mode.');
  row('update_track', 'result mode on an untyped track', { timelineName: 'Legacy', instanceUid: 0, resultMode: 'absolute' },
    'Changing the result mode of an untyped (older) track would leave its stored values stale; open and save the timeline in the Construct 3 editor first.',
    { prepare: withLegacy });
  row('update_track', 'result mode with a folder that holds one', { timelineName: 'Move', instanceUid: 0, resultMode: 'absolute' }, FOLDER_MODE, { prepare: withRootMode });
  row('update_track', 'path mode on a value track', { timelineName: 'Move', trackName: 'Level', pathMode: 'line' }, 'A value track has no path mode.');
  row('update_track', 'name on an instance track', { timelineName: 'Move', instanceUid: 0, name: 'Renamed' }, 'Only value and audio tracks have a name.');
  row('update_track', 'audio field on an instance track', { timelineName: 'Move', instanceUid: 0, audioTag: 'x' }, 'audioFile, audioStartOffset and audioTag apply to audio tracks only.');
  row('update_track', 'invalid new name', { timelineName: 'Move', trackName: 'Level', name: 'Bad/Name' }, NAME_RULE);
  row('update_track', 'new name used by another track', { timelineName: 'Move', trackName: 'Level', name: 'Blur' },
    'Timeline "Move" already has a value or audio track named "Blur".', { prepare: withBlur });
  row('update_track', 'audio track without an audioSource property track', { timelineName: 'Move', trackName: 'Sfx', audioTag: 'x' },
    'Audio track "Sfx" has no audioSource property track.',
    { prepare: async () => { await withAudio(); await patchTimeline('Move', timeline => { timeline.tracks.find(track => track.name === 'Sfx')!.propertyTracks = []; }); } });
  row('update_track', 'audio file that is not registered', { timelineName: 'Move', trackName: 'Sfx', audioFile: 'Nope.webm' },
    'Audio file "Nope.webm" is not registered in the project\'s sound or music files. Import it into Sounds or Music in the Construct 3 editor first.', { prepare: withAudio });

  // ─── add_value_track ──────────────────────────────────────

  row('add_value_track', 'unknown timeline', { timelineName: 'Nope', name: 'Zoom' }, notFound('Nope'));
  row('add_value_track', 'invalid name', { timelineName: 'Move', name: 'Bad/Name' }, NAME_RULE);
  row('add_value_track', 'duplicate name', { timelineName: 'Move', name: 'Level' }, 'Timeline "Move" already has a value or audio track named "Level".');
  row('add_value_track', 'a time given twice', { timelineName: 'Move', name: 'Zoom', keyframes: [{ time: 1, value: 1 }, { time: 1, value: 2 }] }, 'Each keyframe time may appear once.');
  row('add_value_track', 'time beyond the end', { timelineName: 'Move', name: 'Zoom', keyframes: [{ time: 9, value: 1 }] }, outOfRange(9));
  row('add_value_track', 'missing folder', { timelineName: 'Move', name: 'Zoom', folder: 'Nope' }, `No track folder "Nope". ${FOLDERS}`);

  // ─── add_audio_track ──────────────────────────────────────

  const addAudio = { timelineName: 'Move', audioFile: 'Beep.webm' };
  row('add_audio_track', 'unknown timeline', { ...addAudio, timelineName: 'Nope' }, notFound('Nope'));
  row('add_audio_track', 'file that is not registered', { ...addAudio, audioFile: 'Nope.webm' },
    'Audio file "Nope.webm" is not registered in the project\'s sound or music files. Import it into Sounds or Music in the Construct 3 editor first.');
  row('add_audio_track', 'file that is not in the chosen folder', { ...addAudio, audioFolder: 'music' },
    'Audio file "Beep.webm" is not registered in the project\'s music files. Import it into Sounds or Music in the Construct 3 editor first.');
  row('add_audio_track', 'file registered as sound and music', addAudio,
    'Audio file "Beep.webm" is registered more than once (sound, music); pass audioFolder to choose sound or music.',
    { prepare: () => editProject(project => { project.rootFileFolders.music.items.push(MUSIC_SAME_NAME); }) });
  row('add_audio_track', 'invalid name', { ...addAudio, name: 'Bad/Name' }, NAME_RULE);
  row('add_audio_track', 'duplicate name', { ...addAudio, name: 'Level' }, 'Timeline "Move" already has a value or audio track named "Level".');
  row('add_audio_track', 'time beyond the end', { ...addAudio, keyframeTimes: [0, 9] }, outOfRange(9));
  row('add_audio_track', 'first keyframe not at time 0', { ...addAudio, keyframeTimes: [1] },
    'An audio track needs its first keyframe at time 0. Include 0 in keyframeTimes.');
  row('add_audio_track', 'missing folder', { ...addAudio, folder: 'Nope' }, `No track folder "Nope". ${FOLDERS}`);

  // ─── track folders ────────────────────────────────────────

  row('add_timeline_folder', 'unknown timeline', { timelineName: 'Nope', name: 'New' }, notFound('Nope'));
  row('add_timeline_folder', 'name with a slash', { timelineName: 'Move', name: 'A/B' }, 'Folder names cannot contain "/".');
  row('add_timeline_folder', 'name with a control character', { timelineName: 'Move', name: 'A\u0001B' }, 'Folder names cannot contain control characters.');
  row('add_timeline_folder', 'name with a delete character', { timelineName: 'Move', name: 'A\u007fB' }, 'Folder names cannot contain control characters.');
  row('add_timeline_folder', 'unknown parent folder', { timelineName: 'Move', name: 'New', parentFolder: 'Nope' }, `No track folder "Nope". ${FOLDERS}`);
  row('add_timeline_folder', 'folder that exists', { timelineName: 'Move', name: 'Group' }, 'A track folder named "Group" already exists there.');

  row('rename_timeline_folder', 'unknown timeline', { timelineName: 'Nope', folder: 'Group', newName: 'New' }, notFound('Nope'));
  row('rename_timeline_folder', 'name with a slash', { timelineName: 'Move', folder: 'Group', newName: 'A/B' }, 'Folder names cannot contain "/".');
  row('rename_timeline_folder', 'name with a control character', { timelineName: 'Move', folder: 'Group', newName: 'A\tB' }, 'Folder names cannot contain control characters.');
  row('rename_timeline_folder', 'the root folder', { timelineName: 'Move', folder: '', newName: 'New' }, 'The root folder cannot be renamed.');
  row('rename_timeline_folder', 'unknown folder', { timelineName: 'Move', folder: 'Nope', newName: 'New' }, `No track folder "Nope". ${FOLDERS}`);
  row('rename_timeline_folder', 'name of a sibling', { timelineName: 'Move', folder: 'Group', newName: 'Other' }, 'A track folder named "Other" already exists there.');

  row('delete_timeline_folder', 'unknown timeline', { timelineName: 'Nope', folder: 'Group' }, notFound('Nope'));
  row('delete_timeline_folder', 'the root folder', { timelineName: 'Move', folder: '' }, 'The root folder cannot be deleted.');
  row('delete_timeline_folder', 'unknown folder', { timelineName: 'Move', folder: 'Nope' }, `No track folder "Nope". ${FOLDERS}`);
  row('delete_timeline_folder', 'folder with a result mode that holds an instance track', { timelineName: 'Move', folder: 'Other' },
    'Deleting track folder "Other" would move a track out of a folder with result mode "absolute". No fixture holds a folder with a non-default result mode, so the values Construct would store are not known here; move the track or delete the folder in the Construct 3 editor, or pass deleteContents to delete the tracks with it.',
    {
      prepare: async () => {
        await ok('move_timeline_track', { timelineName: 'Move', instanceUid: 0, folder: 'Other' });
        await patchTimeline('Move', timeline => { timeline.tracksRoot.subfolders[1].resultMode = 'absolute'; });
      },
    });

  row('delete_timeline_folder', 'subfolder whose name the parent already has', { timelineName: 'Move', folder: 'Other' },
    'Cannot move subfolder "Group" up: the parent already has a folder of that name. Rename one first or pass deleteContents.',
    { prepare: async () => { await ok('add_timeline_folder', { timelineName: 'Move', name: 'Group', parentFolder: 'Other' }); } });

  row('move_timeline_track', 'unknown timeline', { timelineName: 'Nope', instanceUid: 0, folder: 'Other' }, notFound('Nope'));
  row('move_timeline_track', 'neither instanceUid nor trackName', { timelineName: 'Move', folder: 'Other' }, EXACTLY_ONE);
  row('move_timeline_track', 'both instanceUid and trackName', { timelineName: 'Move', instanceUid: 0, trackName: 'Level', folder: 'Other' }, EXACTLY_ONE);
  row('move_timeline_track', 'instance with no track', { timelineName: 'Move', instanceUid: 77, folder: 'Other' }, noTrack('Move', 77, ' Tracked instance UIDs: 0.'));
  row('move_timeline_track', 'track already in the folder', { timelineName: 'Move', trackName: 'Level', folder: 'Group' }, 'The track is already in track folder "Group".');
  row('move_timeline_track', 'track already at the root', { timelineName: 'Move', instanceUid: 0, folder: '' }, 'The track is already in the root.');
  row('move_timeline_track', 'missing destination', { timelineName: 'Move', instanceUid: 0, folder: 'Nope' }, `No track folder "Nope". ${FOLDERS}`);
  row('move_timeline_track', 'folder on the way that holds a result mode', { timelineName: 'Move', instanceUid: 0, folder: 'Other' },
    'A track folder on the way has result mode "absolute". No fixture holds a folder with a non-default result mode, so moving this track could change its values in ways the tools cannot check; move it in the Construct 3 editor.',
    { prepare: withRootMode });

  // ─── eases ────────────────────────────────────────────────

  row('create_ease', 'invalid name', { name: '1bad', points: LINE }, NAME_RULE);
  row('create_ease', 'name of a built-in ease', { name: 'easeinsine', points: LINE }, '"easeinsine" is one of Construct\'s own ease names; choose another name.');
  row('create_ease', 'name of a built-in ease in capitals', { name: 'EASEINSINE', points: LINE }, '"EASEINSINE" is one of Construct\'s own ease names; choose another name.');
  row('create_ease', 'existing name', { name: 'Bouncy', points: LINE }, 'Custom ease "Bouncy" already exists.');
  row('create_ease', 'case variant of a registered name', { name: 'bouncy', points: LINE },
    'A custom ease whose name differs from "bouncy" only in letter case is registered. Names are matched with their letter case. Did you mean "Bouncy"?');
  row('create_ease', 'name of a timeline', { name: 'Move', points: LINE }, '"Move" is already the name of a timeline in this project; choose another ease name.');
  row('create_ease', 'first point not at the origin', { name: 'Fresh', points: [{ x: 0.1, y: 0 }, { x: 1, y: 1 }] }, 'The first ease point must be at x 0, y 0.');
  row('create_ease', 'last point not at 1, 1', { name: 'Fresh', points: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] }, 'The last ease point must be at x 1, y 1.');
  row('create_ease', 'x values that do not increase', { name: 'Fresh', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }] },
    'Ease point x values must increase strictly (point 2 has x 0.5).');
  row('create_ease', 'incoming handle on the first point', { name: 'Fresh', points: [{ x: 0, y: 0, endHandle: { x: -0.1, y: 0 } }, { x: 1, y: 1 }] },
    'The first ease point has no incoming handle; give startHandle only.');
  row('create_ease', 'outgoing handle on the last point', { name: 'Fresh', points: [{ x: 0, y: 0 }, { x: 1, y: 1, startHandle: { x: 0.1, y: 0 } }] },
    'The last ease point has no outgoing handle; give endHandle only.');
  row('create_ease', 'file already on disk', { name: 'Ghost', points: LINE },
    'timelines/transitions/Ghost.json already exists on disk but is not registered; remove or register it first.',
    { prepare: () => writeFile(file('timelines/transitions/Ghost.json'), '{}', 'utf-8') });

  row('update_ease', 'no updates', { name: 'Bouncy' }, 'No updates provided. Specify points or linear.');
  row('update_ease', 'unknown ease', { name: 'Nope', linear: true }, noEase('Nope'));
  row('update_ease', 'case variant of a name', { name: 'bouncy', linear: true }, easeCaseHint('bouncy', 'Bouncy'));
  row('update_ease', 'bad points', { name: 'Bouncy', points: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] }, 'The last ease point must be at x 1, y 1.');
  row('update_ease', 'ease file that cannot be read', { name: 'Bouncy', linear: true },
    'Custom ease "Bouncy" is registered but timelines/transitions/Bouncy.json could not be read (ENOENT).', { prepare: () => rm(file('timelines/transitions/Bouncy.json')) });
  row('update_ease', 'timelines that cannot be read', { name: 'Bouncy', linear: true },
    'Custom ease "Bouncy" was not updated: timeline "Hollow", timeline "Broken" could not be read, so a copy of the ease in them could not be refreshed. Fix or remove them first.',
    { prepare: async () => { await withHollow(); await registerTimelineFile('Broken', '{ broken'); } });
  row('update_ease', 'event sheet that cannot be read', { name: 'Bouncy', linear: true },
    'Custom ease "Bouncy" was not updated: event sheet "MainSheet" could not be read, so a copy of the ease in it could not be refreshed. Fix or remove it first.',
    { prepare: () => writeFile(file('eventSheets/MainSheet.json'), '{ broken', 'utf-8') });

  row('delete_ease', 'unknown ease', { name: 'Nope' }, noEase('Nope'));
  row('delete_ease', 'case variant of a name', { name: 'bouncy' }, easeCaseHint('bouncy', 'Bouncy'));
  row('delete_ease', 'ease used by a timeline', { name: 'Smooth' },
    'Custom ease "Smooth" is used by timeline(s) Move; change those eases first (update_timeline, update_track, set_keyframe).');
  row('delete_ease', 'event sheet that cannot be read, without force', { name: 'Bouncy' },
    'Custom ease "Bouncy" was not deleted: event sheet "MainSheet" could not be read. Check those uses, then pass force: true to delete anyway.',
    { prepare: () => writeFile(file('eventSheets/MainSheet.json'), '{ broken', 'utf-8') });
  row('delete_ease', 'script that cannot be read, besides a use in an event sheet', { name: 'Bouncy' },
    'Custom ease "Bouncy" was not deleted: the name "Bouncy" appears in event sheet "MainSheet" (for example as a Tween ease); script "scripts/gone.js" could not be read. Check those uses, then pass force: true to delete anyway.',
    {
      prepare: () => editProject(project => {
        project.rootFileFolders.script.items.push({ name: 'gone.js', type: 'application/javascript', sid: 700000000000009, 'script-info': { purpose: 'import' } });
      }),
    });
  row('delete_ease', 'ease named in an event sheet, without force', { name: 'Bouncy' },
    'Custom ease "Bouncy" was not deleted: the name "Bouncy" appears in event sheet "MainSheet" (for example as a Tween ease). Check those uses, then pass force: true to delete anyway.');

  it('has a row for every tool that writes', () => {
    const tools = new Set(rows.map(r => r.tool));
    for (const name of [
      'create_timeline', 'update_timeline', 'delete_timeline', 'add_timeline_track', 'remove_timeline_track', 'add_property_track',
      'remove_property_track', 'set_keyframe', 'delete_keyframe', 'update_track', 'add_value_track', 'add_audio_track',
      'add_timeline_folder', 'rename_timeline_folder', 'delete_timeline_folder', 'move_timeline_track',
      'create_ease', 'update_ease', 'delete_ease',
    ]) expect(tools.has(name), name).toBe(true);
  });

  it.each(rows)('$tool refuses $kind and changes nothing', async (r) => {
    await r.prepare?.();
    const before = await hashProject();

    const result = await call(r.tool, r.args);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    if (r.partial) expect(text).toContain(r.text);
    else expect(text).toBe(`${r.text} ${END}`);
    expect(text.endsWith(END)).toBe(true);
    expect(text.split(END)).toHaveLength(2);
    expectNoProjectFolder(text);
    expect(await hashProject()).toEqual(before);
  });

  // ─── read-only tools ──────────────────────────────────────

  const readOnly: Array<Omit<Row, 'partial'>> = [
    { tool: 'get_timeline_details', kind: 'unknown timeline', args: { name: 'Nope' }, text: 'Timeline "Nope" not found.\nAvailable timelines: Move, Spare' },
    { tool: 'get_timeline_details', kind: 'case variant of a name', args: { name: 'move' }, text: caseHint('move', 'Move') },
    { tool: 'get_timeline_details', kind: 'a transition', args: { name: 'Smooth' }, text: transitionText('Smooth') },
    {
      tool: 'get_timeline_details', kind: 'a file without tracks', args: { name: 'Hollow' }, prepare: withHollow,
      text: 'Timeline "Hollow" is registered in the project but its file timelines/Hollow.json holds no tracks, so it is not a timeline (a custom ease file looks like this; see list_eases).',
    },
    { tool: 'list_timeline_tracks', kind: 'unknown timeline', args: { timelineName: 'Nope' }, text: notFound('Nope') },
    { tool: 'list_timeline_tracks', kind: 'case variant of a name', args: { timelineName: 'move' }, text: caseHint('move', 'Move') },
    { tool: 'list_timeline_tracks', kind: 'a transition', args: { timelineName: 'Smooth' }, text: transitionText('Smooth') },
  ];

  it.each(readOnly)('$tool answers $kind as a plain error', async (r) => {
    await r.prepare?.();
    const before = await hashProject();

    const result = await call(r.tool, r.args);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toBe(r.text);
    expect(text).not.toContain(END);
    expectNoProjectFolder(text);
    expect(await hashProject()).toEqual(before);
  });

  // ─── broken and missing timeline files ────────────────────

  it('words a broken or missing timeline file without a path, and the tools that write change nothing', async () => {
    await writeFile(file('timelines/Move.json'), '{ broken', 'utf-8');
    await rm(file('timelines/Spare.json'));
    const before = await hashProject();
    const unreadable = (name: string) => `Timeline "${name}" is registered in the project but its file timelines/${name}.json could not be read (`;

    const opens: Array<{ tool: string; args: (name: string) => Record<string, unknown>; writes: boolean }> = [
      { tool: 'get_timeline_details', args: name => ({ name }), writes: false },
      { tool: 'list_timeline_tracks', args: name => ({ timelineName: name }), writes: false },
      { tool: 'update_timeline', args: name => ({ name, loop: true }), writes: true },
      { tool: 'add_timeline_track', args: name => ({ timelineName: name, layoutName: 'Layout 1', instanceUid: 0 }), writes: true },
    ];
    for (const { tool, args, writes } of opens) {
      for (const [name, detail] of [['Move', ''], ['Spare', 'ENOENT).']] as const) {
        const result = await call(tool, args(name));
        const text = result.content[0].text;
        expect(result.isError, `${tool} ${name}`).toBe(true);
        expect(text, `${tool} ${name}`).toContain(unreadable(name) + detail);
        expect(text.endsWith(END), `${tool} ${name}`).toBe(writes);
        if (writes) expect(text.endsWith(`). ${END}`), `${tool} ${name}`).toBe(true);
        expectNoProjectFolder(text);
        expect(await hashProject(), `${tool} ${name}`).toEqual(before);
      }
    }

    const deleted = await call('delete_timeline', { name: 'Move' });
    expect(deleted.isError).toBe(true);
    expect(deleted.content[0].text).toContain('Timeline "Move" is registered but its file timelines/Move.json could not be read (');
    expect(deleted.content[0].text.endsWith(`), so it was not deleted. Check it with get_timeline_details. ${END}`)).toBe(true);
    expectNoProjectFolder(deleted.content[0].text);
    expect(await readFile(file('timelines/Move.json'), 'utf-8')).toBe('{ broken');
    expect(await hashProject()).toEqual(before);

    const updated = await call('update_ease', { name: 'Bouncy', linear: true });
    expect(updated.isError).toBe(true);
    expect(updated.content[0].text).toBe(`Custom ease "Bouncy" was not updated: timeline "Move", timeline "Spare" could not be read, so a copy of the ease in them could not be refreshed. Fix or remove them first. ${END}`);
    const removed = await call('delete_ease', { name: 'Bouncy' });
    expect(removed.isError).toBe(true);
    expect(removed.content[0].text).toBe(`Timeline(s) Move, Spare could not be opened, so it is unknown whether they use custom ease "Bouncy". Fix or remove them first. ${END}`);
    for (const result of [updated, removed]) expectNoProjectFolder(result.content[0].text);
    expect(await hashProject()).toEqual(before);
  });

  it('words a timeline file that cannot be read with the error code, not the error text', async () => {
    // A folder where the file should be: reading it fails with EISDIR, whose own text differs from its code
    await rm(file('timelines/Move.json'));
    await mkdir(file('timelines/Move.json'));
    const before = await hashProject();
    const wording = 'Timeline "Move" is registered in the project but its file timelines/Move.json could not be read (EISDIR).';

    const read = await call('get_timeline_details', { name: 'Move' });
    expect(read.isError).toBe(true);
    expect(read.content[0].text).toBe(wording);
    const written = await call('update_timeline', { name: 'Move', loop: true });
    expect(written.isError).toBe(true);
    expect(written.content[0].text).toBe(`${wording} ${END}`);
    for (const result of [read, written]) expectNoProjectFolder(result.content[0].text);
    expect(await hashProject()).toEqual(before);
  });

  // ─── the catch blocks ─────────────────────────────────────

  /** An error as a file system raises it, holding an absolute path inside the project. */
  const failureAt = (code: string, doing: string, ...parts: string[]) => new Error(`${code}: ${doing} '${join(tmpDir, ...parts)}'`);

  const catches: Array<{ tool: string; args: Record<string, unknown>; arm: () => { called: () => boolean }; text: string }> = [
    {
      tool: 'update_timeline', args: { name: 'Move', loop: true },
      arm: () => { const spy = vi.spyOn(writer, 'replaceFile').mockRejectedValue(failureAt('EACCES', 'permission denied, open', 'timelines', 'Move.json')); return { called: () => spy.mock.calls.length > 0 }; },
      text: "Error updating timeline: EACCES: permission denied, open 'timelines/Move.json'",
    },
    {
      tool: 'add_timeline_track', args: { timelineName: 'Spare', layoutName: 'Layout 1', instanceUid: 0 },
      arm: () => { const spy = vi.spyOn(reader, 'listLayouts').mockRejectedValueOnce(failureAt('EIO', 'i/o error, scandir', 'layouts')); return { called: () => spy.mock.calls.length > 0 }; },
      text: "Error adding timeline track: EIO: i/o error, scandir 'layouts'",
    },
    {
      tool: 'add_value_track', args: { timelineName: 'Move', name: 'Zoom' },
      arm: () => { const spy = vi.spyOn(writer, 'replaceFile').mockRejectedValue(failureAt('EACCES', 'permission denied, open', 'timelines', 'Move.json')); return { called: () => spy.mock.calls.length > 0 }; },
      text: "Error adding value track: EACCES: permission denied, open 'timelines/Move.json'",
    },
    {
      tool: 'update_ease', args: { name: 'Bouncy', linear: true },
      arm: () => { const spy = vi.spyOn(reader, 'listEventSheets').mockRejectedValueOnce(failureAt('EIO', 'i/o error, scandir', 'eventSheets')); return { called: () => spy.mock.calls.length > 0 }; },
      text: "Error updating ease: EIO: i/o error, scandir 'eventSheets'",
    },
    {
      tool: 'delete_ease', args: { name: 'Bouncy' },
      arm: () => { const spy = vi.spyOn(reader, 'listEventSheets').mockRejectedValueOnce(failureAt('EIO', 'i/o error, scandir', 'eventSheets')); return { called: () => spy.mock.calls.length > 0 }; },
      text: "Error deleting ease: EIO: i/o error, scandir 'eventSheets'",
    },
    {
      tool: 'list_eases', args: {},
      arm: () => { const spy = vi.spyOn(reader, 'listEventSheets').mockRejectedValueOnce(failureAt('EIO', 'i/o error, scandir', 'eventSheets')); return { called: () => spy.mock.calls.length > 0 }; },
      text: "Error listing eases: EIO: i/o error, scandir 'eventSheets'",
    },
    {
      // The lookup reads the project's timelines container first; the reader failing there is not one of the lookup's own refusals
      tool: 'list_timeline_tracks', args: { timelineName: 'Move' },
      arm: () => {
        // The original is taken before the spy replaces it, so a later call cannot reach the spy again
        const getProject = reader.getProject.bind(reader);
        const spy = vi.spyOn(reader, 'getProject');
        let armed = false;
        spy.mockImplementation(() => {
          if (armed) return getProject();
          armed = true;
          throw failureAt('EIO', 'i/o error, read', 'project.c3proj');
        });
        return { called: () => armed };
      },
      text: "Error listing timeline tracks: EIO: i/o error, read 'project.c3proj'",
    },
  ];

  it.each(catches)('$tool words an unexpected failure project-relative', async (c) => {
    const before = await hashProject();
    const probe = c.arm();
    // The handler logs the failure to stderr before it words it
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await call(c.tool, c.args);

    expect(probe.called()).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(c.text);
    expectNoProjectFolder(result.content[0].text);
    expect(await hashProject()).toEqual(before);
  });
});
