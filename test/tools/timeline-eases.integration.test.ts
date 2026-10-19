/**
 * Real-filesystem tests for the custom ease tools (list_eases, create_ease,
 * update_ease, delete_ease): the files they write, the order they write
 * them in, and what a failed or refused call leaves on disk.
 *
 * Shapes are compared, key order included, against
 * test/fixtures/timeline-kinds/shapes-r495.json, which holds the key order and
 * leaf types (no values) of timelines saved by the Construct 3 r495.2 editor.
 * The project is a temp copy of test/fixtures/minimal-project with a second
 * event sheet, `Second`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, readdir, writeFile, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { StaleFileError } from '../../src/construct3/disk-state.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter, UnconfirmedWriteError } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { easeParameterValue, forEachEaseParameter, EASE_PARAMETER_KEY } from '../../src/construct3/ease-params.js';
import type { CustomEase } from '../../src/construct3/timeline-model.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const KINDS_DIR = join(__dirname, '..', 'fixtures', 'timeline-kinds');
const OUTSIDE = '{ "outside": "a save made by another program, of another length" }';

/** A keyframe, track, folder, timeline or project read back from disk: the parts the tests navigate, the rest unknown. */
interface Json {
  [key: string]: unknown;
  name: string;
  items: string[];
  subfolders: Json[];
  tracks: Json[];
  transitionsData: Array<{ json: Json }>;
  transitionKeyframes: Array<Record<string, unknown>>;
  linear: boolean;
}

/** The parts of project.c3proj these tests change. */
interface ProjectJson {
  rootFileFolders: Record<string, { items: unknown[]; subfolders: unknown[] } | undefined>;
  timelines: { items: string[]; subfolders: Array<{ name?: string; items: string[]; subfolders: unknown[] }> };
  eventSheets: { items: string[] };
}

/** An event sheet as the tests write one. */
interface SheetJson {
  events: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** A tool result. */
interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function parseResult(result: ToolResponse) {
  return JSON.parse(result.content[0].text) as Json;
}

/** Key order and leaf types, arrays reduced to their first element (as the fixture was built). */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = shapeOf(entry);
    return out;
  }
  return typeof value;
}

/** Order-sensitive shape comparison. */
function expectShape(actual: unknown, expected: unknown) {
  expect(JSON.stringify(shapeOf(actual))).toBe(JSON.stringify(expected));
}

/** The path as the writer sees it, with `/` separators. */
const slashed = (path: string) => path.replace(/\\/g, '/');

describe('custom eases (real project on disk)', () => {
  let tmpDir: string;
  let server: MockServer;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let shapes: Record<string, Json>;
  let nextSid = 800000000000001;

  const file = (rel: string) => join(tmpDir, ...rel.split('/'));
  const readText = (rel: string) => readFile(file(rel), 'utf-8');

  beforeEach(async () => {
    shapes = JSON.parse(await readFile(join(KINDS_DIR, 'shapes-r495.json'), 'utf-8')) as Record<string, Json>;
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-timeline-eases-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const main = JSON.parse(await readFile(file('eventSheets/MainSheet.json'), 'utf-8')) as SheetJson;
    await writeFile(file('eventSheets/Second.json'), JSON.stringify({ ...main, name: 'Second' }, null, '\t'), 'utf-8');
    const project = JSON.parse(await readFile(file('project.c3proj'), 'utf-8')) as ProjectJson;
    project.eventSheets.items.push('Second');
    await writeFile(file('project.c3proj'), JSON.stringify(project, null, '\t'), 'utf-8');
    await boot();
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

  async function call(name: string, args: Record<string, unknown>) {
    return server.callTool(name, args);
  }

  async function ok(name: string, args: Record<string, unknown>) {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
    return parseResult(result);
  }

  async function fails(name: string, args: Record<string, unknown>, text: string) {
    const result = await call(name, args);
    expect(result.isError, `${name} should fail`).toBe(true);
    expect(result.content[0].text).toContain(text);
    expect(result.content[0].text).toMatch(/Nothing was changed\.$/);
  }

  async function onDisk(name = 'Move', ...folders: string[]): Promise<Json> {
    return JSON.parse(await readFile(join(tmpDir, 'timelines', ...folders, `${name}.json`), 'utf-8')) as Json;
  }

  async function projectJson(): Promise<ProjectJson> {
    return JSON.parse(await readText('project.c3proj')) as ProjectJson;
  }

  async function editProject(change: (project: ProjectJson) => void): Promise<void> {
    const project = await projectJson();
    change(project);
    await writeFile(file('project.c3proj'), JSON.stringify(project, null, '\t'), 'utf-8');
  }

  /** The bytes of every file under the project folder, by project-relative path, leaving out the `.bak` files a rolled-back write leaves. */
  async function snapshot(dir = tmpDir): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(files, await snapshot(path));
      else if (!entry.name.endsWith('.bak')) files[relative(tmpDir, path).split('\\').join('/')] = await readFile(path, 'utf-8');
    }
    return files;
  }

  async function createMove() {
    await ok('create_timeline', { name: 'Move', totalTime: 5 });
  }

  // ─── custom eases ─────────────────────────────────────────

  describe('custom eases', () => {
    const POINTS = [
      { x: 0, y: 0, startHandle: { x: 0.433, y: 1.329 } },
      { x: 1, y: 1, endHandle: { x: -0.355, y: 0.009 } },
    ];

    it('creates an ease file and registration shaped like the r495 fixture', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      const ease = JSON.parse(await readText('timelines/transitions/Swoop.json')) as Json;
      expectShape(ease, shapes.ease);
      expect(ease).toEqual({
        name: 'Swoop', linear: false, purpose: 'any',
        transitionKeyframes: [
          { x: 0, y: 0, sax: 0.433, say: 1.329, eax: 0, eay: 0, se: true, ee: false, sm: 'cubic' },
          { x: 1, y: 1, sax: 0, say: 0, eax: -0.355, eay: 0.009, se: false, ee: true, sm: 'cubic' },
        ],
      });
      const timelines = (await projectJson()).timelines;
      expect(timelines.subfolders[0]).toEqual({ items: ['Swoop'], subfolders: [] });

      await ok('create_timeline', { name: 'Move' });
      expectShape((await projectJson()).timelines, shapes.projectTimelines);
      expect((await ok('list_timelines', {})).timelines).toEqual(['Move']);
      const listed = await ok('list_eases', {});
      expect((listed.eases as Json[]).map(e => [e.name, e.usedBy])).toEqual([['Swoop', []]]);
    });

    it('finds and reuses the Transitions folder when a named folder comes before it', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      const project = await projectJson();
      const eases = project.timelines.subfolders[0];
      project.timelines.subfolders = [{ name: 'Group', items: [], subfolders: [] }, eases];
      await writeFile(file('project.c3proj'), JSON.stringify(project, null, '\t'), 'utf-8');
      await boot();

      expect(((await ok('list_eases', {})).eases as Json[]).map(e => e.name)).toEqual(['Swoop']);
      await ok('create_ease', { name: 'Second', points: POINTS });
      const timelines = (await projectJson()).timelines;
      expect(timelines.subfolders).toHaveLength(2);
      expect(timelines.subfolders[1].items).toEqual(['Swoop', 'Second']);
      await ok('delete_ease', { name: 'Swoop' });
      expect((await projectJson()).timelines.subfolders[1].items).toEqual(['Second']);
    });

    it('gives a project without a timelines container the nameless eases folder', async () => {
      await editProject(project => {
        delete (project as Partial<ProjectJson>).timelines;
      });
      await boot();
      await ok('create_timeline', { name: 'Move' });
      expect((await projectJson()).timelines).toEqual({ items: ['Move'], subfolders: [{ items: [], subfolders: [] }] });
    });

    it('refuses bad ease names and points', async () => {
      await fails('create_ease', { name: 'easeinoutsine', points: POINTS }, "Construct's own ease names");
      await fails('create_ease', { name: 'Bad', points: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }] }, 'last ease point');
      await fails('create_ease', { name: 'Bad', points: [{ x: 0, y: 0, endHandle: { x: 1, y: 1 } }, { x: 1, y: 1 }] }, 'no incoming handle');
      await ok('create_timeline', { name: 'Move' });
      await fails('create_ease', { name: 'Move', points: POINTS }, 'name of a timeline');
    });

    it('copies a used ease into the timeline and keeps the copy in step', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      await createMove();
      const update = await ok('update_timeline', { name: 'Move', ease: 'Swoop' });
      expect(update.warnings).toBeUndefined();

      let data = await onDisk();
      expectShape(data.transitionsData, shapes.transitionsData);
      expect(data.transitionsData).toEqual([{ folders: [], json: JSON.parse(await readText('timelines/transitions/Swoop.json')) }]);

      const changed = await ok('update_ease', { name: 'Swoop', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
      expect(changed.timelinesRefreshed).toEqual(['Move']);
      data = await onDisk();
      expect(data.transitionsData[0].json.transitionKeyframes[0].sax).toBe(0);

      await fails('delete_ease', { name: 'Swoop' }, 'used by timeline(s) Move');

      await ok('update_timeline', { name: 'Move', ease: 'noease' });
      expect((await onDisk()).transitionsData).toEqual([]);

      await ok('delete_ease', { name: 'Swoop' });
      await expect(stat(file('timelines/transitions/Swoop.json'))).rejects.toThrow();
      expect((await projectJson()).timelines.subfolders[0]).toEqual({ items: [], subfolders: [] });
    });

    it('warns about an ease name that is neither built in nor custom', async () => {
      await createMove();
      const result = await ok('update_timeline', { name: 'Move', ease: 'Wobbly' });
      expect((result.warnings as string[]).join(' ')).toContain('Wobbly');
    });

    it('never stores a timeline among the ease files', async () => {
      await fails('create_timeline', { name: 'Move', subfolder: 'transitions' }, 'custom eases');
      await fails('create_timeline', { name: 'Move', subfolder: 'Transitions/Inner' }, 'custom eases');
      await expect(stat(file('timelines/transitions/Move.json'))).rejects.toThrow();
    });

    it('reads a timeline in a named folder from that folder', async () => {
      await ok('create_timeline', { name: 'Move', subfolder: 'Cutscenes/Intro' });
      const details = await ok('get_timeline_details', { name: 'Move' });
      expect(details).toEqual(await onDisk('Move', 'Cutscenes', 'Intro'));
      await ok('add_value_track', { timelineName: 'Move', name: 'Zoom' });
      expect((await onDisk('Move', 'Cutscenes', 'Intro')).tracks).toHaveLength(1);
      await ok('delete_timeline', { name: 'Move' });
      await expect(stat(file('timelines/Cutscenes/Intro/Move.json'))).rejects.toThrow();
    });

    it('does not read an ease file as a timeline, and leaves the ease registration alone', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      // A timeline registered under the same name, with no file of its own,
      // must not resolve to timelines/transitions/Swoop.json.
      await editProject(project => {
        project.timelines.subfolders.push({ items: ['Swoop'], subfolders: [], name: 'Other' });
        project.timelines.items.push('Swoop');
      });
      await boot();

      const unread = await call('get_timeline_details', { name: 'Swoop' });
      expect(unread.isError).toBe(true);
      expect(unread.content[0].text).toContain('could not be read');
      const noTrack = await call('add_value_track', { timelineName: 'Swoop', name: 'Zoom' });
      expect(noTrack.isError).toBe(true);
      expect(noTrack.content[0].text).toContain('could not be read');

      await ok('delete_timeline', { name: 'Swoop' });
      await ok('delete_timeline', { name: 'Swoop' });
      const after = (await projectJson()).timelines;
      expect(after.items).toEqual([]);
      expect(after.subfolders[0]).toEqual({ items: ['Swoop'], subfolders: [] });
      await expect(stat(file('timelines/transitions/Swoop.json'))).resolves.toBeTruthy();
    });
  });

  // ─── eases and the files that name them ───────────────────

  describe('review follow-ups: eases', () => {
    const POINTS = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

    async function rawTimeline(name = 'Move') {
      return readText(`timelines/${name}.json`);
    }

    it('matches built-in ease names exactly', async () => {
      await ok('create_ease', { name: 'EaseOutSoft', points: POINTS });
      await fails('create_ease', { name: 'EASEOUTBACK', points: POINTS }, "Construct's own ease names");
      await createMove();
      const typo = await ok('update_timeline', { name: 'Move', ease: 'easeinsinee' });
      expect((typo.warnings as string[]).join(' ')).toContain('easeinsinee');
      const known = await ok('update_timeline', { name: 'Move', ease: 'easeinoutquint' });
      expect(known.warnings).toBeUndefined();
    });

    it('leaves timelines that do not use an ease byte-identical when it changes', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      await createMove();
      await ok('create_timeline', { name: 'Other' });
      await ok('update_timeline', { name: 'Move', ease: 'Swoop' });
      const other = await rawTimeline('Other');
      const result = await ok('update_ease', { name: 'Swoop', linear: true });
      expect(result.timelinesRefreshed).toEqual(['Move']);
      expect(await rawTimeline('Other')).toBe(other);
      await expect(stat(file('timelines/Other.json.bak'))).rejects.toThrow();
    });

    it('refuses to delete an ease named in an event sheet or script unless forced', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      const sheetPath = file('eventSheets/MainSheet.json');
      const sheet = JSON.parse(await readFile(sheetPath, 'utf-8')) as SheetJson;
      const action = (sheet.events[0].actions as Array<{ parameters: Record<string, unknown> }>)[0];
      action.parameters.ease = 'Swoop';
      await writeFile(sheetPath, JSON.stringify(sheet, null, '\t'), 'utf-8');
      await boot();

      await fails('delete_ease', { name: 'Swoop' }, 'event sheet "MainSheet"');
      expect((await projectJson()).timelines.subfolders[0].items).toEqual(['Swoop']);

      action.parameters.ease = 'Swooper';
      await writeFile(sheetPath, JSON.stringify(sheet, null, '\t'), 'utf-8');
      await editProject(project => {
        project.rootFileFolders.script!.items.push({ name: 'tween.js', type: 'application/javascript', sid: 700000000000009, 'script-info': { purpose: 'import' } });
      });
      await mkdir(file('scripts'), { recursive: true });
      await writeFile(file('scripts/tween.js'), 'tween.ease = "Swoop";\n', 'utf-8');
      await boot();

      await fails('delete_ease', { name: 'Swoop' }, 'script "scripts/tween.js"');
      const forced = await ok('delete_ease', { name: 'Swoop', force: true });
      expect((forced.warnings as string[]).join(' ')).toContain('force');
      expect((await projectJson()).timelines.subfolders[0].items).toEqual([]);
    });

    it('refuses to delete an ease while a registered timeline cannot be opened', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      await createMove();
      await writeFile(file('timelines/Move.json'), '{ not json', 'utf-8');
      await fails('delete_ease', { name: 'Swoop' }, 'Move could not be opened');
      await expect(stat(file('timelines/transitions/Swoop.json'))).resolves.toBeTruthy();
    });

    it('puts the registration back when deleting the ease file fails', async () => {
      await ok('create_ease', { name: 'Swoop', points: POINTS });
      await writeFile(file('timelines/transitions/Swoop.uistate.json'), '{ "ui": true }', 'utf-8');
      await boot();
      const before = await snapshot();
      const deleteFile = writer.deleteFile.bind(writer);
      vi.spyOn(writer, 'deleteFile').mockImplementation(async (path, options) => {
        if (slashed(path).endsWith('/timelines/transitions/Swoop.json')) throw new Error(`EBUSY: resource busy, unlink '${path}'`);
        return deleteFile(path, options);
      });

      const result = await call('delete_ease', { name: 'Swoop' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('rolled back');
      expect(slashed(result.content[0].text)).not.toContain(slashed(tmpDir));
      expect((await projectJson()).timelines.subfolders[0].items).toEqual(['Swoop']);
      expect(await readText('timelines/transitions/Swoop.json')).toBe(before['timelines/transitions/Swoop.json']);
      expect(await readText('timelines/transitions/Swoop.uistate.json')).toBe('{ "ui": true }');
      expect(await snapshot()).toEqual(before);
    });
  });

  // ─── failed and refused calls ─────────────────────────────

  describe('what a failed or refused call leaves on disk', () => {
    const POINTS = [
      { x: 0, y: 0, startHandle: { x: 0.2, y: 0.6 } },
      { x: 1, y: 1, endHandle: { x: -0.2, y: 0 } },
    ];
    const NEW_POINTS = [{ x: 0, y: 0 }, { x: 0.5, y: 0.9, startHandle: { x: 0.1, y: 0 }, endHandle: { x: -0.1, y: 0 } }, { x: 1, y: 1 }];

    /** An action that tweens a property with `ease` as its ease parameter. */
    function tween(ease: unknown) {
      return {
        id: 'tween-one-property', objectClass: 'Sprite', behaviorType: 'Tween', sid: nextSid++,
        parameters: { tags: '"Custom"', property: 'offsetX', 'end-value': 'Self.X + 50', time: '1', ease, 'destroy-on-complete': 'no' },
      };
    }

    /** Append an every-tick block whose Tween action holds the saved copy of `ease`, writing the sheet straight to disk. */
    async function embedInSheet(ease: CustomEase, sheet = 'MainSheet') {
      const path = file(`eventSheets/${sheet}.json`);
      const data = JSON.parse(await readFile(path, 'utf-8')) as SheetJson;
      data.events.push({
        eventType: 'block',
        conditions: [{ id: 'every-tick', objectClass: 'System', sid: nextSid++ }],
        actions: [tween(easeParameterValue(ease))],
        sid: nextSid++,
      });
      await writeFile(path, JSON.stringify(data, null, '\t'), 'utf-8');
    }

    async function easeOnDisk(): Promise<CustomEase> {
      return JSON.parse(await readText('timelines/transitions/Bouncy.json')) as CustomEase;
    }

    /** Make the ease `Bouncy`, two timelines that use it, and copies of it in `sheets`; then load the project again. */
    async function setupUsed(sheets: string[] = ['MainSheet']) {
      await ok('create_ease', { name: 'Bouncy', points: POINTS });
      for (const name of ['Move', 'Move2']) {
        await ok('create_timeline', { name, totalTime: 5 });
        await ok('update_timeline', { name, ease: 'Bouncy' });
      }
      for (const sheet of sheets) await embedInSheet(await easeOnDisk(), sheet);
      await boot();
    }

    /** Make the ease `Bouncy` with a timeline that holds a copy of it but no longer uses it. */
    async function setupStale(withUistate = false) {
      await ok('create_ease', { name: 'Bouncy', points: POINTS });
      await ok('create_timeline', { name: 'Move', totalTime: 5 });
      await ok('update_timeline', { name: 'Move', ease: 'Bouncy' });
      const data = await onDisk();
      data.ease = 'noease';
      await writeFile(file('timelines/Move.json'), JSON.stringify(data, null, '\t'), 'utf-8');
      if (withUistate) await writeFile(file('timelines/transitions/Bouncy.uistate.json'), '{ "ui": true }', 'utf-8');
      await boot();
    }

    /** The calls the spy `replaceFile` saw, in order. */
    function recordReplaces() {
      const replaceFile = writer.replaceFile.bind(writer);
      const paths: string[] = [];
      vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
        paths.push(slashed(path));
        return replaceFile(path, content, options);
      });
      return paths;
    }

    /** The values of the ease parameters in a sheet the reader holds. */
    async function easeParametersOf(sheet: string): Promise<unknown[]> {
      const values: unknown[] = [];
      forEachEaseParameter(await reader.readEventSheet(sheet), params => values.push(params[EASE_PARAMETER_KEY]));
      return values;
    }

    it('update_ease puts every earlier file back when a later write fails', async () => {
      await setupUsed();
      const before = await snapshot();
      const oldValue = easeParameterValue(await easeOnDisk());
      const replaceFile = writer.replaceFile.bind(writer);
      vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
        if (slashed(path).endsWith('/timelines/Move2.json')) throw new Error(`EACCES: permission denied, open '${path}'`);
        return replaceFile(path, content, options);
      });

      const result = await call('update_ease', { name: 'Bouncy', linear: true });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text.startsWith('Error updating ease:')).toBe(true);
      expect(text).toContain('rolled back');
      expect(text).toContain('timelines/Move2.json');
      expect(slashed(text)).not.toContain(slashed(tmpDir));
      expect(await snapshot()).toEqual(before);
      expect(await easeParametersOf('MainSheet')).toEqual([oldValue]);
    });

    it('update_ease puts back both sheets when the second sheet\'s write fails', async () => {
      await setupUsed(['MainSheet', 'Second']);
      const before = await snapshot();
      const written: string[] = [];
      const writeEntityFile = writer.writeEntityFile.bind(writer);
      vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (category, name, data, subfolder, options) => {
        written.push(name);
        return writeEntityFile(category, name, data, subfolder, options);
      });
      const internals = writer as unknown as { verifyWrittenFile: (...args: unknown[]) => Promise<void> };
      const verify = internals.verifyWrittenFile.bind(writer);
      let failed = false;
      vi.spyOn(internals, 'verifyWrittenFile').mockImplementation(async (...args: unknown[]) => {
        if (!failed && written.length === 2 && slashed(String(args[0])).endsWith(`/eventSheets/${written[1]}.json`)) {
          failed = true;
          throw new Error('read-back failed');
        }
        return verify(...args);
      });

      const result = await call('update_ease', { name: 'Bouncy', linear: true });
      expect(result.isError).toBe(true);
      expect(written).toHaveLength(2);
      expect(failed).toBe(true);
      expect(await snapshot()).toEqual(before);
    });

    it('update_ease writes the ease file last', async () => {
      await setupUsed();
      const paths = recordReplaces();
      await ok('update_ease', { name: 'Bouncy', linear: true });
      expect(paths).toHaveLength(3);
      expect(paths[2].endsWith('/timelines/transitions/Bouncy.json')).toBe(true);
    });

    it('create_ease removes the file when the registration fails', async () => {
      const before = await snapshot();
      vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new Error(`EACCES: permission denied, open '${file('project.c3proj')}'`));

      const result = await call('create_ease', { name: 'Bouncy', points: POINTS });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('rolled back');
      expect(slashed(result.content[0].text)).not.toContain(slashed(tmpDir));
      expect(existsSync(file('timelines/transitions/Bouncy.json'))).toBe(false);
      expect(await readText('project.c3proj')).toBe(before['project.c3proj']);
      expect(await snapshot()).toEqual(before);
    });

    it('refuses an ease name in another letter case', async () => {
      await ok('create_ease', { name: 'Bouncy', points: POINTS });
      await writeFile(file('timelines/transitions/Bouncy.uistate.json'), '{ "ui": true }', 'utf-8');
      const before = await snapshot();
      await fails('update_ease', { name: 'bouncy', linear: true }, 'Did you mean "Bouncy"?');
      await fails('delete_ease', { name: 'bouncy' }, 'Did you mean "Bouncy"?');
      await fails('create_ease', { name: 'bouncy', points: POINTS }, 'Did you mean "Bouncy"?');
      expect(await snapshot()).toEqual(before);
    });

    it('refuses a new ease whose file exists on disk in another letter case', async () => {
      await mkdir(file('timelines/transitions'), { recursive: true });
      await writeFile(file('timelines/transitions/bouncy.json'), '{ "name": "bouncy" }', 'utf-8');
      const before = await snapshot();
      await fails('create_ease', { name: 'Bouncy', points: POINTS }, 'timelines/transitions/bouncy.json');
      expect(await snapshot()).toEqual(before);
    });

    it('delete_ease names a file it could not put back', async () => {
      await ok('create_ease', { name: 'Bouncy', points: POINTS });
      await writeFile(file('timelines/transitions/Bouncy.uistate.json'), '{ "ui": true }', 'utf-8');
      await boot();
      const deleteFile = writer.deleteFile.bind(writer);
      vi.spyOn(writer, 'deleteFile').mockImplementation(async (path, options) => {
        if (slashed(path).endsWith('/timelines/transitions/Bouncy.json')) throw new Error(`EBUSY: resource busy, unlink '${path}'`);
        return deleteFile(path, options);
      });
      vi.spyOn(writer, 'restoreForCall').mockRejectedValueOnce(new Error('EBUSY'));

      const result = await call('delete_ease', { name: 'Bouncy' });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('rolled back only in part');
      expect(text).toContain('not put back: timelines/transitions/Bouncy.uistate.json');
      expect((await projectJson()).timelines.subfolders[0].items).toEqual(['Bouncy']);
    });

    it('changes nothing for a refused call, and a missing script folder is not an error', async () => {
      await ok('create_ease', { name: 'Bouncy', points: POINTS });
      const before = await snapshot();
      await fails('update_ease', { name: 'Bouncy' }, 'No updates provided');
      await fails('update_ease', { name: 'Missing', linear: true }, 'not found');
      await fails('delete_ease', { name: 'Missing' }, 'not found');
      await fails('create_ease', { name: 'Bouncy', points: POINTS }, 'already exists');
      await fails('create_ease', { name: '1 bad/name', points: POINTS }, 'Name must start with a letter or underscore');
      await fails('update_ease', { name: 'Bouncy', points: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }] }, 'last ease point');
      expect(await snapshot()).toEqual(before);

      await editProject(project => {
        delete project.rootFileFolders.script;
      });
      await boot();
      const deleted = await ok('delete_ease', { name: 'Bouncy' });
      expect(deleted.action).toBe('deleted');
      expect(existsSync(file('timelines/transitions/Bouncy.json'))).toBe(false);
    });

    it('update_ease refuses an ease file that cannot be read, and list_eases reports it without a path', async () => {
      await ok('create_ease', { name: 'Bouncy', points: POINTS });
      await writeFile(file('timelines/transitions/Bouncy.json'), '{ broken', 'utf-8');
      await boot();
      const before = await snapshot();

      await fails('update_ease', { name: 'Bouncy', linear: true }, 'timelines/transitions/Bouncy.json could not be read');
      const listed = await ok('list_eases', {});
      const error = String((listed.eases as Json[])[0].error);
      expect(error).toContain('timelines/transitions/Bouncy.json could not be read');
      expect(slashed(error)).not.toContain(slashed(tmpDir));
      expect(await snapshot()).toEqual(before);
    });

    it('update_ease puts back an error thrown after a confirmed write', async () => {
      await setupUsed();
      const before = await snapshot();
      const replaceFile = writer.replaceFile.bind(writer);
      vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
        const written = await replaceFile(path, content, options);
        if (slashed(path).endsWith('/timelines/transitions/Bouncy.json')) {
          throw new UnconfirmedWriteError('timelines/transitions/Bouncy.json was changed by another write right after this one');
        }
        return written;
      });

      const result = await call('update_ease', { name: 'Bouncy', linear: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('rolled back');
      expect(result.content[0].text).not.toContain('Nothing was changed.');
      expect(await snapshot()).toEqual(before);
    });

    it('update_ease keeps an outside version that replaced the ease file during the writer\'s confirmation', async () => {
      await setupUsed();
      const before = await snapshot();
      const internals = writer as unknown as { atomicWrite: (...args: unknown[]) => Promise<void> };
      const atomicWrite = internals.atomicWrite.bind(writer);
      vi.spyOn(internals, 'atomicWrite').mockImplementation(async (...args: unknown[]) => {
        await atomicWrite(...args);
        if (slashed(String(args[0])).endsWith('/timelines/transitions/Bouncy.json')) await writeFile(String(args[0]), OUTSIDE, 'utf-8');
      });

      const result = await call('update_ease', { name: 'Bouncy', linear: true });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('rolled back only in part');
      expect(text).toContain('not put back: timelines/transitions/Bouncy.json');
      expect(text).not.toContain('Nothing was changed.');
      expect(await snapshot()).toEqual({ ...before, 'timelines/transitions/Bouncy.json': OUTSIDE });
    });

    it('update_ease reports a confirmation that failed before the new state was recorded', async () => {
      await setupUsed();
      const before = await snapshot();
      const internals = writer as unknown as { stateIfHolding: (...args: unknown[]) => Promise<unknown> };
      const stateIfHolding = internals.stateIfHolding.bind(writer);
      let failed = false;
      vi.spyOn(internals, 'stateIfHolding').mockImplementation(async (...args: unknown[]) => {
        if (!failed && slashed(String(args[0])).endsWith('/timelines/transitions/Bouncy.json')) {
          failed = true;
          throw new Error('EIO');
        }
        return stateIfHolding(...args);
      });

      const result = await call('update_ease', { name: 'Bouncy', linear: true });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(failed).toBe(true);
      expect(text).toContain('rolled back only in part');
      expect(text).toContain('not put back: timelines/transitions/Bouncy.json');
      const after = await snapshot();
      expect(JSON.parse(after['timelines/transitions/Bouncy.json']).linear).toBe(true);
      expect(await readText('timelines/transitions/Bouncy.json.bak')).toBe(before['timelines/transitions/Bouncy.json']);
      for (const path of Object.keys(before)) {
        if (path !== 'timelines/transitions/Bouncy.json') expect(after[path], path).toBe(before[path]);
      }
    });

    it.each([
      ['update_ease', async () => setupUsed(), { name: 'Bouncy', linear: true }],
      ['delete_ease', async () => setupStale(), { name: 'Bouncy' }],
    ] as Array<[string, () => Promise<void>, Record<string, unknown>]>)('%s does not overwrite a timeline saved on disk after its read', async (tool, setup, args) => {
      await setup();
      const before = await snapshot();
      const replaceFile = writer.replaceFile.bind(writer);
      vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
        if (slashed(path).endsWith('/timelines/Move.json')) await writeFile(path, OUTSIDE, 'utf-8');
        return replaceFile(path, content, options);
      });

      const result = await call(tool, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timelines/Move.json');
      expect(result.content[0].text).toContain('changed on disk');
      expect(await snapshot()).toEqual({ ...before, 'timelines/Move.json': OUTSIDE });
    });

    it('delete_ease checks project.c3proj before its first write', async () => {
      await setupStale();
      const before = await snapshot();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const replaces = recordReplaces();
      vi.spyOn(writer, 'assertProjectFileCurrent').mockRejectedValueOnce(
        new StaleFileError('project.c3proj was changed on disk after this server read it.', 'project.c3proj'),
      );

      const result = await call('delete_ease', { name: 'Bouncy' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('project.c3proj was changed on disk after this server read it.');
      expect(replaces).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });

    it('keeps an ease in use when the track that uses it sits in a deeply nested folder', async () => {
      await ok('create_ease', { name: 'Bouncy', points: POINTS });
      await createMove();
      let parent = '';
      for (let depth = 1; depth <= 40; depth++) {
        await ok('add_timeline_folder', { timelineName: 'Move', name: `f${depth}`, ...(parent === '' ? {} : { parentFolder: parent }) });
        parent = parent === '' ? `f${depth}` : `${parent}/f${depth}`;
      }
      await ok('add_value_track', { timelineName: 'Move', name: 'Deep', folder: parent, keyframes: [{ time: 0, value: 0, ease: 'Bouncy' }] });
      expect((await onDisk()).transitionsData.map(entry => entry.json.name)).toEqual(['Bouncy']);
      const before = await snapshot();

      await fails('delete_ease', { name: 'Bouncy' }, 'used by timeline(s) Move');
      expect(await snapshot()).toEqual(before);

      const updated = await ok('update_ease', { name: 'Bouncy', linear: true });
      expect(updated.timelinesRefreshed).toEqual(['Move']);
      expect((await onDisk()).transitionsData[0].json.linear).toBe(true);
    });

    it('create_ease refuses a file another writer created after the existence check', async () => {
      const before = await snapshot();
      const replaceFile = writer.replaceFile.bind(writer);
      vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
        if (slashed(path).endsWith('/timelines/transitions/Fresh.json')) {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, OUTSIDE, 'utf-8');
        }
        return replaceFile(path, content, options);
      });

      const result = await call('create_ease', { name: 'Fresh', points: POINTS });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('timelines/transitions/Fresh.json');
      expect(text).toContain('changed on disk');
      expect(text).toMatch(/Nothing was changed\.$/);
      expect(await readText('timelines/transitions/Fresh.json')).toBe(OUTSIDE);
      expect(existsSync(file('timelines/transitions/Fresh.json.bak'))).toBe(false);
      expect(await readText('project.c3proj')).toBe(before['project.c3proj']);
    });

    it('update_ease refuses while a copy cannot be read, and writes nothing', async () => {
      await setupUsed(['MainSheet', 'Second']);
      await writeFile(file('timelines/Move2.json'), '{ broken', 'utf-8');
      await boot();
      let before = await snapshot();
      let replaces = recordReplaces();
      let entityWrites = vi.spyOn(writer, 'writeEntityFile');
      let projectWrites = vi.spyOn(writer, 'updateProject');

      await fails('update_ease', { name: 'Bouncy', linear: true }, 'timeline "Move2"');
      expect(replaces).toEqual([]);
      expect(entityWrites).not.toHaveBeenCalled();
      expect(projectWrites).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);

      await writeFile(file('timelines/Move2.json'), await readText('timelines/Move.json'), 'utf-8');
      await boot();
      before = await snapshot();
      replaces = recordReplaces();
      entityWrites = vi.spyOn(writer, 'writeEntityFile');
      projectWrites = vi.spyOn(writer, 'updateProject');
      const readEventSheet = reader.readEventSheet.bind(reader);
      vi.spyOn(reader, 'readEventSheet').mockImplementation(async (name: string) => {
        if (name === 'Second') throw new Error(`EACCES: permission denied, open '${file('eventSheets/Second.json')}'`);
        return readEventSheet(name);
      });

      await fails('update_ease', { name: 'Bouncy', linear: true }, 'event sheet "Second"');
      const refused = await call('update_ease', { name: 'Bouncy', linear: true });
      expect(slashed(refused.content[0].text)).not.toContain(slashed(tmpDir));
      expect(replaces).toEqual([]);
      expect(entityWrites).not.toHaveBeenCalled();
      expect(projectWrites).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    });

    it('gives create_ease no backup file, and update_ease and delete_ease one', async () => {
      const created = await ok('create_ease', { name: 'Bouncy', points: POINTS });
      expect(Object.keys(created)).not.toContain('backupFile');
      const updated = await ok('update_ease', { name: 'Bouncy', points: NEW_POINTS });
      expect(String(updated.backupFile).endsWith('.bak')).toBe(true);
      const deleted = await ok('delete_ease', { name: 'Bouncy' });
      expect(String(deleted.backupFile).endsWith('.bak')).toBe(true);
    });

    it.each(['uistate', 'ease file'])('delete_ease does not delete the %s saved on disk after its read', async (which) => {
      await setupStale(true);
      const before = await snapshot();
      const target = which === 'uistate' ? '/timelines/transitions/Bouncy.uistate.json' : '/timelines/transitions/Bouncy.json';
      const deleteFile = writer.deleteFile.bind(writer);
      vi.spyOn(writer, 'deleteFile').mockImplementation(async (path, options) => {
        if (slashed(path).endsWith(target)) await writeFile(path, OUTSIDE, 'utf-8');
        return deleteFile(path, options);
      });

      const result = await call('delete_ease', { name: 'Bouncy' });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain(target.slice(1));
      expect(text).toContain('changed on disk');
      expect(text).not.toMatch(/not put back:[^.]*Bouncy/);
      expect(await snapshot()).toEqual({ ...before, [target.slice(1)]: OUTSIDE });
    });
  });
});
