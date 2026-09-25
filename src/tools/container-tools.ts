/**
 * Container tools: list_containers, create_container, update_container,
 * delete_container.
 *
 * A Construct 3 "container" groups object types so the editor and runtime
 * create, pick and destroy them together. Unlike every other entity in this
 * server, a container has no name and no JSON file of its own: the whole set
 * lives in a flat array at the root of `project.c3proj`:
 *
 *   "containers": [ { "members": ["diBlackboardPersist", "gcC3ACEController"] } ]
 *
 * (shape confirmed against the C3-ACE project, r495 format). A container is
 * therefore identified by any one of its members, and an object type may
 * belong to at most one container.
 *
 * Because there is no per-entity file, these tools read/modify/write
 * `project.c3proj` directly with the same backup + temp-file + rename pattern
 * `timeline-tools.ts` uses, then ask the reader to reload.
 */

import { z } from 'zod';
import { upgradeProjectShape } from '../construct3/project-shape.js';
import { readFile, writeFile, copyFile, unlink, rename, stat } from 'fs/promises';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectContainer } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';

/** WriteResult plus the container's resulting member list. */
interface ContainerWriteResult extends WriteResult {
  members: string[];
}

// ─── project.c3proj I/O ────────────────────────────────────

type ProjectJson = Record<string, unknown>;

async function readProjectJson(projectPath: string): Promise<ProjectJson> {
  const content = await readFile(projectPath, 'utf-8');
  return JSON.parse(content) as ProjectJson;
}

async function backupProjectFile(projectPath: string): Promise<string> {
  const bak = projectPath + '.bak';
  try {
    await stat(projectPath);
    await copyFile(projectPath, bak);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') return bak;
    throw e;
  }
  return bak;
}

async function atomicWriteProjectJson(projectPath: string, project: ProjectJson): Promise<void> {
  upgradeProjectShape(project as unknown as Record<string, unknown>);
  const tmpPath = projectPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(project, null, '\t'), 'utf-8');
  try {
    await rename(tmpPath, projectPath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(projectPath);
      await rename(tmpPath, projectPath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

// ─── Container helpers ─────────────────────────────────────

/**
 * Read the containers array out of a parsed project, tolerating a missing key
 * and entries whose `members` is absent or not an array (a hand-edited file).
 * Returns normalized copies for reading; use `containersInPlace` to mutate.
 */
function readContainers(project: { containers?: unknown }): ObjectContainer[] {
  const raw = project.containers;
  if (!Array.isArray(raw)) return [];
  return raw.map(entry => {
    const members = (entry as ObjectContainer | undefined)?.members;
    return { ...(entry as ObjectContainer), members: Array.isArray(members) ? members.filter(m => typeof m === 'string') : [] };
  });
}

/** Get the live containers array on a parsed project, creating it if absent. */
function containersInPlace(project: ProjectJson): ObjectContainer[] {
  if (!Array.isArray(project.containers)) project.containers = [];
  const containers = project.containers as ObjectContainer[];
  for (const c of containers) {
    if (!Array.isArray(c.members)) c.members = [];
  }
  return containers;
}

/** Index of the container holding `member`, or -1. */
function findContainerIndex(containers: ObjectContainer[], member: string): number {
  return containers.findIndex(c => c.members.includes(member));
}

/**
 * Validate names destined for a container.
 *
 * @param skipIndex  Index of the container being edited; membership in that
 *                   container is not an "already in another container" error.
 * @returns An error message, or null when every name is usable.
 */
async function validateMembers(
  reader: MutationToolDeps['reader'],
  names: string[],
  containers: ObjectContainer[],
  skipIndex: number,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      return `Member "${name}" is listed more than once.`;
    }
    seen.add(name);
  }

  const objectTypes = await reader.listObjectTypes();
  const families = await reader.listFamilies();
  for (const name of names) {
    if (!objectTypes.includes(name)) {
      const hint = families.includes(name)
        ? ` "${name}" is a family; containers hold object types only.`
        : ' Use list_objects to see available object types.';
      return `Object type "${name}" not found.${hint}`;
    }
    const existing = findContainerIndex(containers, name);
    if (existing !== -1 && existing !== skipIndex) {
      return `Object type "${name}" is already in another container (members: ${containers[existing].members.join(', ')}). ` +
        'An object type may belong to at most one container; remove it from that container first.';
    }
  }
  return null;
}

/** C3 only treats a container as meaningful once it has two or more members. */
function singleMemberWarning(members: string[]): string | null {
  if (members.length !== 1) return null;
  return `Container has only one member ("${members[0]}"). Construct 3 containers are only meaningful with 2 or more members.`;
}

// ─── Registration ──────────────────────────────────────────

export function registerContainerTools({ server, reader }: MutationToolDeps) {
  // ─── list_containers ──────────────────────────────────────

  server.tool(
    'list_containers',
    'List all object containers in the project. A container groups object types so C3 creates, picks and destroys them together.',
    {},
    async () => {
      try {
        const containers = readContainers(reader.getProject());
        return toolResult({
          containers: containers.map(c => ({ members: c.members })),
          count: containers.length,
        });
      } catch (error) {
        console.error('[list_containers] failed:', error);
        return toolError(`Error listing containers: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── create_container ─────────────────────────────────────

  server.tool(
    'create_container',
    'Create an object container from existing object types. Each object type may belong to at most one container.',
    {
      members: z.array(z.string().max(200)).min(1).max(100).describe('Object type names to put in the container (2 or more for a meaningful container)'),
    },
    async (args) => {
      try {
        const projectPath = reader.getProjectPath();
        const project = await readProjectJson(projectPath);
        const containers = containersInPlace(project);

        const problem = await validateMembers(reader, args.members, containers, -1);
        if (problem) return toolError(problem);

        const warnings: string[] = [];
        const oneMember = singleMemberWarning(args.members);
        if (oneMember) warnings.push(oneMember);

        const created: ObjectContainer = { members: [...args.members] };
        containers.push(created);

        const backupPath = await backupProjectFile(projectPath);
        await atomicWriteProjectJson(projectPath, project);
        await reader.reloadProject();

        const result: ContainerWriteResult = {
          success: true,
          entity: created.members.join(', '),
          category: 'container',
          action: 'created',
          members: created.members,
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_container] failed:', error);
        return toolError(`Error creating container: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_container ─────────────────────────────────────

  server.tool(
    'update_container',
    'Add or remove object types in an existing container. The container is identified by any one of its current members. Removing the last member deletes the container.',
    {
      member: z.string().max(200).describe('Any object type currently in the container to update'),
      addMembers: z.array(z.string().max(200)).max(100).optional().describe('Object type names to add to the container'),
      removeMembers: z.array(z.string().max(200)).max(100).optional().describe('Object type names to remove from the container'),
    },
    async (args) => {
      try {
        if (!args.addMembers?.length && !args.removeMembers?.length) {
          return toolError('No updates provided. Specify at least one of: addMembers, removeMembers.');
        }

        const projectPath = reader.getProjectPath();
        const project = await readProjectJson(projectPath);
        const containers = containersInPlace(project);

        const index = findContainerIndex(containers, args.member);
        if (index === -1) {
          return toolError(
            `No container includes object type "${args.member}". Use list_containers to see existing containers.`
          );
        }
        const container = containers[index];

        if (args.addMembers?.length) {
          const problem = await validateMembers(reader, args.addMembers, containers, index);
          if (problem) return toolError(problem);
        }

        const warnings: string[] = [];

        if (args.addMembers) {
          for (const name of args.addMembers) {
            if (container.members.includes(name)) {
              warnings.push(`Member "${name}" already in container, skipping`);
              continue;
            }
            container.members.push(name);
          }
        }

        if (args.removeMembers) {
          for (const name of args.removeMembers) {
            const i = container.members.indexOf(name);
            if (i === -1) {
              warnings.push(`Member "${name}" not in container, skipping`);
              continue;
            }
            container.members.splice(i, 1);
          }
        }

        const members = [...container.members];
        let action = 'updated';
        if (members.length === 0) {
          containers.splice(index, 1);
          action = 'deleted';
          warnings.push('Container had no members left and was removed.');
        } else {
          const oneMember = singleMemberWarning(members);
          if (oneMember) warnings.push(oneMember);
        }

        if (containers.length === 0) delete project.containers;

        const backupPath = await backupProjectFile(projectPath);
        await atomicWriteProjectJson(projectPath, project);
        await reader.reloadProject();

        const result: ContainerWriteResult = {
          success: true,
          entity: members.length > 0 ? members.join(', ') : args.member,
          category: 'container',
          action,
          members,
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_container] failed:', error);
        return toolError(`Error updating container: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_container ─────────────────────────────────────

  server.tool(
    'delete_container',
    'Delete the object container that includes the named object type. The object types themselves are not deleted.',
    {
      member: z.string().max(200).describe('Any object type currently in the container to delete'),
    },
    async (args) => {
      try {
        const projectPath = reader.getProjectPath();
        const project = await readProjectJson(projectPath);
        const containers = containersInPlace(project);

        const index = findContainerIndex(containers, args.member);
        if (index === -1) {
          return toolError(
            `No container includes object type "${args.member}". Use list_containers to see existing containers.`
          );
        }

        const [removed] = containers.splice(index, 1);
        if (containers.length === 0) delete project.containers;

        const backupPath = await backupProjectFile(projectPath);
        await atomicWriteProjectJson(projectPath, project);
        await reader.reloadProject();

        const result: ContainerWriteResult = {
          success: true,
          entity: removed.members.join(', '),
          category: 'container',
          action: 'deleted',
          members: removed.members,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_container] failed:', error);
        return toolError(`Error deleting container: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
