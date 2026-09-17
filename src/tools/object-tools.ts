/**
 * Object type tools: create_object, update_object_properties, delete_object,
 * create_family, update_family, reorder_behaviors, delete_family.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectType, Instance, Layer, Layout } from '../construct3/types.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import { validateName, validateSubfolder, toolResult, toolError, notFoundError, orphanedFileError, boundedRecord } from './shared.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  DEFAULT_OBJECT_IMAGE_SIZE,
  GLOBAL_PLUGINS,
  NONWORLD_GLOBAL_PLUGINS,
  SINGLE_IMAGE_PLUGINS,
  ANIMATION_PLUGINS,
  createSpriteObject,
  createTextObject,
  createTiledBgObject,
  createGlobalObject,
  createGenericObject,
  createInstanceVariable,
  createBehavior,
  KNOWN_SCIRRA_BEHAVIORS,
} from '../construct3/templates.js';

export function registerObjectTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_object ──────────────────────────────────────────

  server.tool(
    'create_object',
    'Create a new object type in the Construct3 project',
    {
      name: z.string().max(200).describe('Object name (must be unique, alphanumeric + underscore)'),
      pluginId: z.string().max(100).describe('Plugin ID — "Sprite", "Text", "TiledBg", "NinePatch", "Audio", etc.'),
      isGlobal: z.boolean().optional().default(false).describe('Whether object is global (auto-detected for known global plugins)'),
      subfolder: z.string().max(500).optional().describe('Subfolder path in project (e.g., "UI/Buttons")'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Check uniqueness
        const existing = await reader.listObjectTypes();
        if (existing.includes(args.name)) {
          return toolError(`Object "${args.name}" already exists. Use update_object_properties to modify it.`);
        }

        // Ensure the plugin is registered in usedAddons
        const addonWarning = await writer.ensureAddonRegistered('plugin', args.pluginId);

        const sid = await idGen.generateSid(reader);
        const isSingleglobal = GLOBAL_PLUGINS.has(args.pluginId);
        const isNonworldGlobal = NONWORLD_GLOBAL_PLUGINS.has(args.pluginId);
        let data: ObjectType;
        let uid: number | undefined;

        if (isSingleglobal || (args.isGlobal && !isNonworldGlobal)) {
          uid = await idGen.generateUid(reader);
          const sgiSid = await idGen.generateSid(reader);
          data = createGlobalObject(args.name, args.pluginId, sid, uid, sgiSid);
        } else if (ANIMATION_PLUGINS.has(args.pluginId)) {
          const animSid = await idGen.generateSid(reader);
          const imageSpriteId = await idGen.generateImageSpriteId(reader);

          // Write placeholder PNG before JSON — abort if image fails
          await writer.writeImageFiles([{
            objectName: args.name,
            animationName: 'Animation 1',
            frameIndex: 0,
            pluginId: args.pluginId,
            width: DEFAULT_OBJECT_IMAGE_SIZE,
            height: DEFAULT_OBJECT_IMAGE_SIZE,
          }]);

          data = createSpriteObject(args.name, sid, animSid, imageSpriteId);
          data['plugin-id'] = args.pluginId;
          if (args.pluginId !== 'Sprite') {
            // All 42 sampled 3D Shape frames omit collisionPoly, which only
            // Sprite frames carry.
            for (const item of data.animations?.items ?? []) {
              for (const frame of item.frames ?? []) delete (frame as unknown as Record<string, unknown>).collisionPoly;
            }
          }
        } else if (args.pluginId === 'Text') {
          data = createTextObject(args.name, sid);
        } else if (SINGLE_IMAGE_PLUGINS.has(args.pluginId)) {
          const imageSpriteId = await idGen.generateImageSpriteId(reader);

          // Write placeholder PNG before JSON — abort if image fails
          await writer.writeImageFiles([{
            objectName: args.name,
            animationName: '',
            frameIndex: 0,
            pluginId: args.pluginId,
            width: DEFAULT_OBJECT_IMAGE_SIZE,
            height: DEFAULT_OBJECT_IMAGE_SIZE,
          }]);

          data = createTiledBgObject(args.name, sid, imageSpriteId);
          data['plugin-id'] = args.pluginId;
          if (args.pluginId === 'Tilemap') {
            // Sampled tilemaps carry this key last, empty when no tile has a
            // collision polygon.
            (data as unknown as Record<string, unknown>)['tile-collision-polys'] = {};
          }
        } else {
          data = createGenericObject(args.name, args.pluginId, sid);
          // Nonworld-global plugins (Arr, Json, Dictionary) are isGlobal but not singleglobal-inst
          if (isNonworldGlobal) {
            data.isGlobal = true;
          }
        }

        await writer.writeEntityFile('objectTypes', args.name, data, args.subfolder);
        await writer.addToProject('objectTypes', args.name, args.subfolder);

        const warnings: string[] = [];
        if (addonWarning) warnings.push(addonWarning);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'created',
          generatedSid: sid,
          generatedUid: uid,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_object] failed:', error);
        return toolError(`Error creating object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_object_properties ─────────────────────────────

  server.tool(
    'update_object_properties',
    'Update properties of an existing object type (variables, behaviors, global status)',
    {
      name: z.string().max(200).describe('Existing object name'),
      isGlobal: z.boolean().optional().describe('Change global status'),
      addVariables: z.array(z.object({
        name: z.string().describe('Variable name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Variable type'),
        description: z.string().max(1000).optional().describe('Description shown in the editor (C3 "desc"; default empty)'),
        showInPropertiesBar: z.boolean().optional().describe('Show the variable in the properties bar (C3 "show"; default true)'),
      })).optional().describe('Instance variables to add'),
      removeVariables: z.array(z.string()).optional().describe('Instance variable names to remove'),
      addBehaviors: z.array(z.object({
        behaviorId: z.string().describe('Behavior plugin ID (e.g., "Tween", "Sin", "Timer")'),
        name: z.string().describe('Behavior instance name'),
      })).optional().describe('Behaviors to add'),
      removeBehaviors: z.array(z.string()).optional().describe('Behavior names to remove; refused while events still use them unless force is true'),
      force: z.boolean().optional().default(false).describe('Remove behaviors even when event conditions or actions still use them (those events are left as they are)'),
      globalInstanceProperties: boundedRecord(100, 4).optional()
        .describe('Plugin property values to merge into a single-global object\'s settings (Keyboard, Touch, Audio, Gamepad, LocalStorage...), e.g. { "use-mouse-input": true }; keys are the plugin\'s property IDs'),
      globalInstanceTags: z.string().max(500).optional().describe('Tags of a single-global object\'s instance'),
    },
    async (args) => {
      try {
        // Check at least one update is provided
        if (args.isGlobal === undefined && !args.addVariables?.length && !args.removeVariables?.length && !args.addBehaviors?.length && !args.removeBehaviors?.length &&
            args.globalInstanceProperties === undefined && args.globalInstanceTags === undefined) {
          return toolError('No updates provided. Specify at least one of: isGlobal, addVariables, removeVariables, addBehaviors, removeBehaviors, globalInstanceProperties, globalInstanceTags.');
        }

        // Read existing object — preserves ALL original fields
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.name);
        } catch {
          return notFoundError('Object', args.name, reader.findNearestName(args.name, 'objects'), 'list_objects');
        }

        const warnings: string[] = [];

        // Single-global settings live on the object type, not in a layout.
        if (args.globalInstanceProperties !== undefined || args.globalInstanceTags !== undefined) {
          const sgi = (obj as Record<string, unknown>)['singleglobal-inst'] as Record<string, unknown> | undefined;
          if (!sgi || typeof sgi !== 'object') {
            return toolError(`Object "${args.name}" (${obj['plugin-id']}) is not a single-global object, so it has no global instance settings. Use update_instance for placed instances.`);
          }
          if (args.globalInstanceProperties !== undefined) {
            const current = sgi.properties && typeof sgi.properties === 'object' ? sgi.properties as Record<string, unknown> : {};
            const unknownKeys = Object.keys(args.globalInstanceProperties).filter(k => !(k in current));
            if (unknownKeys.length > 0) {
              warnings.push(`Propert${unknownKeys.length === 1 ? 'y' : 'ies'} ${unknownKeys.map(k => `"${k}"`).join(', ')} not present on "${args.name}" before; check the plugin's property IDs. Present: ${Object.keys(current).join(', ') || '(none)'}.`);
            }
            sgi.properties = { ...current, ...args.globalInstanceProperties };
          }
          if (args.globalInstanceTags !== undefined) sgi.tags = args.globalInstanceTags;
        }

        // Removing a behavior that events still use leaves broken events.
        if (args.removeBehaviors?.length && !args.force) {
          const index = await getProjectIndex(reader);
          const blocked = [];
          for (const b of args.removeBehaviors) {
            const references = index.behaviorReferences.get(`${args.name}::${b}`) ?? [];
            const expressions = await findBehaviorExpressionReferences(reader, new Set([args.name]), b);
            if (references.length > 0 || expressions.length > 0) blocked.push({ behavior: b, references, expressions });
          }
          if (blocked.length > 0) {
            return toolResult({
              success: false,
              entity: args.name,
              category: 'object',
              action: 'update_blocked',
              message: 'Events still use these behaviors. Remove or change those events first, or pass force: true.',
              references: blocked.map(r => ({
                behavior: r.behavior,
                count: r.references.length + r.expressions.length,
                sample: r.references.slice(0, 20),
                expressions: r.expressions.slice(0, 20),
              })),
            });
          }
        }

        // A new behavior name must not match one the object already gets from a family.
        if (args.addBehaviors?.length) {
          const unknownAddons = unregistrableBehaviors(reader, args.addBehaviors.map(b => b.behaviorId));
          if (unknownAddons.length > 0) {
            return toolError(`Behavior addon(s) ${unknownAddons.map(id => `"${id}"`).join(', ')} are not in the project's usedAddons and are not known built-in Scirra behaviors. Add them in the Construct 3 editor first.`);
          }
          const inherited = await behaviorNamesOf(reader, args.name, await reader.readAllFamilies());
          for (const b of args.addBehaviors) {
            const owner = inherited.get(b.name);
            if (owner && owner.startsWith('family')) {
              return toolError(`Behavior name "${b.name}" is already given to "${args.name}" by ${owner}. Construct needs each behavior name to be unique on an object type; choose another name.`);
            }
          }
        }

        // Update global status
        if (args.isGlobal !== undefined) {
          obj.isGlobal = args.isGlobal;
        }

        // Add variables
        if (args.addVariables && args.addVariables.length > 0) {
          if (!Array.isArray(obj.instanceVariables)) {
            obj.instanceVariables = [];
          }
          const vars = obj.instanceVariables as Array<Record<string, unknown>>;
          for (const v of args.addVariables) {
            if (vars.some(existing => existing.name === v.name)) {
              warnings.push(`Variable "${v.name}" already exists, skipping`);
              continue;
            }
            const sid = await idGen.generateSid(reader);
            vars.push(createInstanceVariable(v.name, v.type, sid, v.description ?? '', v.showInPropertiesBar ?? true));
          }
        }

        // Remove variables
        if (args.removeVariables && args.removeVariables.length > 0) {
          if (Array.isArray(obj.instanceVariables)) {
            const vars = obj.instanceVariables as Array<Record<string, unknown>>;
            for (const varName of args.removeVariables) {
              const idx = vars.findIndex(v => v.name === varName);
              if (idx !== -1) {
                vars.splice(idx, 1);
              } else {
                warnings.push(`Variable "${varName}" not found, skipping`);
              }
            }
          }
        }

        // Add behaviors
        if (args.addBehaviors && args.addBehaviors.length > 0) {
          for (const b of args.addBehaviors) {
            const bWarning = await writer.ensureAddonRegistered('behavior', b.behaviorId);
            if (bWarning) warnings.push(bWarning);
          }

          if (!Array.isArray(obj.behaviorTypes)) {
            obj.behaviorTypes = [];
          }
          const behaviors = obj.behaviorTypes as Array<Record<string, unknown>>;
          for (const b of args.addBehaviors) {
            if (behaviors.some(existing => existing.name === b.name)) {
              warnings.push(`Behavior "${b.name}" already exists, skipping`);
              continue;
            }
            const sid = await idGen.generateSid(reader);
            behaviors.push(createBehavior(b.behaviorId, b.name, sid));
          }
        }

        // Remove behaviors
        if (args.removeBehaviors && args.removeBehaviors.length > 0) {
          if (Array.isArray(obj.behaviorTypes)) {
            const behaviors = obj.behaviorTypes as Array<Record<string, unknown>>;
            for (const bName of args.removeBehaviors) {
              const idx = behaviors.findIndex(b => b.name === bName);
              if (idx !== -1) {
                behaviors.splice(idx, 1);
              } else {
                warnings.push(`Behavior "${bName}" not found, skipping`);
              }
            }
          }
        }

        // Write updated object
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.name);
        const backupPath = await writer.writeEntityFile('objectTypes', args.name, obj, subfolder);

        // Sync layout instances: ensure all instances of this object have
        // behaviors/instanceVariables dicts so C3 can resolve them on load,
        // and drop the per-instance settings of removed behaviors.
        if (args.addBehaviors?.length || args.removeBehaviors?.length || args.addVariables?.length || args.removeVariables?.length) {
          const syncedLayouts: string[] = [];
          try {
            await syncLayoutInstances(reader, writer, new Set([args.name]), args.removeBehaviors ?? [], syncedLayouts);
          } catch (error) {
            return partialWriteResult(args.name, 'object', backupPath, syncedLayouts, error);
          }
          if (syncedLayouts.length > 0) {
            warnings.push(`Updated instances in layout(s): ${syncedLayouts.join(', ')}`);
          }
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_object_properties] failed:', error);
        return toolError(`Error updating object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_instance_variable ─────────────────────────────

  server.tool(
    'update_instance_variable',
    'Edit an existing instance variable definition on an object type or family (rename, retype, description, properties-bar visibility) and keep placed instances and event-sheet references in sync',
    {
      objectName: z.string().max(200).optional().describe('Object type that owns the variable (supply exactly one of objectName/familyName)'),
      familyName: z.string().max(200).optional().describe('Family that owns the variable (supply exactly one of objectName/familyName)'),
      variableName: z.string().max(200).describe('Current instance variable name'),
      newName: z.string().max(200).optional().describe('New variable name'),
      newType: z.enum(['number', 'string', 'boolean']).optional().describe('New variable type — stored values on placed instances are coerced'),
      description: z.string().max(1000).optional().describe('New description (C3 "desc")'),
      showInPropertiesBar: z.boolean().optional().describe('Show the variable in the properties bar (C3 "show")'),
      renameReferences: z.boolean().optional().default(false).describe('Rewrite event-sheet references when renaming. When false, a rename is refused while references exist.'),
    },
    async (args) => {
      try {
        if ((args.objectName === undefined) === (args.familyName === undefined)) {
          return toolError('Specify exactly one of objectName or familyName.');
        }
        if (args.newName === undefined && args.newType === undefined &&
            args.description === undefined && args.showInPropertiesBar === undefined) {
          return toolError('No updates provided. Specify at least one of: newName, newType, description, showInPropertiesBar.');
        }

        const isFamily = args.familyName !== undefined;
        const ownerName = (args.objectName ?? args.familyName) as string;

        let owner: Record<string, unknown>;
        if (isFamily) {
          try {
            owner = await reader.readFamily(ownerName);
          } catch {
            return toolError(`Family "${ownerName}" not found. Use list_families to see available families.`);
          }
        } else {
          try {
            owner = await reader.readObjectType(ownerName) as unknown as Record<string, unknown>;
          } catch {
            return notFoundError('Object', ownerName, reader.findNearestName(ownerName, 'objects'), 'list_objects');
          }
        }

        const vars = Array.isArray(owner.instanceVariables)
          ? owner.instanceVariables as Array<Record<string, unknown>>
          : [];
        const target = vars.find(v => v.name === args.variableName);
        if (!target) {
          const available = vars.map(v => String(v.name));
          const hint = available.length > 0
            ? `\nAvailable instance variables: ${available.join(', ')}`
            : '\nThis object type or family has no instance variables.';
          return toolError(`Instance variable "${args.variableName}" not found on ${isFamily ? 'family' : 'object'} "${ownerName}".${hint}`);
        }

        const renaming = args.newName !== undefined && args.newName !== args.variableName;
        const newName = args.newName as string;
        if (renaming) {
          try {
            validateName(newName);
          } catch (e) {
            return toolError(`Invalid new variable name: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (vars.some(v => v !== target && v.name === newName)) {
            return toolError(`"${ownerName}" already has an instance variable named "${newName}".`);
          }
        }

        // Types whose placed instances carry a stored value for this variable.
        // C3 stores a family instance variable flat in each member instance's
        // own `instanceVariables` dict, so a family rename touches every member.
        const affectedTypes = new Set<string>();
        if (isFamily) {
          const members = Array.isArray(owner.members) ? owner.members as string[] : [];
          for (const m of members) affectedTypes.add(m);
        } else {
          affectedTypes.add(ownerName);
        }

        if (renaming && isFamily) {
          for (const member of affectedTypes) {
            let memberObj: ObjectType;
            try {
              memberObj = await reader.readObjectType(member);
            } catch {
              continue;
            }
            const memberVars = Array.isArray(memberObj.instanceVariables)
              ? memberObj.instanceVariables as Array<Record<string, unknown>>
              : [];
            if (memberVars.some(v => v.name === newName)) {
              return toolError(`Family member "${member}" already has its own instance variable named "${newName}".`);
            }
          }
        }

        // Names an event sheet can use to reach the variable: the owning
        // object type, or the family plus each of its members.
        const referringNames = new Set<string>(affectedTypes);
        if (isFamily) referringNames.add(ownerName);

        const warnings: string[] = [];
        let rewrittenSheets: string[] = [];

        if (renaming) {
          const sheets = await reader.readAllEventSheets();
          const pattern = buildExpressionPattern(referringNames, args.variableName);
          const referenced: Array<{ sheet: string; count: number }> = [];
          const modifiedSheets: string[] = [];

          for (const [sheetName, sheet] of sheets) {
            const ctx: SheetScanContext = {
              referringNames,
              variableName: args.variableName,
              newName,
              expressionPattern: pattern,
              apply: args.renameReferences,
              count: 0,
            };
            const modified = scanSheetNode(sheet, ctx, undefined);
            if (ctx.count > 0) referenced.push({ sheet: sheetName, count: ctx.count });
            if (modified) modifiedSheets.push(sheetName);
          }

          if (referenced.length > 0 && !args.renameReferences) {
            const total = referenced.reduce((n, r) => n + r.count, 0);
            const list = referenced.map(r => `${r.sheet} (${r.count})`).join(', ');
            return toolError(
              `Renaming "${args.variableName}" to "${newName}" would break ${total} event-sheet reference(s) in: ${list}. ` +
              'Re-run with renameReferences: true to rewrite them, or remove the references first.'
            );
          }

          for (const sheetName of modifiedSheets) {
            const sheet = sheets.get(sheetName);
            if (!sheet) continue;
            const sheetSubfolder = writer.getSubfolderForEntity('eventSheets', sheetName);
            await writer.writeEntityFile('eventSheets', sheetName, sheet, sheetSubfolder);
          }
          rewrittenSheets = modifiedSheets;
        }

        // Update the definition itself
        if (renaming) target.name = newName;
        if (args.newType !== undefined) target.type = args.newType;
        if (args.description !== undefined) target.desc = args.description;
        if (args.showInPropertiesBar !== undefined) target.show = args.showInPropertiesBar;
        owner.instanceVariables = vars;

        const category = isFamily ? 'families' : 'objectTypes';
        const subfolder = writer.getSubfolderForEntity(category, ownerName);
        const backupPath = await writer.writeEntityFile(category, ownerName, owner, subfolder);

        // Sync stored values on placed instances across all layouts
        const sync = await syncInstanceVariableValues(
          reader,
          writer,
          affectedTypes,
          args.variableName,
          renaming ? newName : undefined,
          args.newType,
        );

        if (sync.layouts.length > 0) {
          warnings.push(`Updated placed instances in layout(s): ${sync.layouts.join(', ')}`);
        }
        if (renaming && sync.renamed > 0) {
          warnings.push(`Renamed the stored value key on ${sync.renamed} placed instance(s).`);
        }
        if (args.newType !== undefined && sync.coerced > 0) {
          warnings.push(`Coerced ${sync.coerced} stored instance value(s) to ${args.newType}.`);
        }
        if (rewrittenSheets.length > 0) {
          warnings.push(`Rewrote event-sheet references in: ${rewrittenSheets.join(', ')}`);
          warnings.push('Rewrites cover "instance-variable" ACE parameters and <Object>.<variable> expression text only. References built by string concatenation, or written inside JavaScript script actions or script files, are NOT rewritten.');
        }

        const result: WriteResult = {
          success: true,
          entity: `${ownerName}.${renaming ? newName : args.variableName}`,
          category: isFamily ? 'family' : 'object',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_instance_variable] failed:', error);
        return toolError(`Error updating instance variable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_object ────────────────────────────────────────

  server.tool(
    'delete_object',
    'Delete an object type from the project (checks references first)',
    {
      name: z.string().max(200).describe('Object name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        // Verify the object exists
        const existing = await reader.listObjectTypes();
        if (!existing.includes(args.name)) {
          return notFoundError('Object', args.name, reader.findNearestName(args.name, 'objects'), 'list_objects');
        }

        // Check references
        const index = await getProjectIndex(reader);
        const eventSheetRefs = index.getEventSheetsForObject(args.name);
        const layoutRefs = index.objectToLayouts.get(args.name) || [];
        const familyRefs = index.objectToFamilies.get(args.name) || [];

        const hasRefs = eventSheetRefs.length > 0 || layoutRefs.length > 0 || familyRefs.length > 0;

        if (hasRefs && !args.force) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'object',
            action: 'delete_blocked',
            message: 'Object is still referenced. Use force=true to delete anyway (references will NOT be cleaned up).',
            references: {
              eventSheets: eventSheetRefs,
              layouts: layoutRefs,
              families: familyRefs,
            },
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          warnings.push(`Object deleted but still referenced in: ${[...eventSheetRefs, ...layoutRefs].join(', ')}. References were NOT cleaned up.`);
        }

        // Capture the subfolder first: removeFromProject reloads project.c3proj,
        // after which the name is no longer resolvable.
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.name);
        // Deregister before deleting the file. A failure in the second step
        // then leaves an orphaned file (info-level) instead of a dangling
        // registration (a file-existence error).
        await writer.removeFromProject('objectTypes', args.name);
        let backupPath: string;
        try {
          backupPath = await writer.deleteEntityFile('objectTypes', args.name, subfolder);
        } catch (error) {
          console.error('[delete_object] file delete failed after deregistration:', error);
          return orphanedFileError('objectTypes', args.name, subfolder, error);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'object',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_object] failed:', error);
        return toolError(`Error deleting object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── create_family ────────────────────────────────────────

  server.tool(
    'create_family',
    'Create a new family in the project. Families let you group object types and share instance variables and behaviors across them.',
    {
      name: z.string().max(200).describe('Family name (must be unique)'),
      pluginId: z.string().max(100).describe('Plugin ID all members must share (e.g. "Sprite", "Text")'),
      members: z.array(z.string().max(200)).optional().default([]).describe('Object type names to add as initial members'),
      subfolder: z.string().max(500).optional().describe('Subfolder path in project (e.g. "UI")'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Check uniqueness
        const existing = await reader.listFamilies();
        if (existing.includes(args.name)) {
          return toolError(`Family "${args.name}" already exists.`);
        }

        // Validate members exist
        const warnings: string[] = [];
        for (const memberName of args.members) {
          try {
            await reader.readObjectType(memberName);
          } catch {
            warnings.push(`Member "${memberName}" does not exist as an object type. It will be listed but C3 may warn.`);
          }
        }

        const sid = await idGen.generateSid(reader);

        const familyData: Record<string, unknown> = {
          name: args.name,
          'plugin-id': args.pluginId,
          sid,
          instanceVariables: [],
          behaviorTypes: [],
          effectTypes: [],
          members: args.members,
        };

        await writer.writeEntityFile('families', args.name, familyData, args.subfolder);
        await writer.addToProject('families', args.name, args.subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'family',
          action: 'created',
          generatedSid: sid,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_family] failed:', error);
        return toolError(`Error creating family: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_family ────────────────────────────────────────

  server.tool(
    'update_family',
    'Update a family: add/remove members, shared instance variables and shared behaviors',
    {
      name: z.string().max(200).describe('Family name to update'),
      addMembers: z.array(z.string().max(200)).optional().describe('Object type names to add to the family'),
      removeMembers: z.array(z.string().max(200)).optional().describe('Object type names to remove from the family'),
      addVariables: z.array(z.object({
        name: z.string().describe('Variable name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Variable type'),
        description: z.string().max(1000).optional().describe('Description shown in the editor (C3 "desc"; default empty)'),
        showInPropertiesBar: z.boolean().optional().describe('Show the variable in the properties bar (C3 "show"; default true)'),
      })).optional().describe('Instance variables to add to all family members'),
      removeVariables: z.array(z.string()).optional().describe('Instance variable names to remove'),
      addBehaviors: z.array(z.object({
        behaviorId: z.string().max(100).describe('Behavior addon ID (e.g. "Bullet", "Sin", "Platform")'),
        name: z.string().max(200).describe('Behavior name, unique across the family and each member\'s own behaviors'),
      })).max(50).optional().describe('Behaviors every member gets through the family'),
      removeBehaviors: z.array(z.string().max(200)).max(50).optional()
        .describe('Family behavior names to remove; refused while events still use them unless force is true'),
      force: z.boolean().optional().default(false).describe('Remove behaviors even when events still use them (those events are left as they are)'),
    },
    async (args) => {
      try {
        const hasUpdates = (args.addMembers?.length ?? 0) > 0 || (args.removeMembers?.length ?? 0) > 0 ||
          (args.addVariables?.length ?? 0) > 0 || (args.removeVariables?.length ?? 0) > 0 ||
          (args.addBehaviors?.length ?? 0) > 0 || (args.removeBehaviors?.length ?? 0) > 0;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: addMembers, removeMembers, addVariables, removeVariables, addBehaviors, removeBehaviors.');
        }

        let family: Record<string, unknown>;
        try {
          family = await reader.readFamily(args.name);
        } catch {
          return toolError(`Family "${args.name}" not found. Use list_families to see available families.`);
        }

        const warnings: string[] = [];

        // Manage members
        if (!Array.isArray(family.members)) family.members = [];
        const members = family.members as string[];
        const originalMembers = [...members];

        if (args.addMembers) {
          for (const m of args.addMembers) {
            if (members.includes(m)) {
              warnings.push(`Member "${m}" already in family, skipping`);
            } else {
              members.push(m);
            }
          }
        }

        if (args.removeMembers) {
          for (const m of args.removeMembers) {
            const idx = members.indexOf(m);
            if (idx !== -1) {
              members.splice(idx, 1);
            } else {
              warnings.push(`Member "${m}" not in family, skipping`);
            }
          }
        }

        // Manage instance variables
        if (!Array.isArray(family.instanceVariables)) family.instanceVariables = [];
        const vars = family.instanceVariables as Array<Record<string, unknown>>;

        if (args.addVariables) {
          for (const v of args.addVariables) {
            if (vars.some(ev => ev.name === v.name)) {
              warnings.push(`Variable "${v.name}" already exists, skipping`);
              continue;
            }
            const sid = await idGen.generateSid(reader);
            vars.push(createInstanceVariable(v.name, v.type, sid, v.description ?? '', v.showInPropertiesBar ?? true));
          }
        }

        if (args.removeVariables) {
          for (const varName of args.removeVariables) {
            const idx = vars.findIndex(v => v.name === varName);
            if (idx !== -1) {
              vars.splice(idx, 1);
            } else {
              warnings.push(`Variable "${varName}" not found, skipping`);
            }
          }
        }

        // Manage behaviors. A family behavior is used in events through the
        // family or any member, and every member instance carries its settings.
        if (!Array.isArray(family.behaviorTypes)) family.behaviorTypes = [];
        const familyBehaviors = family.behaviorTypes as Array<Record<string, unknown>>;
        const removedBehaviors: string[] = [];
        if (args.removeBehaviors?.length) {
          const missing = args.removeBehaviors.filter(b => !familyBehaviors.some(e => e.name === b));
          for (const b of missing) warnings.push(`Behavior "${b}" not found on the family, skipping`);
          const toRemove = args.removeBehaviors.filter(b => !missing.includes(b));
          if (toRemove.length > 0 && !args.force) {
            const index = await getProjectIndex(reader);
            const users = new Set([args.name, ...originalMembers, ...members]);
            const blocked = [];
            for (const b of toRemove) {
              const references = [...users].flatMap(u => index.behaviorReferences.get(`${u}::${b}`) ?? []);
              const expressions = await findBehaviorExpressionReferences(reader, users, b);
              if (references.length > 0 || expressions.length > 0) blocked.push({ behavior: b, references, expressions });
            }
            if (blocked.length > 0) {
              return toolResult({
                success: false,
                entity: args.name,
                category: 'family',
                action: 'update_blocked',
                message: 'Events still use these family behaviors (through the family or a member). Remove or change those events first, or pass force: true.',
                references: blocked.map(r => ({
                  behavior: r.behavior,
                  count: r.references.length + r.expressions.length,
                  sample: r.references.slice(0, 20),
                  expressions: r.expressions.slice(0, 20),
                })),
              });
            }
          }
          for (const b of toRemove) {
            familyBehaviors.splice(familyBehaviors.findIndex(e => e.name === b), 1);
            removedBehaviors.push(b);
          }
        }

        // Validate every new behavior before anything is registered or written.
        const newBehaviors: Array<{ behaviorId: string; name: string }> = [];
        for (const b of args.addBehaviors ?? []) {
          if (!BEHAVIOR_NAME.test(b.name)) {
            return toolError(`Behavior name "${b.name}" is not valid: use letters, digits, underscores and spaces.`);
          }
          if (familyBehaviors.some(e => e.name === b.name) || newBehaviors.some(e => e.name === b.name)) {
            warnings.push(`Behavior "${b.name}" already exists on the family, skipping`);
            continue;
          }
          newBehaviors.push(b);
        }

        const unknownAddons = unregistrableBehaviors(reader, newBehaviors.map(b => b.behaviorId));
        if (unknownAddons.length > 0) {
          return toolError(`Behavior addon(s) ${unknownAddons.map(id => `"${id}"`).join(', ')} are not in the project's usedAddons and are not known built-in Scirra behaviors. Add them in the Construct 3 editor first.`);
        }

        // Every member must be able to carry every family behavior name: check
        // new members against all family behaviors, and new behaviors against all members.
        if (newBehaviors.length > 0 || (args.addMembers?.length ?? 0) > 0) {
          const addedMembers = new Set(members.filter(m => !originalMembers.includes(m)));
          const newNames = new Set(newBehaviors.map(b => b.name));
          const allNames = [...familyBehaviors.map(e => String(e.name)), ...newNames];
          const families = await reader.readAllFamilies();
          for (const m of members) {
            const owners = await behaviorNamesOf(reader, m, families, args.name);
            for (const n of allNames) {
              const owner = owners.get(n);
              if (owner && (addedMembers.has(m) || newNames.has(n))) {
                return toolError(`Behavior name "${n}" would appear twice on "${m}": the family "${args.name}" and ${owner} both define it. Construct needs each behavior name to be unique on an object type; rename one of them first.`);
              }
            }
          }
        }

        for (const b of newBehaviors) {
          const bWarning = await writer.ensureAddonRegistered('behavior', b.behaviorId);
          if (bWarning) warnings.push(bWarning);
          familyBehaviors.push(createBehavior(b.behaviorId, b.name, await idGen.generateSid(reader)));
        }

        const subfolder = writer.getSubfolderForEntity('families', args.name);
        const backupPath = await writer.writeEntityFile('families', args.name, family, subfolder);

        const syncedLayouts: string[] = [];
        const cleanedLayouts: string[] = [];
        try {
          if (newBehaviors.length > 0 || removedBehaviors.length > 0 || args.addMembers?.length) {
            await syncLayoutInstances(reader, writer, new Set(members), removedBehaviors, syncedLayouts);
          }
          const formerMembers = originalMembers.filter(m => !members.includes(m));
          // Former members no longer get any of the family's behaviors.
          const familyBehaviorNames = [...familyBehaviors.map(e => String(e.name)), ...removedBehaviors];
          if (formerMembers.length > 0 && familyBehaviorNames.length > 0) {
            await syncLayoutInstances(reader, writer, new Set(formerMembers), familyBehaviorNames, cleanedLayouts);
          }
        } catch (error) {
          return partialWriteResult(args.name, 'family', backupPath, [...new Set([...syncedLayouts, ...cleanedLayouts])], error);
        }
        if (syncedLayouts.length > 0) {
          warnings.push(`Updated member instances in layout(s): ${syncedLayouts.join(', ')}`);
        }
        if (cleanedLayouts.length > 0) {
          warnings.push(`Removed family behavior settings from former member instances in layout(s): ${cleanedLayouts.join(', ')}`);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'family',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_family] failed:', error);
        return toolError(`Error updating family: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── reorder_behaviors ────────────────────────────────────

  server.tool(
    'reorder_behaviors',
    'Reorder the behaviors of an object type or a family, as dragging them in the editor\'s Behaviors dialog does. The order is saved in the object type or family file.',
    {
      objectName: z.string().max(200).optional().describe('Object type whose behaviors to reorder'),
      familyName: z.string().max(200).optional().describe('Family whose behaviors to reorder'),
      order: z.array(z.string().max(200)).min(1).max(100).describe('Every behavior name exactly once, in the new order'),
    },
    async (args) => {
      try {
        if ((args.objectName === undefined) === (args.familyName === undefined)) {
          return toolError('Give exactly one of objectName and familyName.');
        }
        const isFamily = args.familyName !== undefined;
        const name = (args.objectName ?? args.familyName)!;
        let holder: Record<string, unknown>;
        try {
          holder = isFamily
            ? await reader.readFamily(name)
            : await reader.readObjectType(name) as unknown as Record<string, unknown>;
        } catch {
          return isFamily
            ? toolError(`Family "${name}" not found. Use list_families to see available families.`)
            : notFoundError('Object', name, reader.findNearestName(name, 'objects'), 'list_objects');
        }

        const behaviors = Array.isArray(holder.behaviorTypes) ? holder.behaviorTypes as Array<Record<string, unknown>> : [];
        const current = behaviors.map(b => String(b.name));
        const sameSet = args.order.length === current.length
          && new Set(args.order).size === args.order.length
          && args.order.every(n => current.includes(n));
        if (!sameSet) {
          return toolError(`order must list every behavior of "${name}" exactly once. Current order: ${current.join(', ') || '(no behaviors)'}.`);
        }
        if (args.order.every((n, i) => n === current[i])) {
          return toolResult({ success: true, entity: name, category: isFamily ? 'family' : 'object', action: 'unchanged', order: current });
        }

        holder.behaviorTypes = args.order.map(n => behaviors.find(b => b.name === n)!);
        const folder = isFamily ? 'families' : 'objectTypes';
        const subfolder = writer.getSubfolderForEntity(folder, name);
        const backupPath = await writer.writeEntityFile(folder, name, holder, subfolder);

        const result: WriteResult = {
          success: true,
          entity: name,
          category: isFamily ? 'family' : 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: [`Behavior order: ${args.order.join(', ')}.`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[reorder_behaviors] failed:', error);
        return toolError(`Error reordering behaviors: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_family ────────────────────────────────────────

  server.tool(
    'delete_family',
    'Delete a family from the project',
    {
      name: z.string().max(200).describe('Family name to delete'),
    },
    async (args) => {
      try {
        const existing = await reader.listFamilies();
        if (!existing.includes(args.name)) {
          return toolError(`Family "${args.name}" not found. Use list_families to see available families.`);
        }

        // Capture the subfolder first: removeFromProject reloads project.c3proj,
        // after which the name is no longer resolvable.
        const subfolder = writer.getSubfolderForEntity('families', args.name);
        // Deregister before deleting the file. A failure in the second step
        // then leaves an orphaned file (info-level) instead of a dangling
        // registration (a file-existence error).
        await writer.removeFromProject('families', args.name);
        let backupPath: string;
        try {
          backupPath = await writer.deleteEntityFile('families', args.name, subfolder);
        } catch (error) {
          console.error('[delete_family] file delete failed after deregistration:', error);
          return orphanedFileError('families', args.name, subfolder, error);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'family',
          action: 'deleted',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_family] failed:', error);
        return toolError(`Error deleting family: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/**
 * Ensure all layout instances of an object type have the standard
 * `behaviors` and `instanceVariables` dicts that C3 expects.
 * Without these, C3 may fail to load the project after a behavior or
 * variable is added to the object type definition.
 *
 * Returns the names of any layouts that were modified.
 */
async function syncLayoutInstances(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  objectNames: Set<string>,
  removedBehaviors: string[] = [],
  modifiedLayouts: string[] = [],
): Promise<string[]> {
  const layouts = await reader.readAllLayouts();

  for (const [layoutName, layout] of layouts) {
    let modified = false;

    // Every layer depth plus non-world instances.
    forEachLayoutInstance(layout, (instance) => {
      if (!objectNames.has(instance.type)) return;
      if (ensureInstanceFields(instance)) modified = true;
      const behaviors = instance.behaviors as Record<string, unknown>;
      for (const name of removedBehaviors) {
        if (Object.prototype.hasOwnProperty.call(behaviors, name)) {
          delete behaviors[name];
          modified = true;
        }
      }
    });

    if (modified) {
      const subfolder = writer.getSubfolderForEntity('layouts', layoutName);
      await writer.writeEntityFile('layouts', layoutName, layout, subfolder);
      modifiedLayouts.push(layoutName);
    }
  }

  return modifiedLayouts;
}

/** Construct behavior names: the default for 8 Direction is "8Direction". */
const BEHAVIOR_NAME = /^[A-Za-z0-9_][A-Za-z0-9_ ]*$/;

/** Where an event sheet uses a behavior through an expression such as `Player.Platform.VectorX`. */
interface BehaviorExpressionReference {
  eventSheet: string;
  eventSid?: number;
  text: string;
}

/**
 * Expression references to `<name>.<behavior>.` for any of `names`, in every
 * string parameter of every event sheet. The usage index only records a
 * condition's or action's `behaviorType`, so these need their own scan.
 */
async function findBehaviorExpressionReferences(
  reader: Construct3ProjectReader,
  names: Set<string>,
  behavior: string,
): Promise<BehaviorExpressionReference[]> {
  const pattern = new RegExp(
    `\\b(?:${Array.from(names).map(escapeRegExp).join('|')})\\s*\\.\\s*${escapeRegExp(behavior)}\\s*\\.`,
  );
  const found: BehaviorExpressionReference[] = [];
  const visit = (node: unknown, sheet: string, sid: number | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, sheet, sid);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const ownSid = typeof record.eventType === 'string' && typeof record.sid === 'number' ? record.sid : sid;
    const params = record.parameters;
    const values = Array.isArray(params) ? params : params && typeof params === 'object' ? Object.values(params) : [];
    for (const value of values) {
      if (typeof value === 'string' && pattern.test(value)) found.push({ eventSheet: sheet, eventSid: ownSid, text: value });
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'parameters' && value && typeof value === 'object') visit(value, sheet, ownSid);
    }
  };
  for (const [sheetName, sheet] of await reader.readAllEventSheets()) visit(sheet, sheetName, undefined);
  return found;
}

/**
 * Behavior names an object type already carries, with where each comes from:
 * its own behaviors and those of its families, optionally skipping one family.
 */
async function behaviorNamesOf(
  reader: Construct3ProjectReader,
  objectName: string,
  families: Map<string, Record<string, unknown>>,
  skipFamily?: string,
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  try {
    const obj = await reader.readObjectType(objectName);
    for (const b of (obj.behaviorTypes ?? []) as Array<{ name?: string }>) {
      if (typeof b.name === 'string') owners.set(b.name, `object type "${objectName}"`);
    }
  } catch {
    // Unknown object type: nothing to collide with.
  }
  for (const [familyName, family] of families) {
    if (familyName === skipFamily) continue;
    if (!(Array.isArray(family.members) && (family.members as string[]).includes(objectName))) continue;
    for (const b of (Array.isArray(family.behaviorTypes) ? family.behaviorTypes : []) as Array<{ name?: string }>) {
      if (typeof b.name === 'string') owners.set(b.name, `family "${familyName}"`);
    }
  }
  return owners;
}

/**
 * The behavior addons in `ids` that ensureAddonRegistered would refuse: not in
 * usedAddons and not a known Scirra behavior. Checked up front so a refused
 * addon cannot leave earlier ones registered.
 */
function unregistrableBehaviors(reader: Construct3ProjectReader, ids: string[]): string[] {
  const used = reader.getUsedAddons();
  return [...new Set(ids)].filter(id =>
    !used.some(a => a.type === 'behavior' && a.id === id) && !(id in KNOWN_SCIRRA_BEHAVIORS));
}

/** A layout sync failed after the entity file was written; report exactly what changed. */
function partialWriteResult(
  entity: string,
  category: 'object' | 'family',
  backupFile: string | undefined,
  writtenLayouts: string[],
  error: unknown,
) {
  return toolResult({
    success: false,
    entity,
    category,
    action: 'partially_updated',
    message: `The ${category === 'family' ? 'family' : 'object type'} file was written, but updating placed instances failed: ${error instanceof Error ? error.message : String(error)}. Layouts already written: ${writtenLayouts.join(', ') || '(none)'}. Restore the backup and the listed layouts' backups, then retry.`,
    backupFile,
    writtenLayouts,
  });
}

/**
 * Ensure an instance has the standard fields C3 expects.
 * Returns true if the instance was modified.
 */
function ensureInstanceFields(instance: Instance): boolean {
  let modified = false;
  const inst = instance as Record<string, unknown>;

  if (!inst.behaviors || typeof inst.behaviors !== 'object') {
    inst.behaviors = {};
    modified = true;
  }
  if (!inst.instanceVariables || typeof inst.instanceVariables !== 'object') {
    inst.instanceVariables = {};
    modified = true;
  }

  return modified;
}

// ─── Instance variable rename/retype helpers ───────────────

/**
 * Visit every placed instance in a layout: each layer's instances, the same
 * for nested sub-layers, and the layout's non-world instances.
 */
function forEachLayoutInstance(layout: Layout, fn: (instance: Instance) => void): void {
  const walkLayers = (layers: unknown[]): void => {
    for (const layer of layers as Layer[]) {
      if (!layer || typeof layer !== 'object') continue;
      if (Array.isArray(layer.instances)) {
        for (const instance of layer.instances) fn(instance);
      }
      if (Array.isArray(layer.subLayers)) walkLayers(layer.subLayers);
    }
  };
  walkLayers(Array.isArray(layout.layers) ? layout.layers : []);

  const nonworld = (layout as Record<string, unknown>)['nonworld-instances'];
  if (Array.isArray(nonworld)) {
    for (const instance of nonworld as Instance[]) fn(instance);
  }
}

/**
 * Coerce a stored instance-variable value to a new definition type.
 *
 * C3 stores placed-instance values untyped in the instance's
 * `instanceVariables` dict, so a retype has to rewrite them. The rule is:
 *   - to string:  String(value); null/undefined become ""
 *   - to number:  Number(value), falling back to 0 when not finite;
 *                 booleans become 1/0
 *   - to boolean: JavaScript truthiness (0 and "" are false)
 */
function coerceInstanceValue(value: unknown, newType: 'number' | 'string' | 'boolean'): unknown {
  if (newType === 'string') {
    return value === undefined || value === null ? '' : String(value);
  }
  if (newType === 'number') {
    if (typeof value === 'boolean') return value ? 1 : 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return Boolean(value);
}

/**
 * Rename and/or coerce one instance's stored value for a variable.
 * Key order is preserved so the rewritten layout stays diff-friendly.
 */
function applyToInstanceValues(
  instance: Instance,
  variableName: string,
  newName: string | undefined,
  newType: 'number' | 'string' | 'boolean' | undefined,
): { renamed: boolean; coerced: boolean } {
  const stored = (instance as Record<string, unknown>).instanceVariables;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { renamed: false, coerced: false };
  }
  const dict = stored as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(dict, variableName)) {
    return { renamed: false, coerced: false };
  }

  let coerced = false;
  if (newType !== undefined) {
    dict[variableName] = coerceInstanceValue(dict[variableName], newType);
    coerced = true;
  }

  let renamed = false;
  if (newName !== undefined && newName !== variableName) {
    const rebuilt: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dict)) {
      rebuilt[key === variableName ? newName : key] = value;
    }
    (instance as Record<string, unknown>).instanceVariables = rebuilt;
    renamed = true;
  }

  return { renamed, coerced };
}

/**
 * Rename and/or retype the stored value of an instance variable on every
 * placed instance of the affected object types, across all layouts.
 * Returns the layouts written and how many instances were touched.
 */
async function syncInstanceVariableValues(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  affectedTypes: Set<string>,
  variableName: string,
  newName: string | undefined,
  newType: 'number' | 'string' | 'boolean' | undefined,
): Promise<{ layouts: string[]; renamed: number; coerced: number }> {
  const layouts = await reader.readAllLayouts();
  const modifiedLayouts: string[] = [];
  let renamed = 0;
  let coerced = 0;

  for (const [layoutName, layout] of layouts) {
    let modified = false;
    forEachLayoutInstance(layout, (instance) => {
      if (!affectedTypes.has(instance.type)) return;
      const outcome = applyToInstanceValues(instance, variableName, newName, newType);
      if (outcome.renamed) { renamed++; modified = true; }
      if (outcome.coerced) { coerced++; modified = true; }
    });

    if (modified) {
      const subfolder = writer.getSubfolderForEntity('layouts', layoutName);
      await writer.writeEntityFile('layouts', layoutName, layout, subfolder);
      modifiedLayouts.push(layoutName);
    }
  }

  return { layouts: modifiedLayouts, renamed, coerced };
}

/** State carried through one event sheet's reference scan. */
interface SheetScanContext {
  /** Names an event sheet may use to reach the variable (type and/or family). */
  referringNames: Set<string>;
  variableName: string;
  newName: string;
  expressionPattern: RegExp;
  /** false = count references only (dry run); true = rewrite them. */
  apply: boolean;
  count: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the pattern matching `<ReferringName>.<variableName>` inside event
 * parameter expressions (e.g. "fAgents.vEntityBlackboardUID").
 */
export function buildInstanceVariablePattern(referringNames: Set<string>, variableName: string): RegExp {
  return buildExpressionPattern(referringNames, variableName);
}

function buildExpressionPattern(referringNames: Set<string>, variableName: string): RegExp {
  const names = Array.from(referringNames).map(escapeRegExp).join('|');
  return new RegExp(`\\b(${names})\\s*\\.\\s*${escapeRegExp(variableName)}\\b`, 'g');
}

/**
 * Walk an event sheet, counting (and optionally rewriting) references to an
 * instance variable. Two reference shapes occur in C3 event sheets, both
 * confirmed against the C3-ACE project:
 *
 *   1. an ACE parameter keyed "instance-variable" whose value is the bare
 *      variable name, on an action/condition whose "objectClass" is one of the
 *      referring names (e.g. set-instvar-value on nodeCooldownXSec);
 *   2. expression text naming it as `<ReferringName>.<variableName>` inside
 *      any other parameter value.
 *
 * Returns true when the sheet was modified.
 */
function scanSheetNode(node: unknown, ctx: SheetScanContext, objectClass: string | undefined): boolean {
  if (Array.isArray(node)) {
    let modified = false;
    for (const item of node) {
      if (scanSheetNode(item, ctx, objectClass)) modified = true;
    }
    return modified;
  }
  if (!node || typeof node !== 'object') return false;

  const record = node as Record<string, unknown>;
  const scope = typeof record.objectClass === 'string' ? record.objectClass : objectClass;
  let modified = false;

  const params = record.parameters;
  if (Array.isArray(params)) {
    for (let i = 0; i < params.length; i++) {
      const value = params[i];
      if (typeof value !== 'string') continue;
      const matches = value.match(ctx.expressionPattern);
      if (!matches) continue;
      ctx.count += matches.length;
      if (ctx.apply) {
        params[i] = value.replace(ctx.expressionPattern, (_full, prefix: string) => `${prefix}.${ctx.newName}`);
        modified = true;
      }
    }
  } else if (params && typeof params === 'object') {
    const dict = params as Record<string, unknown>;
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value !== 'string') continue;

      if (key === 'instance-variable' && value === ctx.variableName &&
          scope !== undefined && ctx.referringNames.has(scope)) {
        ctx.count++;
        if (ctx.apply) {
          dict[key] = ctx.newName;
          modified = true;
        }
        continue;
      }

      const matches = value.match(ctx.expressionPattern);
      if (!matches) continue;
      ctx.count += matches.length;
      if (ctx.apply) {
        dict[key] = value.replace(ctx.expressionPattern, (_full, prefix: string) => `${prefix}.${ctx.newName}`);
        modified = true;
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === 'parameters') continue;
    if (value && typeof value === 'object') {
      if (scanSheetNode(value, ctx, scope)) modified = true;
    }
  }

  return modified;
}
