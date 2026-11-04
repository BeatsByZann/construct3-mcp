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

import { findNameClash, nameKey } from './names.js';

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
 * with their member names after the change. A container that lists the
 * name twice (in two letter cases) gets `newName` twice.
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

/**
 * The names a project.c3proj entity container ("objectTypes", "families")
 * registers, in its items and in every subfolder; none when it is missing
 * or malformed.
 */
export function registeredNames(container: unknown): string[] {
  if (!isRecord(container)) return [];
  const names = Array.isArray(container.items)
    ? container.items.filter((item): item is string => typeof item === 'string')
    : [];
  if (Array.isArray(container.subfolders)) {
    for (const subfolder of container.subfolders) names.push(...registeredNames(subfolder));
  }
  return names;
}

/** One thing wrong with the members of a container. */
export interface ContainerProblem {
  /**
   * 'missing': a member that is no object type; 'case-variant': one that
   * differs from an object type only in letter case; 'too-few': fewer than
   * two distinct object types.
   */
  kind: 'missing' | 'case-variant' | 'too-few';
  /** The member as written ('missing' and 'case-variant') */
  member?: string;
  /** The registered spelling ('case-variant'); for 'too-few' the one object type the container has, when it has one */
  registered?: string;
}

/**
 * The rule the editor applies when it opens a container, once, for
 * validate_project and for the container tools: every member must be an
 * object type of the project (a member that differs only in letter case is
 * reported apart), and a container needs at least two distinct object
 * types. The problems come in member order, 'too-few' last.
 */
export function containerMemberProblems(
  members: readonly string[],
  registeredObjects: readonly string[],
): ContainerProblem[] {
  const problems: ContainerProblem[] = [];
  const existing: string[] = [];
  for (const member of members) {
    const match = findNameClash(member, registeredObjects);
    if (match === undefined) {
      problems.push({ kind: 'missing', member });
      continue;
    }
    existing.push(match);
    if (match !== member) problems.push({ kind: 'case-variant', member, registered: match });
  }
  if (new Set(existing.map(nameKey)).size < 2) {
    problems.push(existing.length > 0 ? { kind: 'too-few', registered: existing[0] } : { kind: 'too-few' });
  }
  return problems;
}

/**
 * A container tool's refusal, thrown inside a writer update's change (before
 * the file is backed up or written) or before it. The message ends with
 * "Nothing was changed." already, so a tool returns it as it is.
 */
export class ContainerRefusal extends Error {
  constructor(reason: string) {
    super(`${reason} Nothing was changed.`);
    this.name = 'ContainerRefusal';
  }
}

const quoted = (names: readonly string[]) => names.map(name => `"${name}"`).join(', ');

/**
 * The members of a container to be written, or a ContainerRefusal. A member
 * must be an object type, spelled as registered, listed once (ignoring
 * case); the container needs two distinct object types; and no other
 * container (not the one at index `except`) may list it. A family is not an
 * object type. Called on the objects, families and containers of the file
 * as it is right before the write.
 */
export function checkNewContainerMembers(
  members: readonly string[],
  objectTypes: readonly string[],
  families: readonly string[],
  containers: readonly ContainerEntry[],
  except?: number,
): string[] {
  const seen = new Set<string>();
  for (const member of members) {
    const key = nameKey(member);
    if (seen.has(key)) {
      throw new ContainerRefusal(`"${member}" is listed twice (names are compared ignoring letter case).`);
    }
    seen.add(key);
  }
  const familyKeys = new Set(families.map(nameKey));
  for (const member of members) {
    if (familyKeys.has(nameKey(member))) {
      throw new ContainerRefusal(`"${member}" is a family, and a container holds object types.`);
    }
  }
  for (const problem of containerMemberProblems(members, objectTypes)) {
    if (problem.kind === 'case-variant') {
      throw new ContainerRefusal(`"${problem.member}" differs only in letter case from the object type "${problem.registered}", `
        + `and names are matched with their letter case; write "${problem.registered}".`);
    }
    if (problem.kind === 'missing') {
      throw new ContainerRefusal(`"${problem.member}" is not an object type of the project. `
        + 'Construct 3 r506-2 does not open a project whose container names a missing object type.');
    }
    throw new ContainerRefusal('A container needs at least two distinct object types. '
      + 'Construct 3 r506-2 refuses to open a project with a container of fewer than two object types.');
  }
  for (const other of containers) {
    if (other.index === except) continue;
    const clash = members.find(member => other.members.some(name => nameKey(name) === nameKey(member)));
    if (clash !== undefined) {
      throw new ContainerRefusal(`"${clash}" is already in container ${other.index} of project.c3proj (${quoted(other.members)}). `
        + 'Construct 3 r506-2 refuses to open a project in which an object type is in two containers '
        + '(it reports "already in a container").');
    }
  }
  return [...members];
}

/**
 * The container that lists `member` (ignoring case), or why there is none.
 * With `index`, the container at that position, which must list `member`.
 * Without it, the only container that lists it; when several do, the error
 * names each one's index and members, since a hand edit can put a type in
 * two containers. Called again on the file inside every writer update
 * round, so a reorder between rounds never edits another container.
 */
export function findContainerOf(
  project: { containers?: unknown },
  member: string,
  index?: number,
): { index: number; container: ContainerEntry } | { error: string } {
  const key = nameKey(member);
  const containers = projectContainers(project);
  const listing = containers.filter(container => container.members.some(name => nameKey(name) === key));
  if (index !== undefined) {
    const container = containers[index];
    if (container === undefined) {
      return { error: `The project has no container at index ${index} (it has ${containers.length}); the containers may have changed during the call.` };
    }
    if (!listing.includes(container)) {
      return { error: `The container at index ${index} does not list "${member}"; the containers may have changed during the call.` };
    }
    return { index, container };
  }
  if (listing.length === 0) {
    return { error: `No container lists "${member}". Use list_containers to see the containers.` };
  }
  if (listing.length > 1) {
    const where = listing.map(container => `container ${container.index} (${quoted(container.members)})`).join(' and ');
    return { error: `"${member}" is in ${where}; give index to pick one.` };
  }
  return { index: listing[0].index, container: listing[0] };
}

/** Append a container to a parsed project.c3proj, in place, creating "containers" when it is absent; returns its index. */
export function addContainer(project: { containers?: unknown }, members: string[]): number {
  if (!Array.isArray(project.containers)) project.containers = [];
  return (project.containers as unknown[]).push({ members }) - 1;
}

/** Set the members of the container at `index` of a parsed project.c3proj, in place; its other keys stay. */
export function setContainerMembers(project: { containers?: unknown }, index: number, members: string[]): void {
  if (!Array.isArray(project.containers)) return;
  const entry: unknown = project.containers[index];
  if (isRecord(entry)) entry.members = members;
  else project.containers[index] = { members };
}

/** Remove the container at `index` of a parsed project.c3proj, in place; an emptied list stays as []. */
export function deleteContainer(project: { containers?: unknown }, index: number): void {
  if (Array.isArray(project.containers)) project.containers.splice(index, 1);
}
