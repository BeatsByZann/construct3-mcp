/**
 * Animation tools: add_animation_to_sprite, update_animation_properties,
 * delete_animation, rename_animation, add_frame_to_animation,
 * delete_frame_from_animation, update_frame, replace_sprite_image,
 * replace_object_image, reorder_frames, reverse_frames, duplicate_frame,
 * create_animation_folder, move_animation_to_folder.
 */

import { z } from 'zod';
import { readFile, copyFile, rename, stat, unlink } from 'fs/promises';
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
import { backupOnce, forgetChange, recordChange, recordWrite } from '../construct3/change-journal.js';
import { findNameClash } from '../construct3/names.js';
import { createAnimation, createAnimationFrame } from '../construct3/templates.js';
import { describeCharacter, getImageFileName, invalidImageNameCharacter } from '../construct3/png-generator.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { EntityWriteError } from '../construct3/project-writer.js';
import {
  animationsSharingImageFiles,
  countAnimationNameParameters,
  describeAvailableAnimations,
  everyAnimation,
  familiesContaining,
  findAnimation,
  frameImageExtension,
  planFrameImageRenames,
  renameInitialAnimation,
} from '../construct3/animation-rename.js';
import type { ImageFileRename } from '../construct3/animation-rename.js';

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

/** An animation subfolder's name; C3 types it loosely, so read it defensively. */
function folderName(container: AnimationsContainer): string {
  return typeof container.name === 'string' ? container.name : '';
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

/**
 * File extension of a frame's image, from the `fileType` its frame record
 * declares: "png" for a PNG frame or one without fileType, "jpg" for a JPEG
 * frame (see frameImageExtension in animation-rename.ts), "gif" for a GIF
 * frame (sampled r495.2 projects hold GIF frames among their PNGs); anything
 * else takes the MIME subtype as its extension.
 */
function frameExtension(frame: { fileType?: string } | undefined): string {
  const type = frame?.fileType;
  // PNG (also a frame without fileType) and JPEG, whose file is ".jpg"
  const known = frameImageExtension(type);
  if (known !== undefined) return known;
  if (type === 'image/gif') return 'gif';
  if (typeof type !== 'string') return 'png';
  const subtype = type.split('/')[1];
  return subtype && /^[a-z0-9]+$/i.test(subtype) ? subtype.toLowerCase() : 'png';
}

/** Absolute path of the image file C3 expects for a Sprite animation frame. */
function frameImagePath(projectDir: string, objectName: string, animationName: string, frameIndex: number, extension = 'png'): string {
  return resolveProjectPath(projectDir, 'images', getImageFileName(objectName, animationName, frameIndex, 'Sprite', extension));
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
    recordChange({ kind: 'move', path: to, from });
  }

  async copy(from: string, to: string): Promise<void> {
    await copyFile(from, to);
    this.done.push({ from, to, copied: true });
    recordChange({ kind: 'copy', path: to });
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
      // The tool undid it itself, so the call's journal must not offer it again.
      forgetChange(step.to);
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
  frames: AnimationFrame[],
): Promise<{ moved: number; journal: FileMoveJournal }> {
  const journal = new FileMoveJournal();
  try {
    const parked: Array<string | undefined> = [];
    for (let index = 0; index < order.length; index++) {
      const source = frameImagePath(projectDir, objectName, animationName, index, frameExtension(frames[index]));
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
      // The frame keeps its own image type at its new index.
      await journal.move(temp, frameImagePath(projectDir, objectName, animationName, newIndex, frameExtension(frames[order[newIndex]])));
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
  frames: AnimationFrame[],
): Promise<number> {
  let moved = 0;
  for (let index = frameCount - 1; index >= from; index--) {
    const extension = frameExtension(frames[index]);
    const source = frameImagePath(projectDir, objectName, animationName, index, extension);
    if (!(await pathExists(source))) continue;
    await journal.move(source, frameImagePath(projectDir, objectName, animationName, index + 1, extension));
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
  frames: AnimationFrame[],
): Promise<{ moved: number; parked?: string }> {
  try {
    let moved = 0;
    let parked: string | undefined;

    const removed = frameImagePath(projectDir, objectName, animationName, frameIndex, frameExtension(frames[frameIndex]));
    if (await pathExists(removed)) {
      parked = removed + '.reorder-tmp';
      await journal.move(removed, parked);
      moved++;
    }
    for (let index = frameIndex + 1; index < frameCount; index++) {
      const extension = frameExtension(frames[index]);
      const source = frameImagePath(projectDir, objectName, animationName, index, extension);
      if (!(await pathExists(source))) continue;
      await journal.move(source, frameImagePath(projectDir, objectName, animationName, index - 1, extension));
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
  frames: AnimationFrame[],
): Promise<{ moved: number; journal: FileMoveJournal }> {
  const journal = new FileMoveJournal();
  try {
    let moved = await shiftFrameImagesUp(projectDir, objectName, animationName, insertAt, frameCount, journal, frames);
    // The source frame's image has itself shifted when it sat at or after insertAt.
    const sourceIndex = frameIndex >= insertAt ? frameIndex + 1 : frameIndex;
    const extension = frameExtension(frames[frameIndex]);
    const sourcePath = frameImagePath(projectDir, objectName, animationName, sourceIndex, extension);
    if (await pathExists(sourcePath)) {
      await journal.copy(sourcePath, frameImagePath(projectDir, objectName, animationName, insertAt, extension));
      moved++;
    }
    return { moved, journal };
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
        // Animations in animation folders too: their image file names do not
        // contain the folder, so a new animation of the same name would write
        // its placeholder images over theirs
        const allAnims = everyAnimation<Animation>(obj.animations);

        // Check for a duplicate animation name in any animation folder. The editor
        // compares animation names ignoring case, and image file names are the
        // lowercased object and animation names, so a case variant would write its
        // placeholder images over the existing animation's images
        const nameClash = findNameClash(args.animationName, animationNames(allAnims));
        if (nameClash === args.animationName) {
          return toolError(`Animation "${args.animationName}" already exists on "${args.objectName}". Use update_animation_properties to modify it.`);
        }
        if (nameClash) {
          return toolError(animationCaseClashError(args.objectName, args.animationName, nameClash));
        }
        const nameError = animationNameFileError(args.animationName);
        if (nameError) return toolError(nameError);

        // Determine frame dimensions from existing animation if not specified
        let frameWidth = args.frameWidth ?? 100;
        let frameHeight = args.frameHeight ?? 100;
        if ((!args.frameWidth || !args.frameHeight) && allAnims.length > 0) {
          const existingFrames = Array.isArray(allAnims[0].frames) ? allAnims[0].frames : [];
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

        // Find the target animation (in any animation folder)
        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available animations: ${describeAvailableAnimations(obj.animations)}`);
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

        // The animation can be in an animation folder; it is removed from that folder
        const found = findAnimation<Animation>(obj.animations, args.animationName);
        if (!found) {
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${describeAvailableAnimations(obj.animations)}`);
        }

        if (everyAnimation(obj.animations).length <= 1) {
          return toolError(`Cannot delete the last animation on "${args.objectName}". A Sprite must have at least one animation.`);
        }

        found.items.splice(found.items.indexOf(found.animation), 1);

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
    'Rename an animation on a Sprite object, together with its frame image files and the "initial-animation" of layout instances that start with it',
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

        // On Windows and macOS the object file is found under a name that
        // differs in case, but layout instances and event sheets name the
        // object exactly, so they would be left naming the old animation
        if (typeof obj.name === 'string' && obj.name !== args.objectName) {
          return toolError(`Object "${args.objectName}" is named "${obj.name}" in the project. Object names are case-sensitive: `
            + `use objectName "${obj.name}". Nothing was changed.`);
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite. Only Sprite objects have animations.`);
        }

        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        // The animation can be in an animation folder, where it stays: its frame
        // image file names do not contain the folder
        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${describeAvailableAnimations(obj.animations)}`);
        }

        // Like the editor: another animation's name (in any animation folder, ignoring
        // case) is taken, changing the case of this one is fine (its lowercase image
        // file names stay the same)
        const others = everyAnimation<Animation>(obj.animations).filter(a => a !== anim);
        const nameClash = args.newName === anim.name ? anim.name : findNameClash(args.newName, animationNames(others));
        if (nameClash === args.newName) {
          return toolError(`Animation "${args.newName}" already exists on "${args.objectName}".`);
        }
        if (nameClash) {
          return toolError(animationCaseClashError(args.objectName, args.newName, nameClash));
        }

        // Construct 3 names the frame image files after the animation
        const nameError = animationNameFileError(args.newName);
        if (nameError) return toolError(nameError);

        // Frame image files, layout instances starting with this animation, and
        // event sheet strings naming it (see animation-rename.ts)
        const oldName = anim.name;
        const frames = Array.isArray(anim.frames) ? anim.frames : [];
        const sharing = animationsSharingImageFiles(obj.animations, anim);
        if (sharing.length > 0 && frames.length > 0) {
          return toolError(`Cannot rename "${oldName}" on "${args.objectName}": animation ${sharing.map(n => `"${n}"`).join(', ')} differs from it only in case, `
            + `so both use the same frame image files (images/${getImageFileName(args.objectName, oldName, 0, 'Sprite')}, …), and renaming them would leave `
            + `${sharing.length > 1 ? 'those animations' : 'that animation'} without images. Nothing was changed. `
            + 'Delete the duplicate first (delete_animation leaves the image files in place), then rename.');
        }
        const images = planFrameImageRenames(await writer.listImageFiles(), args.objectName, oldName, args.newName, frames);
        if (images.clashes.length > 0) {
          return toolError(`Cannot rename "${oldName}" to "${args.newName}" on "${args.objectName}": its frame images would be renamed to `
            + `${someOf(images.clashes.map(f => `images/${f}`), 5)}, which already exist(s). Nothing was changed. `
            + 'Renaming would overwrite them. Choose another name, or check these files and remove them if nothing uses them.');
        }
        const layoutRefs = [...(await reader.readAllLayouts())]
          .map(([name, layout]) => ({ name, count: renameInitialAnimation(layout, args.objectName, oldName) }))
          .filter(ref => ref.count > 0);
        // Only used for a warning: conditions and actions of the object and of
        // the families it belongs to that name the animation
        let families: string[] = [];
        try {
          families = familiesContaining(args.objectName, await reader.readAllFamilies());
        } catch {
          // Count the object's own parameters only
        }
        const objectClasses = [args.objectName, ...families];
        let sheetRefs: Array<{ name: string; count: number }> = [];
        try {
          sheetRefs = [...(await reader.readAllEventSheets())]
            .map(([name, sheet]) => ({ name, count: countAnimationNameParameters(sheet, objectClasses, oldName) }))
            .filter(ref => ref.count > 0);
        } catch {
          // Only used for a warning
        }

        anim.name = args.newName;
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);

        // Image files first (renamed back by the writer if one fails), then the
        // object and the layouts; a failure there rolls back everything before
        // it, including the file whose write failed if it was already replaced
        await writer.renameImageFiles(images.renames);
        // Journal the moves, so revert_last_change renames the files back too
        const imagePath = (name: string) => resolveProjectPath(reader.getProjectDir(), 'images', name);
        for (const r of images.renames) recordChange({ kind: 'move', path: imagePath(r.to), from: imagePath(r.from) });
        const written: WrittenEntity[] = [];
        // The file being written, named in the rollback message if its write fails
        let pending = entityFileLabel('objectTypes', args.objectName, subfolder);
        let backupPath: string;
        try {
          backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);
          written.push({ backup: backupPath, file: pending });
          for (const ref of layoutRefs) {
            const layout = await reader.readLayout(ref.name);
            renameInitialAnimation(layout, args.objectName, oldName, args.newName);
            const layoutSubfolder = writer.getSubfolderForEntity('layouts', ref.name);
            pending = entityFileLabel('layouts', ref.name, layoutSubfolder);
            written.push({ backup: await writer.writeEntityFile('layouts', ref.name, layout, layoutSubfolder), file: pending });
          }
        } catch (error) {
          if (error instanceof EntityWriteError) written.push({ backup: error.backupPath, file: pending });
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`${cause}. ${await rollBackAnimationRename(writer, written, images.renames, imagePath)}`);
        }

        const warnings: string[] = [];
        if (images.renames.length > 0) {
          const [first] = images.renames;
          warnings.push(`Renamed ${images.renames.length} frame image file(s) in images/ ("${first.from}" → "${first.to}"${images.renames.length > 1 ? ', …' : ''}).`);
        } else {
          // A change of case keeps the lowercase file names, and a frame whose
          // files already carry the new name (left by an earlier rename) is kept
          warnings.push(`No frame image files needed renaming under images/ for "${oldName}", so only the animation name changed.`);
        }
        if (images.missing.length > 0) {
          warnings.push(`No image file in images/ for ${images.missing.length} frame(s) of "${oldName}" (expected ${someOf(images.missing, 3)}); nothing was renamed for them.`);
        }
        if (layoutRefs.length > 0) {
          const count = layoutRefs.reduce((n, ref) => n + ref.count, 0);
          warnings.push(`Set "initial-animation" to "${args.newName}" on ${count} instance(s) of "${args.objectName}" in layout(s): ${layoutRefs.map(ref => ref.name).join(', ')}.`);
        }
        if (sheetRefs.length > 0) {
          const count = sheetRefs.reduce((n, ref) => n + ref.count, 0);
          const owners = families.length > 0
            ? `"${args.objectName}" and its families (${families.map(f => `"${f}"`).join(', ')})`
            : `"${args.objectName}"`;
          warnings.push(`${count} condition/action parameter(s) of ${owners} still name "${oldName}" as a string, in event sheet(s): `
            + `${sheetRefs.map(ref => ref.name).join(', ')}. rename_animation does not change expressions; update them if they should use "${args.newName}". `
            + 'Parameters that compute an animation name are not counted.');
        }

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

        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found. Available: ${describeAvailableAnimations(obj.animations)}`);
        }
        const nameError = animationNameFileError(anim.name, true);
        if (nameError) return toolError(nameError);

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
            reader.getProjectDir(), args.objectName, args.animationName, insertAt, anim.frames.length, journal, anim.frames,
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

        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found. Available: ${describeAvailableAnimations(obj.animations)}`);
        }
        // The later frames' image files are renamed, and their names contain the animation name
        const nameError = animationNameFileError(anim.name, true);
        if (nameError) return toolError(nameError);

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
          reader.getProjectDir(), args.objectName, args.animationName, args.frameIndex, anim.frames.length, journal, anim.frames,
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

        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found. Available: ${describeAvailableAnimations(obj.animations)}`);
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

        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found. Available: ${describeAvailableAnimations(obj.animations)}`);
        }
        const nameError = animationNameFileError(anim.name, true);
        if (nameError) return toolError(nameError);

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
        const { existed: imageExisted } = await backupOnce(filePath);
        await writeFile(filePath, pngBuffer);
        await recordWrite(filePath, imageExisted);

        // Update frame metadata if dimensions provided
        if (args.width !== undefined) frame.width = args.width;
        if (args.height !== undefined) frame.height = args.height;

        // The editor picks the image file's extension from the frame's fileType
        // (a JPEG frame's image is "<name>.jpg"), so a frame stored in another
        // format is switched to PNG; otherwise the editor keeps loading the old file
        const warnings = [`Image written to ${filePath}`];
        if (typeof frame.fileType === 'string' && frame.fileType !== 'image/png') {
          const oldFile = ` (images/${fileName.replace(/\.png$/, `.${frameExtension(frame)}`)})`;
          warnings.push(`Frame ${args.frameIndex} was stored as "${frame.fileType}"${oldFile}. Its fileType is now "image/png", so Construct 3 loads the new PNG; the old file is no longer used and was left in images/.`);
          frame.fileType = 'image/png';
        }

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

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
        const { existed: imageExisted } = await backupOnce(filePath);
        await writeFile(filePath, png);
        await recordWrite(filePath, imageExisted);

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

    const anim = findAnimation<Animation>(animations.root, animationName)?.animation;
    if (!anim) {
      return toolError(`Animation "${animationName}" not found on "${objectName}". Available: ${describeAvailableAnimations(animations.root)}`);
    }
    // The frame image files are renamed, and their names contain the animation name
    const nameError = animationNameFileError(anim.name, true);
    if (nameError) return toolError(nameError);

    const frames = anim.frames;
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

    const { moved, journal } = await reorderFrameImages(reader.getProjectDir(), objectName, animationName, resolved, frames);
    try {
      anim.frames = resolved.map(index => frames[index]);

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

        const anim = findAnimation<Animation>(animations.root, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${describeAvailableAnimations(animations.root)}`);
        }
        const nameError = animationNameFileError(anim.name, true);
        if (nameError) return toolError(nameError);

        const frames = anim.frames;
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
          reader.getProjectDir(), args.objectName, args.animationName, args.frameIndex, insertAt, frames.length, frames,
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

        const found = findAnimation<Animation>(animations.root, args.animationName);
        if (!found) {
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${describeAvailableAnimations(animations.root)}`);
        }
        // Where the animation is now, for the message. Whether it is at the animations
        // root is a question about the container that holds it, not about the joined
        // folder path: a folder with no name joins to an empty path too.
        const atRoot = found.items === animations.root.items;
        const fromLabel = atRoot ? 'the animations root'
          : found.folders.join('/') ? `"${found.folders.join('/')}"`
          : 'a folder with no name';

        const target = findAnimationFolder(animations.root, targetPath);
        if (!target) {
          return toolError(`Animation folder "${targetPath}" does not exist on "${args.objectName}". Create it with create_animation_folder first.`);
        }
        if (found.items === target.items) {
          const where = targetPath ? `folder "${targetPath}"` : 'the animations root';
          return toolError(`Animation "${args.animationName}" is already in ${where}.`);
        }

        found.items.splice(found.items.indexOf(found.animation), 1);
        target.items.push(found.animation);

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: [`Moved "${args.animationName}" from ${fromLabel} to ${targetPath ? `"${targetPath}"` : 'the animations root'}.`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[move_animation_to_folder] failed:', error);
        return toolError(`Error moving animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

function animationNames(anims: Animation[]): string[] {
  return anims.map(a => a.name).filter((n): n is string => typeof n === 'string');
}

/**
 * Error for an animation name that differs from another animation of the
 * sprite only in case. The editor compares animation names ignoring case, and
 * it names image files "<object>-<animation>-NNN" in lowercase, so both
 * animations would also use the same image files.
 */
function animationCaseClashError(objectName: string, requested: string, existing: string): string {
  const file = getImageFileName(objectName, requested, 0, 'Sprite');
  return `"${requested}" differs only in case from the existing animation "${existing}" on "${objectName}". `
    + 'Construct 3 treats animation names that differ only in case as the same name, and it names image files in lowercase '
    + `("images/${file}"), so both animations would use the same image files. Choose a different name.`;
}

/**
 * Why `animationName` cannot be used in frame image file names
 * (images/<object>-<animation>-NNN.png), or undefined when it can. With
 * `existing`, the message is for an animation that already has the name.
 */
function animationNameFileError(animationName: string, existing = false): string | undefined {
  const char = invalidImageNameCharacter(animationName);
  if (char === undefined) return undefined;
  const subject = existing ? `Animation "${animationName}"` : `The animation name "${animationName}"`;
  return `${subject} contains ${describeCharacter(char)}. Construct 3 names the frame image files after the animation `
    + '(images/<object>-<animation>-000.png), and a file name cannot contain a path separator (/ or \\) or a character '
    + 'Windows does not allow in file names (: * ? " < > | or a control character). '
    + (existing ? 'Rename the animation first (rename_animation). Nothing was changed.' : 'Choose another name.');
}

/**
 * An entity file rename_animation wrote: the backup its write returned, and
 * the file's project-relative path for messages (client-visible errors never
 * carry absolute paths).
 */
interface WrittenEntity {
  backup: string;
  file: string;
}

/** Project-relative path of an entity file, e.g. "layouts/Levels/Level 1.json". */
function entityFileLabel(category: string, name: string, subfolder: string | undefined): string {
  return `${category}/${subfolder ? `${subfolder}/` : ''}${name}.json`;
}

/** The first `max` items, quoted, and how many more there are. */
function someOf(items: string[], max: number): string {
  const shown = items.slice(0, max).map(item => `"${item}"`).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/**
 * Undo a rename_animation whose JSON writes failed part way: put back the
 * entity files written so far and the one whose write failed (it may have been
 * replaced; an unchanged file is left alone), from their backups, newest
 * first, then rename the image files back. Returns a sentence for the error
 * message.
 */
async function rollBackAnimationRename(
  writer: MutationToolDeps['writer'],
  written: WrittenEntity[],
  renames: ImageFileRename[],
  imagePath: (name: string) => string,
): Promise<string> {
  const failed: string[] = [];
  for (const { backup, file } of [...written].reverse()) {
    try {
      await writer.restoreEntityFile(backup);
    } catch {
      failed.push(file);
    }
  }
  try {
    await writer.renameImageFiles(renames.map(r => ({ from: r.to, to: r.from })));
    // Undone here, so the call's journal must not offer the moves again
    for (const r of renames) forgetChange(imagePath(r.to));
  } catch (error) {
    failed.push(`image files (${error instanceof Error ? error.message : String(error)})`);
  }
  return failed.length === 0
    ? 'The rename was rolled back: the image files have their old names again, and every JSON file it had written or started to write was restored from its backup.'
    : `Rolling back the rename failed for: ${failed.join('; ')}. Check these (the .bak files hold the previous JSON).`;
}
