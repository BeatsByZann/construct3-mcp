/**
 * Container members (project.c3proj "containers"): delete_object takes the
 * object type out of its containers in the same project.c3proj update that
 * deregisters it, so the project still opens; the analysis tools list
 * container membership; validate_project reports a member that names no
 * object type (container-member). Synthetic data on a temp copy of the
 * minimal fixture, with the real reader and writer.
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
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface ProjectFile {
  name: string;
  objectTypes: { items: string[] };
  containers?: Array<{ members: string[] }>;
  [key: string]: unknown;
}
interface ObjectFile { name: string; sid: number; [key: string]: unknown }
interface ContainerJson { index: number; members: string[]; others?: string[] }
interface ToolData {
  isError?: boolean;
  text?: string;
  success?: boolean;
  action?: string;
  warnings?: string[];
  containersUpdated?: ContainerJson[];
  containersRemoved?: ContainerJson[];
  [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const projectPath = () => join(tmpDir, 'project.c3proj');
const objectPath = (name: string) => join(tmpDir, 'objectTypes', `${name}.json`);
const readProject = async (): Promise<ProjectFile> => JSON.parse(await readFile(projectPath(), 'utf8')) as ProjectFile;
const call = async (tool: string, args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};

/** An object type `name`: a copy of the fixture's Sprite with its own name and SID, not placed or used anywhere. */
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

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-containers-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  const names: Array<[string, number]> = [
    ['Hitbox', 710000000000001], ['Shield', 710000000000002], ['Gem', 710000000000003],
    ['Coin', 710000000000004], ['Key', 710000000000005],
  ];
  for (const [name, sid] of names) await addObjectType(name, sid);
  reader = new Construct3ProjectReader(projectPath());
  await reader.loadProject();
  await setProject(project => {
    project.objectTypes.items.push(...names.map(([name]) => name));
    // A two-member and a three-member container
    project.containers = [{ members: ['Hitbox', 'Shield'] }, { members: ['Gem', 'Coin', 'Key'] }];
  });
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerObjectTools({ server, reader, writer, idGen } as never);
  registerAnalysisTools(server as never, reader);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('delete_object and containers', () => {
  it('takes the object type out of its container, without force', async () => {
    const data = await call('delete_object', { name: 'Gem' });
    expect(data.success).toBe(true);
    expect(data.containersUpdated).toEqual([{ index: 1, members: ['Coin', 'Key'] }]);
    expect((data.warnings ?? []).join(' ')).toContain('Taken out of the container with "Coin", "Key".');
    const project = await readProject();
    expect(project.containers).toEqual([{ members: ['Hitbox', 'Shield'] }, { members: ['Coin', 'Key'] }]);
    expect(project.objectTypes.items).not.toContain('Gem');
    expect(existsSync(objectPath('Gem'))).toBe(false);
  });

  it('takes out a member saved in another letter case', async () => {
    await setProject(project => { project.containers![1].members = ['gem', 'Coin', 'Key']; });
    const data = await call('delete_object', { name: 'Gem' });
    expect(data.success).toBe(true);
    expect((await readProject()).containers![1].members).toEqual(['Coin', 'Key']);
  });

  it('writes project.c3proj once, with the registration and the membership both gone', async () => {
    const writes = countProjectWrites();
    await call('delete_object', { name: 'Gem' });
    expect(writes()).toBe(1);
    const project = await readProject();
    expect(project.objectTypes.items).not.toContain('Gem');
    expect(project.containers![1].members).toEqual(['Coin', 'Key']);
  });

  it('changes no container when none lists the object type, still in one write', async () => {
    await setProject(project => { project.containers = [{ members: ['Coin', 'Key'] }]; });
    const writes = countProjectWrites();
    const data = await call('delete_object', { name: 'Gem' });
    expect(data.success).toBe(true);
    expect(writes()).toBe(1);
    expect(data.containersUpdated).toBeUndefined();
    expect((await readProject()).containers).toEqual([{ members: ['Coin', 'Key'] }]);
  });

  it('puts the object file back when the project.c3proj update fails, and changes nothing', async () => {
    const projectBefore = await readFile(projectPath());
    const objectBefore = await readFile(objectPath('Gem'));
    writer.removeFromProject = async () => { throw new Error('disk full'); };
    const data = await call('delete_object', { name: 'Gem' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('disk full');
    expect(Buffer.compare(await readFile(projectPath()), projectBefore)).toBe(0);
    expect(Buffer.compare(await readFile(objectPath('Gem')), objectBefore)).toBe(0);
  });

  it('puts the registration and the membership back when the file delete fails after the update', async () => {
    const projectBefore = await readFile(projectPath());
    const objectBefore = await readFile(objectPath('Gem'));
    writer.deleteEntityFile = async () => { throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' }); };
    const data = await call('delete_object', { name: 'Gem' });
    expect(data.isError).toBe(true);
    expect(Buffer.compare(await readFile(projectPath()), projectBefore)).toBe(0);
    expect(Buffer.compare(await readFile(objectPath('Gem')), objectBefore)).toBe(0);
  });

  it('builds the update on project.c3proj as found on disk, not on the reader\'s copy', async () => {
    // The editor opened the project before the call and saves it (with a change of its own) before the update
    // starts: the update reads that save, so it never needs a retry round (the next test does)
    const snapshot = await readProject();
    const saved = JSON.stringify({ ...snapshot, name: 'Saved in the editor' }, null, '\t');
    const removeFromProject = writer.removeFromProject.bind(writer);
    writer.removeFromProject = async (...args) => {
      await writeFile(projectPath(), saved);
      return removeFromProject(...args);
    };
    const data = await call('delete_object', { name: 'Gem' });
    expect(data.success).toBe(true);
    const project = await readProject();
    expect(project.name).toBe('Saved in the editor');
    expect(project.objectTypes.items).not.toContain('Gem');
    expect(project.containers![1].members).toEqual(['Coin', 'Key']);
  });

  it('keeps an editor save that lands during the update, which runs again on it, in one write', async () => {
    // The editor saves its older copy (with a change of its own) after the update has read the file and
    // made its backup but before the write: the update sees the file changed, reads it again and runs the
    // container change on it again
    const snapshot = await readProject();
    const saved = JSON.stringify({ ...snapshot, name: 'Saved in the editor' }, null, '\t');
    const internals = writer as unknown as { createBackup: (path: string, options?: unknown) => Promise<string> };
    const createBackup = internals.createBackup.bind(writer);
    let saves = 0;
    internals.createBackup = async (path, options) => {
      const backup = await createBackup(path, options);
      if (path.endsWith('project.c3proj') && saves++ === 0) await writeFile(projectPath(), saved);
      return backup;
    };
    const writes = countProjectWrites();
    const data = await call('delete_object', { name: 'Gem' });
    expect(data.success).toBe(true);
    expect(saves).toBe(2);
    const project = await readProject();
    expect(project.name).toBe('Saved in the editor');
    expect(project.objectTypes.items).not.toContain('Gem');
    expect(project.containers![1].members).toEqual(['Coin', 'Key']);
    expect(writes()).toBe(1);
  });

  it('counts only members that are names toward the two a container needs', async () => {
    await setProject(project => { project.containers = [{ members: ['Gem', 'Coin', null as never] }, { members: ['Hitbox', 'Shield'] }]; });
    const data = await call('delete_object', { name: 'Gem' });
    expect(data.success).toBe(true);
    expect(data.containersRemoved).toEqual([{ index: 0, members: ['Gem', 'Coin'] }]);
    expect((await readProject()).containers).toEqual([{ members: ['Hitbox', 'Shield'] }]);
  });

  it('puts everything back when the write of project.c3proj fails after the container change was made', async () => {
    const projectBefore = await readFile(projectPath());
    const objectBefore = await readFile(objectPath('Gem'));
    let changed = false;
    const removeFromProject = writer.removeFromProject.bind(writer);
    writer.removeFromProject = async (category, name, options) => {
      await removeFromProject(category, name, {
        alsoChange: project => { options?.alsoChange?.(project); changed = true; },
      });
    };
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    internals.atomicWrite = async (path, content) => {
      if (path.endsWith('project.c3proj')) throw new Error('disk full');
      return atomicWrite(path, content);
    };
    const data = await call('delete_object', { name: 'Gem' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('disk full');
    expect(changed).toBe(true);
    expect(Buffer.compare(await readFile(projectPath()), projectBefore)).toBe(0);
    expect(Buffer.compare(await readFile(objectPath('Gem')), objectBefore)).toBe(0);
  });

  it('removes a container left with fewer than two members, in the same update', async () => {
    const data = await call('delete_object', { name: 'Hitbox' });
    expect(data.success).toBe(true);
    expect(data.containersRemoved).toEqual([{ index: 0, members: ['Hitbox', 'Shield'] }]);
    expect((await readProject()).containers).toEqual([{ members: ['Gem', 'Coin', 'Key'] }]);
    expect((data.warnings ?? []).join(' ')).toContain('Removed the container with "Hitbox", "Shield", since fewer than two members were left.');
  });

  it('counts a name listed twice once, so a container left with one distinct member is removed', async () => {
    await setProject(project => { project.containers = [{ members: ['Sprite', 'Sprite', 'Hitbox'] }]; });
    const data = await call('delete_object', { name: 'Hitbox' });
    expect(data.success).toBe(true);
    expect(data.containersRemoved).toEqual([{ index: 0, members: ['Sprite', 'Sprite', 'Hitbox'] }]);
    expect((await readProject()).containers).toEqual([]);
  });
});

interface Orphans { orphanedObjects: Array<{ name: string; containers?: ContainerJson[] }> }
interface Dependencies { object: { containers?: ContainerJson[] } }

describe('analysis tools and containers', () => {
  it('find_orphaned_objects lists the containers of an orphan', async () => {
    const data = await call('find_orphaned_objects', {}) as unknown as Orphans;
    const gem = data.orphanedObjects.find(o => o.name === 'Gem');
    expect(gem?.containers).toEqual([{ index: 1, members: ['Gem', 'Coin', 'Key'], others: ['Coin', 'Key'] }]);
  });

  it('get_object_dependencies reports container membership, read from project.c3proj as it is now', async () => {
    const one = await call('get_object_dependencies', { object: 'Gem' }) as unknown as Dependencies;
    expect(one.object.containers).toEqual([{ index: 1, members: ['Gem', 'Coin', 'Key'], others: ['Coin', 'Key'] }]);
    const sprite = await call('get_object_dependencies', { object: 'Sprite' }) as unknown as Dependencies;
    expect(sprite.object.containers).toBeUndefined();
    // An own write of project.c3proj that touches nothing else: the next call sees it
    await writer.updateProject(project => { project.containers = []; });
    const after = await call('get_object_dependencies', { object: 'Gem' }) as unknown as Dependencies;
    expect(after.object.containers).toBeUndefined();
  });
});

describe('validate_project container-member', () => {
  const containerIssues = async () => {
    const result = await validateProjectIntegrity(reader);
    const pick = (list: typeof result.errors) => list.filter(e => e.check === 'container-member');
    return { errors: pick(result.errors), warnings: pick(result.warnings), info: pick(result.info) };
  };

  it('reports nothing while every container has two or more object types', async () => {
    expect(await containerIssues()).toEqual({ errors: [], warnings: [], info: [] });
  });

  it('reports a member that names no object type as an error', async () => {
    await setProject(project => { project.containers![1].members.push('Ghost'); });
    const { errors } = await containerIssues();
    expect(errors).toHaveLength(1);
    expect(errors[0].entity).toBe('containers/1');
    expect(errors[0].message).toContain('lists "Ghost", which is not an object type of the project');
    expect(errors[0].message).toContain('cannot find object type name');
  });

  it('warns about a member that differs only in case', async () => {
    await setProject(project => { project.containers![0].members = ['hitbox', 'Shield']; });
    const { errors, warnings } = await containerIssues();
    expect(errors).toEqual([]);
    expect(warnings.map(w => w.message)).toEqual([expect.stringContaining('"hitbox", which differs only in letter case from the object type "Hitbox"')]);
  });

  it('reports a container with fewer than two object types as an error', async () => {
    await setProject(project => { project.containers![0].members = ['Shield']; });
    const { errors } = await containerIssues();
    expect(errors.map(e => e.message)).toEqual([expect.stringContaining('has only one member that is an object type ("Shield")')]);
  });

  it('reports no error after delete_object took the member out', async () => {
    await call('delete_object', { name: 'Gem' });
    expect((await containerIssues()).errors).toEqual([]);
  });
});
