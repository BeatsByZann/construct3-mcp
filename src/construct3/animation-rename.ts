/**
 * What else changes when a Sprite animation is renamed.
 *
 * Frame image files: the editor names a frame's image
 * lower("<object>-<animation>-<NNN>.<ext>"), NNN being the frame's index in
 * the animation (3 digits) and ext "jpg" for a JPEG frame (fileType
 * "image/jpeg"), "png" otherwise (also when fileType is missing). The
 * animation's folder and the frames' imageSpriteId are not part of the name.
 * Checked on Scirra's public example projects
 * (github.com/Scirra/Construct-Example-Projects: 20,185 of 20,185 frames,
 * 1,651 of them in animation folders, 4,040 without fileType) and on
 * editor-saved r449 projects (5,146 of 5,146 frames, 17 of them JPEG). So a
 * renamed animation's images have to be renamed too, or the editor no longer
 * finds them. images/ can also hold files the frames no longer use under such
 * names (seen in editor-saved projects: a PNG next to a JPEG frame's file of
 * the same name, and files for frame indexes past the last frame); they are
 * left as they are.
 *
 * An editor rename seen in an editor-saved project's history renamed every
 * frame file (same content, no file left under the old name), changed nothing
 * in the object JSON but the animation's name (sid, frames and imageSpriteIds
 * kept), set "initial-animation" of the object's layout instances that named
 * the old animation to the new name, and left a string naming the old
 * animation in an event sheet as it was.
 *
 * Since the file name holds the frame's index, inserting or deleting a frame
 * renumbers the image files of the frames after it too: they move one index
 * up or down with their frames (planFrameImageShift), or every later frame
 * would show its neighbour's image.
 *
 * Layout instances: every Sprite instance names an animation of its object
 * in "initial-animation" (20,833 of 20,833 in the public examples, 2,494 of
 * 2,494 in the editor-saved projects, sub-layers included).
 */

import { getImageFileName } from './png-generator.js';
import { forEachLayoutInstance } from './layers.js';
import { nameKey } from './names.js';

/** A file in images/ to rename (names relative to images/). */
export interface ImageFileRename {
  from: string;
  to: string;
}

/** The image file renames that go with an animation rename. */
export interface FrameImageRenamePlan {
  renames: ImageFileRename[];
  /** Expected file names of frames that have no image file (nothing to rename for them) */
  missing: string[];
  /** Target names already taken by other files (renaming would replace them) */
  clashes: string[];
}

/**
 * Extension of a Sprite frame's image file: "jpg" for a JPEG frame, "png" for
 * a PNG frame or one without fileType; undefined for any other fileType (none
 * seen in editor-saved projects or the public examples).
 */
export function frameImageExtension(fileType: unknown): 'jpg' | 'png' | undefined {
  if (fileType === 'image/jpeg') return 'jpg';
  if (fileType === 'image/png' || fileType === undefined) return 'png';
  return undefined;
}

/** A frame's image file name without the extension, e.g. "hero-walk-000". */
export function frameImageBaseName(objectName: string, animationName: string, frameIndex: number): string {
  return getImageFileName(objectName, animationName, frameIndex, 'Sprite').replace(/\.png$/, '');
}

/**
 * The file name a frame's image is expected under, e.g. "hero-walk-001.jpg":
 * `base` (from frameImageBaseName) with the extension of the frame's
 * fileType, "*" for a fileType without a known extension.
 */
export function expectedFrameImageName(base: string, fileType: unknown): string {
  return `${base}.${frameImageExtension(fileType) ?? '*'}`;
}

/**
 * The files of a listing of images/, looked up by nameKey() (names.ts):
 * ignoring case and Unicode normalization, as Windows and macOS compare file
 * names (macOS HFS+ lists "ä" decomposed, NFD, where a name built from the
 * JSON usually has it composed, NFC).
 */
export interface ImageFileIndex {
  /** The files whose name is `name` by nameKey() (several only on a case- or normalization-sensitive file system) */
  named(name: string): string[];
  /**
   * The files that hold the image of the frame whose file name without
   * extension is `base`: the file its fileType points to; for another
   * fileType, every file named `base` with a single extension.
   */
  frameFiles(base: string, fileType: unknown): string[];
}

/** Index a listing of images/ (file names) for lookups by nameKey(). */
export function indexImageFiles(files: readonly string[]): ImageFileIndex {
  const byKey = new Map<string, string[]>();
  const byStem = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, file: string) => {
    const list = map.get(key);
    if (list) list.push(file); else map.set(key, [file]);
  };
  for (const file of files) {
    const key = nameKey(file);
    add(byKey, key, file);
    // "hero-walk-000.gif" has the stem "hero-walk-000", "hero-walk-000.png.bak" has none that a frame uses
    const dot = key.lastIndexOf('.');
    if (dot > 0 && dot < key.length - 1) add(byStem, key.slice(0, dot), file);
  }
  return {
    named: name => byKey.get(nameKey(name)) ?? [],
    frameFiles: (base, fileType) => {
      const extension = frameImageExtension(fileType);
      return extension !== undefined ? byKey.get(nameKey(`${base}.${extension}`)) ?? [] : byStem.get(nameKey(base)) ?? [];
    },
  };
}

/** The extension of a file name, lowercase ("PNG" of "a.b.PNG" → "png"). */
function extensionOf(file: string): string {
  return file.slice(file.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * Plan the renames of an animation's frame image files when it is renamed
 * from `oldName` to `newName`. `files` lists images/. Each frame's file is
 * the one its fileType points to, found ignoring case (so a mixed-case name
 * written by older versions of these tools is found too), and gets the
 * lowercase name for `newName`. For a frame of another format, every file
 * with the frame's name and a single extension is renamed, keeping the
 * extension. Only files of existing frames are renamed.
 */
export function planFrameImageRenames(
  files: readonly string[],
  objectName: string,
  oldName: string,
  newName: string,
  frames: ReadonlyArray<{ fileType?: unknown }>,
): FrameImageRenamePlan {
  const index = indexImageFiles(files);

  const plan: FrameImageRenamePlan = { renames: [], missing: [], clashes: [] };
  frames.forEach((frame, frameIndex) => {
    const oldBase = frameImageBaseName(objectName, oldName, frameIndex);
    const newBase = frameImageBaseName(objectName, newName, frameIndex);
    const sources = index.frameFiles(oldBase, frame?.fileType);
    if (sources.length === 0) {
      plan.missing.push(expectedFrameImageName(oldBase, frame?.fileType));
      return;
    }
    for (const from of sources) {
      const to = `${newBase}.${extensionOf(from)}`;
      if (from === to) continue;
      // Another file under the target name (any case) would be replaced, or
      // two files that differ only in case would get the same name
      if (index.named(to).some(file => file !== from) || plan.renames.some(r => nameKey(r.to) === nameKey(to))) {
        plan.clashes.push(to);
        continue;
      }
      plan.renames.push({ from, to });
    }
  });
  return plan;
}

/**
 * A frame inserted at index `insertAt` (0 to the frame count), or the
 * frame at `deleteAt` deleted. With `copyOf`, the inserted frame is a copy
 * of frame `copyOf` (an index before the change) and gets copies of its
 * image files instead of a placeholder.
 */
export type FrameListChange = { insertAt: number; copyOf?: number } | { deleteAt: number };

/** The image file renames that go with inserting or deleting a frame. */
export interface FrameImageShiftPlan {
  /**
   * Every rename, in the order to apply them: each target name is free when
   * its rename runs (a name another rename moved away before counts as free).
   * Undo them in reverse order.
   */
  renames: ImageFileRename[];
  /** True for an insert (the later files move one index up), false for a delete */
  inserted: boolean;
  /** Image files of later frames moved one index up (insert) or down (delete), in `renames` */
  shifted: ImageFileRename[];
  /** Image files of the deleted frame, kept under a .bak name, in `renames` */
  parked: ImageFileRename[];
  /**
   * Files no frame uses under a name a moved image or the new frame's image
   * takes (e.g. an image left behind by a deleted frame), kept under a .bak
   * name instead of being replaced, in `renames`
   */
  backedUp: ImageFileRename[];
  /** Expected file names of moved frames that have no image file (nothing moved for them) */
  missing: string[];
  /** Name of the new frame's placeholder image (insert without copyOf; the name is free once `renames` ran) */
  newFrameFile?: string;
  /**
   * Insert with copyOf: the image files to copy for the new frame, from the
   * name the copied frame's file has once `renames` ran to the new frame's
   * name, keeping the extension (the name is free once `renames` ran)
   */
  copies: ImageFileRename[];
  /** Insert with copyOf: the copied frame's expected file name when it has no image file (nothing is copied) */
  uncopied?: string;
  /** Why the renames cannot be applied (nothing may be changed then) */
  clashes: string[];
}

/**
 * A name for `file` ending in `suffix` that no name in `taken` (compared by
 * nameKey) has: `<file><suffix>`, else `<file>.1<suffix>`, `<file>.2<suffix>`,
 * ... The name returned is added to `taken`.
 */
function freeName(file: string, suffix: string, taken: Set<string>): string {
  for (let n = 0; ; n++) {
    const name = n === 0 ? `${file}${suffix}` : `${file}.${n}${suffix}`;
    if (!taken.has(nameKey(name))) {
      taken.add(nameKey(name));
      return name;
    }
  }
}

/**
 * A backup name for `file` that no name in `taken` (compared by nameKey)
 * has: `<file>.bak`, else `<file>.1.bak`, `<file>.2.bak`, ... The name
 * returned is added to `taken`.
 */
export function freeBackupName(file: string, taken: Set<string>): string {
  return freeName(file, '.bak', taken);
}

/**
 * Plan the image file renames that keep an animation's frames and their
 * images together when a frame is inserted or deleted. `files` lists images/,
 * `frames` are the animation's frames before the change. Each frame's files
 * are found as for a rename (planFrameImageRenames: its fileType's
 * extension, or for another fileType every file with its name and a single
 * extension, ignoring case) and move to the lowercase name of their new
 * index, keeping the extension.
 *
 * - Insert at k: the files of frames k..n-1 move one index up, the last
 *   first; the new frame's image then goes under the name of index k.
 * - Delete at k: the deleted frame's files are renamed to <file>.bak (kept,
 *   not deleted), then the files of frames k+1..n-1 move one index down.
 * - Insert at k with copyOf: the same moves, then the copied frame's files are
 *   copied (by the caller) to the names of index k, keeping their extension,
 *   instead of a placeholder.
 *
 * No existing file is replaced: a file that no frame uses but that has a
 * name a moved image or the new frame's image needs is renamed to <file>.bak
 * first (<file>.1.bak, … when that name is taken too).
 */
export function planFrameImageShift(
  files: readonly string[],
  objectName: string,
  animationName: string,
  frames: ReadonlyArray<{ fileType?: unknown } | null | undefined>,
  change: FrameListChange,
): FrameImageShiftPlan {
  const index = indexImageFiles(files);
  const base = (frameIndex: number) => frameImageBaseName(objectName, animationName, frameIndex);
  const plan: FrameImageShiftPlan = {
    inserted: 'insertAt' in change, renames: [], shifted: [], parked: [], backedUp: [], missing: [], copies: [], clashes: [],
  };

  // Every name in images/ so far, and those the renames produce, by nameKey() (for free .bak names)
  const taken = new Set(files.map(nameKey));
  // With copyOf: the files each frame placed would bind at its new index, also one without an image file
  const slots: string[] = [];
  const backupName = (file: string): string => freeBackupName(file, taken);

  const move = (from: number, to: number) => {
    const fileType = frames[from]?.fileType;
    const sources = index.frameFiles(base(from), fileType);
    if (sources.length === 0) plan.missing.push(expectedFrameImageName(base(from), fileType));
    for (const file of sources) {
      const target = `${base(to)}.${extensionOf(file)}`;
      plan.shifted.push({ from: file, to: target });
      taken.add(nameKey(target));
    }
  };

  if ('insertAt' in change) {
    for (let i = frames.length - 1; i >= change.insertAt; i--) move(i, i + 1);
    if (change.copyOf === undefined) {
      plan.newFrameFile = getImageFileName(objectName, animationName, change.insertAt, 'Sprite');
    } else {
      const fileType = frames[change.copyOf]?.fileType;
      const sources = index.frameFiles(base(change.copyOf), fileType);
      if (sources.length === 0) plan.uncopied = expectedFrameImageName(base(change.copyOf), fileType);
      for (const file of sources) {
        // A file of a frame at or after insertAt has moved up by the time it is copied
        const now = plan.shifted.find(r => r.from === file)?.to ?? file;
        const target = `${base(change.insertAt)}.${extensionOf(file)}`;
        plan.copies.push({ from: now, to: target });
        taken.add(nameKey(target));
      }
      // With copyOf, every frame placed reserves the files it would bind at its new index, also one without an
      // image file, so it never takes an unused file there (add and delete keep the planning above unchanged)
      for (let i = frames.length - 1; i >= change.insertAt; i--) slots.push(...index.frameFiles(base(i + 1), frames[i]?.fileType));
      slots.push(...index.frameFiles(base(change.insertAt), fileType));
    }
  } else {
    for (const file of index.frameFiles(base(change.deleteAt), frames[change.deleteAt]?.fileType)) {
      plan.parked.push({ from: file, to: backupName(file) });
    }
    for (let i = change.deleteAt + 1; i < frames.length; i++) move(i, i - 1);
  }

  // Files in the way: named like a target, but not moved themselves
  const moved = new Set([...plan.parked, ...plan.shifted].map(r => r.from));
  const targets = [
    ...plan.shifted.map(r => r.to),
    ...(plan.newFrameFile !== undefined ? [plan.newFrameFile] : []),
    ...plan.copies.map(c => c.to),
  ];
  for (const file of [...targets.flatMap(target => index.named(target)), ...slots]) {
    if (!moved.has(file) && !plan.backedUp.some(r => r.from === file)) {
      plan.backedUp.push({ from: file, to: backupName(file) });
    }
  }
  plan.renames = [...plan.backedUp, ...plan.parked, ...plan.shifted];
  const result = simulateImageRenames(files, plan.renames);
  plan.clashes = result.clashes.map(c => `images/${c.from} cannot be renamed to images/${c.to}: images/${c.occupant} would be replaced`);
  if (plan.clashes.length === 0) {
    for (const target of [...(plan.newFrameFile !== undefined ? [plan.newFrameFile] : []), ...plan.copies.map(c => c.to)]) {
      const occupant = result.present.get(nameKey(target))?.[0];
      if (occupant !== undefined) plan.clashes.push(`images/${occupant} would be replaced by the new frame's image`);
    }
  }
  return plan;
}

/** The image file renames that go with putting an animation's frames in a new order. */
export interface FrameImageReorderPlan {
  /** Every rename, in the order to apply them (each target name is free when its rename runs); undo them in reverse order */
  renames: ImageFileRename[];
  /** Image files that follow their frame to its new index: the name before the call and the final name (in `renames`, some by way of a temporary name) */
  moved: ImageFileRename[];
  /** Files no frame uses under a name a moved image needs, kept under a .bak name, in `renames` */
  backedUp: ImageFileRename[];
  /** Expected file names of frames that change index but have no image file (nothing moved for them) */
  missing: string[];
  /** Why the renames cannot be applied (nothing may be changed then) */
  clashes: string[];
}

/**
 * Plan the image file renames that keep an animation's frames and their
 * images together when the frames are put in a new order: `order[k]` is the
 * index before the call of the frame that ends at index k (a permutation of
 * 0 to n-1). `files` lists images/, `frames` are the frames before the
 * call. Each moving frame's files are found as for a rename
 * (planFrameImageRenames: its fileType's extension, or for another fileType
 * every file with its name and a single extension, ignoring case) and move
 * to the lowercase name of the frame's new index, keeping the extension.
 * A file no frame uses under a target name is kept as <file>.bak first, as
 * planFrameImageShift does. Each rename runs once its target is free; moves
 * that wait on each other in a cycle (two frames that swap) go through a
 * temporary name, <file>.reorder (<file>.1.reorder, ... when taken). No
 * existing file is replaced.
 */
export function planFrameImageReorder(
  files: readonly string[],
  objectName: string,
  animationName: string,
  frames: ReadonlyArray<{ fileType?: unknown } | null | undefined>,
  order: readonly number[],
): FrameImageReorderPlan {
  const index = indexImageFiles(files);
  const base = (frameIndex: number) => frameImageBaseName(objectName, animationName, frameIndex);
  const plan: FrameImageReorderPlan = { renames: [], moved: [], backedUp: [], missing: [], clashes: [] };
  // Every name in images/ so far, and those the renames produce, by nameKey() (for free .bak and .reorder names)
  const taken = new Set(files.map(nameKey));
  // The files each moving frame would bind at its new index, also one without an image file: any of them that does not move is in the way
  const slots: string[] = [];

  order.forEach((from, to) => {
    if (from === to) return;
    const fileType = frames[from]?.fileType;
    slots.push(...index.frameFiles(base(to), fileType));
    const sources = index.frameFiles(base(from), fileType);
    if (sources.length === 0) plan.missing.push(expectedFrameImageName(base(from), fileType));
    for (const file of sources) {
      const target = `${base(to)}.${extensionOf(file)}`;
      // Two files that differ only in case (a case-sensitive file system) would get the same name
      const other = plan.moved.find(r => nameKey(r.to) === nameKey(target));
      if (other !== undefined) {
        plan.clashes.push(`images/${other.from} and images/${file} would both be renamed to images/${target}`);
        continue;
      }
      plan.moved.push({ from: file, to: target });
      taken.add(nameKey(target));
    }
  });
  if (plan.clashes.length > 0) return plan;

  // Files in the way: named like a target, or bound by a moving frame at its new index, but not moved themselves
  const movedFrom = new Set(plan.moved.map(r => r.from));
  for (const file of [...plan.moved.flatMap(({ to }) => index.named(to)), ...slots]) {
    if (!movedFrom.has(file) && !plan.backedUp.some(r => r.from === file)) {
      plan.backedUp.push({ from: file, to: freeName(file, '.bak', taken) });
    }
  }

  // How many files have each name (by nameKey) once the backups ran, kept up to date as the renames below go
  const present = new Map<string, number>();
  const count = (name: string, n: number) => present.set(nameKey(name), (present.get(nameKey(name)) ?? 0) + n);
  for (const file of files) count(file, 1);
  for (const { from, to } of plan.backedUp) {
    count(from, -1);
    count(to, 1);
  }

  const sequence: ImageFileRename[] = [];
  const rename = (from: string, to: string) => {
    sequence.push({ from, to });
    count(from, -1);
    count(to, 1);
  };
  const pending = plan.moved.map(r => ({ ...r }));
  for (let steps = 0; pending.length > 0; steps++) {
    // Each move runs once, each cycle parks one file: more steps than this means the moves cannot be ordered
    if (steps > 2 * plan.moved.length) {
      plan.clashes.push('the frame image renames could not be put in an order in which no file is replaced');
      return plan;
    }
    const ready = pending.findIndex(r => (present.get(nameKey(r.to)) ?? 0) === 0);
    if (ready !== -1) {
      const [move] = pending.splice(ready, 1);
      rename(move.from, move.to);
      continue;
    }
    // Every target is taken by a file that moves too: a cycle. Park the first one under a temporary name
    const first = pending[0];
    const temporary = freeName(first.from, '.reorder', taken);
    rename(first.from, temporary);
    first.from = temporary;
  }
  plan.renames = [...plan.backedUp, ...sequence];
  plan.clashes = simulateImageRenames(files, plan.renames).clashes
    .map(c => `images/${c.from} cannot be renamed to images/${c.to}: images/${c.occupant} would be replaced`);
  return plan;
}

/** A rename whose target name is taken by another file when it would run. */
export interface ImageRenameClash extends ImageFileRename {
  /** The file under the target name (ignoring case) */
  occupant: string;
  /** Whether an earlier rename of the list put `occupant` there */
  renamedThere: boolean;
}

/**
 * Apply `renames` in order to a listing of images/, comparing names by
 * nameKey() (ignoring case and Unicode normalization, as Windows and macOS
 * do): a target name is free when no file has it at that point, also when an
 * earlier rename moved its file away. Returns the renames whose target is
 * taken by another file (these are skipped) and the files present afterwards
 * by nameKey().
 */
export function simulateImageRenames(
  files: readonly string[],
  renames: readonly ImageFileRename[],
): { clashes: ImageRenameClash[]; present: Map<string, string[]> } {
  const present = new Map<string, string[]>();
  const add = (file: string) => {
    const list = present.get(nameKey(file));
    if (list) list.push(file); else present.set(nameKey(file), [file]);
  };
  files.forEach(add);
  const renamedThere = new Set<string>();
  const clashes: ImageRenameClash[] = [];
  for (const { from, to } of renames) {
    const occupant = (present.get(nameKey(to)) ?? []).find(file => file !== from);
    if (occupant !== undefined) {
      clashes.push({ from, to, occupant, renamedThere: renamedThere.has(occupant) });
      continue;
    }
    const left = (present.get(nameKey(from)) ?? []).filter(file => file !== from);
    if (left.length > 0) present.set(nameKey(from), left); else present.delete(nameKey(from));
    add(to);
    renamedThere.add(to);
  }
  return { clashes, present };
}

/** An animation of a Sprite's "animations" container and where it is. */
export interface AnimationEntry<T = Record<string, unknown>> {
  animation: T;
  /** The items list that holds it: the container's, or an animation folder's */
  items: T[];
  /** Names of the animation folders it is in, outermost first (empty at the top level) */
  folders: string[];
}

/**
 * Every animation of a Sprite's "animations" container, those in animation
 * folders (subfolders, at any depth) included: the top-level items first,
 * then each folder's, depth-first.
 */
export function animationEntries<T = Record<string, unknown>>(container: unknown): Array<AnimationEntry<T>> {
  const out: Array<AnimationEntry<T>> = [];
  const walk = (node: unknown, folders: string[]) => {
    if (typeof node !== 'object' || node === null) return;
    const { items, subfolders } = node as { items?: unknown; subfolders?: unknown };
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item === 'object' && item !== null) out.push({ animation: item as T, items: items as T[], folders });
      }
    }
    if (Array.isArray(subfolders)) {
      for (const folder of subfolders) {
        const name = typeof folder === 'object' && folder !== null ? (folder as { name?: unknown }).name : undefined;
        walk(folder, [...folders, typeof name === 'string' ? name : '?']);
      }
    }
  };
  walk(container, []);
  return out;
}

/** Every animation of a Sprite's "animations" container, those in animation folders included. */
export function everyAnimation<T = Record<string, unknown>>(container: unknown): T[] {
  return animationEntries<T>(container).map(entry => entry.animation);
}

/**
 * The animation named `name` (exactly) in a Sprite's "animations" container,
 * in any animation folder, with the items list that holds it; the first one
 * in animationEntries order if the name is used twice.
 */
export function findAnimation<T = Record<string, unknown>>(container: unknown, name: string): AnimationEntry<T> | undefined {
  return animationEntries<T>(container).find(entry => (entry.animation as { name?: unknown }).name === name);
}

/**
 * The animation names of a Sprite for a "not found" message: an animation in
 * an animation folder is shown with its folder path ("Moves/Walk"), followed
 * by a note that the tools take the name alone.
 */
export function describeAvailableAnimations(container: unknown): string {
  const entries = animationEntries(container);
  const names = entries.map(entry => [...entry.folders, String(entry.animation.name)].join('/'));
  const note = entries.some(entry => entry.folders.length > 0)
    ? ' (animations in animation folders are shown with their folder path; pass the animation name alone)'
    : '';
  return `${names.join(', ')}${note}`;
}

/**
 * The other animations of the object (in any animation folder) that use
 * frame image files of `animation`: they have frames, and their names differ
 * from its name only in case (image file names are lowercase). None of the
 * editor-saved projects checked has such a pair, but older versions of these
 * tools could create one.
 */
export function animationsSharingImageFiles(container: unknown, animation: { name: string }): string[] {
  const lower = animation.name.toLowerCase();
  return everyAnimation(container)
    .filter(a => a !== animation && typeof a.name === 'string' && a.name.toLowerCase() === lower
      && Array.isArray(a.frames) && a.frames.length > 0)
    .map(a => a.name as string);
}

/**
 * Set "initial-animation" to `newName` on the instances of `objectName` in
 * `layout` that name `oldName`. Returns how many instances changed; with
 * `newName` undefined, only counts them.
 */
export function renameInitialAnimation(
  layout: unknown,
  objectName: string,
  oldName: string,
  newName?: string,
): number {
  let count = 0;
  forEachLayoutInstance(layout, instance => {
    if (instance.type !== objectName) return;
    const properties = instance.properties;
    if (typeof properties !== 'object' || properties === null) return;
    const props = properties as Record<string, unknown>;
    if (props['initial-animation'] !== oldName) return;
    count++;
    if (newName !== undefined) props['initial-animation'] = newName;
  });
  return count;
}

/** Names of the families in `families` (as read by readAllFamilies) that list `objectName` as a member. */
export function familiesContaining(objectName: string, families: ReadonlyMap<string, unknown>): string[] {
  const names: string[] = [];
  for (const [name, family] of families) {
    const members = typeof family === 'object' && family !== null ? (family as { members?: unknown }).members : undefined;
    if (Array.isArray(members) && members.includes(objectName)) names.push(name);
  }
  return names;
}

/**
 * How many condition/action parameters of `objectClasses` (the object, and
 * the families it belongs to, whose conditions and actions can name its
 * animations too) in an event sheet are the string expression naming
 * `animationName` (e.g. "Set animation" with `"Walk"`). A rename leaves them
 * as they are. Parameters that compute a name (e.g. `"Walk" & n`) are not
 * counted, so this is a lower bound.
 */
export function countAnimationNameParameters(
  sheet: unknown,
  objectClasses: string | readonly string[],
  animationName: string,
): number {
  const classes = new Set(typeof objectClasses === 'string' ? [objectClasses] : objectClasses);
  const expression = `"${animationName}"`;
  let count = 0;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.objectClass === 'string' && classes.has(record.objectClass)
      && typeof record.parameters === 'object' && record.parameters !== null) {
      for (const value of Object.values(record.parameters as Record<string, unknown>)) {
        if (value === expression) count++;
      }
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null) visit(value);
    }
  };
  visit(sheet);
  return count;
}
