/**
 * How the timeline tools find, read, create, change and delete a timeline
 * file: eases kept apart from timelines, names matched with their letter
 * case, files that do not read, changes made on disk between two calls, and
 * the rollback of a call that wrote more than one file.
 * Real reader, writer and ID generator on a temp copy of the minimal fixture,
 * with the editor-saved timeline of `test/fixtures/timeline-sample` registered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, readdir, writeFile, mkdir } from 'fs/promises';
import type { PathLike } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { StaleFileError } from '../../src/construct3/disk-state.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

/** The one file whose read fails with a permission error that names its absolute path (empty: none). */
const unreadable = vi.hoisted(() => ({ path: '' }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFileOf = actual.readFile as (path: PathLike, ...rest: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readFile: vi.fn(async (path: PathLike, ...rest: unknown[]) => {
      if (unreadable.path !== '' && String(path) === unreadable.path) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), { code: 'EACCES' });
      }
      return readFileOf(path, ...rest);
    }),
  };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const SAMPLE_TIMELINE = join(__dirname, '..', 'fixtures', 'timeline-sample', 'Timeline 1.json');

const EASE_KEYFRAMES = [
  { x: 0, y: 0, sax: 0, say: 0, eax: 0, eay: 0, se: true, ee: false, sm: 'cubic' },
  { x: 1, y: 1, sax: 0, say: 0, eax: 0, eay: 0, se: false, ee: true, sm: 'cubic' },
];

let dir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const projectPath = () => join(dir, 'project.c3proj');
const file = (rel: string) => join(dir, ...rel.split('/'));
const readText = (rel: string) => readFile(file(rel), 'utf-8');
const registered = async () => (JSON.parse(await readFile(projectPath(), 'utf-8')) as { timelines: { items: string[]; subfolders: Array<{ items: string[] }> } }).timelines;

/** The path as the writer sees it, with `/` separators. */
const slashed = (path: string) => path.replace(/\\/g, '/');

/** Every file below the project folder by project-relative path, leaving out the `.bak` files. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string) => {
    for (const entry of await readdir(rel === '' ? dir : file(rel), { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (!child.endsWith('.bak')) out[child] = await readText(child);
    }
  };
  await walk('');
  return out;
}

/** Load the project in `dir` with a fresh reader, writer and server. */
async function load(): Promise<void> {
  reader = new Construct3ProjectReader(projectPath());
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
  server = new MockServer();
  registerTimelineTools({ server, reader, writer, idGen: new IdGenerator() } as unknown as MutationToolDeps);
}

/** Rewrite project.c3proj through `change`. */
async function editProject(change: (project: Record<string, unknown>) => void): Promise<void> {
  const project = JSON.parse(await readFile(projectPath(), 'utf-8')) as Record<string, unknown>;
  change(project);
  await writeFile(projectPath(), JSON.stringify(project, null, '\t'), 'utf-8');
}

/** The text of an ease file. */
const easeText = (name: string) => JSON.stringify({ name, linear: false, purpose: 'any', transitionKeyframes: EASE_KEYFRAMES }, null, '\t');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-timeline-lookup-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  await mkdir(file('timelines'), { recursive: true });
  await cp(SAMPLE_TIMELINE, file('timelines/Timeline 1.json'));
  await editProject(project => {
    project.timelines = { items: ['Timeline 1'], subfolders: [{ items: [], subfolders: [] }] };
  });
  await load();
});

afterEach(async () => {
  unreadable.path = '';
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('timeline lookups', () => {
  it('tells a timeline from a custom ease', async () => {
    await mkdir(file('timelines/transitions'), { recursive: true });
    await writeFile(file('timelines/transitions/Ease A.json'), easeText('Ease A'), 'utf-8');
    await editProject(project => {
      (project.timelines as { subfolders: Array<{ items: string[] }> }).subfolders[0].items.push('Ease A');
    });
    await load();
    const before = await snapshot();

    const details = await server.callTool('get_timeline_details', { name: 'Ease A' });
    expect(details.isError).toBe(true);
    expect(details.content[0].text).toContain('list_eases');
    for (const [tool, args] of [
      ['update_timeline', { name: 'Ease A', loop: true }],
      ['delete_timeline', { name: 'Ease A' }],
    ] as const) {
      const result = await server.callTool(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0].text, tool).toContain('list_eases');
      expect(result.content[0].text, tool).toMatch(/Nothing was changed\.$/);
    }
    expect(await readText('timelines/transitions/Ease A.json')).toBe(easeText('Ease A'));
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a registered file that holds no tracks and never deletes it', async () => {
    await writeFile(file('timelines/Hollow.json'), '{ "name": "Hollow" }', 'utf-8');
    await editProject(project => {
      (project.timelines as { items: string[] }).items.push('Hollow');
    });
    await load();
    const before = await snapshot();

    const details = await server.callTool('get_timeline_details', { name: 'Hollow' });
    expect(details.isError).toBe(true);
    expect(details.content[0].text).toContain('timelines/Hollow.json');
    expect(details.content[0].text).toContain('holds no tracks');

    const deleted = await server.callTool('delete_timeline', { name: 'Hollow' });
    expect(deleted.isError).toBe(true);
    expect(deleted.content[0].text).toContain('was not deleted');
    expect(deleted.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
    expect((await registered()).items).toContain('Hollow');
  });

  it('finds a root timeline whose file sits in timelines/transitions/', async () => {
    const sample = JSON.parse(await readFile(SAMPLE_TIMELINE, 'utf-8')) as Record<string, unknown>;
    await mkdir(file('timelines/transitions'), { recursive: true });
    await writeFile(file('timelines/transitions/X.json'), JSON.stringify({ ...sample, name: 'X' }, null, '\t'), 'utf-8');
    await writeFile(file('timelines/transitions/Y.json'), easeText('Y'), 'utf-8');
    await editProject(project => {
      (project.timelines as { items: string[] }).items.push('X', 'Y');
    });
    await load();

    const details = await server.callTool('get_timeline_details', { name: 'X' });
    expect(details.isError).toBeUndefined();
    expect(JSON.parse(details.content[0].text).name).toBe('X');
    const updated = await server.callTool('update_timeline', { name: 'X', loop: true });
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(await readText('timelines/transitions/X.json')).loop).toBe(true);
    expect(existsSync(file('timelines/X.json'))).toBe(false);

    // A file there without tracks is an ease, not the timeline
    const before = await snapshot();
    const ease = await server.callTool('get_timeline_details', { name: 'Y' });
    expect(ease.isError).toBe(true);
    expect(ease.content[0].text).toContain('could not be read');
    const refused = await server.callTool('update_timeline', { name: 'Y', loop: true });
    expect(refused.isError).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a timeline name in another letter case, naming the registered one', async () => {
    const before = await snapshot();
    for (const [tool, args] of [
      ['update_timeline', { name: 'timeline 1', loop: true }],
      ['delete_timeline', { name: 'timeline 1' }],
    ] as const) {
      const result = await server.callTool(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0].text, tool).toContain('Did you mean "Timeline 1"?');
      expect(result.content[0].text, tool).toMatch(/Nothing was changed\.$/);
    }
    expect(await snapshot()).toEqual(before);

    const details = await server.callTool('get_timeline_details', { name: 'timeline 1' });
    expect(details.isError).toBe(true);
    expect(details.content[0].text).toContain('Did you mean "Timeline 1"?');
    expect(details.content[0].text).not.toContain('Nothing was changed.');
  });

  it('names an unreadable timeline file without its path', async () => {
    await writeFile(file('timelines/Timeline 1.json'), '{ broken', 'utf-8');
    const broken = await server.callTool('get_timeline_details', { name: 'Timeline 1' });
    expect(broken.isError).toBe(true);
    expect(broken.content[0].text).toContain('timelines/Timeline 1.json');
    expect(broken.content[0].text).toContain('JSON');
    expect(slashed(broken.content[0].text)).not.toContain(slashed(dir));
    expect(broken.content[0].text).not.toContain('Nothing was changed.');

    await rm(file('timelines/Timeline 1.json'));
    const missing = await server.callTool('get_timeline_details', { name: 'Timeline 1' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('timelines/Timeline 1.json');
    expect(missing.content[0].text).toContain('ENOENT');
    expect(slashed(missing.content[0].text)).not.toContain(slashed(dir));
    expect(missing.content[0].text).not.toContain('Nothing was changed.');

    // A file system error names the file by its absolute path in its own message; the answer holds the code only
    await writeFile(file('timelines/Timeline 1.json'), '{}', 'utf-8');
    unreadable.path = file('timelines/Timeline 1.json');
    const denied = await server.callTool('get_timeline_details', { name: 'Timeline 1' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('timelines/Timeline 1.json');
    expect(denied.content[0].text).toContain('EACCES');
    expect(slashed(denied.content[0].text)).not.toContain(slashed(dir));
  });

  it('sees a change made on disk between two calls', async () => {
    const first = JSON.parse((await server.callTool('list_timelines', {})).content[0].text) as { timelines: string[] };
    expect(first.timelines).toEqual(['Timeline 1']);
    await editProject(project => {
      (project.timelines as { items: string[] }).items.push('Added Outside');
    });
    const second = JSON.parse((await server.callTool('list_timelines', {})).content[0].text) as { timelines: string[] };
    expect(second.timelines).toEqual(['Timeline 1', 'Added Outside']);
  });
});

describe('refusals and errors', () => {
  it('ends every refusal of the write tools with Nothing was changed.', async () => {
    await writeFile(file('timelines/Orphan.json'), '{}', 'utf-8');
    await mkdir(file('timelines/transitions'), { recursive: true });
    await writeFile(file('timelines/transitions/Ease A.json'), easeText('Ease A'), 'utf-8');
    await editProject(project => {
      project.timelines = {
        items: ['Timeline 1'],
        subfolders: [
          { items: ['Ease A'], subfolders: [] },
          { items: [], subfolders: [], name: 'UI' },
          { items: [], subfolders: [{ items: ['Stray'], subfolders: [] }], name: 'Nested' },
        ],
      };
    });
    await load();
    const before = await snapshot();

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['create_timeline', { name: 'a/b' }, 'Name must start with a letter'],
      ['create_timeline', { name: 'Fine', subfolder: '../objectTypes' }, 'Subfolder path contains invalid characters'],
      ['create_timeline', { name: 'Fine', subfolder: 'transitions' }, 'would sit among the ease files'],
      ['create_timeline', { name: 'Timeline 1' }, 'already exists'],
      ['create_timeline', { name: 'Ease A' }, 'name of a transition'],
      ['create_timeline', { name: 'Stray' }, 'would register the name twice'],
      ['create_timeline', { name: 'Fine', subfolder: 'ui/More' }, 'Use subfolder "UI/More"'],
      ['create_timeline', { name: 'timeline 1' }, 'differs only in case'],
      ['create_timeline', { name: 'Orphan' }, 'timelines/Orphan.json already exists'],
      ['update_timeline', { name: 'Timeline 1' }, 'No updates provided'],
      ['update_timeline', { name: 'Ghost', loop: true }, '"Ghost" not found'],
      ['update_timeline', { name: 'Stray', loop: true }, 'cannot resolve'],
      ['delete_timeline', { name: 'Ghost' }, '"Ghost" not found'],
      ['delete_timeline', { name: 'Stray' }, 'cannot resolve'],
    ];
    for (const [tool, args, text] of cases) {
      const label = `${tool} ${JSON.stringify(args)}`;
      const result = await server.callTool(tool, args);
      expect(result.isError, label).toBe(true);
      expect(result.content[0].text, label).toContain(text);
      expect(result.content[0].text, label).toMatch(/Nothing was changed\.$/);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('words an unexpected error without the project folder', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(reader, 'getProject').mockImplementation(() => {
      throw new Error(`cannot use ${projectPath()}`);
    });

    for (const [tool, args, doing] of [
      ['list_timelines', {}, 'listing timelines'],
      ['get_timeline_details', { name: 'Timeline 1' }, 'getting timeline details'],
      ['create_timeline', { name: 'New' }, 'creating timeline'],
      ['update_timeline', { name: 'Timeline 1', loop: true }, 'updating timeline'],
      ['delete_timeline', { name: 'Timeline 1' }, 'deleting timeline'],
    ] as const) {
      const result = await server.callTool(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0].text, tool).toBe(`Error ${doing}: cannot use project.c3proj`);
    }
  });

  it('words a refused path without the project folder', async () => {
    await editProject(project => {
      (project.timelines as { items: string[] }).items.push('../escape');
    });
    await load();
    const before = await snapshot();

    const details = await server.callTool('get_timeline_details', { name: '../escape' });
    expect(details.isError).toBe(true);
    expect(details.content[0].text.startsWith('Timeline "../escape": ')).toBe(true);
    expect(slashed(details.content[0].text)).not.toContain(slashed(dir));
    expect(details.content[0].text).not.toContain('Nothing was changed.');

    const updated = await server.callTool('update_timeline', { name: '../escape', loop: true });
    expect(updated.isError).toBe(true);
    expect(updated.content[0].text.startsWith('Timeline "../escape": ')).toBe(true);
    expect(updated.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
  });

});

describe('create_timeline', () => {
  it('gives a new container the nameless eases folder', async () => {
    await editProject(project => {
      delete project.timelines;
    });
    await load();

    const created = await server.callTool('create_timeline', { name: 'New' });
    expect(created.isError).toBeUndefined();
    const container = await registered();
    expect(container).toEqual({ items: ['New'], subfolders: [{ items: [], subfolders: [] }] });
    expect(Object.keys(container)).toEqual(['items', 'subfolders']);
    expect(Object.keys(container.subfolders[0])).toEqual(['items', 'subfolders']);
  });

  it('writes the same top-level keys, in the same order, as an editor-saved timeline', async () => {
    expect((await server.callTool('create_timeline', { name: 'New' })).isError).toBeUndefined();
    const sample = JSON.parse(await readFile(SAMPLE_TIMELINE, 'utf-8')) as Record<string, unknown>;
    const created = JSON.parse(await readText('timelines/New.json')) as Record<string, unknown>;
    expect(Object.keys(created)).toEqual(Object.keys(sample));
  });

  it('removes its file when the registration fails', async () => {
    const before = await snapshot();
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(
      new Error(`EACCES: permission denied, open '${projectPath()}'`),
    );

    const result = await server.callTool('create_timeline', { name: 'New' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text.startsWith('Error creating timeline:')).toBe(true);
    expect(text).toContain('rolled back');
    expect(text).toContain('project.c3proj');
    expect(slashed(text)).not.toContain(slashed(dir));
    expect(existsSync(file('timelines/New.json'))).toBe(false);
    expect(await snapshot()).toEqual(before);

    const again = await server.callTool('create_timeline', { name: 'New' });
    expect(again.isError).toBeUndefined();
    expect(existsSync(file('timelines/New.json'))).toBe(true);
  });

  it('refuses a file another writer created after the existence check', async () => {
    const before = await snapshot();
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      if (slashed(path).endsWith('/timelines/New.json')) await writeFile(path, '{ "outside": "a save made by another program" }', 'utf-8');
      return replaceFile(path, content, options);
    });

    const result = await server.callTool('create_timeline', { name: 'New' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('timelines/New.json');
    expect(text).toContain('changed on disk');
    expect(text).toMatch(/Nothing was changed\.$/);
    expect(text).not.toContain('rolled back only in part');
    expect(await readText('timelines/New.json')).toBe('{ "outside": "a save made by another program" }');
    expect(existsSync(file('timelines/New.json.bak'))).toBe(false);
    expect(await readText('project.c3proj')).toBe(before['project.c3proj']);
  });
});

describe('update_timeline', () => {
  it('refuses to overwrite a save made on disk after its read', async () => {
    const projectBefore = await readText('project.c3proj');
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      if (slashed(path).endsWith('/timelines/Timeline 1.json')) await writeFile(path, '{ "outside": "a save made by another program" }', 'utf-8');
      return replaceFile(path, content, options);
    });

    const result = await server.callTool('update_timeline', { name: 'Timeline 1', loop: true });
    expect(result.isError).toBe(true);
    // The writer's text is the answer: it says the file was not written and the change on disk is kept
    expect(result.content[0].text.startsWith('timelines/Timeline 1.json was changed on disk')).toBe(true);
    expect(result.content[0].text).toContain('so that change is kept');
    expect(await readText('timelines/Timeline 1.json')).toBe('{ "outside": "a save made by another program" }');
    expect(await readText('project.c3proj')).toBe(projectBefore);
  });
});

describe('delete_timeline', () => {
  const OUTSIDE = '{ "outside": "a save made by another program" }';

  it('puts the file back when the deregistration fails', async () => {
    const original = await readText('timelines/Timeline 1.json');
    const before = await snapshot();
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(
      new Error(`EACCES: permission denied, open '${projectPath()}'`),
    );

    const result = await server.callTool('delete_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rolled back');
    expect(await readText('timelines/Timeline 1.json')).toBe(original);
    expect((await registered()).items).toEqual(['Timeline 1']);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a file that exists but does not parse', async () => {
    await writeFile(file('timelines/Timeline 1.json'), '{ broken', 'utf-8');
    await load();
    const before = await snapshot();

    const result = await server.callTool('delete_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('was not deleted');
    expect(result.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await readText('timelines/Timeline 1.json')).toBe('{ broken');
    expect((await registered()).items).toEqual(['Timeline 1']);
    expect(await snapshot()).toEqual(before);

    await rm(file('timelines/Timeline 1.json'));
    const gone = await server.callTool('delete_timeline', { name: 'Timeline 1' });
    expect(gone.isError).toBeUndefined();
    expect(JSON.parse(gone.content[0].text)).toMatchObject({ action: 'deregistered' });
    expect((await registered()).items).toEqual([]);
  });

  it('checks project.c3proj before it deletes', async () => {
    const original = await readText('timelines/Timeline 1.json');
    // The unexpected-error path logs the cause; this case is meant to reach it
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(writer, 'assertProjectFileCurrent').mockRejectedValueOnce(
      new StaleFileError('project.c3proj was changed on disk after this server read it.', 'project.c3proj'),
    );

    const result = await server.callTool('delete_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('project.c3proj was changed on disk after this server read it.');
    expect(existsSync(file('timelines/Timeline 1.json.bak'))).toBe(false);
    expect(await readText('timelines/Timeline 1.json')).toBe(original);
  });

  it('refuses a timeline saved on disk after its read, and does not delete it', async () => {
    const before = await readText('project.c3proj');
    const deleteFile = writer.deleteFile.bind(writer);
    vi.spyOn(writer, 'deleteFile').mockImplementation(async (path, options) => {
      if (slashed(path).endsWith('/timelines/Timeline 1.json')) await writeFile(path, OUTSIDE, 'utf-8');
      return deleteFile(path, options);
    });

    const result = await server.callTool('delete_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timelines/Timeline 1.json');
    expect(result.content[0].text).toContain('changed on disk');
    expect(result.content[0].text).toMatch(/Nothing was changed\.$/);
    expect(await readText('timelines/Timeline 1.json')).toBe(OUTSIDE);
    expect(existsSync(file('timelines/Timeline 1.json.bak'))).toBe(false);
    expect(await readText('project.c3proj')).toBe(before);
    expect((await registered()).items).toEqual(['Timeline 1']);
  });

  it('restores the bytes that were deleted, and never a lookup text over a newer save', async () => {
    const original = await readText('timelines/Timeline 1.json');
    const deleteFile = writer.deleteFile.bind(writer);
    const spy = vi.spyOn(writer, 'deleteFile');
    vi.spyOn(writer, 'updateProject').mockRejectedValue(new Error(`EACCES: permission denied, open '${projectPath()}'`));

    // The delete runs against the file as the lookup read it; the failed deregistration puts those bytes back
    spy.mockImplementation((path, options) => deleteFile(path, options));
    const restored = await server.callTool('delete_timeline', { name: 'Timeline 1' });
    expect(restored.isError).toBe(true);
    expect(restored.content[0].text).toContain('rolled back');
    expect(await readText('timelines/Timeline 1.json')).toBe(original);

    // A save made before the delete is kept, not written over with the lookup's text
    spy.mockImplementation(async (path, options) => {
      if (slashed(path).endsWith('/timelines/Timeline 1.json')) await writeFile(path, OUTSIDE, 'utf-8');
      return deleteFile(path, options);
    });
    const refused = await server.callTool('delete_timeline', { name: 'Timeline 1' });
    expect(refused.isError).toBe(true);
    expect(await readText('timelines/Timeline 1.json')).toBe(OUTSIDE);
  });
});
