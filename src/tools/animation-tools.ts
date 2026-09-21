/**
 * Animation tools: add_animation_to_sprite, update_animation_properties,
 * delete_animation, rename_animation, add_frame_to_animation,
 * delete_frame_from_animation, update_frame, replace_sprite_image,
 * replace_object_image, reorder_frames, reverse_frames, duplicate_frame,
 * create_animation_folder, move_animation_to_folder.
 */

import { z } from 'zod';
import { readFile, copyFile, rename, stat, unlink } from 'fs/promises';
import { basename } from 'path';
import type { MutationToolDeps } from './shared.js';
import type {
  WriteResult,
  ObjectType,
  Animation,
  AnimationFrame,
  AnimationsContainer,
  ImagePoint,
} from '../construct3/types.js';
import { toolResult, toolError, notFoundError, validateSubfolder } from './shared.js';
import { createAnimation, createAnimationFrame } from '../construct3/templates.js';
import { getImageFileName } from '../construct3/png-generator.js';
import { resolveProjectPath } from '../construct3/path-utils.js';

/** Width and height from a PNG's IHDR chunk, or undefined when the data is not a PNG. */
export function readPngSize(png: Buffer): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || signature.some((byte, i) => png[i] !== byte)) return undefined;
  if (png.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

// ─── Shared animation helpers ────────────────────────────

/** An animation together with the container and folder path that hold it. */
interface AnimationLocation {
  anim: Animation;
  container: AnimationsContainer;
  index: number;
  /** Slash-separated folder path, or undefined at the animations root. */
  folderPath?: string;
}

/** An animation subfolder's name; C3 types it loosely, so read it defensively. */
function folderName(container: AnimationsContainer): string {
  return typeof container.name === 'string' ? container.name : '';
}

/** Every animation in an object, root folder first, depth-first after that. */
function listAnimations(root: AnimationsContainer, folderPath?: string): AnimationLocation[] {
  const found: AnimationLocation[] = [];
  root.items.forEach((anim, index) => found.push({ anim, container: root, index, folderPath }));
  for (const sub of root.subfolders) {
    const name = folderName(sub);
    found.push(...listAnimations(sub, folderPath ? folderPath + '/' + name : name));
  }
  return found;
}

/** Find an animation by name anywhere in the folder tree. */
function findAnimationAnywhere(root: AnimationsContainer, name: string): AnimationLocation | undefined {
  return listAnimations(root).find(location => location.anim.name === name);
}

/** Find the container addressed by a slash-separated folder path. */
function findAnimationFolder(root: AnimationsContainer, folderPath?: string): AnimationsContainer | undefined {
  if (!folderPath) return root;
  let current: AnimationsContainer = root;
  for (const part of folderPath.split('/')) {
    const next: AnimationsContainer | undefined = current.subfolders.find(candidate => folderName(candidate) === part);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/** Guard the Sprite plugin and the animations container in one step. */
type SpriteAnimations =
  | { ok: true; root: AnimationsContainer }
  | { ok: false; error: ReturnType<typeof toolError> };

function readSpriteAnimations(obj: ObjectType, objectName: string): SpriteAnimations {
  if (obj['plugin-id'] !== 'Sprite') {
    return { ok: false, error: toolError(`Object "${objectName}" is not a Sprite. Only Sprite objects have animations.`) };
  }
  if (!obj.animations || !Array.isArray(obj.animations.items) || !Array.isArray(obj.animations.subfolders)) {
    return { ok: false, error: toolError(`Object "${objectName}" has no animations structure.`) };
  }
  return { ok: true, root: obj.animations };
}

/**
 * Validate image points: x/y are normalized 0-1 relative to the frame, and
 * names are unique within a frame because C3 addresses a point by its name.
 */
function validateImagePoints(points: ImagePoint[], context: string): void {
  const seen = new Set<string>();
  for (const point of points) {
    if (!Number.isFinite(point.x) || point.x < 0 || point.x > 1 ||
      !Number.isFinite(point.y) || point.y < 0 || point.y > 1) {
      throw new Error(
        `Image point "${point.name}" in ${context} is out of range (x=${point.x}, y=${point.y}). ` +
        'Image point x/y are normalized 0-1 relative to the frame.'
      );
    }
    if (seen.has(point.name)) {
      throw new Error(`Image point name "${point.name}" appears twice in ${context}. Names must be unique within a frame.`);
    }
    seen.add(point.name);
  }
}

/** Absolute path of the image file C3 expects for a Sprite animation frame. */
function frameImagePath(projectDir: string, objectName: string, animationName: string, frameIndex: number): string {
  return resolveProjectPath(projectDir, 'images', getImageFileName(objectName, animationName, frameIndex, 'Sprite'));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** A sequence of image-file moves that can be undone when a later step fails. */
class FileMoveJournal {
  private done: Array<{ from: string; to: string; copied?: boolean }> = [];

  async move(from: string, to: string): Promise<void> {
    await rename(from, to);
    this.done.push({ from, to });
  }

  async copy(from: string, to: string): Promise<void> {
    await copyFile(from, to);
    this.done.push({ from, to, copied: true });
  }

  async undo(): Promise<void> {
    for (let i = this.done.length - 1; i >= 0; i--) {
      const step = this.done[i];
      try {
        if (step.copied) await unlink(step.to);
        else await rename(step.to, step.from);
      } catch {
        // Best-effort rollback: a file that is already gone is the desired state.
      }
    }
    this.done = [];
  }
}

/**
 * Re-point frame image files so images/<object>-<animation>-NNN.png stays
 * aligned with the reordered frames.
 *
 * C3 addresses a frame's image by the frame index baked into the file name, so
 * reordering the JSON alone would leave every frame showing the image of
 * whichever frame previously sat at its index. Files are parked under
 * temporary names first, so no rename targets a name that is still occupied.
 *
 * @returns the number of image files moved and a journal that undoes them.
 */
async function reorderFrameImages(
  projectDir: string,
  objectName: string,
  animationName: string,
  order: number[],
): Promise<{ moved: number; journal: FileMoveJournal }> {
  const journal = new FileMoveJournal();
  try {
    const parked: Array<string | undefined> = [];
    for (let index = 0; index < order.length; index++) {
      const source = frameImagePath(projectDir, objectName, animationName, index);
      if (!(await pathExists(source))) {
        parked.push(undefined);
        continue;
      }
      const temp = source + '.reorder-tmp';
      await journal.move(source, temp);
      parked.push(temp);
    }

    let moved = 0;
    for (let newIndex = 0; newIndex < order.length; newIndex++) {
      const temp = parked[order[newIndex]];
      if (temp === undefined) continue;
      await journal.move(temp, frameImagePath(projectDir, objectName, animationName, newIndex));
      moved++;
    }
    return { moved, journal };
  } catch (error) {
    await journal.undo();
    throw error;
  }
}

/**
 * Shift the image files of frames at or after `from` up by one, freeing the
 * `from` slot for an inserted frame. Renaming runs from the highest index
 * down, so no move targets a name that is still occupied. The caller owns the
 * journal and is responsible for undoing it.
 */
async function shiftFrameImagesUp(
  projectDir: string,
  objectName: string,
  animationName: string,
  from: number,
  frameCount: number,
  journal: FileMoveJournal,
): Promise<number> {
  let moved = 0;
  for (let index = frameCount - 1; index >= from; index--) {
    const source = frameImagePath(projectDir, objectName, animationName, index);
    if (!(await pathExists(source))) continue;
    await journal.move(source, frameImagePath(projectDir, objectName, animationName, index + 1));
    moved++;
  }
  return moved;
}

/**
 * Park the removed frame's image file and shift every later frame's image down
 * by one, so the surviving frames keep the images they had.
 *
 * The removed image is parked rather than deleted: undoing the journal then
 * restores it, and the caller discards the parked file only once the JSON
 * write has succeeded.
 */
async function removeFrameImageSlot(
  projectDir: string,
  objectName: string,
  animationName: string,
  frameIndex: number,
  frameCount: number,
  journal: FileMoveJournal,
): Promise<{ moved: number; parked?: string }> {
  try {
    let moved = 0;
    let parked: string | undefined;

    const removed = frameImagePath(projectDir, objectName, animationName, frameIndex);
    if (await pathExists(removed)) {
      parked = removed + '.reorder-tmp';
      await journal.move(removed, parked);
      moved++;
    }
    for (let index = frameIndex + 1; index < frameCount; index++) {
      const source = frameImagePath(projectDir, objectName, animationName, index);
      if (!(await pathExists(source))) continue;
      await journal.move(source, frameImagePath(projectDir, objectName, animationName, index - 1));
      moved++;
    }
    return { moved, parked };
  } catch (error) {
    await journal.undo();
    throw error;
  }
}

/**
 * Shift frame image files up by one from `insertAt`, then copy the duplicated
 * frame's image into the freed slot. Mirrors reorderFrameImages' contract.
 */
async function duplicateFrameImage(
  projectDir: string,
  objectName: string,
  animationName: string,
  frameIndex: number,
  insertAt: number,
  frameCount: number,
): Promise<{ moved: number; journal: FileMoveJournal }> {
  const journal = new FileMoveJournal();
  try {
    let moved = await shiftFrameImagesUp(projectDir, objectName, animationName, insertAt, frameCount, journal);
    // The source frame's image has itself shifted when it sat at or after insertAt.
    const sourceIndex = frameIndex >= insertAt ? frameIndex + 1 : frameIndex;
    const sourcePath = frameImagePath(projectDir, objectName, animationName, sourceIndex);
    if (await pathExists(sourcePath)) {
      await journal.copy(sourcePath, frameImagePath(projectDir, objectName, animationName, insertAt));
      moved++;
    }
    return { moved, journal };
  } catch (error) {
    await journal.undo();
    throw error;
  }
}

/**
 * Move an animation's frame image files from the old animation name to the new
 * one, so images/<object>-<animation>-NNN.png follows a rename.
 *
 * C3 finds a frame's image by the animation name baked into the file name, so
 * renaming the animation in the JSON alone leaves every frame without an
 * image. The old and new names never share a file, except when they differ
 * only in case: both then map to the same lowercase file and nothing moves.
 *
 * A frame whose old file is missing is skipped, as the other frame tools do.
 * When its new file is already there, that file is adopted, which is how a
 * rename stranded by an earlier version is undone by renaming back. A frame
 * that has both an old file and a new one is refused before anything moves,
 * because moving would overwrite a file this tool did not write.
 *
 * @returns the number of image files moved and a journal that undoes them.
 */
async function renameAnimationFrameImages(
  projectDir: string,
  objectName: string,
  oldName: string,
  newName: string,
  frameCount: number,
): Promise<{ moved: number; journal: FileMoveJournal }> {
  const journal = new FileMoveJournal();
  if (frameCount === 0) return { moved: 0, journal };
  if (frameImagePath(projectDir, objectName, oldName, 0) === frameImagePath(projectDir, objectName, newName, 0)) {
    return { moved: 0, journal };
  }

  const moves: Array<{ from: string; to: string }> = [];
  for (let index = 0; index < frameCount; index++) {
    const from = frameImagePath(projectDir, objectName, oldName, index);
    const to = frameImagePath(projectDir, objectName, newName, index);
    if (!(await pathExists(from))) continue;
    if (await pathExists(to)) {
      throw new Error(
        `Frame ${index} already has an image file for "${newName}" (images/${basename(to)}) as well as its own ` +
        `(images/${basename(from)}). Renaming would overwrite it; move or delete one of them first.`
      );
    }
    moves.push({ from, to });
  }

  try {
    for (const step of moves) await journal.move(step.from, step.to);
    return { moved: moves.length, journal };
  } catch (error) {
    await journal.undo();
    throw error;
  }
}

/** An image point as accepted by update_frame; ranges are checked in the handler. */
const imagePointSchema = z.object({
  name: z.string().min(1).max(200).describe('Image point name'),
  x: z.number().describe('Horizontal position, normalized 0-1 relative to the frame'),
  y: z.number().describe('Vertical position, normalized 0-1 relative to the frame'),
});

export function registerAnimationTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── add_animation_to_sprite ──────────────────────────────

  server.tool(
    'add_animation_to_sprite',
    'Add a new animation to a Sprite object',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name (e.g., "Idle", "Walk", "Jump")'),
      speed: z.number().min(0).optional().default(5).describe('Frames per second (default: 5)'),
      isLooping: z.boolean().optional().default(true).describe('Loop the animation (default: true)'),
      isPingPong: z.boolean().optional().default(false).describe('Ping-pong playback (default: false)'),
      repeatCount: z.number().int().min(1).optional().default(1).describe('Repeat count if not looping (default: 1)'),
      frameCount: z.number().int().min(1).max(100).optional().default(1).describe('Number of blank frames to create (default: 1)'),
      frameWidth: z.number().int().positive().optional().describe('Frame width in pixels (default: existing sprite width)'),
      frameHeight: z.number().int().positive().optional().describe('Frame height in pixels (default: existing sprite height)'),
    },
    async (args) => {
      try {
        // Read existing object
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        // Verify it's a Sprite
        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is a "${obj['plugin-id']}" plugin, not a Sprite. Only Sprite objects have animations.`);
        }

        // Navigate to animations.items
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure. It may be corrupted.`);
        }
        const animItems = obj.animations.items;

        // Check for duplicate animation name
        if (animItems.some(a => a.name === args.animationName)) {
          return toolError(`Animation "${args.animationName}" already exists on "${args.objectName}". Use update_animation_properties to modify it.`);
        }

        // Determine frame dimensions from existing animation if not specified
        let frameWidth = args.frameWidth ?? 100;
        let frameHeight = args.frameHeight ?? 100;
        if ((!args.frameWidth || !args.frameHeight) && animItems.length > 0) {
          const existingFrames = animItems[0].frames;
          if (existingFrames.length > 0) {
            if (!args.frameWidth) frameWidth = existingFrames[0].width ?? 100;
            if (!args.frameHeight) frameHeight = existingFrames[0].height ?? 100;
          }
        }

        // Generate frames with imageSpriteIds and write placeholder PNGs
        const frames: AnimationFrame[] = [];
        const imageFiles: Array<{
          objectName: string;
          animationName: string;
          frameIndex: number;
          pluginId: string;
          width: number;
          height: number;
        }> = [];

        for (let i = 0; i < args.frameCount; i++) {
          const imageSpriteId = await idGen.generateImageSpriteId(reader);
          frames.push(createAnimationFrame(frameWidth, frameHeight, imageSpriteId));
          imageFiles.push({
            objectName: args.objectName,
            animationName: args.animationName,
            frameIndex: i,
            pluginId: 'Sprite',
            width: frameWidth,
            height: frameHeight,
          });
        }

        // Write placeholder PNGs before JSON — abort if image write fails
        await writer.writeImageFiles(imageFiles);

        // Generate SID for the animation
        const animSid = await idGen.generateSid(reader);

        const anim = createAnimation(
          args.animationName,
          animSid,
          args.speed,
          args.isLooping,
          args.isPingPong,
          args.repeatCount,
          frames,
        );

        animItems.push(anim);

        // Write back
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          generatedSid: animSid,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_animation_to_sprite] failed:', error);
        return toolError(`Error adding animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_animation_properties ──────────────────────────

  server.tool(
    'update_animation_properties',
    'Update properties of an existing animation on a Sprite object',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name to modify'),
      speed: z.number().min(0).optional().describe('New speed (frames per second)'),
      isLooping: z.boolean().optional().describe('New loop setting'),
      isPingPong: z.boolean().optional().describe('New ping-pong setting'),
      repeatCount: z.number().int().min(1).optional().describe('New repeat count'),
    },
    async (args) => {
      try {
        // Read existing object
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        // Verify it's a Sprite
        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is a "${obj['plugin-id']}" plugin, not a Sprite. Only Sprite objects have animations.`);
        }

        // Navigate to animations.items
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }
        const animItems = obj.animations.items;

        // Find the target animation
        const anim = animItems.find(a => a.name === args.animationName);
        if (!anim) {
          const availableNames = animItems.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available animations: ${availableNames}`);
        }

        // Check at least one property is being updated
        if (args.speed === undefined && args.isLooping === undefined && args.isPingPong === undefined && args.repeatCount === undefined) {
          return toolError('No updates provided. Specify at least one of: speed, isLooping, isPingPong, repeatCount.');
        }

        // Apply updates
        if (args.speed !== undefined) anim.speed = args.speed;
        if (args.isLooping !== undefined) anim.isLooping = args.isLooping;
        if (args.isPingPong !== undefined) anim.isPingPong = args.isPingPong;
        if (args.repeatCount !== undefined) anim.repeatCount = args.repeatCount;

        // Warn: isLooping:true + repeatCount>1 is contradictory — C3 ignores repeatCount when looping.
        const warnings: string[] = [];
        const effectiveLooping = args.isLooping !== undefined ? args.isLooping : anim.isLooping;
        const effectiveRepeat = args.repeatCount !== undefined ? args.repeatCount : anim.repeatCount;
        if (effectiveLooping === true && typeof effectiveRepeat === 'number' && effectiveRepeat > 1) {
          const msg = `isLooping is true but repeatCount is ${effectiveRepeat} — C3 ignores repeatCount when looping is enabled. Set isLooping: false to use repeatCount.`;
          console.warn('[update_animation_properties]', msg);
          warnings.push(msg);
        }

        // Write back
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_animation_properties] failed:', error);
        return toolError(`Error updating animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_animation ─────────────────────────────────────

  server.tool(
    'delete_animation',
    'Delete an animation from a Sprite object (must not be the last animation)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name to delete'),
    },
    async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite. Only Sprite objects have animations.`);
        }

        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }
        const animItems = obj.animations.items;

        const animIdx = animItems.findIndex(a => a.name === args.animationName);
        if (animIdx === -1) {
          const available = animItems.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${available}`);
        }

        if (animItems.length <= 1) {
          return toolError(`Cannot delete the last animation on "${args.objectName}". A Sprite must have at least one animation.`);
        }

        animItems.splice(animIdx, 1);

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_animation] failed:', error);
        return toolError(`Error deleting animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── rename_animation ─────────────────────────────────────

  server.tool(
    'rename_animation',
    'Rename an animation on a Sprite object, renaming its frame image files to match',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Current animation name'),
      newName: z.string().min(1).max(200).describe('New animation name'),
    },
    async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite. Only Sprite objects have animations.`);
        }

        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }
        const animItems = obj.animations.items;

        const anim = animItems.find(a => a.name === args.animationName);
        if (!anim) {
          const available = animItems.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${available}`);
        }

        if (animItems.some(a => a.name === args.newName)) {
          return toolError(`Animation "${args.newName}" already exists on "${args.objectName}".`);
        }
        // Frame files are named in lowercase, so two animations whose names
        // differ only in case would share every frame file.
        const clash = animItems.find(a => a !== anim && a.name.toLowerCase() === args.newName.toLowerCase());
        if (clash) {
          return toolError(
            `Animation "${clash.name}" on "${args.objectName}" differs from "${args.newName}" only in case, ` +
            'and their frame image files would share names. Choose another name.'
          );
        }

        const frameCount = Array.isArray(anim.frames) ? anim.frames.length : 0;
        const { moved, journal } = await renameAnimationFrameImages(
          reader.getProjectDir(), args.objectName, args.animationName, args.newName, frameCount,
        );
        try {
          anim.name = args.newName;

          const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
          const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

          const result: WriteResult = {
            success: true,
            entity: args.objectName,
            category: 'object',
            action: 'updated',
            backupFile: backupPath,
            warnings: [moved === 0
              ? `No frame image files needed renaming under images/ for "${args.animationName}", so only the animation name changed.`
              : `Renamed ${moved} frame image file(s) under images/ to follow the new animation name.`],
          };
          return toolResult(result);
        } catch (error) {
          await journal.undo();
          throw error;
        }
      } catch (error) {
        console.error('[rename_animation] failed:', error);
        return toolError(`Error renaming animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_frame_to_animation ───────────────────────────────

  server.tool(
    'add_frame_to_animation',
    'Add a new blank frame to a Sprite animation',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      index: z.number().int().min(0).optional().describe('Insert at this frame index (default: append)'),
      width: z.number().int().positive().optional().describe('Frame width in pixels (default: matches first frame)'),
      height: z.number().int().positive().optional().describe('Frame height in pixels (default: matches first frame)'),
      duration: z.number().positive().optional().default(1).describe('Frame duration in seconds (default: 1)'),
    },
    async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite.`);
        }
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        const anim = obj.animations.items.find(a => a.name === args.animationName);
        if (!anim) {
          const available = obj.animations.items.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found. Available: ${available}`);
        }

        // Infer dimensions from first existing frame
        const frameWidth = args.width ?? (anim.frames[0]?.width ?? 100);
        const frameHeight = args.height ?? (anim.frames[0]?.height ?? 100);

        const insertAt = args.index ?? anim.frames.length;
        if (insertAt > anim.frames.length) {
          return toolError(`index ${insertAt} is out of range. It must be between 0 and ${anim.frames.length} (append).`);
        }

        const imageSpriteId = await idGen.generateImageSpriteId(reader);

        // Inserting mid-animation renumbers every later frame, and C3 addresses
        // a frame's image by the index in its file name, so the existing image
        // files move up before the placeholder claims the freed slot.
        const journal = new FileMoveJournal();
        let shifted: number;
        try {
          shifted = await shiftFrameImagesUp(
            reader.getProjectDir(), args.objectName, args.animationName, insertAt, anim.frames.length, journal,
          );
        } catch (shiftError) {
          await journal.undo();
          throw shiftError;
        }

        let placeholderWritten = false;
        try {
          // Write placeholder PNG
          await writer.writeImageFiles([{
            objectName: args.objectName,
            animationName: args.animationName,
            frameIndex: insertAt,
            pluginId: 'Sprite',
            width: frameWidth,
            height: frameHeight,
          }]);
          placeholderWritten = true;

          const newFrame: AnimationFrame = {
            ...createAnimationFrame(frameWidth, frameHeight, imageSpriteId),
            duration: args.duration,
          };

          anim.frames.splice(insertAt, 0, newFrame);

          const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
          const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

          const result: WriteResult = {
            success: true,
            entity: args.objectName,
            category: 'object',
            action: 'updated',
            backupFile: backupPath,
            warnings: shifted > 0
              ? [`Shifted ${shifted} frame image file(s) under images/ up by one so they stay aligned with the inserted frame.`]
              : undefined,
          };
          return toolResult(result);
        } catch (writeError) {
          if (placeholderWritten) {
            try {
              await unlink(frameImagePath(reader.getProjectDir(), args.objectName, args.animationName, insertAt));
            } catch { /* best effort */ }
          }
          await journal.undo();
          throw writeError;
        }
      } catch (error) {
        console.error('[add_frame_to_animation] failed:', error);
        return toolError(`Error adding frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_frame_from_animation ─────────────────────────

  server.tool(
    'delete_frame_from_animation',
    'Delete a frame from a Sprite animation by index (must not be the last frame)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based frame index to delete'),
    },
    async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite.`);
        }
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        const anim = obj.animations.items.find(a => a.name === args.animationName);
        if (!anim) {
          const available = obj.animations.items.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found. Available: ${available}`);
        }

        if (args.frameIndex >= anim.frames.length) {
          return toolError(`Frame index ${args.frameIndex} is out of range. Animation "${args.animationName}" has ${anim.frames.length} frame(s) (indices 0–${anim.frames.length - 1}).`);
        }

        if (anim.frames.length <= 1) {
          return toolError(`Cannot delete the last frame of animation "${args.animationName}". An animation must have at least one frame.`);
        }

        // Removing a frame renumbers every later frame, and C3 addresses a
        // frame's image by the index in its file name, so the later image files
        // move down by one and the removed image is discarded only once the
        // JSON write has succeeded.
        const journal = new FileMoveJournal();
        const { moved, parked } = await removeFrameImageSlot(
          reader.getProjectDir(), args.objectName, args.animationName, args.frameIndex, anim.frames.length, journal,
        );

        try {
          anim.frames.splice(args.frameIndex, 1);

          const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
          const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

          if (parked) {
            try { await unlink(parked); } catch { /* best effort */ }
          }

          const result: WriteResult = {
            success: true,
            entity: args.objectName,
            category: 'object',
            action: 'updated',
            backupFile: backupPath,
            warnings: moved > 0
              ? [`Removed or shifted ${moved} frame image file(s) under images/ so they stay aligned with the remaining frames.`]
              : undefined,
          };
          return toolResult(result);
        } catch (writeError) {
          await journal.undo();
          throw writeError;
        }
      } catch (error) {
        console.error('[delete_frame_from_animation] failed:', error);
        return toolError(`Error deleting frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_frame ─────────────────────────────────────────

  server.tool(
    'update_frame',
    'Update per-frame properties of a Sprite animation frame (duration, dimensions, origin, tag, image points, collision polygon)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based frame index'),
      width: z.number().int().positive().optional().describe('New frame width in pixels'),
      height: z.number().int().positive().optional().describe('New frame height in pixels'),
      duration: z.number().positive().optional().describe('New frame duration in seconds'),
      originX: z.number().min(0).max(1).optional().describe('Horizontal origin 0-1 (0.5 = center)'),
      originY: z.number().min(0).max(1).optional().describe('Vertical origin 0-1 (0.5 = center)'),
      tag: z.string().max(200).optional().describe('Frame tag (empty string clears it)'),
      imagePoints: z.array(imagePointSchema).max(200).optional()
        .describe('Replace the whole image point list; x/y are normalized 0-1 and names must be unique'),
      addImagePoints: z.array(imagePointSchema).max(200).optional()
        .describe('Append image points to the existing list; names must not collide'),
      removeImagePoints: z.array(z.string().min(1).max(200)).max(200).optional()
        .describe('Remove image points by name; every name must exist on the frame'),
      collisionPoly: z.array(z.number()).max(2000).optional()
        .describe('Custom collision polygon as a flat [x0,y0,x1,y1,...] list normalized 0-1; at least 3 points, or [] to clear'),
      useCollisionPoly: z.boolean().optional().describe('Whether C3 uses the custom collision polygon for this frame'),
    },
    async (args) => {
      try {
        const hasUpdates = args.width !== undefined || args.height !== undefined ||
          args.duration !== undefined || args.originX !== undefined || args.originY !== undefined ||
          args.tag !== undefined || args.imagePoints !== undefined || args.addImagePoints !== undefined ||
          args.removeImagePoints !== undefined || args.collisionPoly !== undefined ||
          args.useCollisionPoly !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: width, height, duration, originX, originY, tag, imagePoints, addImagePoints, removeImagePoints, collisionPoly, useCollisionPoly.');
        }
        if (args.imagePoints !== undefined && (args.addImagePoints !== undefined || args.removeImagePoints !== undefined)) {
          return toolError('imagePoints replaces the whole image point list; do not combine it with addImagePoints or removeImagePoints.');
        }

        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite.`);
        }
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        const anim = obj.animations.items.find(a => a.name === args.animationName);
        if (!anim) {
          const available = obj.animations.items.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found. Available: ${available}`);
        }

        if (args.frameIndex >= anim.frames.length) {
          return toolError(`Frame index ${args.frameIndex} is out of range. Animation "${args.animationName}" has ${anim.frames.length} frame(s).`);
        }

        const frame = anim.frames[args.frameIndex];
        const warnings: string[] = [];

        if (args.width !== undefined) frame.width = args.width;
        if (args.height !== undefined) frame.height = args.height;
        if (args.duration !== undefined) frame.duration = args.duration;
        if (args.originX !== undefined) frame.originX = args.originX;
        if (args.originY !== undefined) frame.originY = args.originY;
        if (args.tag !== undefined) frame.tag = args.tag;

        if (args.imagePoints !== undefined) {
          try {
            validateImagePoints(args.imagePoints, 'imagePoints');
          } catch (validationError) {
            return toolError(validationError instanceof Error ? validationError.message : String(validationError));
          }
          frame.imagePoints = args.imagePoints;
        }

        // Remove before add, so one call can replace a point by name.
        if (args.removeImagePoints !== undefined) {
          const current = Array.isArray(frame.imagePoints) ? frame.imagePoints : [];
          const missing = args.removeImagePoints.filter(name => !current.some(point => point.name === name));
          if (missing.length > 0) {
            return toolError(`Image point(s) not found on frame ${args.frameIndex} of "${args.animationName}": ${missing.join(', ')}.`);
          }
          const removals = args.removeImagePoints;
          frame.imagePoints = current.filter(point => !removals.includes(point.name));
        }

        if (args.addImagePoints !== undefined) {
          const merged = [...(Array.isArray(frame.imagePoints) ? frame.imagePoints : []), ...args.addImagePoints];
          try {
            validateImagePoints(args.addImagePoints, 'addImagePoints');
            validateImagePoints(merged, 'the resulting image point list');
          } catch (validationError) {
            return toolError(validationError instanceof Error ? validationError.message : String(validationError));
          }
          frame.imagePoints = merged;
        }

        if (args.collisionPoly !== undefined) {
          const points = args.collisionPoly;
          if (points.length > 0) {
            if (points.length % 2 !== 0) {
              return toolError(`collisionPoly must hold x,y pairs, so its length must be even; got ${points.length} value(s).`);
            }
            if (points.length < 6) {
              return toolError(`collisionPoly needs at least 3 points (6 values) to form a polygon; got ${points.length / 2} point(s).`);
            }
          }
          const outside = points.filter(value => value < 0 || value > 1).length;
          if (outside > 0) {
            warnings.push(`${outside} collisionPoly value(s) fall outside 0-1. C3 stores polygon points normalized to the frame, so points beyond the frame edge are accepted but unusual.`);
          }
          frame.collisionPoly = { points };
        }

        if (args.useCollisionPoly !== undefined) frame.useCollisionPoly = args.useCollisionPoly;

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_frame] failed:', error);
        return toolError(`Error updating frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── replace_sprite_image ─────────────────────────────────

  server.tool(
    'replace_sprite_image',
    'Replace the image for a specific Sprite animation frame with real PNG data (base64-encoded)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based frame index'),
      pngBase64: z.string().max(10_000_000).describe('Base64-encoded PNG image data'),
      width: z.number().int().positive().optional().describe('Image width in pixels (updates frame metadata if provided)'),
      height: z.number().int().positive().optional().describe('Image height in pixels (updates frame metadata if provided)'),
    },
    async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite.`);
        }
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        const anim = obj.animations.items.find(a => a.name === args.animationName);
        if (!anim) {
          const available = obj.animations.items.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found. Available: ${available}`);
        }

        if (args.frameIndex >= anim.frames.length) {
          return toolError(`Frame index ${args.frameIndex} is out of range. Animation has ${anim.frames.length} frame(s).`);
        }

        const frame = anim.frames[args.frameIndex];

        // Decode and validate PNG
        let pngBuffer: Buffer;
        try {
          pngBuffer = Buffer.from(args.pngBase64, 'base64');
        } catch {
          return toolError('Invalid base64 data in pngBase64.');
        }

        // Minimal PNG header check: first 8 bytes must be PNG signature
        if (pngBuffer.length < 8 ||
          pngBuffer[0] !== 0x89 || pngBuffer[1] !== 0x50 || pngBuffer[2] !== 0x4E || pngBuffer[3] !== 0x47) {
          return toolError('Decoded data does not appear to be a valid PNG (invalid header).');
        }

        // Write the PNG to the correct images/ path using the imageSpriteId from the frame
        const imageSpriteId = frame.imageSpriteId;
        if (imageSpriteId === undefined) {
          return toolError(`Frame ${args.frameIndex} of animation "${args.animationName}" has no imageSpriteId. It may be a corrupted frame.`);
        }

        const fileName = getImageFileName(args.objectName, args.animationName, args.frameIndex, 'Sprite');
        const filePath = resolveProjectPath(reader.getProjectDir(), 'images', fileName);

        const { mkdir, writeFile } = await import('fs/promises');
        const { dirname } = await import('path');
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, pngBuffer);

        // Update frame metadata if dimensions provided
        if (args.width !== undefined) frame.width = args.width;
        if (args.height !== undefined) frame.height = args.height;

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: [`Image written to ${filePath}`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[replace_sprite_image] failed:', error);
        return toolError(`Error replacing sprite image: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── replace_object_image ──────────────────────────────

  server.tool(
    'replace_object_image',
    'Replace the single image of a Tiled Background, 9-patch, Particles, Sprite Font or Tilemap object type with real PNG data (base64). The image size is read from the PNG and written to the object type.',
    {
      objectName: z.string().max(200).describe('Object type that has one image (not a Sprite; use replace_sprite_image for Sprite frames)'),
      pngBase64: z.string().max(10_000_000).describe('Base64-encoded PNG image data'),
    },
    async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }
        const image = (obj as Record<string, unknown>).image as Record<string, unknown> | undefined;
        if (!image || typeof image !== 'object') {
          return toolError(obj['plugin-id'] === 'Sprite'
            ? `Object "${args.objectName}" is a Sprite; its images belong to animation frames. Use replace_sprite_image.`
            : `Object "${args.objectName}" (${obj['plugin-id']}) has no editable image.`);
        }

        const png = Buffer.from(args.pngBase64, 'base64');
        const size = readPngSize(png);
        if (!size) {
          return toolError('Decoded data is not a valid PNG (bad signature or header).');
        }

        const warnings: string[] = [];
        const oldWidth = image.width;
        const oldHeight = image.height;
        if ((oldWidth !== size.width || oldHeight !== size.height) && obj['plugin-id'] === 'Tilemap') {
          warnings.push(`The tileset changed size from ${String(oldWidth)}x${String(oldHeight)} to ${size.width}x${size.height}. Tile numbers count across and down the image, so placed tiles and per-tile collision polygons may now point at different tiles; check the Tilemap with get_tilemap_data.`);
        }

        // Every single-image object in the r495 examples and C3-ACE stores its
        // image as images/<lowercased object name>.png.
        const filePath = resolveProjectPath(reader.getProjectDir(), 'images', `${args.objectName.toLowerCase()}.png`);
        const { mkdir, writeFile } = await import('fs/promises');
        const { dirname } = await import('path');
        await mkdir(dirname(filePath), { recursive: true });
        const previous = await readFile(filePath).catch(() => undefined);
        await writeFile(filePath, png);

        image.width = size.width;
        image.height = size.height;
        if ('fileType' in image) image.fileType = 'image/png';

        let backupPath: string | undefined;
        try {
          const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
          backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);
        } catch (error) {
          // Keep the image and the object type in step.
          const message = error instanceof Error ? error.message : String(error);
          try {
            if (previous) await writeFile(filePath, previous);
            else await unlink(filePath).catch(() => undefined);
          } catch (rollbackError) {
            throw new Error(`${message}; restoring the previous image at ${filePath} also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
          throw new Error(`${message} (the previous image was restored)`);
        }

        warnings.push(`Image written to ${filePath} (${size.width}x${size.height}).`);
        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[replace_object_image] failed:', error);
        return toolError(`Error replacing object image: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── reorder_frames / reverse_frames ───────────────────

  /**
   * Shared frame-order implementation. The image files are re-pointed before
   * the JSON is written, and rolled back when the JSON write fails, so the
   * frames and images/ never disagree about which image belongs to a frame.
   */
  const applyFrameOrder = async (
    objectName: string,
    animationName: string,
    order: number[] | undefined,
    reverse: boolean,
  ) => {
    let obj: ObjectType;
    try {
      obj = await reader.readObjectType(objectName);
    } catch {
      return notFoundError('Object', objectName, reader.findNearestName(objectName, 'objects'), 'list_objects');
    }

    const animations = readSpriteAnimations(obj, objectName);
    if (!animations.ok) return animations.error;

    const location = findAnimationAnywhere(animations.root, animationName);
    if (!location) {
      const available = listAnimations(animations.root).map(item => item.anim.name).join(', ');
      return toolError(`Animation "${animationName}" not found on "${objectName}". Available: ${available}`);
    }

    const frames = location.anim.frames;
    const resolved = reverse
      ? frames.map((_unused, index) => frames.length - 1 - index)
      : (order ?? []);

    if (resolved.length !== frames.length) {
      return toolError(`order must list every frame exactly once: animation "${animationName}" has ${frames.length} frame(s) but order has ${resolved.length} entry/entries.`);
    }
    const seen = new Set<number>();
    for (const index of resolved) {
      if (index < 0 || index >= frames.length) {
        return toolError(`order contains frame index ${index}, which is out of range 0-${frames.length - 1}.`);
      }
      if (seen.has(index)) {
        return toolError(`order repeats frame index ${index}. order must be a permutation of every current frame index.`);
      }
      seen.add(index);
    }

    const { moved, journal } = await reorderFrameImages(reader.getProjectDir(), objectName, animationName, resolved);
    try {
      location.anim.frames = resolved.map(index => frames[index]);

      const subfolder = writer.getSubfolderForEntity('objectTypes', objectName);
      const backupPath = await writer.writeEntityFile('objectTypes', objectName, obj, subfolder);

      const result: WriteResult = {
        success: true,
        entity: objectName,
        category: 'object',
        action: 'updated',
        backupFile: backupPath,
        warnings: [moved === 0
          ? `No frame image files were found under images/ for "${animationName}", so only the frame JSON was reordered.`
          : `Renamed ${moved} frame image file(s) under images/ so they stay aligned with the new frame order.`],
      };
      return toolResult(result);
    } catch (error) {
      await journal.undo();
      throw error;
    }
  };

  server.tool(
    'reorder_frames',
    'Reorder the frames of a Sprite animation, renaming their image files to match',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      order: z.array(z.number().int()).min(1).max(1000)
        .describe('New frame order: a full permutation of the current 0-based frame indices'),
    },
    async (args) => {
      try {
        return await applyFrameOrder(args.objectName, args.animationName, args.order, false);
      } catch (error) {
        console.error('[reorder_frames] failed:', error);
        return toolError(`Error reordering frames: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'reverse_frames',
    'Reverse the frame order of a Sprite animation, renaming their image files to match',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
    },
    async (args) => {
      try {
        return await applyFrameOrder(args.objectName, args.animationName, undefined, true);
      } catch (error) {
        console.error('[reverse_frames] failed:', error);
        return toolError(`Error reversing frames: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── duplicate_frame ───────────────────────────────────

  server.tool(
    'duplicate_frame',
    'Duplicate a Sprite animation frame, copying its JSON and its image file',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based index of the frame to duplicate'),
      insertAt: z.number().int().min(0).optional()
        .describe('0-based index to insert the copy at (default: immediately after the source frame)'),
    },
    async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        const animations = readSpriteAnimations(obj, args.objectName);
        if (!animations.ok) return animations.error;

        const location = findAnimationAnywhere(animations.root, args.animationName);
        if (!location) {
          const available = listAnimations(animations.root).map(item => item.anim.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${available}`);
        }

        const frames = location.anim.frames;
        if (args.frameIndex >= frames.length) {
          return toolError(`Frame index ${args.frameIndex} is out of range. Animation "${args.animationName}" has ${frames.length} frame(s).`);
        }
        const insertAt = args.insertAt ?? args.frameIndex + 1;
        if (insertAt > frames.length) {
          return toolError(`insertAt ${insertAt} is out of range. It must be between 0 and ${frames.length} (append).`);
        }

        const source = frames[args.frameIndex];
        const copy = JSON.parse(JSON.stringify(source)) as AnimationFrame;
        // A duplicated frame needs its own image identity; C3 keys the image
        // record by imageSpriteId, so reusing the source id would alias them.
        let newImageSpriteId: number | undefined;
        if (source.imageSpriteId !== undefined) {
          newImageSpriteId = await idGen.generateImageSpriteId(reader);
          copy.imageSpriteId = newImageSpriteId;
        }

        const { moved, journal } = await duplicateFrameImage(
          reader.getProjectDir(), args.objectName, args.animationName, args.frameIndex, insertAt, frames.length,
        );
        try {
          frames.splice(insertAt, 0, copy);

          const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
          const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

          const warnings = [moved === 0
            ? `No frame image files were found under images/ for "${args.animationName}", so only the frame JSON was duplicated.`
            : `Copied or shifted ${moved} frame image file(s) under images/ so they stay aligned with the inserted frame.`];
          if (newImageSpriteId !== undefined) {
            warnings.push(`The duplicated frame was given imageSpriteId ${newImageSpriteId}.`);
          }

          const result: WriteResult = {
            success: true,
            entity: args.objectName,
            category: 'object',
            action: 'updated',
            backupFile: backupPath,
            warnings,
          };
          return toolResult(result);
        } catch (error) {
          await journal.undo();
          throw error;
        }
      } catch (error) {
        console.error('[duplicate_frame] failed:', error);
        return toolError(`Error duplicating frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── create_animation_folder ───────────────────────────

  server.tool(
    'create_animation_folder',
    'Create an animation subfolder on a Sprite object',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      folderPath: z.string().min(1).max(500).describe('Slash-separated animation folder path, e.g. "Combat/Melee"'),
    },
    async (args) => {
      try {
        validateSubfolder(args.folderPath);

        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        const animations = readSpriteAnimations(obj, args.objectName);
        if (!animations.ok) return animations.error;

        let current = animations.root;
        const created: string[] = [];
        for (const part of args.folderPath.split('/')) {
          let next = current.subfolders.find(candidate => folderName(candidate) === part);
          if (!next) {
            next = { items: [], subfolders: [], name: part };
            current.subfolders.push(next);
            created.push(part);
          }
          current = next;
        }
        if (created.length === 0) {
          return toolError(`Animation folder "${args.folderPath}" already exists on "${args.objectName}".`);
        }

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: [`Created animation folder(s): ${created.join(', ')}.`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_animation_folder] failed:', error);
        return toolError(`Error creating animation folder: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_animation_to_folder ──────────────────────────

  server.tool(
    'move_animation_to_folder',
    'Move an animation into an existing animation subfolder, or back to the animations root',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name to move'),
      folderPath: z.string().max(500).nullable()
        .describe('Destination animation folder path, or null for the animations root'),
    },
    async (args) => {
      try {
        const targetPath = args.folderPath === null || args.folderPath === '' ? undefined : args.folderPath;
        if (targetPath) validateSubfolder(targetPath);

        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        const animations = readSpriteAnimations(obj, args.objectName);
        if (!animations.ok) return animations.error;

        const location = findAnimationAnywhere(animations.root, args.animationName);
        if (!location) {
          const available = listAnimations(animations.root).map(item => item.anim.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${available}`);
        }

        const target = findAnimationFolder(animations.root, targetPath);
        if (!target) {
          return toolError(`Animation folder "${targetPath}" does not exist on "${args.objectName}". Create it with create_animation_folder first.`);
        }
        if (location.folderPath === targetPath) {
          const where = targetPath ? `folder "${targetPath}"` : 'the animations root';
          return toolError(`Animation "${args.animationName}" is already in ${where}.`);
        }

        location.container.items.splice(location.index, 1);
        target.items.push(location.anim);

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: [`Moved "${args.animationName}" from ${location.folderPath ? `"${location.folderPath}"` : 'the animations root'} to ${targetPath ? `"${targetPath}"` : 'the animations root'}.`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[move_animation_to_folder] failed:', error);
        return toolError(`Error moving animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
