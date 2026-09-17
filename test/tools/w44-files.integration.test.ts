import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, stat, mkdir, rename, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { MockServer } from '../mocks/mock-server.js';

const cases = [
  ['layouts', 'create_layout', 'delete_layout'],
  ['objectTypes', 'create_object', 'delete_object'],
  ['eventSheets', 'create_event_sheet', 'delete_event_sheet'],
  ['families', 'create_family', 'delete_family'],
] as const;

describe('recursive orphan scan and nested deletion', () => {
  let dir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let server: MockServer;
  beforeEach(async () => {
    resetProjectIndex();
    dir = await mkdtemp(join(tmpdir(), 'c3-w44-'));
    await cp(join(__dirname, '..', 'fixtures', 'minimal-project'), dir, { recursive: true });
    reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerMutationTools(server as any, reader, writer, idGen);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetProjectIndex();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function nestedEntity(category: typeof cases[number][0], create: string) {
    const created = await server.callTool(create, { name: 'Nested', pluginId: 'Sprite' });
    expect(created.isError).not.toBe(true);
    await mkdir(join(dir, category, 'Outer', 'Inner'), { recursive: true });
    await writer.removeFromProject(category, 'Nested');
    await rename(join(dir, category, 'Nested.json'), join(dir, category, 'Outer/Inner/Nested.json'));
    await writer.addToProject(category, 'Nested', 'Outer/Inner');
  }

  it.each(cases)('reports deep %s orphans without hiding a duplicate basename', async (category, create) => {
    await nestedEntity(category, create);
    await writeFile(join(dir, category, 'Nested.json'), '{}');
    await writeFile(join(dir, category, 'Outer/Inner/Orphan.json'), '{}');
    await writeFile(join(dir, category, 'Outer/Inner/ignored.txt'), 'not JSON');
    const result = await validateProjectIntegrity(reader);
    const paths = result.info.filter(i => i.check === 'orphaned-file').map(i => i.entity);
    expect(paths).toEqual(expect.arrayContaining([`${category}/Nested.json`, `${category}/Outer/Inner/Orphan.json`]));
    expect(paths).not.toContain(`${category}/Outer/Inner/Nested.json`);
    expect(paths).not.toContain(`${category}/Outer/Inner/ignored.txt`);
  });

  it.each(cases)('deletes nested %s using the subfolder captured before deregistration', async (category, create, remove) => {
    await nestedEntity(category, create);
    const path = join(dir, category, 'Outer/Inner/Nested.json');
    const original = await readFile(path, 'utf8');
    const result = await server.callTool(remove, { name: 'Nested' });
    expect(result.isError).not.toBe(true);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(`${path}.bak`, 'utf8')).toBe(original);
    expect(reader.getEntityRelativePath(category, 'Nested')).toBe(`${category}/Nested.json`);
    expect((await validateProjectIntegrity(reader)).info.filter(i => i.check === 'orphaned-file')).toEqual([]);
  });

  it.each(cases)('reports the exact nested %s orphan after a failed delete', async (category, create, remove) => {
    await nestedEntity(category, create);
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error(`EACCES: permission denied, unlink '${join(dir, category, 'Outer/Inner/Nested.json')}'`));
    const result = await server.callTool(remove, { name: 'Nested' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`${category}/Outer/Inner/Nested.json`);
    expect(result.content[0].text).toContain('.bak');
    expect(result.content[0].text).toContain('validate_project');
    expect(result.content[0].text).not.toContain(dir);
    expect((await validateProjectIntegrity(reader)).info).toContainEqual(expect.objectContaining({
      check: 'orphaned-file', entity: `${category}/Outer/Inner/Nested.json`,
    }));
  });

  it('does not traverse a category root that is itself a directory link', async () => {
    const target = join(dir, 'linked-target');
    await mkdir(target);
    await writeFile(join(target, 'Outside.json'), '{}');
    await rm(join(dir, 'families'), { recursive: true, force: true });
    await symlink(target, join(dir, 'families'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await validateProjectIntegrity(reader);
    expect(result.info.some(i => i.check === 'orphaned-file' && i.entity === 'families/Outside.json')).toBe(false);
  });

  it('does not follow a directory link back into the project', async () => {
    // A Windows junction needs no symlink privilege; directory symlinks work on POSIX.
    await symlink(dir, join(dir, 'layouts', 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await validateProjectIntegrity(reader);
    expect(result.info.some(i => i.entity.includes('/loop/'))).toBe(false);
  });
});
