/**
 * Containers in project.c3proj.
 *
 * A container makes object types be created, picked and destroyed together.
 * It has no name and no file of its own: project.c3proj holds every
 * container as an entry of its root "containers" array, which lists the
 * member object types by name, as the editor saves it:
 *
 *   "containers": [ { "members": ["Player", "PlayerHitbox"] } ]
 *
 * Construct 3 r506-2 refuses to open a project whose container has fewer
 * than two types or names a missing type ("cannot find object type name").
 * So delete_object takes a deleted object type out of its containers in the
 * update that deregisters it, and validate_project reports a member that
 * names no object type. Members are matched ignoring case (nameKey): a
 * member saved in another letter case is taken out too.
 *
 * Membership is not a use. find_orphaned_objects and get_object_dependencies
 * list an object's containers, and an object nothing else uses is still an
 * orphan; get_asset_usage reports the images of such an object as
 * not-analysed, since the other members' instances create its instances.
 *
 * These functions read the project as parsed; callers pass
 * reader.getProject() at the point of use, or the file inside a writer
 * update, never a cached copy.
 */

import { nameKey } from './names.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What happens to a container left with fewer than two members, from a
 * live check in the Construct 3 editor (release r506-2, guest session):
 * 'kept' when the editor opens such a container and saves it unchanged,
 * 'removed' when it refuses, warns about or changes it, 'kept-unverified'
 * when it was not checked.
 *
 * The check gave 'removed': a container with one member or none is refused
 * on open (the project does not load; the console reports "[Project]
 * Exception opening: Error: need at least 2 types in container"), a
 * container naming a missing object type is refused ("cannot find object
 * type name"), and a two-member container opens and is saved unchanged.
 */
export const SMALL_CONTAINER_RULE: 'kept' | 'removed' | 'kept-unverified' = 'removed';

/** A container of project.c3proj: its index in "containers" and its member names as saved. */
export interface ContainerEntry {
  /**
   * The container's position in "containers" before the call. A report of
   * delete_object counts positions in the file as it was before that call,
   * even when the same call removed an earlier container.
   */
  index: number;
  /** The members that are strings, in saved order */
  members: string[];
}

/** A container as seen from one of its members: `others` are the other members. */
export interface ContainerMembership extends ContainerEntry {
  others: string[];
}

/** What removeContainerMember changed. */
export interface ContainerRemoval {
  /** Containers that lost the member and stay, with their members after the change */
  updated: ContainerEntry[];
  /** Containers removed because fewer than two members were left, with their members before the change */
  removed: ContainerEntry[];
}

/**
 * The containers of a parsed project.c3proj; none when "containers" is
 * missing or not an array. An entry whose "members" is not an array has no
 * members.
 */
export function projectContainers(project: { containers?: unknown }): ContainerEntry[] {
  const raw = project.containers;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => ({
    index,
    members: isRecord(entry) && Array.isArray(entry.members)
      ? entry.members.filter((member): member is string => typeof member === 'string')
      : [],
  }));
}

/** Every member's containers, by nameKey() of the member name. */
export function containerMemberships(project: { containers?: unknown }): Map<string, ContainerMembership[]> {
  const byMember = new Map<string, ContainerMembership[]>();
  for (const container of projectContainers(project)) {
    for (const key of new Set(container.members.map(nameKey))) {
      const membership = { ...container, others: container.members.filter(member => nameKey(member) !== key) };
      const list = byMember.get(key);
      if (list) list.push(membership); else byMember.set(key, [membership]);
    }
  }
  return byMember;
}

/**
 * Take `objectName` (matched ignoring case) out of every container of a
 * parsed project.c3proj, in place, inside a writer update. With
 * `dropUnderTwo`, a container left with fewer than two members (members that
 * are names, each distinct name ignoring case counted once; an entry of
 * another type does not count) is removed from "containers"; otherwise it
 * stays in its place.
 */
export function removeContainerMember(
  project: { containers?: unknown },
  objectName: string,
  options: { dropUnderTwo?: boolean } = {},
): ContainerRemoval {
  const removal: ContainerRemoval = { updated: [], removed: [] };
  if (!Array.isArray(project.containers)) return removal;
  const key = nameKey(objectName);
  const kept: unknown[] = [];
  project.containers.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry) || !Array.isArray(entry.members)) {
      kept.push(entry);
      return;
    }
    const before = entry.members.filter((member): member is string => typeof member === 'string');
    const after = entry.members.filter(member => typeof member !== 'string' || nameKey(member) !== key);
    if (after.length === entry.members.length) {
      kept.push(entry);
      return;
    }
    // Only members that are names count toward the two a container needs, and a name listed twice counts once
    const namesAfter = after.filter((member): member is string => typeof member === 'string');
    const distinctAfter = new Set(namesAfter.map(nameKey));
    if (options.dropUnderTwo && distinctAfter.size < 2) {
      removal.removed.push({ index, members: before });
      return;
    }
    entry.members = after;
    removal.updated.push({ index, members: namesAfter });
    kept.push(entry);
  });
  if (removal.removed.length > 0) project.containers = kept;
  return removal;
}

/**
 * Rename `objectName` (matched ignoring case) to `newName` in every
 * container of a parsed project.c3proj, in place, inside a writer update
 * (renameInProject's alsoChange, so the registration and the members
 * change in one write). Entries that are not containers, and members that
 * are not names, stay as they are. Returns the containers that changed,
 * with their member names after the change.
 */
export function renameContainerMember(project: { containers?: unknown }, objectName: string, newName: string): ContainerEntry[] {
  const changed: ContainerEntry[] = [];
  if (!Array.isArray(project.containers)) return changed;
  const key = nameKey(objectName);
  project.containers.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry) || !Array.isArray(entry.members)) return;
    if (!entry.members.some(member => typeof member === 'string' && nameKey(member) === key)) return;
    entry.members = entry.members.map(member => (typeof member === 'string' && nameKey(member) === key ? newName : member));
    changed.push({ index, members: (entry.members as unknown[]).filter((m): m is string => typeof m === 'string') });
  });
  return changed;
}

/** The delete_object warning for a removal, or undefined when no container changed. */
export function describeContainerRemoval(removal: ContainerRemoval): string | undefined {
  const quoted = (names: string[]) => names.map(name => `"${name}"`).join(', ');
  const parts = removal.updated.map(({ index, members }) => {
    if (members.length >= 2) return `Taken out of the container with ${quoted(members)}.`;
    const what = members.length === 1 ? `it now has one member ("${members[0]}")` : 'it now has no members';
    const check = SMALL_CONTAINER_RULE === 'kept-unverified'
      ? ' Whether Construct 3 opens a container of fewer than two members was not checked.'
      : '';
    return `Taken out of container ${index} of project.c3proj: ${what}, and a container groups two or more; `
      + `add a member or remove the container in the Construct 3 editor.${check}`;
  });
  for (const { members } of removal.removed) {
    parts.push(`Removed the container with ${quoted(members)}, since fewer than two members were left.`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
