/**
 * Hierarchy (scene graph) links between layout instances.
 *
 * The editor stores both sides of a link in `sceneGraphData` on the world
 * instances of one layout: the child has `"parent-uid"` (the parent's UID;
 * null on an instance without a parent) and its own `flags`, the parent lists
 * `{ uid, flags }` for each child in `children`, an array that is absent when
 * it has no children. Checked against Scirra's public example projects
 * (github.com/Scirra/Construct-Example-Projects: three-cups, rotating-maze,
 * blacksmith-forge, dig-the-way and dock-fishing, 33 instances with
 * sceneGraphData): no empty `children` array, children on another layer than
 * their parent (3 in three-cups), one record with neither a parent nor
 * children (rotating-maze), none on non-world instances.
 *
 * Links go by UID, and UIDs are reused: a new instance gets the highest UID in
 * the project plus one, so after the instance with the highest UID is deleted,
 * the next new instance gets its UID. A link left pointing at a deleted
 * instance would then point at the new one. Deleting instances therefore
 * removes the links to them (unlinkRemovedInstances), and the ID generator
 * counts the UIDs that links name (hierarchyUids). linkInstances,
 * unlinkInstance and unlinkChildren make and remove links, always on both
 * sides.
 */

import type { Instance, Layout } from './types.js';
import { findInstanceByUid, forEachLayoutInstance, type LayerEntry } from './layers.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An instance's sceneGraphData record, or undefined when it has none. */
export function sceneGraphOf(instance: unknown): Record<string, unknown> | undefined {
  return isRecord(instance) && isRecord(instance.sceneGraphData) ? instance.sceneGraphData : undefined;
}

/** The parent UID a sceneGraphData record names, or undefined for none (null or missing). */
function parentUidOf(sceneGraph: Record<string, unknown>): number | undefined {
  const parent = sceneGraph['parent-uid'];
  return typeof parent === 'number' ? parent : undefined;
}

/** The child UIDs a sceneGraphData record lists. */
function childUidsOf(sceneGraph: Record<string, unknown>): number[] {
  const children = sceneGraph.children;
  if (!Array.isArray(children)) return [];
  return children
    .map(child => (isRecord(child) ? child.uid : undefined))
    .filter((uid): uid is number => typeof uid === 'number');
}

/** Every UID a hierarchy link of this instance names: its parent and its children. */
export function hierarchyUids(instance: unknown): number[] {
  const sceneGraph = sceneGraphOf(instance);
  if (!sceneGraph) return [];
  const parent = parentUidOf(sceneGraph);
  return [...(parent !== undefined ? [parent] : []), ...childUidsOf(sceneGraph)];
}

/** What unlinkRemovedInstances changed on the instances left in the layout. */
export interface HierarchyUnlink {
  /** UIDs of instances whose parent was removed: they no longer have a parent */
  detachedChildren: number[];
  /** UIDs of instances that listed a removed instance as a child: the entry was removed */
  updatedParents: number[];
  /**
   * Removed UIDs that another instance of the layout still has (a duplicate
   * UID, which validate_project reports as duplicate-uid): which instance a
   * link naming it means cannot be told, so such links were left as they are
   */
  stillUsed: number[];
}

/** How many instances of the layout have each UID. */
function uidCounts(layout: unknown): Map<number, number> {
  const counts = new Map<number, number>();
  forEachLayoutInstance(layout, instance => {
    if (typeof instance.uid === 'number') counts.set(instance.uid, (counts.get(instance.uid) ?? 0) + 1);
  });
  return counts;
}

/**
 * Remove the hierarchy links to instances that were removed from `layout`
 * (`removed`: their UIDs, the instances already taken out of the layout): an
 * instance whose parent was removed gets `"parent-uid": null` (it stays in
 * the layout, without a parent), and a removed child is taken out of its
 * parent's `children` (an emptied array is removed, as the editor saves a
 * parent without children). Children are detached, not deleted with their
 * parent: what the editor does with the children of an instance deleted in
 * the Layout View is not verified, and detaching loses no instance. A removed
 * UID that another instance of the layout still has (duplicate UIDs) is left
 * alone: a link naming it may mean that instance (`stillUsed`).
 */
export function unlinkRemovedInstances(layout: Layout, removedUids: ReadonlySet<number>): HierarchyUnlink {
  const result: HierarchyUnlink = { detachedChildren: [], updatedParents: [], stillUsed: [] };
  if (removedUids.size === 0) return result;
  const remaining = uidCounts(layout);
  const removed = new Set<number>();
  for (const uid of removedUids) {
    if (remaining.has(uid)) result.stillUsed.push(uid);
    else removed.add(uid);
  }
  if (removed.size === 0) return result;
  forEachLayoutInstance(layout, instance => {
    const sceneGraph = sceneGraphOf(instance);
    if (!sceneGraph) return;
    const parent = parentUidOf(sceneGraph);
    if (parent !== undefined && removed.has(parent)) {
      sceneGraph['parent-uid'] = null;
      if (typeof instance.uid === 'number') result.detachedChildren.push(instance.uid);
    }
    if (Array.isArray(sceneGraph.children)) {
      const kept = sceneGraph.children.filter(child => !(isRecord(child) && typeof child.uid === 'number' && removed.has(child.uid)));
      if (kept.length !== sceneGraph.children.length) {
        if (kept.length > 0) sceneGraph.children = kept;
        else delete sceneGraph.children;
        if (typeof instance.uid === 'number') result.updatedParents.push(instance.uid);
      }
    }
  });
  return result;
}

/** The warning sentences for what unlinkRemovedInstances changed; empty when nothing. */
export function hierarchyUnlinkWarnings(unlink: HierarchyUnlink): string[] {
  const warnings: string[] = [];
  if (unlink.detachedChildren.length > 0) {
    warnings.push(`Detached hierarchy children of the removed instance(s): UID ${unlink.detachedChildren.join(', ')} ` +
      '(they stay in the layout, without a parent).');
  }
  if (unlink.updatedParents.length > 0) {
    warnings.push(`Removed the hierarchy links from UID ${unlink.updatedParents.join(', ')} to the removed instance(s).`);
  }
  if (unlink.stillUsed.length > 0) {
    warnings.push(`Another instance of the layout has UID ${unlink.stillUsed.join(', ')} too (duplicate-uid in validate_project), so ` +
      'hierarchy links naming that UID were left as they are: check them in the Construct 3 editor.');
  }
  return warnings;
}

/** A hierarchy link that does not hold up, for validate_project. */
export interface HierarchyLinkProblem {
  /** UID of the instance whose record has the link */
  uid: number;
  type: string;
  /** Its layer; undefined for a non-world instance */
  entry?: LayerEntry;
  /**
   * - "missing-parent": "parent-uid" names no instance of the layout
   * - "missing-child": a `children` entry names no instance of the layout
   * - "parent-not-linked": the parent does not list this instance as a child
   * - "child-not-linked": the child names another parent, or none
   */
  problem: 'missing-parent' | 'missing-child' | 'parent-not-linked' | 'child-not-linked';
  /** The UID the link names */
  target: number;
}

/**
 * Hierarchy links in one layout that point at no instance of the layout, or
 * whose other side does not name this instance (e.g. a link left behind when
 * an instance was deleted, which a reused UID then points at another
 * instance). Each broken link is reported once, from the side that has it.
 * UIDs that several instances of the layout have are skipped, as instances
 * and as link targets: which instance a link means cannot be told, and
 * duplicate-uid reports them.
 */
export function findHierarchyLinkProblems(layout: unknown): HierarchyLinkProblem[] {
  const counts = uidCounts(layout);
  const byUid = new Map<number, Instance>();
  forEachLayoutInstance(layout, instance => {
    if (typeof instance.uid === 'number' && counts.get(instance.uid) === 1) byUid.set(instance.uid, instance);
  });
  const duplicate = (uid: number) => (counts.get(uid) ?? 0) > 1;
  const problems: HierarchyLinkProblem[] = [];
  forEachLayoutInstance(layout, (instance, entry) => {
    const sceneGraph = sceneGraphOf(instance);
    if (!sceneGraph || typeof instance.uid !== 'number' || duplicate(instance.uid)) return;
    const base = { uid: instance.uid, type: String(instance.type), ...(entry ? { entry } : {}) };
    const parent = parentUidOf(sceneGraph);
    if (parent !== undefined && !duplicate(parent)) {
      const parentGraph = sceneGraphOf(byUid.get(parent));
      if (!byUid.has(parent)) problems.push({ ...base, problem: 'missing-parent', target: parent });
      else if (!parentGraph || !childUidsOf(parentGraph).includes(instance.uid)) {
        problems.push({ ...base, problem: 'parent-not-linked', target: parent });
      }
    }
    for (const child of childUidsOf(sceneGraph)) {
      if (duplicate(child)) continue;
      const childInstance = byUid.get(child);
      if (!childInstance) {
        problems.push({ ...base, problem: 'missing-child', target: child });
        continue;
      }
      // A link the child has to another parent is checked (and reported) from the child's side
      const childGraph = sceneGraphOf(childInstance);
      const childParent = childGraph ? parentUidOf(childGraph) : undefined;
      if (childParent !== instance.uid) {
        problems.push({ ...base, problem: 'child-not-linked', target: child });
      }
    }
  });
  return problems;
}

/** The inheritance flags of a hierarchy link, as saved in the child's `flags` and in its parent's `children[].flags`. */
export type LinkFlags = Record<string, boolean | string>;

/**
 * The flags of a new link, and of a new record, when the caller gives none:
 * those Construct 3 r495.2 saved for a record (one editor-saved project
 * checked), the newest evidence there is; older example projects save other
 * values (three-cups: z and a false). Construct 3 r506-2 adds `de: true` to
 * the flags it saves for a link; this server does not write that key. An
 * existing link keeps its own flags (linkInstances).
 */
export const DEFAULT_LINK_FLAGS: Readonly<LinkFlags> = Object.freeze({
  x: true, y: true, z: true, w: true, h: true, d: true, a: true, o: false, v: false, sm: 'normal',
});

/**
 * The `preview` of a new record when no record of the project has one to
 * copy (blankPreviewLike): none. Construct 3 r506-2 opened and kept a project
 * whose hierarchy records had no `preview`.
 */
export const PREVIEW_FOR_NEW_RECORD: Readonly<Record<string, unknown>> | undefined = undefined;

/** The instance keys an r495.2 save writes after sceneGraphData, in order (fork 1718271 places instanceFolderItem first). */
const KEYS_AFTER_SCENE_GRAPH = ['instanceFolderItem', 'showing', 'locked', 'world'] as const;
/** The record keys after children in upstream's three-cups record (parent-uid, uid, children, flags, preview). */
const KEYS_AFTER_CHILDREN = ['flags', 'preview'] as const;

/**
 * Set `obj[key]`; a key `obj` did not have goes before the first of
 * `followers` it has (they move behind it), where the editor puts it.
 * Keys already in `obj` keep their place.
 */
function setKeyBefore(obj: Record<string, unknown>, key: string, value: unknown, followers: readonly string[]): void {
  const had = Object.hasOwn(obj, key);
  obj[key] = value;
  if (had) return;
  const keys = Object.keys(obj);
  const at = keys.findIndex(k => followers.includes(k));
  if (at === -1) return;
  for (const k of keys.slice(at)) {
    if (k === key) continue;
    const moved = obj[k];
    delete obj[k];
    obj[k] = moved;
  }
}

/** A preview record with the keys of `sample` (another record's preview): numbers 0, booleans false, anything else as it is. */
export function blankPreviewLike(sample: unknown): Record<string, unknown> | undefined {
  if (!isRecord(sample)) return undefined;
  return Object.fromEntries(Object.entries(sample).map(([key, value]) =>
    [key, typeof value === 'number' ? 0 : typeof value === 'boolean' ? false : value]));
}

/** What linkInstances changed. */
export interface HierarchyLink {
  /** The child's parent before the call, when it was another instance; that link was removed */
  previousParent?: number;
  /** UIDs of other instances that listed the child without the child naming them (one-sided links); their entries were removed */
  staleEntries?: number[];
  /** UIDs of the instances that got a sceneGraphData record (they had none) */
  createdRecords: number[];
  /** False when the link existed already with these flags on both sides: nothing changed */
  changed: boolean;
  /** The link's flags after the call */
  flags: LinkFlags;
}

/** The one world instance with this UID (on a layer or sub-layer), or the error text. */
function linkable(layout: Layout, uid: number, counts: ReadonlyMap<number, number>): { instance: Instance } | { error: string } {
  const n = counts.get(uid) ?? 0;
  if (n > 1) return { error: `UID ${uid} is used by ${n} instances of the layout (duplicate-uid in validate_project), so which one is meant cannot be told.` };
  const found = findInstanceByUid(layout, uid);
  if (!found) return { error: `No instance with UID ${uid} in the layout. Use get_layout_details to see the instance UIDs.` };
  if (!found.entry) return { error: `UID ${uid} is a non-world instance: hierarchy links join instances placed on layers.` };
  return { instance: found.instance };
}

/** The world instances whose record lists `uid` in its children (a link the parent side alone records counts too). */
function listersOf(layout: Layout, uid: number): Instance[] {
  const found: Instance[] = [];
  forEachLayoutInstance(layout, instance => {
    const graph = sceneGraphOf(instance);
    if (graph && childUidsOf(graph).includes(uid)) found.push(instance);
  });
  return found;
}

/**
 * Whether walking up from `uid` reaches `ancestor`, where an instance's
 * parents are the one its "parent-uid" names and every instance that lists
 * it in its children (either side of a one-sided link). A loop already in
 * the file ends the walk.
 */
function descendsFrom(layout: Layout, uid: number, ancestor: number): boolean {
  const seen = new Set<number>();
  const queue = [uid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const graph = sceneGraphOf(findInstanceByUid(layout, current)?.instance);
    const named = graph ? parentUidOf(graph) : undefined;
    if (named !== undefined) queue.push(named);
    for (const lister of listersOf(layout, current)) if (typeof lister.uid === 'number') queue.push(lister.uid);
  }
  return false;
}

/** Take `childUid` out of the children of each instance in `listers`, in place; an emptied list is removed. */
function dropEntriesOf(listers: readonly Instance[], childUid: number): void {
  for (const lister of listers) {
    const graph = sceneGraphOf(lister);
    if (!graph || !Array.isArray(graph.children)) continue;
    const kept = graph.children.filter(child => !(isRecord(child) && child.uid === childUid));
    if (kept.length > 0) graph.children = kept;
    else delete graph.children;
  }
}

/** The error for listers of `childUid` whose own UID several instances share, or undefined. */
function sharedListerError(listers: readonly Instance[], childUid: number, counts: ReadonlyMap<number, number>): { error: string } | undefined {
  const shared = listers.find(lister => typeof lister.uid === 'number' && (counts.get(lister.uid) ?? 0) > 1);
  return shared === undefined ? undefined
    : { error: `UID ${childUid} is listed as a child by UID ${shared.uid}, which several instances of the layout have (duplicate-uid in validate_project), so its link cannot be changed safely.` };
}

/** Whether a saved flags value holds exactly these keys and values. */
function sameFlags(saved: unknown, flags: Readonly<LinkFlags>): boolean {
  if (!isRecord(saved)) return false;
  const keys = new Set([...Object.keys(saved), ...Object.keys(flags)]);
  return [...keys].every(key => saved[key] === flags[key]);
}

/**
 * The instance's record; a new one ({ "parent-uid": null, uid, flags,
 * preview? }) when it has none, placed before the instance's showing,
 * locked and world keys, and noted in `created`.
 */
function recordOf(instance: Instance, preview: Readonly<Record<string, unknown>> | undefined, created: number[]): Record<string, unknown> {
  const existing = sceneGraphOf(instance);
  if (existing) return existing;
  const record: Record<string, unknown> = {
    'parent-uid': null, uid: instance.uid, flags: { ...DEFAULT_LINK_FLAGS }, ...(preview ? { preview: { ...preview } } : {}),
  };
  setKeyBefore(instance, 'sceneGraphData', record, KEYS_AFTER_SCENE_GRAPH);
  created.push(instance.uid);
  return record;
}

/**
 * Make `childUid` a hierarchy child of `parentUid` in `layout`, in place,
 * on both sides: the child's record names the parent and holds the flags,
 * the parent's record lists { uid, flags } in `children` (created when
 * absent, after "uid"). The flags are the child's saved flags (unknown
 * keys included) with `given` over them, or DEFAULT_LINK_FLAGS with
 * `given` over them for a child without a record. An instance without a
 * record gets one (recordOf, with `preview` when given). The child is
 * taken out of the children of every other instance that lists it, its
 * previous parent and any that list it one-sidedly (`staleEntries`).
 * Refused, with the layout unchanged: a self-link, a UID that names no
 * instance, a non-world instance or several instances, a parent that
 * descends from the child along either side of a link (the link would
 * close a loop), and a previous parent or lister whose UID several
 * instances share.
 */
export function linkInstances(
  layout: Layout, childUid: number, parentUid: number, given: Readonly<LinkFlags>,
  preview?: Readonly<Record<string, unknown>>,
): HierarchyLink | { error: string } {
  if (childUid === parentUid) return { error: `UID ${childUid} cannot be its own hierarchy parent.` };
  const counts = uidCounts(layout);
  const child = linkable(layout, childUid, counts);
  if ('error' in child) return child;
  const parent = linkable(layout, parentUid, counts);
  if ('error' in parent) return parent;
  if (descendsFrom(layout, parentUid, childUid)) {
    return { error: `UID ${parentUid} already descends from UID ${childUid} in the hierarchy, so the link would close a loop.` };
  }
  const childBefore = sceneGraphOf(child.instance);
  const previous = childBefore ? parentUidOf(childBefore) : undefined;
  if (previous !== undefined && previous !== parentUid && (counts.get(previous) ?? 0) > 1) {
    return { error: `The parent of UID ${childUid}, UID ${previous}, is used by several instances of the layout (duplicate-uid in validate_project), so its link cannot be removed safely.` };
  }
  // Every other instance that lists the child loses that entry, also when the child does not name it
  const otherListers = listersOf(layout, childUid).filter(lister => lister !== parent.instance);
  const listerError = sharedListerError(otherListers, childUid, counts);
  if (listerError) return listerError;
  // An existing record keeps its flags, keys this server does not know included; given keys go over them
  const flags: LinkFlags = { ...(childBefore && isRecord(childBefore.flags) ? childBefore.flags as LinkFlags : DEFAULT_LINK_FLAGS), ...given };
  const parentBefore = sceneGraphOf(parent.instance);
  const entry = parentBefore && Array.isArray(parentBefore.children)
    ? parentBefore.children.find(c => isRecord(c) && c.uid === childUid)
    : undefined;
  if (previous === parentUid && otherListers.length === 0 && childBefore && isRecord(entry)
    && sameFlags(childBefore.flags, flags) && sameFlags(entry.flags, flags)) {
    return { createdRecords: [], changed: false, flags };
  }

  const createdRecords: number[] = [];
  const childGraph = recordOf(child.instance, preview, createdRecords);
  const parentGraph = recordOf(parent.instance, preview, createdRecords);
  dropEntriesOf(otherListers, childUid);
  childGraph['parent-uid'] = parentUid;
  childGraph.flags = { ...flags };
  if (!Array.isArray(parentGraph.children)) setKeyBefore(parentGraph, 'children', [], KEYS_AFTER_CHILDREN);
  const children = parentGraph.children as unknown[];
  const link = { uid: childUid, flags: { ...flags } };
  const at = children.findIndex(c => isRecord(c) && c.uid === childUid);
  if (at === -1) children.push(link);
  else children[at] = link;
  const staleEntries = otherListers.map(lister => lister.uid).filter((uid): uid is number => typeof uid === 'number' && uid !== previous);
  return {
    ...(previous !== undefined && previous !== parentUid ? { previousParent: previous } : {}),
    ...(staleEntries.length > 0 ? { staleEntries } : {}),
    createdRecords,
    changed: true,
    flags,
  };
}

/**
 * Take `childUid` off its hierarchy parent in `layout`, in place, on both
 * sides: its record gets "parent-uid": null (the record stays; an example
 * project has a record with neither a parent nor children), and the parent
 * no longer lists it (an emptied list is removed). `previousParent` is
 * undefined when it had no parent, and then nothing changed unless
 * `staleEntries` lists instances that listed it without it naming them.
 */
export function unlinkInstance(layout: Layout, childUid: number): { previousParent?: number; staleEntries?: number[] } | { error: string } {
  const counts = uidCounts(layout);
  const child = linkable(layout, childUid, counts);
  if ('error' in child) return child;
  const graph = sceneGraphOf(child.instance);
  const previous = graph ? parentUidOf(graph) : undefined;
  if (previous !== undefined && (counts.get(previous) ?? 0) > 1) {
    return { error: `The parent of UID ${childUid}, UID ${previous}, is used by several instances of the layout (duplicate-uid in validate_project), so its link cannot be removed safely.` };
  }
  // Every instance that lists the child loses that entry, also one the child does not name
  const listers = listersOf(layout, childUid);
  const listerError = sharedListerError(listers, childUid, counts);
  if (listerError) return listerError;
  if (previous === undefined && listers.length === 0) return {};
  dropEntriesOf(listers, childUid);
  if (graph && previous !== undefined) graph['parent-uid'] = null;
  const staleEntries = listers.map(lister => lister.uid).filter((uid): uid is number => typeof uid === 'number' && uid !== previous);
  return { ...(previous !== undefined ? { previousParent: previous } : {}), ...(staleEntries.length > 0 ? { staleEntries } : {}) };
}

/**
 * Detach every hierarchy child of `parentUid` in `layout`, in place: each
 * listed child that names it as its parent gets "parent-uid": null, and the
 * parent's children list is removed. `detached` lists those; `unlisted`,
 * instances whose "parent-uid" names it although it does not list them (a
 * one-sided link, parent-not-linked in validate_project), detached too;
 * `missing`, the listed UIDs that name no instance of the layout;
 * `otherParent`, listed instances that name another parent or none (only
 * the entry goes). Refused, unchanged, when a listed UID is shared by
 * several instances.
 */
export function unlinkChildren(
  layout: Layout, parentUid: number,
): { detached: number[]; unlisted: number[]; missing: number[]; otherParent: number[] } | { error: string } {
  const counts = uidCounts(layout);
  const parent = linkable(layout, parentUid, counts);
  if ('error' in parent) return parent;
  const result = { detached: [] as number[], unlisted: [] as number[], missing: [] as number[], otherParent: [] as number[] };
  const graph = sceneGraphOf(parent.instance);
  const listed = graph ? childUidsOf(graph) : [];
  // Children that name the parent without being listed: their link is one-sided. Collected first, so a
  // shared UID among them refuses the call before anything changes
  const unlisted: Array<{ uid: number; record: Record<string, unknown> }> = [];
  forEachLayoutInstance(layout, instance => {
    const own = sceneGraphOf(instance);
    if (!own || parentUidOf(own) !== parentUid || typeof instance.uid !== 'number' || listed.includes(instance.uid)) return;
    unlisted.push({ uid: instance.uid, record: own });
  });
  for (const uid of [...listed, ...unlisted.map(entry => entry.uid)]) {
    const n = counts.get(uid) ?? 0;
    if (n > 1) return { error: `Child UID ${uid} is used by ${n} instances of the layout (duplicate-uid in validate_project), so which one is meant cannot be told.` };
  }
  for (const { uid, record } of unlisted) {
    record['parent-uid'] = null;
    result.unlisted.push(uid);
  }
  if (!graph || !Array.isArray(graph.children)) return result;
  for (const uid of listed) {
    if ((counts.get(uid) ?? 0) === 0) {
      result.missing.push(uid);
      continue;
    }
    const childGraph = sceneGraphOf(findInstanceByUid(layout, uid)?.instance);
    if (childGraph && parentUidOf(childGraph) === parentUid) {
      childGraph['parent-uid'] = null;
      result.detached.push(uid);
    } else {
      result.otherParent.push(uid);
    }
  }
  delete graph.children;
  return result;
}
