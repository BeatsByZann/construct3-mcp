/**
 * Animation tools: add_animation_to_sprite, update_animation_properties,
 * delete_animation, create_animation_folder, move_animation_to_folder,
 * rename_animation, add_frame_to_animation, delete_frame_from_animation,
 * update_frame, replace_sprite_image.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectType, Animation, AnimationFrame, AnimationsContainer } from '../construct3/types.js';
import { toolResult, toolError, notFoundError, validateSubfolder } from './shared.js';
import { findNameClash, findFolderPathClash } from '../construct3/names.js';
import { createAnimation, createAnimationFrame } from '../construct3/templates.js';
import { describeCharacter, getImageFileName, invalidImageNameCharacter } from '../construct3/png-generator.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { EntityWriteError, failedWriteLeftReason, filesLeftClause } from '../construct3/project-writer.js';
import { StaleFileError } from '../construct3/disk-state.js';
import { fileErrorText } from '../construct3/fs-errors.js';
import {
  animationsSharingImageFiles,
  countAnimationNameParameters,
  describeAvailableAnimations,
  everyAnimation,
  familiesContaining,
  findAnimation,
  planFrameImageRenames,
  planFrameImageShift,
  renameInitialAnimation,
} from '../construct3/animation-rename.js';
import type { FrameImageShiftPlan, ImageFileRename } from '../construct3/animation-rename.js';
import {
  checkUnscannedFiles,
  describeUnscannedFile,
  unscannedFields,
  unscannedFilesOf,
  unscannedWarnings,
  type UnscannedFile,
  type UnscannedFileReport,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../construct3/raw-text-search.js';
import { withProjectSync } from './project-sync.js';

export function registerAnimationTools({ server: mcpServer, reader, writer, idGen }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);
  // Every animation tool reads a Sprite's object file and writes it back, and
  // several rename or write frame image files, whose names hold the frame
  // index: they run one at a time (see withAnimationLock)
  const oneAtATime = <A, R>(handler: (args: A) => Promise<R>) =>
    (args: A): Promise<R> => writer.withAnimationLock(() => handler(args));

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
    oneAtATime(async (args) => {
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
            width: 1,
            height: 1,
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
    }),
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
    oneAtATime(async (args) => {
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
    }),
  );

  // ─── delete_animation ─────────────────────────────────────

  server.tool(
    'delete_animation',
    'Delete an animation from a Sprite object (must not be the last animation)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name to delete'),
    },
    oneAtATime(async (args) => {
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
    }),
  );

  // ─── create_animation_folder ──────────────────────────────

  server.tool(
    'create_animation_folder',
    'Create an animation folder, and the folders above it, among a Sprite object\'s animations (e.g. "Combat/Melee"). The folder is not '
      + 'part of the frame image file names, so no image file changes. A folder whose name differs from a sibling folder only in case is refused',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      folderPath: z.string().min(1).max(500).describe('Animation folder path, "/"-separated (e.g. "Combat/Melee")'),
    },
    oneAtATime(async (args) => {
      const relative = (path: string) => writer.projectRelative(path);
      try {
        const invalid = invalidFolderPath(args.folderPath);
        if (invalid !== undefined) return toolError(`Error creating animation folder: ${invalid}. Nothing was changed.`);
        const sprite = await loadSpriteAnimations(reader, args.objectName, true);
        if (sprite.refusal !== undefined) return sprite.refusal;
        const { obj, animations } = sprite;
        const clash = findFolderPathClash(animations, args.folderPath);
        if (clash !== undefined) return toolError(animationFolderCaseClashError(args.objectName, args.folderPath, clash));

        // Each folder of the path that is not there yet, with the keys of a new project-bar folder (items, subfolders, name)
        const parts = args.folderPath.split('/');
        const created: string[] = [];
        let node: AnimationsContainer = animations;
        for (const [i, part] of parts.entries()) {
          const path = parts.slice(0, i + 1).join('/');
          let next = node.subfolders.find(folder => folder?.name === part);
          if (next === undefined) {
            next = { items: [], subfolders: [], name: part };
            node.subfolders.push(next);
            created.push(path);
          } else if (!Array.isArray(next.items) || !Array.isArray(next.subfolders)) {
            return toolError(`Animation folder "${path}" on "${args.objectName}" has no items or subfolders list. Nothing was changed.`);
          }
          node = next;
        }
        if (created.length === 0) {
          return toolError(`Animation folder "${args.folderPath}" already exists on "${args.objectName}". Nothing was changed.`);
        }

        const backupPath = await writeObjectOrRollBack(writer, args.objectName, obj);
        return toolResult({
          success: true, entity: args.objectName, category: 'object', action: 'updated', backupFile: backupPath, foldersCreated: created,
        });
      } catch (error) {
        console.error('[create_animation_folder] failed:', error);
        return toolError(`Error creating animation folder: ${fileErrorText(error, relative)}`);
      }
    }),
  );

  // ─── move_animation_to_folder ─────────────────────────────

  server.tool(
    'move_animation_to_folder',
    'Move an animation of a Sprite object to the end of an existing animation folder, or to the end of the top level of its animations '
      + '(folderPath left out, null or ""). The folder is not part of the frame image file names, so no image file changes',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation to move'),
      folderPath: z.string().max(500).nullable().optional()
        .describe('Existing animation folder path, "/"-separated; left out, null or "" for the top level'),
    },
    oneAtATime(async (args) => {
      const relative = (path: string) => writer.projectRelative(path);
      try {
        const targetPath = args.folderPath ?? '';
        const invalid = targetPath === '' ? undefined : invalidFolderPath(targetPath);
        if (invalid !== undefined) return toolError(`Error moving animation: ${invalid}. Nothing was changed.`);
        const sprite = await loadSpriteAnimations(reader, args.objectName, false);
        if (sprite.refusal !== undefined) return sprite.refusal;
        const { obj, animations } = sprite;
        const found = findAnimation<Animation>(animations, args.animationName);
        if (!found) {
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${describeAvailableAnimations(animations)}. Nothing was changed.`);
        }
        const target = findAnimationFolder(animations, targetPath);
        if (target === undefined || !Array.isArray(target.items)) {
          const clash = findFolderPathClash(animations, targetPath);
          const variant = clash === undefined ? undefined : existingCaseVariantFolder(animations, targetPath, clash);
          return toolError(variant !== undefined
            ? `Animation folder "${targetPath}" does not exist on "${args.objectName}"; "${variant.existing}" exists, whose name differs only in case from "${variant.requested}". Nothing was changed.`
            : `Animation folder "${targetPath}" does not exist on "${args.objectName}". Create it with create_animation_folder first. Nothing was changed.`);
        }
        const where = (path: string) => (path === '' ? 'the top level of the animations' : `animation folder "${path}"`);
        if (found.items === target.items) {
          return toolError(`Animation "${found.animation.name}" is already in ${where(targetPath)}. Nothing was changed.`);
        }
        const fromTop = found.items === animations.items;
        const fromPath = fromTop ? '' : found.folders.join('/');

        found.items.splice(found.items.indexOf(found.animation), 1);
        target.items.push(found.animation);
        const warnings = fromTop && animations.items.length === 0
          ? [`"${found.animation.name}" was the last animation outside animation folders: the top level of the animations of "${args.objectName}" now has none.`]
          : undefined;

        const backupPath = await writeObjectOrRollBack(writer, args.objectName, obj);
        return toolResult({
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          fromFolder: fromPath === '' ? null : fromPath,
          toFolder: targetPath === '' ? null : targetPath,
          warnings,
        });
      } catch (error) {
        console.error('[move_animation_to_folder] failed:', error);
        return toolError(`Error moving animation: ${fileErrorText(error, relative)}`);
      }
    }),
  );

  // ─── rename_animation ─────────────────────────────────────

  server.tool(
    'rename_animation',
    'Rename an animation on a Sprite object, together with its frame image files and the "initial-animation" of layout instances that start with it. Layouts that could not be parsed (over the 10MB read limit, not valid JSON) cannot be updated: one whose text names the object and the animation (possibly instances that start with it), or that cannot be read at all, refuses the rename without force (update_blocked); with force the rename goes ahead and a warning names them. Event sheets that could not be parsed and possibly name the animation only get a warning. Such files are listed in unscannedFiles',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Current animation name'),
      newName: z.string().min(1).max(200).describe('New animation name'),
      force: z.boolean().optional().default(false).describe('If true, rename even when layouts that could not be parsed possibly have instances that start with the animation (they are NOT updated)'),
    },
    oneAtATime(async (args) => {
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
            + 'Choose another name, or check these files and remove them if nothing uses them.');
        }
        const allLayouts = await reader.readAllLayouts();
        const layoutFailures = reader.getReadFailures('layouts');
        const layoutRefs = [...allLayouts]
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
        let skippedSheets: UnscannedFile[] = [];
        try {
          const sheets = await reader.readAllEventSheets();
          const sheetFailures = reader.getReadFailures('eventSheets');
          sheetRefs = [...sheets]
            .map(([name, sheet]) => ({ name, count: countAnimationNameParameters(sheet, objectClasses, oldName) }))
            .filter(ref => ref.count > 0);
          skippedSheets = unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, sheetFailures);
        } catch {
          // Only used for a warning
        }
        // Layouts and event sheets that could not be parsed: their instances are not
        // updated and their parameters not counted, so search their text (issue #55)
        const layoutSearch = await checkUnscannedFiles(
          reader,
          unscannedFilesOf('layouts', await reader.listLayouts(), allLayouts, layoutFailures),
          [{ categories: ['layouts'], allOf: [[nameTerm(args.objectName)], [nameTerm(oldName)]] }],
        );
        const sheetSearch = await checkUnscannedFiles(reader, skippedSheets, [
          { categories: ['eventSheets'], allOf: [objectClasses.map(n => nameTerm(n)), [nameTerm(oldName)]] },
        ]);
        // Instances there that start with the animation would be left naming one that no longer exists
        if (!args.force && layoutSearch.some(r => r.textSearch === 'possible-use' || r.textSearch === 'unreadable')) {
          return toolResult({
            success: false,
            entity: args.objectName,
            category: 'object',
            action: 'update_blocked',
            message: `${renameLayoutRefusal(layoutSearch, args.objectName, oldName)} Nothing was changed. ` +
              'Use force=true to rename anyway (instances in these layouts will NOT be updated).',
            ...unscannedFields([...layoutSearch, ...sheetSearch]),
          });
        }

        anim.name = args.newName;
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);

        // Image files first (renamed back by the writer if one fails), then the
        // object and the layouts; a failure there rolls back everything before
        // it (rollBackAnimationRename), except a file changed on disk after the
        // call wrote it, which is left as it is and named. A write refused because
        // its file changed on disk during the call (StaleFileError) has had the
        // writer put back the files already, so only the image renames are undone
        await writer.renameImageFiles(images.renames);
        let writing = reader.getEntityRelativePath('objectTypes', args.objectName);
        let backupPath: string;
        try {
          backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);
          for (const ref of layoutRefs) {
            const layout = await reader.readLayout(ref.name);
            renameInitialAnimation(layout, args.objectName, oldName, args.newName);
            writing = reader.getEntityRelativePath('layouts', ref.name);
            await writer.writeEntityFile('layouts', ref.name, layout, writer.getSubfolderForEntity('layouts', ref.name));
          }
        } catch (error) {
          // A refusal of the writer ends with a full stop already
          const cause = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
          throw new Error(`${cause}. ${await rollBackAnimationRename(writer, error, writing, images.renames)}`.trimEnd());
        }

        const warnings: string[] = [];
        if (images.renames.length > 0) {
          const [first] = images.renames;
          warnings.push(`Renamed ${images.renames.length} frame image file(s) in images/ ("${first.from}" → "${first.to}"${images.renames.length > 1 ? ', …' : ''}).`);
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
        warnings.push(...renameUnscannedWarnings(layoutSearch, sheetSearch, args.objectName, oldName));

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
          ...unscannedFields([...layoutSearch, ...sheetSearch]),
        };
        return toolResult(result);
      } catch (error) {
        console.error('[rename_animation] failed:', error);
        return toolError(`Error renaming animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── add_frame_to_animation ───────────────────────────────

  server.tool(
    'add_frame_to_animation',
    'Add a new blank frame (placeholder PNG) to a Sprite animation, at an index or at the end. The image files of the frames '
      + 'after the index move one index up with their frames; an unused file in the way is kept as .bak',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      index: z.number().int().min(0).optional().describe('Insert at this frame index, 0 to the frame count (default: append)'),
      width: z.number().int().positive().optional().describe('Frame width in pixels (default: matches first frame)'),
      height: z.number().int().positive().optional().describe('Frame height in pixels (default: matches first frame)'),
      duration: z.number().positive().optional().default(1).describe('Frame duration in seconds (default: 1)'),
    },
    oneAtATime(async (args) => {
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

        const frameCount = anim.frames.length;
        const insertAt = args.index ?? frameCount;
        if (insertAt > frameCount) {
          return toolError(`Frame index ${insertAt} is out of range. Animation "${anim.name}" has ${frameCount} frame(s): `
            + `insert at an index from 0 to ${frameCount}, or leave index out to append. Nothing was changed.`);
        }

        // Frame image files are named by frame index: the images of the frames
        // from insertAt on move one index up (see animation-rename.ts)
        const imageObjectName = storedObjectName(obj, args.objectName);
        const images = planFrameImageShift(await writer.listImageFiles(), imageObjectName, anim.name, anim.frames, { insertAt });
        if (images.clashes.length > 0) {
          return toolError(`Cannot add a frame at index ${insertAt} to "${anim.name}" on "${args.objectName}": the frame image files `
            + `after it cannot be renamed one index up (${someOf(images.clashes, 3)}). Nothing was changed. Check these files in images/.`);
        }

        // Infer dimensions from first existing frame
        const frameWidth = args.width ?? (anim.frames[0]?.width ?? 100);
        const frameHeight = args.height ?? (anim.frames[0]?.height ?? 100);

        const imageSpriteId = await idGen.generateImageSpriteId(reader);

        const newFrame: AnimationFrame = {
          ...createAnimationFrame(frameWidth, frameHeight, imageSpriteId),
          duration: args.duration,
        };
        anim.frames.splice(insertAt, 0, newFrame);
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);

        // Image files first (renamed back by the writer if one fails), then the
        // placeholder PNG in the freed name, then the object; a failure there
        // undoes everything before it
        if (images.renames.length > 0) await writer.renameImageFiles(images.renames);
        let backupPath: string;
        let otherWrite = false;
        try {
          await writer.writeImageFiles([{
            objectName: imageObjectName,
            animationName: anim.name,
            frameIndex: insertAt,
            pluginId: 'Sprite',
            width: 1,
            height: 1,
          }]);
          backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);
        } catch (error) {
          const kept = await frameChangeAfterOtherWrite(reader, args.objectName, anim.name, error,
            frames => frames.length === frameCount + 1 && frames[insertAt]?.imageSpriteId === imageSpriteId);
          if (kept !== true) {
            // A refusal of the writer ends with a full stop already
            const cause = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
            throw new Error(`${cause}. ${await rollBackFrameChange(writer, error, images.renames, {
              newFrameFile: images.newFrameFile, kept,
            })}`);
          }
          backupPath = (error as EntityWriteError).backupPath;
          otherWrite = true;
        }

        const warnings = frameImageWarnings(images, anim.name);
        if (otherWrite) warnings.push(otherWriteKeptWarning('the new frame'));
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
        console.error('[add_frame_to_animation] failed:', error);
        return toolError(`Error adding frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── delete_frame_from_animation ─────────────────────────

  server.tool(
    'delete_frame_from_animation',
    'Delete a frame from a Sprite animation by index (must not be the last frame). Its image file is kept as .bak, and the '
      + 'image files of the frames after it move one index down',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based frame index to delete'),
    },
    oneAtATime(async (args) => {
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

        if (args.frameIndex >= anim.frames.length) {
          return toolError(`Frame index ${args.frameIndex} is out of range. Animation "${args.animationName}" has ${anim.frames.length} frame(s) (indices 0–${anim.frames.length - 1}).`);
        }

        if (anim.frames.length <= 1) {
          return toolError(`Cannot delete the last frame of animation "${args.animationName}". An animation must have at least one frame.`);
        }

        // Frame image files are named by frame index: the deleted frame's image
        // is kept as .bak, the images of the frames after it move one index
        // down (see animation-rename.ts)
        const images = planFrameImageShift(
          await writer.listImageFiles(), storedObjectName(obj, args.objectName), anim.name, anim.frames, { deleteAt: args.frameIndex },
        );
        if (images.clashes.length > 0) {
          return toolError(`Cannot delete frame ${args.frameIndex} of "${anim.name}" on "${args.objectName}": the frame image files `
            + `after it cannot be renamed one index down (${someOf(images.clashes, 3)}). Nothing was changed. Check these files in images/.`);
        }

        const frameCount = anim.frames.length;
        const deletedId = anim.frames[args.frameIndex]?.imageSpriteId;
        anim.frames.splice(args.frameIndex, 1);
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);

        // Image files first (renamed back by the writer if one fails), then the
        // object; a failure there renames the image files back
        if (images.renames.length > 0) await writer.renameImageFiles(images.renames);
        let backupPath: string;
        let otherWrite = false;
        try {
          backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);
        } catch (error) {
          const kept = await frameChangeAfterOtherWrite(reader, args.objectName, anim.name, error,
            frames => frames.length === frameCount - 1
              && (deletedId === undefined || !frames.some(frame => frame?.imageSpriteId === deletedId)));
          if (kept !== true) {
            // A refusal of the writer ends with a full stop already
            const cause = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
            throw new Error(`${cause}. ${await rollBackFrameChange(writer, error, images.renames, { kept })}`);
          }
          backupPath = (error as EntityWriteError).backupPath;
          otherWrite = true;
        }

        const warnings = frameImageWarnings(images, anim.name);
        if (otherWrite) warnings.push(otherWriteKeptWarning('the frame deletion'));
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
        console.error('[delete_frame_from_animation] failed:', error);
        return toolError(`Error deleting frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── update_frame ─────────────────────────────────────────

  server.tool(
    'update_frame',
    'Update per-frame properties of a Sprite animation frame (duration, dimensions, origin)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based frame index'),
      width: z.number().int().positive().optional().describe('New frame width in pixels'),
      height: z.number().int().positive().optional().describe('New frame height in pixels'),
      duration: z.number().positive().optional().describe('New frame duration in seconds'),
      originX: z.number().min(0).max(1).optional().describe('Horizontal origin 0-1 (0.5 = center)'),
      originY: z.number().min(0).max(1).optional().describe('Vertical origin 0-1 (0.5 = center)'),
    },
    oneAtATime(async (args) => {
      try {
        const hasUpdates = args.width !== undefined || args.height !== undefined ||
          args.duration !== undefined || args.originX !== undefined || args.originY !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: width, height, duration, originX, originY.');
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
        if (args.width !== undefined) frame.width = args.width;
        if (args.height !== undefined) frame.height = args.height;
        if (args.duration !== undefined) frame.duration = args.duration;
        if (args.originX !== undefined) frame.originX = args.originX;
        if (args.originY !== undefined) frame.originY = args.originY;

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
        console.error('[update_frame] failed:', error);
        return toolError(`Error updating frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
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
    oneAtATime(async (args) => {
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

        const fileName = getImageFileName(storedObjectName(obj, args.objectName), args.animationName, args.frameIndex, 'Sprite');
        const filePath = resolveProjectPath(reader.getProjectDir(), 'images', fileName);

        // Through the writer: the old image is kept under a free .bak name, once per call
        await writer.replaceFile(filePath, pngBuffer);

        // Update frame metadata if dimensions provided
        if (args.width !== undefined) frame.width = args.width;
        if (args.height !== undefined) frame.height = args.height;

        // The editor picks the image file's extension from the frame's fileType
        // (a JPEG frame's image is "<name>.jpg"), so a frame stored in another
        // format is switched to PNG; otherwise the editor keeps loading the old file
        const warnings = [`Image written to ${filePath}`];
        if (typeof frame.fileType === 'string' && frame.fileType !== 'image/png') {
          const oldFile = frame.fileType === 'image/jpeg' ? ` (images/${fileName.replace(/\.png$/, '.jpg')})` : '';
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
    }),
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
 * The Sprite object `objectName` and its animations container, or the
 * refusal to return from the tool (the object is not found, is not a Sprite,
 * or has no animations structure); a refusal changed nothing. With
 * `folderList`, the container and its folders must have lists of
 * subfolders, as a tool that adds a folder needs.
 */
async function loadSpriteAnimations(
  reader: MutationToolDeps['reader'],
  objectName: string,
  folderList: boolean,
): Promise<{ obj: ObjectType; animations: AnimationsContainer; refusal?: undefined } | { refusal: ReturnType<typeof toolError> }> {
  let obj: ObjectType;
  try {
    obj = await reader.readObjectType(objectName);
  } catch {
    return { refusal: notFoundError('Object', objectName, reader.findNearestName(objectName, 'objects'), 'list_objects') };
  }
  if (obj['plugin-id'] !== 'Sprite') {
    return { refusal: toolError(`Object "${objectName}" is not a Sprite. Only Sprite objects have animations. Nothing was changed.`) };
  }
  const animations = obj.animations;
  if (!animations || !Array.isArray(animations.items) || (folderList && !Array.isArray(animations.subfolders))) {
    return { refusal: toolError(`Object "${objectName}" has no animations structure${folderList ? ' with a folder list' : ''}. Nothing was changed.`) };
  }
  return { obj, animations };
}

/**
 * Write the Sprite object `obj` and return the path of its backup. When the
 * write fails, throws an Error whose message names the cause (an fs error by
 * its code and project-relative path) and what happened to the object file
 * (rollBackObjectWrite).
 */
async function writeObjectOrRollBack(writer: MutationToolDeps['writer'], objectName: string, obj: ObjectType): Promise<string> {
  const subfolder = writer.getSubfolderForEntity('objectTypes', objectName);
  try {
    return await writer.writeEntityFile('objectTypes', objectName, obj, subfolder);
  } catch (error) {
    const cause = fileErrorText(error, path => writer.projectRelative(path)).replace(/\.$/, '');
    throw new Error(`${cause}. ${await rollBackObjectWrite(writer, error)}`);
  }
}

/**
 * The animation folder at `path` ("/"-separated folder names, compared
 * exactly) among a Sprite's animations, or undefined when there is none.
 * An empty path is the animations container itself (the top level).
 */
function findAnimationFolder(animations: AnimationsContainer, path: string): AnimationsContainer | undefined {
  let node: AnimationsContainer = animations;
  for (const part of path === '' ? [] : path.split('/')) {
    const next: AnimationsContainer | undefined = Array.isArray(node.subfolders)
      ? node.subfolders.find(folder => folder?.name === part)
      : undefined;
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

/** Why `path` is not a valid animation folder path (the message of validateSubfolder), or undefined when it is. */
function invalidFolderPath(path: string): string | undefined {
  try {
    validateSubfolder(path);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The part of the requested folder path `requested` that exists on the
 * Sprite only in another spelling: `spelled` is the path as
 * findFolderPathClash gives it, which holds an invariant this relies on: it
 * spells every leading folder that exists (in any letter case) as the
 * existing folder is, and every folder from the first one that does not
 * exist on as requested. Returns the longest leading part of it that is an existing
 * folder (`existing`) and the same part as requested (`requested`), or
 * undefined when no leading part exists. A folder below that part is not
 * claimed.
 */
function existingCaseVariantFolder(
  animations: AnimationsContainer,
  requested: string,
  spelled: string,
): { existing: string; requested: string } | undefined {
  const spelledParts = spelled.split('/');
  for (let count = spelledParts.length; count > 0; count--) {
    const existing = spelledParts.slice(0, count).join('/');
    if (findAnimationFolder(animations, existing) !== undefined) {
      return { existing, requested: requested.split('/').slice(0, count).join('/') };
    }
  }
  return undefined;
}

/**
 * Error for an animation folder path with a folder that differs from an
 * existing sibling folder only in case (findFolderPathClash). The rule is
 * the server's, as for project-bar folders; how the editor compares
 * animation folder names was not checked.
 */
function animationFolderCaseClashError(objectName: string, requested: string, existing: string): string {
  return `Animation folder path "${requested}" has a folder whose name differs only in case from an existing animation folder on "${objectName}" `
    + `(spelled as the existing folders are: "${existing}"): the server compares animation folder names ignoring case, as it does `
    + `project-bar folders. Use "${existing}". Nothing was changed.`;
}

/**
 * The sentence for the error of an animation tool whose one object file
 * write failed (`error`): a write refused before it replaced the file
 * changed nothing; one that failed after (EntityWriteError) is restored
 * from its backup while the file holds that write's own content, and left
 * as it is when another write replaced it during this one or changed it
 * after.
 */
async function rollBackObjectWrite(writer: MutationToolDeps['writer'], error: unknown): Promise<string> {
  if (!(error instanceof EntityWriteError)) return 'Nothing was changed.';
  if (error.changedByOtherWrite) {
    return 'Another write replaced the object file during this one (a tool call running in parallel?); it was left as that write left it: '
      + 're-read the object to check it.';
  }
  const label = writer.projectRelative(error.backupPath.replace(/\.bak$/, ''));
  try {
    const { restored, reason } = await writer.restoreFailedWrite(error);
    return restored
      ? `The change was rolled back: ${label} was restored from its backup (its .bak stays).`
      : `${label} was left as it is, since ${failedWriteLeftReason(reason)}; ${label}.bak holds the previous JSON.`;
  } catch {
    return `Restoring ${label} from its backup failed; ${label}.bak holds the previous JSON.`;
  }
}

/** The first `max` items, quoted, and how many more there are. */
function someOf(items: string[], max: number): string {
  const shown = items.slice(0, max).map(item => `"${item}"`).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/**
 * Warnings about the image files an add_frame_to_animation or
 * delete_frame_from_animation renamed (see planFrameImageShift).
 */
function frameImageWarnings(images: FrameImageShiftPlan, animationName: string): string[] {
  const warnings: string[] = [];
  const list = (renames: ImageFileRename[]) => {
    const shown = renames.slice(0, 3).map(r => `"images/${r.from}" → "images/${r.to}"`).join(', ');
    return renames.length > 3 ? `${shown} and ${renames.length - 3} more` : shown;
  };
  if (images.shifted.length > 0) {
    const [first] = images.shifted;
    const direction = images.newFrameFile !== undefined ? 'up' : 'down';
    warnings.push(`Renamed ${images.shifted.length} frame image file(s) in images/ one index ${direction}, with their frames `
      + `("${first.from}" → "${first.to}"${images.shifted.length > 1 ? ', …' : ''}).`);
  }
  if (images.parked.length > 0) {
    warnings.push(`The deleted frame's image was kept as a backup: ${list(images.parked)}. No frame uses it; delete it when it is no longer needed.`);
  }
  if (images.backedUp.length > 0) {
    warnings.push(`${images.backedUp.length} file(s) in images/ had the name a frame image needed, but no frame used them (e.g. images a `
      + `deleted frame left behind); they were renamed instead of being replaced: ${list(images.backedUp)}.`);
  }
  if (images.missing.length > 0) {
    warnings.push(`No image file in images/ for ${images.missing.length} frame(s) of "${animationName}" after the changed index `
      + `(expected ${someOf(images.missing, 3)}); nothing was renamed for them.`);
  }
  return warnings;
}

/**
 * The object's name as stored in its file, which the editor names its frame
 * image files after, or `requested` (the objectName a tool was called with)
 * when the file has none. They differ when `requested` reaches the file by
 * another path (e.g. "./Sprite") or in another case.
 */
function storedObjectName(obj: ObjectType, requested: string): string {
  return typeof obj.name === 'string' && obj.name !== '' ? obj.name : requested;
}

/**
 * For an add_frame_to_animation or delete_frame_from_animation whose object
 * write failed because another write to the object file landed during it (the
 * post-write check found other valid JSON there, see
 * EntityWriteError.changedByOtherWrite): whether the file now has this call's
 * frame change, `hasChange` telling from the animation's frames, i.e. the
 * other write was made on top of it. undefined for any other failure and when
 * the file cannot be read; the change is then rolled back as usual.
 */
async function frameChangeAfterOtherWrite(
  reader: MutationToolDeps['reader'],
  objectName: string,
  animationName: string,
  error: unknown,
  hasChange: (frames: ReadonlyArray<{ imageSpriteId?: unknown } | null | undefined>) => boolean,
): Promise<boolean | undefined> {
  if (!(error instanceof EntityWriteError) || !error.changedByOtherWrite) return undefined;
  try {
    const current = await reader.readObjectType(objectName);
    const anim = findAnimation<{ frames?: unknown }>(current.animations, animationName)?.animation;
    return anim !== undefined && Array.isArray(anim.frames) && hasChange(anim.frames);
  } catch {
    return undefined;
  }
}

/** Warning for a frame change that another write kept (frameChangeAfterOtherWrite). */
function otherWriteKeptWarning(change: string): string {
  return `Another write changed the object file right after this one (a tool call running in parallel?). The file still has ${change}, `
    + 'so the image files stay as renamed, but the other write may have been made on older content: re-read the object to check it.';
}

/**
 * Undo an add_frame_to_animation or delete_frame_from_animation whose writes
 * after the image renames failed: put back the object file from its backup
 * when its write failed after replacing it and the file still holds that
 * write's own content (restoreFailedWrite), remove the new frame's
 * placeholder image (`newFrameFile`), then rename the image files back, last
 * first. The placeholder's name was free before the call (see
 * planFrameImageShift), so a file there, also one a failed write left part
 * written, is removed. When another write replaced the object file during
 * this one (EntityWriteError.changedByOtherWrite), the file is left as that
 * write left it, never restored over, and the image files are renamed back to
 * match the object as it was: `kept` (frameChangeAfterOtherWrite) false says
 * that write lacks this call's change, undefined that the file could not be
 * read again to tell. Returns a sentence for the error message.
 */
async function rollBackFrameChange(
  writer: MutationToolDeps['writer'],
  error: unknown,
  renames: ImageFileRename[],
  options: { newFrameFile?: string; kept?: boolean } = {},
): Promise<string> {
  const failed: string[] = [];
  const otherWrite = error instanceof EntityWriteError && error.changedByOtherWrite;
  const restore = error instanceof EntityWriteError && !otherWrite;
  let restoredFile = false;
  if (restore) {
    try {
      const { restored, label, reason } = await writer.restoreFailedWrite(error);
      if (restored) restoredFile = true;
      else failed.push(`${label} (${failedWriteLeftReason(reason)}; it was left as it is)`);
    } catch {
      failed.push(writer.projectRelative(error.backupPath.replace(/\.bak$/, '')));
    }
  }
  let placeholderRemoved = false;
  if (options.newFrameFile !== undefined) {
    try {
      placeholderRemoved = await writer.deleteImageFile(options.newFrameFile);
    } catch {
      failed.push(`images/${options.newFrameFile}`);
    }
  }
  if (renames.length > 0) {
    try {
      await writer.renameImageFiles(renames.map(r => ({ from: r.to, to: r.from })).reverse());
    } catch (e) {
      failed.push(`image files (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const unchecked = otherWrite && options.kept !== false;
  const otherWriteNote = !otherWrite ? '' : unchecked
    ? 'Another write replaced the object file during this one (a tool call running in parallel?), and the file could not be read again '
      + 'to tell whether it kept this call\'s change; it was left as that write left it: re-read the object to check its frames. '
    : 'Another write replaced the object file during this one (a tool call running in parallel?) without this call\'s change; '
      + 'the object file was left as that write left it. ';
  if (failed.length > 0) {
    return `${otherWriteNote}Rolling back failed for: ${failed.join('; ')}. Check these (the .bak file holds the previous object JSON).`;
  }
  const undone = [
    ...(renames.length > 0 ? ['the image files have their old names again'] : []),
    ...(placeholderRemoved ? ['the placeholder image was removed'] : []),
    ...(restoredFile ? ['the object file was restored from its backup'] : []),
  ];
  const nothing = unchecked ? 'The rest was rolled back' : 'Nothing was changed';
  return otherWriteNote + (undone.length === 0
    ? `${nothing}.`
    : `${nothing}: ${undone.slice(0, -1).join(', ')}${undone.length > 1 ? ' and ' : ''}${undone[undone.length - 1]}.`);
}

/**
 * Undo a rename_animation whose object or layout write failed (`error`, for
 * the file `failedFile`), and return sentences for the error message. After a
 * write refused as stale (StaleFileError) the writer has put back the files
 * the call wrote, or named those it had to leave, in the refusal already;
 * otherwise the writer puts them back now (undoToolCall), leaving a file
 * saved in the editor after the call wrote it as it is. The file whose write
 * failed is not among them: it is restored from its backup when the write
 * may have replaced it (EntityWriteError), unless another write replaced it
 * during this one (changedByOtherWrite) or after it failed
 * (restoreFailedWrite finds other content or cannot read the file), such as
 * a save in the editor, which is kept. Last, the frame image files, which
 * the writer does not track, are renamed back.
 */
async function rollBackAnimationRename(
  writer: MutationToolDeps['writer'],
  error: unknown,
  failedFile: string,
  renames: ImageFileRename[],
): Promise<string> {
  const renameBack = async (): Promise<string | undefined> => {
    if (renames.length === 0) return undefined;
    try {
      await writer.renameImageFiles(renames.map(r => ({ from: r.to, to: r.from })).reverse());
      return undefined;
    } catch (e) {
      return `renaming its frame image files back failed (${e instanceof Error ? e.message : String(e)}); rename them back by hand: `
        + renames.map(r => `"images/${r.to}" → "images/${r.from}"`).join(', ');
    }
  };

  if (error instanceof StaleFileError) {
    const imagesFailed = await renameBack();
    if (imagesFailed !== undefined) return `${imagesFailed[0].toUpperCase()}${imagesFailed.slice(1)}.`;
    return renames.length > 0 ? 'Its frame image files have their old names again.' : '';
  }

  const done: string[] = [];
  const problems: string[] = [];
  let otherWrite = '';
  if (error instanceof EntityWriteError) {
    if (error.changedByOtherWrite) {
      otherWrite = `${failedFile} was left as that write left it. `;
    } else {
      try {
        const { restored, reason } = await writer.restoreFailedWrite(error);
        if (restored) done.push(`${failedFile} was restored from its backup`);
        else problems.push(`${failedFile} was left as it is, since ${failedWriteLeftReason(reason)} (${failedFile}.bak holds the previous JSON)`);
      } catch {
        problems.push(`restoring ${failedFile} from its backup failed (${failedFile}.bak holds the previous JSON)`);
      }
    }
  }
  const undo = await writer.undoToolCall();
  const imagesFailed = await renameBack();
  if (imagesFailed !== undefined) problems.push(imagesFailed);
  else if (renames.length > 0) done.unshift('its frame image files have their old names again');
  if (undo.restored.length > 0) done.push(`put back as they were before the call: ${undo.restored.join(', ')}`);
  if (undo.left.length > 0) problems.push(filesLeftClause(undo.left));

  if (problems.length === 0) {
    return done.length === 0 ? `${otherWrite}Nothing was changed.` : `${otherWrite}The rename was rolled back: ${done.join('; ')}.`;
  }
  return `${otherWrite}The rename was rolled back only in part: ${[...done, ...problems].join('; ')}. `
    + 'Check the project (validate_project, git diff) before you run the tool again.';
}

/**
 * Why rename_animation refuses without force: layouts it could not parse
 * whose text names the object and the old animation name (possibly instances
 * that start with it, which it cannot update), or that it could not search.
 */
function renameLayoutRefusal(layouts: UnscannedFileReport[], objectName: string, oldName: string): string {
  const possible = layouts.filter(r => r.textSearch === 'possible-use');
  const unreadable = layouts.filter(r => r.textSearch === 'unreadable');
  const sentences: string[] = [];
  if (possible.length > 0) {
    sentences.push(`Layouts that could not be parsed possibly have instances of "${objectName}" that start with "${oldName}", ` +
      `which the rename cannot update: ${possible.map(describeUnscannedFile).join(', ')}, whose text names "${objectName}" and ` +
      `"${oldName}" (a text search cannot tell an instance from the same names in other strings).`);
  }
  if (unreadable.length > 0) {
    sentences.push(`Layouts that could not be parsed could not be searched for such instances either: ${unreadable.map(describeUnscannedFile).join(', ')}.`);
  }
  return sentences.join(' ');
}

/**
 * The warnings of rename_animation for layouts and event sheets it could not
 * parse (searched as text for the object and the old animation name): layout
 * instances there that may still start with the old name were not updated
 * (it only gets here for those with force), and parameters there were not
 * counted (like the parameters it counts, only a warning).
 */
function renameUnscannedWarnings(
  layouts: UnscannedFileReport[], sheets: UnscannedFileReport[], objectName: string, oldName: string,
): string[] {
  const warnings: string[] = [];
  for (const r of layouts) {
    if (r.textSearch === 'possible-use') {
      warnings.push(`Renamed with force=true: ${describeUnscannedFile(r)} could not be parsed, and its text names "${objectName}" and "${oldName}": instances of `
        + `"${objectName}" there possibly still start with "${oldName}" and were NOT updated. Check them in the Construct 3 editor.`);
    } else if (r.textSearch === 'unreadable') {
      warnings.push(`Renamed with force=true: ${describeUnscannedFile(r)}: instances of "${objectName}" there that start with "${oldName}" could not be `
        + 'checked and were NOT updated.');
    }
  }
  const sheetHits = sheets.filter(r => r.textSearch !== 'no-match');
  if (sheetHits.length > 0) {
    warnings.push(`Event sheet(s) that could not be parsed possibly name "${oldName}" too (not counted above): `
      + `${sheetHits.map(describeUnscannedFile).join(', ')}.`);
  }
  warnings.push(...unscannedWarnings([...layouts, ...sheets].filter(r => r.textSearch === 'no-match'), 'Renamed'));
  return warnings;
}
