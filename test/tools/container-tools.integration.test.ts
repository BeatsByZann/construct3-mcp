/**
 * Real-reader/writer tests for the container tools.
 *
 * Containers have no entity file: the whole set lives in a flat
 * `containers: [{ members: [...] }]` array at the root of `project.c3proj`,
 * and an object type may belong to at most one container. These tests run
 * against a temp copy of the minimal fixture with the real reader, writer and
 * ID generator so the on-disk c3proj and the reloaded project are both
 * checked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerContainerTools } from '../../src/tools/container-tools.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe('container tools (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let idGen: IdGenerator;
  let server: MockServer;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-container-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });

    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerContainerTools({ server, reader, writer, idGen } as any);
    registerObjectTools({ server, reader, writer, idGen } as any);

    // The fixture ships one object type; containers need more than one.
    for (const name of ['Enemy', 'Weapon', 'Shield']) {
      const created = parseResult(await server.callTool('create_object', { name, pluginId: 'Text' }));
      expect(created.success).toBe(true);
    }
    const family = parseResult(await server.callTool('create_family', { name: 'fAgents', pluginId: 'Text', members: ['Enemy'] }));
    expect(family.success).toBe(true);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function projectOnDisk(): Promise<Record<string, any>> {
    return JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8'));
  }

  async function listed(): Promise<Array<{ members: string[] }>> {
    return parseResult(await server.callTool('list_containers')).containers;
  }

  it('reports no containers for a project without a containers key', async () => {
    const result = parseResult(await server.callTool('list_containers'));
    expect(result.containers).toEqual([]);
    expect(result.count).toBe(0);
    expect(await projectOnDisk()).not.toHaveProperty('containers');
  });

  it('creates a container, writes it to c3proj and backs the file up', async () => {
    const result = parseResult(await server.callTool('create_container', { members: ['Enemy', 'Weapon'] }));
    expect(result.success).toBe(true);
    expect(result.category).toBe('container');
    expect(result.action).toBe('created');
    expect(result.members).toEqual(['Enemy', 'Weapon']);
    expect(result.warnings).toBeUndefined();

    expect((await projectOnDisk()).containers).toEqual([{ members: ['Enemy', 'Weapon'] }]);
    // The reloaded project (not just the file) sees it
    expect(await listed()).toEqual([{ members: ['Enemy', 'Weapon'] }]);
    await expect(stat(join(tmpDir, 'project.c3proj.bak'))).resolves.toBeDefined();
  });

  it('warns when a container has only one member', async () => {
    const result = parseResult(await server.callTool('create_container', { members: ['Enemy'] }));
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('only one member');
  });

  it('refuses a member that is not an object type', async () => {
    const result = await server.callTool('create_container', { members: ['Enemy', 'Ghost'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Object type "Ghost" not found');
    expect(await projectOnDisk()).not.toHaveProperty('containers');
  });

  it('refuses a family as a container member', async () => {
    const result = await server.callTool('create_container', { members: ['Enemy', 'fAgents'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('is a family');
    expect(await projectOnDisk()).not.toHaveProperty('containers');
  });

  it('refuses a member already held by another container', async () => {
    expect(parseResult(await server.callTool('create_container', { members: ['Enemy', 'Weapon'] })).success).toBe(true);

    const result = await server.callTool('create_container', { members: ['Weapon', 'Shield'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already in another container');
    // The first container is untouched and no second one was written
    expect((await projectOnDisk()).containers).toEqual([{ members: ['Enemy', 'Weapon'] }]);
  });

  it('refuses a member listed twice in one request', async () => {
    const result = await server.callTool('create_container', { members: ['Enemy', 'Enemy'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('listed more than once');
  });

  it('adds and removes members, identified by any current member', async () => {
    await server.callTool('create_container', { members: ['Enemy', 'Weapon'] });

    const added = parseResult(await server.callTool('update_container', { member: 'Weapon', addMembers: ['Shield'] }));
    expect(added.success).toBe(true);
    expect(added.action).toBe('updated');
    expect(added.members).toEqual(['Enemy', 'Weapon', 'Shield']);

    const removed = parseResult(await server.callTool('update_container', { member: 'Shield', removeMembers: ['Enemy'] }));
    expect(removed.members).toEqual(['Weapon', 'Shield']);
    expect((await projectOnDisk()).containers).toEqual([{ members: ['Weapon', 'Shield'] }]);
  });

  it('warns instead of failing on a duplicate add or an absent remove', async () => {
    await server.callTool('create_container', { members: ['Enemy', 'Weapon'] });
    const result = parseResult(await server.callTool('update_container', {
      member: 'Enemy', addMembers: ['Weapon'], removeMembers: ['Shield'],
    }));
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('already in container');
    expect(result.warnings.join(' ')).toContain('not in container');
    expect(result.members).toEqual(['Enemy', 'Weapon']);
  });

  it('refuses adding an object type held by another container', async () => {
    await server.callTool('create_container', { members: ['Enemy', 'Weapon'] });
    await server.callTool('create_container', { members: ['Shield'] });

    const result = await server.callTool('update_container', { member: 'Enemy', addMembers: ['Shield'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already in another container');
    expect((await projectOnDisk()).containers).toEqual([
      { members: ['Enemy', 'Weapon'] },
      { members: ['Shield'] },
    ]);
  });

  it('deletes the container when its last member is removed', async () => {
    await server.callTool('create_container', { members: ['Enemy', 'Weapon'] });
    const result = parseResult(await server.callTool('update_container', {
      member: 'Enemy', removeMembers: ['Enemy', 'Weapon'],
    }));
    expect(result.success).toBe(true);
    expect(result.action).toBe('deleted');
    expect(result.members).toEqual([]);
    expect(result.warnings.join(' ')).toContain('no members left');
    expect(await projectOnDisk()).not.toHaveProperty('containers');
    expect(await listed()).toEqual([]);
  });

  it('requires at least one update', async () => {
    await server.callTool('create_container', { members: ['Enemy', 'Weapon'] });
    const result = await server.callTool('update_container', { member: 'Enemy' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates provided');
  });

  it('errors when no container holds the named member', async () => {
    const update = await server.callTool('update_container', { member: 'Enemy', addMembers: ['Weapon'] });
    expect(update.isError).toBe(true);
    expect(update.content[0].text).toContain('No container includes object type "Enemy"');

    const del = await server.callTool('delete_container', { member: 'Enemy' });
    expect(del.isError).toBe(true);
    expect(del.content[0].text).toContain('No container includes object type "Enemy"');
  });

  it('deletes a container without deleting its object types', async () => {
    await server.callTool('create_container', { members: ['Enemy', 'Weapon'] });
    await server.callTool('create_container', { members: ['Shield'] });

    const result = parseResult(await server.callTool('delete_container', { member: 'Weapon' }));
    expect(result.success).toBe(true);
    expect(result.action).toBe('deleted');
    expect(result.members).toEqual(['Enemy', 'Weapon']);

    expect((await projectOnDisk()).containers).toEqual([{ members: ['Shield'] }]);
    const objectTypes = await reader.listObjectTypes();
    expect(objectTypes).toEqual(expect.arrayContaining(['Enemy', 'Weapon', 'Shield']));
    await expect(stat(join(tmpDir, 'objectTypes', 'Enemy.json'))).resolves.toBeDefined();
  });

  it('keeps the c3proj parseable and otherwise unchanged', async () => {
    const before = await projectOnDisk();
    await server.callTool('create_container', { members: ['Enemy', 'Weapon'] });
    const after = await projectOnDisk();

    expect(after.containers).toBeDefined();
    delete after.containers;
    expect(after).toEqual(before);
  });
});
