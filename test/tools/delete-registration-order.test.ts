/**
 * The delete tools check the entity's file, take its name out of
 * project.c3proj, then delete the file (#ISSUE). A step that fails never
 * leaves a name registered without its file (validate_project:
 * file-existence, an error); the call is undone, and the error says what
 * is on disk afterwards, read again (an editor save of project.c3proj
 * during the delete, a project.c3proj replacement that failed half way). A
 * delete that succeeds while project.c3proj was saved again listing the
 * entity is reported, not called a success. Real reader, writer and ID
 * generator on a copy of the minimal fixture; all data is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, readFile, rm, unlink, rename } from 'fs/promises';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { registerMutationTools } from '../../src/tools/mutations.js';

// rename passes through unless a test queues a failure (test I drives atomicReplace's EEXIST fallback)
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

beforeEach(async () => {
  resetProjectIndex();
  dir = await mkdtemp(join(tmpdir(), 'c3-delete-order-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerAnalysisTools(server as never, reader);
  registerMutationTools(server as never, reader, writer, idGen);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function call(tool: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const result = await server.callTool(tool, args);
  return { isError: result.isError === true, text: result.content[0].text };
}

async function ok(tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await call(tool, args);
  expect(result.isError, `${tool}: ${result.text}`).toBe(false);
  return result.text;
}

interface Container { items: string[]; subfolders: Container[] }
interface Issue { check: string; entity: string }

function namesIn(container: Container): string[] {
  return [...container.items, ...container.subfolders.flatMap(namesIn)];
}

function isRegistered(category: string, name: string): boolean {
  const project = JSON.parse(readFileSync(join(dir, 'project.c3proj'), 'utf-8')) as Record<string, Container>;
  return namesIn(project[category]).includes(name);
}

const onDisk = (file: string) => join(dir, ...file.split('/'));

/** What validate_project reports, after the spies are gone. */
async function validation(): Promise<{ errors: Issue[]; info: Issue[] }> {
  vi.restoreAllMocks();
  resetProjectIndex();
  return JSON.parse(await ok('validate_project')) as { errors: Issue[]; info: Issue[] };
}

/** The editor saves project.c3proj with a new author (synchronous). */
function editorSavesProject(): void {
  const path = join(dir, 'project.c3proj');
  const project = JSON.parse(readFileSync(path, 'utf-8')) as { properties: { author: string } };
  project.properties.author = 'Editor';
  writeFileSync(path, JSON.stringify(project, null, '\t'), 'utf-8');
}

/** project.c3proj cannot be replaced (held by another program, read-only). */
function projectWritesFail(): void {
  const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
  const atomicWrite = internals.atomicWrite.bind(writer);
  vi.spyOn(internals, 'atomicWrite').mockImplementation(async (path, content) => {
    if (path.endsWith('project.c3proj')) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    return atomicWrite(path, content);
  });
}

const busy = () => Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' });

const CASES = [
  { tool: 'delete_layout', category: 'layouts', name: 'Level', file: 'layouts/Level.json', create: ['create_layout', { name: 'Level' }] },
  { tool: 'delete_event_sheet', category: 'eventSheets', name: 'Other', file: 'eventSheets/Other.json', create: ['create_event_sheet', { name: 'Other' }] },
  { tool: 'delete_object', category: 'objectTypes', name: 'Keys', file: 'objectTypes/Keys.json', create: ['create_object', { name: 'Keys', pluginId: 'Keyboard' }] },
  { tool: 'delete_family', category: 'families', name: 'Foes', file: 'families/Foes.json', create: ['create_family', { name: 'Foes', pluginId: 'Sprite' }] },
] as const;

describe('a delete whose project.c3proj update fails changes nothing (#ISSUE)', () => {
  it.each(CASES)('A: $tool keeps the file and the registration', async (c) => {
    await ok(c.create[0], c.create[1]);
    const before = await readFile(onDisk(c.file), 'utf-8');
    projectWritesFail();

    const result = await call(c.tool, { name: c.name, force: true });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(`EBUSY: resource busy or locked, rename. project.c3proj still lists "${c.name}", and ${c.file} is on disk.`);
    expect(await readFile(onDisk(c.file), 'utf-8')).toBe(before);
    expect(isRegistered(c.category, c.name)).toBe(true);
    expect((await validation()).errors.filter(e => e.check === 'file-existence')).toEqual([]);
  });
});

describe('a delete whose file delete fails puts project.c3proj back (#ISSUE)', () => {
  it.each(CASES)('B: $tool registers the entity again', async (c) => {
    await ok(c.create[0], c.create[1]);
    const projectBefore = await readFile(join(dir, 'project.c3proj'), 'utf-8');
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(busy());

    const result = await call(c.tool, { name: c.name, force: true });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Put back from its backup: project.c3proj. project.c3proj still lists "${c.name}", and ${c.file} is on disk.`);
    expect(await readFile(join(dir, 'project.c3proj'), 'utf-8')).toBe(projectBefore);
    expect(existsSync(onDisk(c.file))).toBe(true);
    expect(isRegistered(c.category, c.name)).toBe(true);
  });
});

describe('what a failed delete can leave, and edge cases (#ISSUE)', () => {
  it('C: leaves the file unregistered and says so when project.c3proj is saved in the editor before the file delete fails', async () => {
    await ok('create_layout', { name: 'Level' });
    vi.spyOn(writer, 'deleteEntityFile').mockImplementationOnce(async () => {
      editorSavesProject();
      throw busy();
    });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Not all of it could be undone: left as they are (changed on disk again after this call wrote them, ' +
      'or their backup was replaced): project.c3proj (its state from before the call is in project.c3proj.bak). ' +
      'project.c3proj no longer lists "Level", but layouts/Level.json is still on disk: check it and delete it by hand. ' +
      'Check the project (validate_project, git diff) before you run the tool again.');
    expect(JSON.parse(await readFile(join(dir, 'project.c3proj'), 'utf-8')).properties.author).toBe('Editor');
    expect(isRegistered('layouts', 'Level')).toBe(false);
    expect(existsSync(onDisk('layouts/Level.json'))).toBe(true);
    const report = await validation();
    expect(report.errors.filter(e => e.check === 'file-existence')).toEqual([]);
    expect(report.info.some(i => i.check === 'orphaned-file' && i.entity === 'layouts/Level.json')).toBe(true);
  });

  it('D: deletes the file of an entity in a project-bar subfolder', async () => {
    await ok('create_event_sheet', { name: 'Other', subfolder: 'Levels' });
    await ok('delete_event_sheet', { name: 'Other' });
    expect(existsSync(onDisk('eventSheets/Levels/Other.json'))).toBe(false);
    expect(isRegistered('eventSheets', 'Other')).toBe(false);
    expect((await validation()).errors.filter(e => e.check === 'file-existence')).toEqual([]);
  });

  it('E: takes out a registered layout whose file was already deleted by hand', async () => {
    await ok('create_layout', { name: 'Level' });
    await unlink(onDisk('layouts/Level.json'));
    await ok('delete_layout', { name: 'Level' });
    expect(isRegistered('layouts', 'Level')).toBe(false);
    expect((await validation()).errors.filter(e => e.check === 'file-existence')).toEqual([]);
  });

  it('F: gives the same hint when the file delete is refused as stale and project.c3proj cannot be put back', async () => {
    await ok('create_layout', { name: 'Level' });
    const deleteEntityFile = writer.deleteEntityFile.bind(writer);
    vi.spyOn(writer, 'deleteEntityFile').mockImplementationOnce(async (...args) => {
      // The editor saves both files after the tool took the name out of project.c3proj
      editorSavesProject();
      const layout = JSON.parse(readFileSync(onDisk('layouts/Level.json'), 'utf-8')) as Record<string, unknown>;
      writeFileSync(onDisk('layouts/Level.json'), JSON.stringify({ ...layout, fromEditor: true }, null, '\t'), 'utf-8');
      return deleteEntityFile(...args);
    });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('layouts/Level.json was changed on disk after this server read it');
    expect(result.text).toContain('project.c3proj no longer lists "Level", but layouts/Level.json is still on disk: check it and delete it by hand.');
    expect(JSON.parse(await readFile(onDisk('layouts/Level.json'), 'utf-8')).fromEditor).toBe(true);
  });

  it('G: refuses before writing anything when the file was saved in the editor after the server read it', async () => {
    await ok('create_layout', { name: 'Level' });
    const projectBefore = await readFile(join(dir, 'project.c3proj'), 'utf-8');
    const getSubfolderForEntity = writer.getSubfolderForEntity.bind(writer);
    vi.spyOn(writer, 'getSubfolderForEntity').mockImplementation((category, name) => {
      if (category === 'layouts' && name === 'Level') {
        const layout = JSON.parse(readFileSync(onDisk('layouts/Level.json'), 'utf-8')) as Record<string, unknown>;
        writeFileSync(onDisk('layouts/Level.json'), JSON.stringify({ ...layout, fromEditor: true }, null, '\t'), 'utf-8');
      }
      return getSubfolderForEntity(category, name);
    });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('layouts/Level.json was changed on disk after this server read it');
    expect(result.text).not.toContain('put back');
    expect(await readFile(join(dir, 'project.c3proj'), 'utf-8')).toBe(projectBefore);
    expect(JSON.parse(await readFile(onDisk('layouts/Level.json'), 'utf-8')).fromEditor).toBe(true);
  });

  it('H: does not report success when project.c3proj is saved during the delete and lists the entity again', async () => {
    await ok('create_layout', { name: 'Level' });
    const before = JSON.parse(readFileSync(join(dir, 'project.c3proj'), 'utf-8')) as { properties: Record<string, unknown> };
    const deleteEntityFile = writer.deleteEntityFile.bind(writer);
    vi.spyOn(writer, 'deleteEntityFile').mockImplementationOnce(async (...args) => {
      // The editor saves the project it holds, from before the call: it still lists the layout
      const saved = { ...before, properties: { ...before.properties, author: 'Editor' } };
      writeFileSync(join(dir, 'project.c3proj'), JSON.stringify(saved, null, '\t'), 'utf-8');
      return deleteEntityFile(...args);
    });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('layouts/Level.json was deleted, but project.c3proj was saved again during the delete ' +
      '(in the Construct 3 editor?) and lists "Level" again. Put the file back from layouts/Level.json.bak, or remove "Level" in the editor.');
    expect(isRegistered('layouts', 'Level')).toBe(true);
    expect(existsSync(onDisk('layouts/Level.json'))).toBe(false);
  });

  it('I: reports a missing project.c3proj when its replacement deleted it and then failed', async () => {
    await ok('create_layout', { name: 'Level' });
    // atomicReplace's Windows fallback: the first rename fails with EEXIST, the destination is deleted, the second rename fails
    vi.mocked(rename)
      .mockImplementationOnce(async () => { throw Object.assign(new Error('EEXIST: file already exists, rename'), { code: 'EEXIST' }); })
      .mockImplementationOnce(async () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('EPERM: operation not permitted, rename. project.c3proj is missing: ' +
      'put it back from project.c3proj.bak (its last backup) before you open the project.');
    expect(result.text).not.toContain('still lists');
    expect(existsSync(join(dir, 'project.c3proj'))).toBe(false);
    expect(existsSync(join(dir, 'project.c3proj.bak'))).toBe(true);
    expect(existsSync(onDisk('layouts/Level.json'))).toBe(true);
  });

  it('J: keeps a project.c3proj change the deregistration merged when the file delete then fails', async () => {
    await ok('create_layout', { name: 'Level' });
    // The editor saves project.c3proj after the update backed it up, before its write: the update reads it again and merges
    const internals = writer as unknown as { createBackup: (path: string) => Promise<string> };
    const createBackup = internals.createBackup.bind(writer);
    let saved = false;
    vi.spyOn(internals, 'createBackup').mockImplementation(async (path: string) => {
      const backup = await createBackup(path);
      if (!saved && path.endsWith('project.c3proj')) {
        saved = true;
        editorSavesProject();
      }
      return backup;
    });
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(busy());

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Put back from its backup: project.c3proj.');
    const project = JSON.parse(await readFile(join(dir, 'project.c3proj'), 'utf-8')) as { properties: { author: string } };
    expect(project.properties.author).toBe('Editor');
    expect(isRegistered('layouts', 'Level')).toBe(true);
  });
});

describe('what the delete tools report when the disk cannot be read back as expected (#ISSUE)', () => {
  /** The file delete runs for real, then `afterDelete` changes the disk the way a program other than the server could. */
  function afterFileDelete(afterDelete: () => void): void {
    const deleteEntityFile = writer.deleteEntityFile.bind(writer);
    vi.spyOn(writer, 'deleteEntityFile').mockImplementationOnce(async (...args) => {
      const backup = await deleteEntityFile(...args);
      afterDelete();
      return backup;
    });
  }

  it('K: reports project.c3proj as unreadable, and keeps the composed message, when the registered names cannot be read', async () => {
    await ok('create_layout', { name: 'Level' });
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(busy());
    // The names fail to read only inside entityOnDisk, after its check of project.c3proj (which reads them itself)
    const entityOnDisk = writer.entityOnDisk.bind(writer);
    const checkProjectFile = reader.checkProjectFile.bind(reader);
    let inside = false;
    vi.spyOn(writer, 'entityOnDisk').mockImplementation(async (...args) => {
      inside = true;
      try { return await entityOnDisk(...args); } finally { inside = false; }
    });
    vi.spyOn(reader, 'checkProjectFile').mockImplementation(async () => {
      const changed = await checkProjectFile();
      if (inside) vi.spyOn(reader, 'getProject').mockImplementation(() => { throw new TypeError('names are gone'); });
      return changed;
    });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('EBUSY: resource busy or locked, unlink. Put back from its backup: project.c3proj. ' +
      'project.c3proj could not be read. Check the project (validate_project, git diff) before you run the tool again.');
    expect(result.text).not.toContain('names are gone');
  });

  it('K2: entityOnDisk answers unreadable when the registered names cannot be read', async () => {
    await ok('create_layout', { name: 'Level' });
    vi.spyOn(reader, 'getProject').mockImplementation(() => { throw new TypeError('names are gone'); });

    expect(await writer.entityOnDisk('layouts', 'Level')).toEqual({ project: 'unreadable', file: 'present' });
  });

  it('L: reports an unreadable project.c3proj after a delete that succeeded', async () => {
    await ok('create_layout', { name: 'Level' });
    afterFileDelete(() => {
      // The editor is still writing project.c3proj
      const text = readFileSync(join(dir, 'project.c3proj'), 'utf-8');
      writeFileSync(join(dir, 'project.c3proj'), text.slice(0, text.length / 2), 'utf-8');
    });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('layouts/Level.json was deleted, but the project is not as the delete left it: ' +
      'project.c3proj could not be read. Check the project (validate_project, git diff).');
    expect(existsSync(onDisk('layouts/Level.json'))).toBe(false);
  });

  it('M: reports a missing project.c3proj after a delete that succeeded', async () => {
    await ok('create_layout', { name: 'Level' });
    afterFileDelete(() => { rmSync(join(dir, 'project.c3proj')); });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('layouts/Level.json was deleted, but the project is not as the delete left it: ' +
      'project.c3proj is missing: put it back from project.c3proj.bak (its last backup) before you open the project. ' +
      'Check the project (validate_project, git diff).');
  });

  it('N: reports a file still on disk after a delete that succeeded and took the name out of project.c3proj', async () => {
    await ok('create_layout', { name: 'Level' });
    // The file comes back (restored by another program) right after the delete
    const deleteEntityFile = writer.deleteEntityFile.bind(writer);
    const text = readFileSync(onDisk('layouts/Level.json'), 'utf-8');
    vi.spyOn(writer, 'deleteEntityFile').mockImplementationOnce(async (...args) => {
      const backup = await deleteEntityFile(...args);
      writeFileSync(onDisk('layouts/Level.json'), text, 'utf-8');
      return backup;
    });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('layouts/Level.json was deleted, but the project is not as the delete left it: ' +
      'project.c3proj no longer lists "Level", but layouts/Level.json is still on disk: check it and delete it by hand. ' +
      'Check the project (validate_project, git diff).');
    expect(isRegistered('layouts', 'Level')).toBe(false);
  });

  /** From now on the entity's file path cannot be looked at (a path the file system refuses). */
  function entityFileUnreadable(): { breakIt: () => void } {
    const internals = writer as unknown as { entityFilePath: (...args: unknown[]) => string };
    const entityFilePath = internals.entityFilePath.bind(writer);
    let broken = false;
    vi.spyOn(internals, 'entityFilePath').mockImplementation((...args: unknown[]) => (
      broken ? join(dir, 'layouts', 'Level\0.json') : entityFilePath(...args)
    ));
    return { breakIt: () => { broken = true; } };
  }

  it('O: says the file could not be checked when its state cannot be read after a failed delete', async () => {
    await ok('create_layout', { name: 'Level' });
    const { breakIt } = entityFileUnreadable();
    vi.spyOn(writer, 'deleteEntityFile').mockImplementationOnce(async () => {
      breakIt();
      throw busy();
    });

    const result = await call('delete_layout', { name: 'Level' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('EBUSY: resource busy or locked, unlink. Put back from its backup: project.c3proj. ' +
      'Whether layouts/Level.json is still on disk could not be checked. Check the project (validate_project, git diff) before you run the tool again.');
  });

  it('O2: entityOnDisk answers unknown for a file whose state cannot be read', async () => {
    await ok('create_layout', { name: 'Level' });
    entityFileUnreadable().breakIt();

    expect(await writer.entityOnDisk('layouts', 'Level')).toEqual({ project: 'lists', file: 'unknown' });
  });
});
