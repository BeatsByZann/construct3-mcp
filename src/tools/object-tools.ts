/**
 * Object type tools: create_object, update_object_properties, delete_object,
 * create_family, update_family, delete_family.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectType, Instance, Layer, Layout } from '../construct3/types.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import { validateName, validateSubfolder, toolResult, toolError, notFoundError, orphanedFileError } from './shared.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  GLOBAL_PLUGINS,
  NONWORLD_GLOBAL_PLUGINS,
  createSpriteObject,
  createTextObject,
  createTiledBgObject,
  createGlobalObject,
  createGenericObject,
  createInstanceVariable,
  createBehavior,
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
        } else if (args.pluginId === 'Sprite') {
          const animSid = await idGen.generateSid(reader);
          const imageSpriteId = await idGen.generateImageSpriteId(reader);

          // Write placeholder PNG before JSON — abort if image fails
          await writer.writeImageFiles([{
            objectName: args.name,
            animationName: 'Animation 1',
            frameIndex: 0,
            pluginId: 'Sprite',
            width: 1,
            height: 1,
          }]);

          data = createSpriteObject(args.name, sid, animSid, imageSpriteId);
        } else if (args.pluginId === 'Text') {
          data = createTextObject(args.name, sid);
        } else if (args.pluginId === 'TiledBg') {
          const imageSpriteId = await idGen.generateImageSpriteId(reader);

          // Write placeholder PNG before JSON — abort if image fails
          await writer.writeImageFiles([{
            objectName: args.name,
            animationName: '',
            frameIndex: 0,
            pluginId: 'TiledBg',
            width: 1,
            height: 1,
          }]);

          data = createTiledBgObject(args.name, sid, imageSpriteId);
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
      removeBehaviors: z.array(z.string()).optional().describe('Behavior names to remove'),
    },
    async (args) => {
      try {
        // Check at least one update is provided
        if (args.isGlobal === undefined && !args.addVariables?.length && !args.removeVariables?.length && !args.addBehaviors?.length && !args.removeBehaviors?.length) {
          return toolError('No updates provided. Specify at least one of: isGlobal, addVariables, removeVariables, addBehaviors, removeBehaviors.');
        }

        // Read existing object — preserves ALL original fields
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.name);
        } catch {
          return notFoundError('Object', args.name, reader.findNearestName(args.name, 'objects'), 'list_objects');
        }

        const warnings: string[] = [];

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
        // behaviors/instanceVariables dicts so C3 can resolve them on load.
        if (args.addBehaviors?.length || args.removeBehaviors?.length || args.addVariables?.length || args.removeVariables?.length) {
          const syncedLayouts = await syncLayoutInstances(reader, writer, args.name);
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
    'Update a family: add/remove members, add/remove shared instance variables or behaviors',
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
    },
    async (args) => {
      try {
        const hasUpdates = (args.addMembers?.length ?? 0) > 0 || (args.removeMembers?.length ?? 0) > 0 ||
          (args.addVariables?.length ?? 0) > 0 || (args.removeVariables?.length ?? 0) > 0;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: addMembers, removeMembers, addVariables, removeVariables.');
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

        const subfolder = writer.getSubfolderForEntity('families', args.name);
        const backupPath = await writer.writeEntityFile('families', args.name, family, subfolder);

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
  objectName: string,
): Promise<string[]> {
  const layouts = await reader.readAllLayouts();
  const modifiedLayouts: string[] = [];

  for (const [layoutName, layout] of layouts) {
    let modified = false;

    for (const layer of layout.layers) {
      for (const instance of layer.instances) {
        if (instance.type === objectName) {
          modified = ensureInstanceFields(instance) || modified;
        }
      }
    }

    // Also check nonworld-instances
    const nonworld = (layout as Record<string, unknown>)['nonworld-instances'] as Instance[] | undefined;
    if (Array.isArray(nonworld)) {
      for (const instance of nonworld) {
        if (instance.type === objectName) {
          modified = ensureInstanceFields(instance) || modified;
        }
      }
    }

    if (modified) {
      const subfolder = writer.getSubfolderForEntity('layouts', layoutName);
      await writer.writeEntityFile('layouts', layoutName, layout, subfolder);
      modifiedLayouts.push(layoutName);
    }
  }

  return modifiedLayouts;
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
