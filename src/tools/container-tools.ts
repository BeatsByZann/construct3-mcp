/**
 * Container tools: list_containers, create_container, update_container,
 * delete_container.
 *
 * A container makes object types be created, picked and destroyed together.
 * It has no name and no file of its own: project.c3proj lists every
 * container in its root "containers" array (see containers.ts), so each
 * write here is one writer.updateProject whose `change` checks and edits the
 * file as it is right before the write. A save of project.c3proj in the
 * editor during the call is merged, not lost, and a refusal found inside
 * `change` is thrown before the writer makes its backup, so nothing is
 * written.
 *
 * Construct 3 r506-2 refuses to open a project with a container of fewer
 * than two object types, one naming a missing object type, or one in which
 * an object type is in two containers (it reports "already in a container").
 * The tools never write any of these. An emptied "containers" list stays [].
 * The object types themselves are never touched.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import { rollBackFailedCall } from './call-rollback.js';
import { nameKey } from '../construct3/names.js';
import {
  addContainer,
  checkNewContainerMembers,
  containerMemberProblems,
  ContainerRefusal,
  deleteContainer,
  findContainerOf,
  projectContainers,
  registeredNames,
  setContainerMembers,
} from '../construct3/containers.js';
import { withProjectSync } from './project-sync.js';

/** The parts of a parsed project.c3proj the container tools read. */
interface ContainerProject {
  containers?: unknown;
  objectTypes?: unknown;
  families?: unknown;
}

/** What a container tool reports about the container it wrote (or found). */
interface ContainerResult extends WriteResult {
  index: number;
  members: string[];
}

/** What update_container works out for one container, on one reading of the file. */
interface UpdatePlan {
  index: number;
  members: string[];
  warnings: string[];
  changed: boolean;
}

const MEMBER_NAME = z.string().min(1).max(200);

/**
 * The new members of the container that lists `args.member`, on the file as
 * `project` holds it, or a ContainerRefusal. Run before the write on the
 * reader's project and again inside the writer's `change` on the parsed file.
 */
function planUpdate(
  project: ContainerProject,
  args: { member: string; index?: number; addMembers?: string[]; removeMembers?: string[] },
): UpdatePlan {
  const found = findContainerOf(project, args.member, args.index);
  if ('error' in found) throw new ContainerRefusal(found.error);
  const add = args.addMembers ?? [];
  const remove = args.removeMembers ?? [];
  const removeKeys = new Set(remove.map(nameKey));
  const both = add.find(name => removeKeys.has(nameKey(name)));
  if (both !== undefined) throw new ContainerRefusal(`"${both}" is in both addMembers and removeMembers.`);

  const current = found.container.members;
  const currentKeys = new Set(current.map(nameKey));
  const warnings: string[] = [];
  for (const name of remove) {
    if (!currentKeys.has(nameKey(name))) warnings.push(`"${name}" is not in the container, so it was not removed.`);
  }
  const added: string[] = [];
  for (const name of add) {
    if (currentKeys.has(nameKey(name))) warnings.push(`"${name}" is already in the container, so it was not added.`);
    else added.push(name);
  }
  const members = [...current.filter(name => !removeKeys.has(nameKey(name))), ...added];
  const changed = members.length !== current.length || members.some((name, i) => name !== current[i]);
  if (!changed) return { index: found.index, members: current, warnings, changed };

  if (new Set(members.map(nameKey)).size < 2) {
    throw new ContainerRefusal('The container would be left with fewer than two object types, and Construct 3 r506-2 refuses to open '
      + `a project with such a container. Use delete_container to remove the container at index ${found.index}.`);
  }
  checkNewContainerMembers(
    members, registeredNames(project.objectTypes), registeredNames(project.families), projectContainers(project), found.index,
  );
  return { index: found.index, members, warnings, changed };
}

/** Register list_containers, create_container, update_container and delete_container. */
export function registerContainerTools({ server: mcpServer, reader, writer }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);

  /** The tool error for a failed call: a refusal as it is, anything else after the rollback of the call's writes. */
  const failure = async (tool: string, error: unknown) => {
    if (error instanceof ContainerRefusal) return toolError(error.message);
    console.error(`[${tool}] failed:`, error);
    return toolError(await rollBackFailedCall(writer, error, { writing: reader.getProjectPath() }));
  };

  // ─── list_containers ──────────────────────────────────────

  server.tool(
    'list_containers',
    'List the containers of project.c3proj. A container makes object types be created, picked and destroyed together; it has no name, so each is identified by its index and its members. A member that is no object type of the project (or differs from one only in letter case) is listed in notObjectTypes: Construct 3 r506-2 does not open such a project. Read-only.',
    {},
    async () => {
      try {
        const project = reader.getProject() as ContainerProject;
        const objectTypes = registeredNames(project.objectTypes);
        const containers = projectContainers(project).map(({ index, members }) => {
          const notObjectTypes = containerMemberProblems(members, objectTypes)
            .flatMap(problem => (problem.kind === 'too-few' || problem.member === undefined ? [] : [problem.member]));
          return notObjectTypes.length > 0 ? { index, members, notObjectTypes } : { index, members };
        });
        return toolResult({ containers, count: containers.length });
      } catch (error) {
        console.error('[list_containers] failed:', error);
        return toolError(`Error listing containers: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── create_container ─────────────────────────────────────

  server.tool(
    'create_container',
    'Create a container of two or more object types in project.c3proj, so they are created, picked and destroyed together. Every member must be an object type of the project (not a family), spelled as registered, listed once, and in no other container: Construct 3 r506-2 refuses to open a project with a container of fewer than two object types, one naming a missing type, or an object type in two containers. A refusal changes nothing. Backs up project.c3proj to project.c3proj.bak.',
    {
      members: z.array(MEMBER_NAME).min(2).max(100).describe('Object type names to group, e.g. ["Player", "PlayerHitbox"]'),
    },
    async (args) => {
      try {
        const check = (project: ContainerProject) => checkNewContainerMembers(
          args.members, registeredNames(project.objectTypes), registeredNames(project.families), projectContainers(project),
        );
        // Before the write, on the reader's project: the common refusal needs no write lock
        check(reader.getProject() as ContainerProject);
        let index = -1;
        const backup = await writer.updateProject((project: ContainerProject) => {
          // Again on the file as it is now: the editor may have saved it meanwhile
          index = addContainer(project, check(project));
        });
        const result: ContainerResult = {
          success: true,
          entity: `containers/${index}`,
          category: 'container',
          action: 'created',
          index,
          members: args.members,
          backupFile: backup,
        };
        return toolResult(result);
      } catch (error) {
        return failure('create_container', error);
      }
    }
  );

  // ─── update_container ─────────────────────────────────────

  server.tool(
    'update_container',
    'Add object types to a container or take some out. The container is found by one of its members (ignoring letter case); give index when the member is in several containers (list_containers shows them). A name already in the container (to add) or not in it (to remove) gives a warning and is skipped. The same rules as create_container apply to the result; a container left with fewer than two object types is refused (use delete_container). When nothing changes the result is "unchanged" and nothing is written. Backs up project.c3proj to project.c3proj.bak.',
    {
      member: MEMBER_NAME.describe('An object type in the container to change'),
      index: z.number().int().min(0).optional().describe('Index of the container (from list_containers); needed only when the member is in several containers'),
      addMembers: z.array(MEMBER_NAME).max(100).optional().describe('Object type names to add'),
      removeMembers: z.array(MEMBER_NAME).max(100).optional().describe('Object type names to take out'),
    },
    async (args) => {
      try {
        // Before the write, on the reader's project: the common refusal and an unchanged call need no write lock
        let last = planUpdate(reader.getProject() as ContainerProject, args);
        let backup: string | undefined;
        if (last.changed) {
          backup = await writer.updateProject((project: ContainerProject) => {
            // Again on the file as it is now, in every round of the update: the editor may have saved it meanwhile
            last = planUpdate(project, args);
            if (!last.changed) return false;
            setContainerMembers(project, last.index, last.members);
          });
        }
        const written = backup !== undefined;
        const result: ContainerResult = {
          success: true,
          entity: `containers/${last.index}`,
          category: 'container',
          action: written ? 'updated' : 'unchanged',
          index: last.index,
          members: last.members,
          ...(last.warnings.length > 0 ? { warnings: last.warnings } : {}),
          ...(written ? { backupFile: backup } : {}),
        };
        return toolResult(result, { projectWritten: written });
      } catch (error) {
        return failure('update_container', error);
      }
    }
  );

  // ─── delete_container ─────────────────────────────────────

  server.tool(
    'delete_container',
    'Delete the container that lists a member (found ignoring letter case; give index when the member is in several containers). The object types stay. Backs up project.c3proj to project.c3proj.bak.',
    {
      member: MEMBER_NAME.describe('An object type in the container to delete'),
      index: z.number().int().min(0).optional().describe('Index of the container (from list_containers); needed only when the member is in several containers'),
    },
    async (args) => {
      try {
        const find = (project: ContainerProject) => {
          const found = findContainerOf(project, args.member, args.index);
          if ('error' in found) throw new ContainerRefusal(found.error);
          return found;
        };
        // Before the write, on the reader's project
        find(reader.getProject() as ContainerProject);
        let deleted = { index: -1, members: [] as string[] };
        const backup = await writer.updateProject((project: ContainerProject) => {
          // Again on the file as it is now, in every round of the update
          const { index, container } = find(project);
          deleted = { index, members: container.members };
          deleteContainer(project, index);
        });
        const result: ContainerResult = {
          success: true,
          entity: `containers/${deleted.index}`,
          category: 'container',
          action: 'deleted',
          index: deleted.index,
          members: deleted.members,
          backupFile: backup,
        };
        return toolResult(result);
      } catch (error) {
        return failure('delete_container', error);
      }
    }
  );
}
