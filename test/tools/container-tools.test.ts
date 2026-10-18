/**
 * Container tools: list_containers, create_container, update_container and
 * delete_container edit the "containers" list of project.c3proj, each in one
 * writer update that checks and edits the file as it is right before the
 * write. All data is synthetic: a temp copy of the minimal fixture with
 * extra Sprite object types, the real reader and writer, tools through the
 * mock server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerContainerTools } from '../../src/tools/container-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { checkNewContainerMembers, containerMemberProblems, ContainerRefusal } from '../../src/construct3/containers.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const NOTHING_CHANGED = 'Nothing was changed.';

interface ProjectFile {
  name: string;
  objectTypes: { items: string[] };
  families: { items: string[] };
  containers?: Array<{ members: string[] }>;
  [key: string]: unknown;
}
interface ObjectFile { name: string; sid: number; [key: string]: unknown }
interface ContainerJson { index: number; members: string[]; notObjectTypes?: string[] }
interface ToolData {
  isError?: boolean;
  text?: string;
  success?: boolean;
  action?: string;
  entity?: string;
  category?: string;
  index?: number;
  members?: string[];
  count?: number;
  containers?: ContainerJson[];
  warnings?: string[];
  backupFile?: string;
  editorNote?: string;
  [key: string]: unknown;
}

const OBJECT_NAMES = ['Hitbox', 'Shield', 'Gem', 'Coin', 'Key', 'Orb', 'Rock'];

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const projectPath = () => join(tmpDir, 'project.c3proj');
const objectPath = (name: string) => join(tmpDir, 'objectTypes', `${name}.json`);
const readProject = async (): Promise<ProjectFile> => JSON.parse(await readFile(projectPath(), 'utf8')) as ProjectFile;
const projectText = () => readFile(projectPath(), 'utf8');
const call = async (tool: string, args: Record<string, unknown> = {}): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const occurrences = (text: string | undefined, sentence: string) => (text ?? '').split(sentence).length - 1;

/** An object type `name`: a copy of the fixture's Sprite with its own name and SID. */
async function addObjectType(name: string, sid: number): Promise<void> {
  const sprite = JSON.parse(await readFile(objectPath('Sprite'), 'utf8')) as ObjectFile;
  await writeFile(objectPath(name), JSON.stringify({ ...sprite, name, sid }, null, '\t'));
}

/** Change project.c3proj on disk, as an edit outside the server would, and load it again. */
async function setProject(change: (project: ProjectFile) => void): Promise<void> {
  const project = await readProject();
  change(project);
  await writeFile(projectPath(), JSON.stringify(project, null, '\t'));
  await reader.loadProject();
  resetProjectIndex();
}

/** The containers of project.c3proj, set by hand. */
const seed = (...containers: string[][]) => setProject(project => { project.containers = containers.map(members => ({ members })); });

/** The text of project.c3proj with its containers replaced: an editor save of the older copy. */
async function savedWith(containers: string[][]): Promise<string> {
  const project = await readProject();
  project.containers = containers.map(members => ({ members }));
  return JSON.stringify(project, null, '\t');
}

/** Count the writer's real writes of project.c3proj (its atomic replace of that file). */
function countProjectWrites(): () => number {
  const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
  const atomicWrite = internals.atomicWrite.bind(writer);
  let writes = 0;
  internals.atomicWrite = async (path, content) => {
    if (path.endsWith('project.c3proj')) writes++;
    return atomicWrite(path, content);
  };
  return () => writes;
}

/** Run `save` once, right before the tool's writer update starts (after the tool's own first check). */
function saveBeforeUpdate(save: () => Promise<void>): void {
  const update = writer.updateProject.bind(writer);
  let saved = false;
  writer.updateProject = async change => {
    if (!saved) {
      saved = true;
      await save();
    }
    return update(change);
  };
}

/** Run `save` once, when the writer has read the file and made its backup but not yet written (so its update runs again). */
function saveDuringUpdate(save: () => Promise<void>): void {
  const internals = writer as unknown as { createBackup: (path: string, options?: unknown) => Promise<string> };
  const createBackup = internals.createBackup.bind(writer);
  let saved = false;
  internals.createBackup = async (path, options) => {
    const backup = await createBackup(path, options);
    if (!saved && path.endsWith('project.c3proj')) {
      saved = true;
      await save();
    }
    return backup;
  };
}

/** The writer's read-back of project.c3proj fails once with an ordinary error. */
function failReadBackOfProject(): void {
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  let failed = false;
  internals.verifyWrittenFile = async (path, name, text) => {
    if (!failed && path.endsWith('project.c3proj')) {
      failed = true;
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    }
    return verify(path, name, text);
  };
}

/** The writer's replacement of project.c3proj fails once, after the old file was removed first when `removeFirst`. */
function failProjectReplace(removeFirst: boolean): void {
  const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
  const write = internals.atomicWrite.bind(writer);
  let failed = false;
  internals.atomicWrite = async (path, content) => {
    if (!failed && path.endsWith('project.c3proj')) {
      failed = true;
      if (removeFirst) await rm(path);
      throw new Error('EACCES: permission denied, rename');
    }
    return write(path, content);
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-container-tools-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  for (const [i, name] of OBJECT_NAMES.entries()) await addObjectType(name, 720000000000001 + i);
  reader = new Construct3ProjectReader(projectPath());
  await reader.loadProject();
  await setProject(project => {
    project.objectTypes.items.push(...OBJECT_NAMES);
    project.families.items.push('Enemies');
  });
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerContainerTools({ server, reader, writer, idGen } as never);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('list_containers', () => {
  it('lists the containers with their indexes, and names a member that is no object type', async () => {
    await seed(['Hitbox', 'Shield'], ['Gem', 'Ghost']);
    const before = await projectText();
    const data = await call('list_containers');
    expect(data.count).toBe(2);
    expect(data.containers).toEqual([
      { index: 0, members: ['Hitbox', 'Shield'] },
      { index: 1, members: ['Gem', 'Ghost'], notObjectTypes: ['Ghost'] },
    ]);
    expect(data.editorNote).toBeUndefined();
    expect(await projectText()).toBe(before);
    expect(existsSync(projectPath() + '.bak')).toBe(false);
  });

  it('lists nothing for a project without containers', async () => {
    expect(await call('list_containers')).toEqual({ containers: [], count: 0 });
  });
});

describe('create_container', () => {
  it('creates a container of two object types, and validate_project reports no container-member issue', async () => {
    const data = await call('create_container', { members: ['Hitbox', 'Shield'] });
    expect(data).toMatchObject({ success: true, category: 'container', action: 'created', index: 0, members: ['Hitbox', 'Shield'] });
    expect(data.backupFile).toBeDefined();
    expect(data.editorNote).toBeDefined();
    expect((await readProject()).containers).toEqual([{ members: ['Hitbox', 'Shield'] }]);
    const result = await validateProjectIntegrity(reader);
    expect([...result.errors, ...result.warnings, ...result.info].filter(issue => issue.check === 'container-member')).toEqual([]);
    const second = await call('create_container', { members: ['Gem', 'Coin', 'Key'] });
    expect(second).toMatchObject({ success: true, index: 1 });
    expect((await call('list_containers')).count).toBe(2);
  });

  it('refuses fewer than two distinct object types, a missing type, a family, a name in another letter case and a name listed twice, writing nothing (no .bak)', async () => {
    const before = await projectText();
    const cases: Array<[string[], string]> = [
      [['Hitbox', 'Ghost'], 'does not open a project whose container names a missing object type'],
      [['Hitbox', 'Enemies'], 'a container holds object types'],
      [['Hitbox', 'shield'], 'names are matched with their letter case'],
      [['Hitbox', 'Hitbox'], 'listed twice'],
      [['Hitbox', 'hitbox'], 'listed twice'],
    ];
    for (const [members, reason] of cases) {
      const data = await call('create_container', { members });
      expect(data.isError, members.join()).toBe(true);
      expect(data.text).toContain(reason);
      expect(occurrences(data.text, NOTHING_CHANGED)).toBe(1);
    }
    // One object type is below the tool's schema; the rule itself still refuses it
    expect(() => checkNewContainerMembers(['Hitbox'], OBJECT_NAMES, ['Enemies'], [])).toThrow(ContainerRefusal);
    expect(() => checkNewContainerMembers(['Hitbox'], OBJECT_NAMES, ['Enemies'], []))
      .toThrow('Construct 3 r506-2 refuses to open a project with a container of fewer than two object types');
    expect(await projectText()).toBe(before);
    expect(existsSync(projectPath() + '.bak')).toBe(false);
  });

  it('refuses an object type another container lists', async () => {
    await seed(['Hitbox', 'Shield']);
    const before = await projectText();
    const data = await call('create_container', { members: ['Shield', 'Gem'] });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('Construct 3 r506-2 refuses to open a project in which an object type is in two containers (it reports "already in a container")');
    expect(data.text).toContain('container 0');
    expect(occurrences(data.text, NOTHING_CHANGED)).toBe(1);
    expect(await projectText()).toBe(before);
    expect(existsSync(projectPath() + '.bak')).toBe(false);
  });
});

describe('update_container', () => {
  it('adds and removes members, found by any member ignoring case', async () => {
    await seed(['Hitbox', 'Shield']);
    const added = await call('update_container', { member: 'shield', addMembers: ['Gem'] });
    expect(added).toMatchObject({ success: true, category: 'container', action: 'updated', index: 0, members: ['Hitbox', 'Shield', 'Gem'] });
    expect(added.backupFile).toBeDefined();
    expect((await readProject()).containers).toEqual([{ members: ['Hitbox', 'Shield', 'Gem'] }]);
    const removed = await call('update_container', { member: 'GEM', removeMembers: ['hitbox'] });
    expect(removed).toMatchObject({ action: 'updated', members: ['Shield', 'Gem'] });
    expect((await readProject()).containers).toEqual([{ members: ['Shield', 'Gem'] }]);
    const both = await call('update_container', { member: 'Gem', addMembers: ['Coin'], removeMembers: ['Shield', 'Key'] });
    expect(both.members).toEqual(['Gem', 'Coin']);
    expect(both.warnings?.join(' ')).toContain('"Key" is not in the container');
    expect((await readProject()).containers).toEqual([{ members: ['Gem', 'Coin'] }]);
  });

  it('refuses a name in both addMembers and removeMembers, and a member that is in another container', async () => {
    await seed(['Hitbox', 'Shield'], ['Gem', 'Coin']);
    const before = await projectText();
    const both = await call('update_container', { member: 'Hitbox', addMembers: ['Key'], removeMembers: ['key'] });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('both addMembers and removeMembers');
    const other = await call('update_container', { member: 'Hitbox', addMembers: ['Gem'] });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('is in two containers');
    expect(other.text).toContain('container 1');
    expect(await projectText()).toBe(before);
    expect(existsSync(projectPath() + '.bak')).toBe(false);
  });

  it('refuses to leave fewer than two object types and names delete_container', async () => {
    await seed(['Hitbox', 'Shield']);
    const before = await projectText();
    for (const removeMembers of [['Shield'], ['Hitbox', 'Shield']]) {
      const data = await call('update_container', { member: 'Hitbox', removeMembers });
      expect(data.isError).toBe(true);
      expect(data.text).toContain('delete_container');
      expect(occurrences(data.text, NOTHING_CHANGED)).toBe(1);
    }
    expect(await projectText()).toBe(before);
    expect(existsSync(projectPath() + '.bak')).toBe(false);
  });

  it('reports no change as unchanged and writes nothing', async () => {
    await seed(['Hitbox', 'Shield']);
    const before = await projectText();
    const writes = countProjectWrites();
    const data = await call('update_container', { member: 'Hitbox', addMembers: ['shield'], removeMembers: ['Gem'] });
    expect(data).toMatchObject({ success: true, action: 'unchanged', index: 0, members: ['Hitbox', 'Shield'] });
    expect(data.warnings).toHaveLength(2);
    expect(data.editorNote).toBeUndefined();
    expect(data.backupFile).toBeUndefined();
    const bare = await call('update_container', { member: 'Hitbox' });
    expect(bare).toMatchObject({ action: 'unchanged' });
    expect(bare.editorNote).toBeUndefined();
    expect(writes()).toBe(0);
    expect(await projectText()).toBe(before);
    expect(existsSync(projectPath() + '.bak')).toBe(false);
  });

  it('refuses a member that no container lists', async () => {
    await seed(['Hitbox', 'Shield']);
    const none = await call('update_container', { member: 'Coin', addMembers: ['Key'] });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('No container lists "Coin"');
    expect(occurrences(none.text, NOTHING_CHANGED)).toBe(1);
  });
});

describe('delete_container', () => {
  it('removes the container, keeps the object types, and leaves an emptied list as []', async () => {
    await seed(['Hitbox', 'Shield'], ['Gem', 'Coin']);
    const first = await call('delete_container', { member: 'gem' });
    expect(first).toMatchObject({ success: true, category: 'container', action: 'deleted', index: 1, members: ['Gem', 'Coin'] });
    expect(first.backupFile).toBeDefined();
    expect((await readProject()).containers).toEqual([{ members: ['Hitbox', 'Shield'] }]);
    await call('delete_container', { member: 'Hitbox' });
    const project = await readProject();
    expect(project.containers).toEqual([]);
    expect(project.objectTypes.items).toEqual(expect.arrayContaining(OBJECT_NAMES));
    for (const name of OBJECT_NAMES) expect(existsSync(objectPath(name))).toBe(true);
    expect(JSON.parse(await projectText())).toHaveProperty('containers', []);
  });
});

describe('a save of project.c3proj during the call', () => {
  it('keeps a save of project.c3proj made during the call, and still writes the change', async () => {
    await seed(['Hitbox', 'Shield']);
    const saved = await savedWith([['Hitbox', 'Shield'], ['Gem', 'Coin']]);
    saveBeforeUpdate(() => writeFile(projectPath(), saved));
    const data = await call('update_container', { member: 'Hitbox', addMembers: ['Key'] });
    expect(data).toMatchObject({ success: true, action: 'updated', index: 0 });
    expect((await readProject()).containers).toEqual([{ members: ['Hitbox', 'Shield', 'Key'] }, { members: ['Gem', 'Coin'] }]);
  });

  it('refuses inside the update when a save during the call made the change invalid', async () => {
    await seed(['Hitbox', 'Shield']);
    const saved = await savedWith([['Hitbox', 'Shield'], ['Gem', 'Coin']]);
    saveBeforeUpdate(() => writeFile(projectPath(), saved));
    const data = await call('create_container', { members: ['Gem', 'Key'] });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('already in a container');
    expect(await projectText()).toBe(saved);
    expect(existsSync(projectPath() + '.bak')).toBe(false);
  });

  it('returns a refusal found inside the update with one "Nothing was changed."', async () => {
    await seed(['Hitbox', 'Shield']);
    const saved = await savedWith([['Hitbox', 'Shield'], ['Gem', 'Coin']]);
    saveBeforeUpdate(() => writeFile(projectPath(), saved));
    const data = await call('create_container', { members: ['Gem', 'Key'] });
    expect(data.isError).toBe(true);
    expect(occurrences(data.text, NOTHING_CHANGED)).toBe(1);
  });

  it('reports the index of the last update round when a save during the call moved the container', async () => {
    await seed(['Hitbox', 'Shield'], ['Gem', 'Coin']);
    const saved = await savedWith([['Orb', 'Rock'], ['Hitbox', 'Shield'], ['Gem', 'Coin']]);
    saveDuringUpdate(() => writeFile(projectPath(), saved));
    const data = await call('update_container', { member: 'Gem', addMembers: ['Key'] });
    expect(data).toMatchObject({ success: true, action: 'updated', index: 2, members: ['Gem', 'Coin', 'Key'] });
    expect((await readProject()).containers).toEqual([
      { members: ['Orb', 'Rock'] }, { members: ['Hitbox', 'Shield'] }, { members: ['Gem', 'Coin', 'Key'] },
    ]);
  });

  it('refuses when a save during the call moved another container to the given index', async () => {
    await seed(['Hitbox', 'Shield'], ['Gem', 'Coin']);
    const saved = await savedWith([['Gem', 'Coin'], ['Hitbox', 'Shield']]);
    saveDuringUpdate(() => writeFile(projectPath(), saved));
    const data = await call('update_container', { member: 'Hitbox', index: 0, addMembers: ['Key'] });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('does not list "Hitbox"');
    expect(occurrences(data.text, NOTHING_CHANGED)).toBe(1);
    // project.c3proj is the save, byte for byte. The writer made its backup in round 1, before it saw the file change,
    // so project.c3proj.bak is left next to the refusal (it holds the file as round 1 read it)
    expect(await projectText()).toBe(saved);
    expect(existsSync(projectPath() + '.bak')).toBe(true);
  });
});

describe('delete_container and a save during the call', () => {
  it('deletes the container that lists the member as the file stands, when a save during the call reordered the containers', async () => {
    await seed(['Hitbox', 'Shield'], ['Gem', 'Coin']);
    const saved = await savedWith([['Gem', 'Coin'], ['Hitbox', 'Shield']]);
    saveDuringUpdate(() => writeFile(projectPath(), saved));
    const data = await call('delete_container', { member: 'Gem' });
    expect(data).toMatchObject({ success: true, action: 'deleted', index: 0, members: ['Gem', 'Coin'] });
    expect((await readProject()).containers).toEqual([{ members: ['Hitbox', 'Shield'] }]);
  });
});

describe('a failed write of project.c3proj', () => {
  it('puts project.c3proj back when its write fails its read-back', async () => {
    const before = await projectText();
    failReadBackOfProject();
    const data = await call('create_container', { members: ['Hitbox', 'Shield'] });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back: project.c3proj is as before the call.');
    expect(await projectText()).toBe(before);
  });

  it('names project.c3proj and its .bak, without "Nothing was changed.", when its replacement failed after the old file was removed', async () => {
    const before = await projectText();
    failProjectReplace(true);
    const data = await call('create_container', { members: ['Hitbox', 'Shield'] });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('project.c3proj (it is missing');
    expect(data.text).toContain('project.c3proj.bak');
    expect(data.text).not.toContain(NOTHING_CHANGED);
    expect(await readFile(projectPath() + '.bak', 'utf8')).toBe(before);
  });
});

describe('the tools and validate_project', () => {
  it('validate_project and the tools agree on every container problem', async () => {
    const cases: Array<{ kind: 'missing' | 'case-variant' | 'too-few'; members: string[]; severity: 'errors' | 'warnings' }> = [
      { kind: 'missing', members: ['Hitbox', 'Ghost'], severity: 'errors' },
      { kind: 'case-variant', members: ['hitbox', 'Shield'], severity: 'warnings' },
      { kind: 'too-few', members: ['Shield'], severity: 'errors' },
    ];
    for (const { kind, members, severity } of cases) {
      await seed(members);
      const result = await validateProjectIntegrity(reader);
      expect(result[severity].filter(issue => issue.check === 'container-member'), kind).not.toHaveLength(0);
      expect(containerMemberProblems(members, OBJECT_NAMES).map(problem => problem.kind)).toContain(kind);
      await seed();
      if (members.length >= 2) {
        const data = await call('create_container', { members });
        expect(data.isError, kind).toBe(true);
      } else {
        expect(() => checkNewContainerMembers(members, OBJECT_NAMES, [], []), kind).toThrow(ContainerRefusal);
      }
    }
    await seed(['Hitbox', 'Shield']);
    const valid = await validateProjectIntegrity(reader);
    expect([...valid.errors, ...valid.warnings].filter(issue => issue.check === 'container-member')).toEqual([]);
    expect(containerMemberProblems(['Hitbox', 'Shield'], OBJECT_NAMES)).toEqual([]);
  });
});

describe('a member that two containers list', () => {
  it('update_container and delete_container refuse a member two containers list, naming both indexes, and write nothing', async () => {
    await seed(['Hitbox', 'Shield'], ['Hitbox', 'Gem']);
    const before = await projectText();
    for (const [tool, extra] of [['update_container', { addMembers: ['Key'] }], ['delete_container', {}]] as const) {
      const data = await call(tool, { member: 'hitbox', ...extra });
      expect(data.isError, tool).toBe(true);
      expect(data.text).toContain('container 0');
      expect(data.text).toContain('container 1');
      expect(data.text).toContain('give index');
      expect(occurrences(data.text, NOTHING_CHANGED)).toBe(1);
    }
    expect(await projectText()).toBe(before);
    expect(existsSync(projectPath() + '.bak')).toBe(false);
  });

  it('update_container and delete_container with index edit that container only', async () => {
    await seed(['Hitbox', 'Shield'], ['Hitbox', 'Gem', 'Coin']);
    const updated = await call('update_container', { member: 'Hitbox', index: 1, removeMembers: ['Hitbox'] });
    expect(updated).toMatchObject({ action: 'updated', index: 1, members: ['Gem', 'Coin'] });
    expect((await readProject()).containers).toEqual([{ members: ['Hitbox', 'Shield'] }, { members: ['Gem', 'Coin'] }]);
    await seed(['Hitbox', 'Shield'], ['Hitbox', 'Gem']);
    const deleted = await call('delete_container', { member: 'Hitbox', index: 0 });
    expect(deleted).toMatchObject({ action: 'deleted', index: 0, members: ['Hitbox', 'Shield'] });
    expect((await readProject()).containers).toEqual([{ members: ['Hitbox', 'Gem'] }]);
    const wrong = await call('delete_container', { member: 'Hitbox', index: 5 });
    expect(wrong.isError).toBe(true);
    expect((await readProject()).containers).toEqual([{ members: ['Hitbox', 'Gem'] }]);
  });
});
