/**
 * Object type tools: create_object, update_object_properties, delete_object,
 * create_family, update_family, reorder_behaviors, delete_family.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectType, Instance, ObjectReference } from '../construct3/types.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import {
  validateName, validateSubfolder, toolResult, toolError, notFoundError, orphanedFileError, boundedRecord, folderCaseClashError,
} from './shared.js';
import { findFolderPathClash } from '../construct3/names.js';
import {
  getProjectIndex,
  toFamilyMemberUse,
  type FamilyMemberUse,
  type MemberReference,
  type MemberRemoval,
  type ObjectUsage,
  type ProjectIndex,
} from '../construct3/analyzers/index-builder.js';
import { forEachLayoutInstance } from '../construct3/layers.js';
import {
  checkFamilyPlugins,
  findObjectClassNameClash,
  findBuiltinObjectClassClash,
  builtinObjectClassClashMessage,
  formatLoadRuleIssue,
  loadRuleErrorMessage,
  newLoadRuleIssues,
  objectClassNameClashMessage,
} from '../construct3/analyzers/load-rules.js';
import { functionsObjectName } from '../construct3/event-shapes.js';
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
import {
  expectedInstanceBehaviors,
  readFamiliesForInstances,
  syncInstanceBehaviors,
  unknownDefaultsWarning,
  behaviorTypesOf,
} from '../construct3/instance-behaviors.js';
import type { InstanceBehavior } from '../construct3/instance-behaviors.js';

export function registerObjectTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_object ──────────────────────────────────────────

  server.tool(
    'create_object',
    'Create a new object type in the Construct3 project',
    {
      name: z.string().max(200).describe('Object name (alphanumeric + underscore; must not match an existing object type or family name, "System" or the name of the built-in Functions object, ignoring case)'),
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
        // Editor load-time rule: object types and families share one name namespace that ignores case
        const nameClash = findObjectClassNameClash(args.name, existing, await reader.listFamilies());
        if (nameClash) {
          return toolError(objectClassNameClashMessage(args.name, nameClash));
        }
        // ...and with the built-in System and Functions objects
        const builtinClash = findBuiltinObjectClassClash(args.name, functionsObjectName(reader));
        if (builtinClash) {
          return toolError(builtinObjectClassClashMessage(args.name, builtinClash));
        }
        if (args.subfolder) {
          const folderClash = findFolderPathClash(reader.getProject().objectTypes, args.subfolder);
          if (folderClash) return toolError(folderCaseClashError(args.subfolder, folderClash));
        }
        // Before any write (addon registration, placeholder images): never replace an existing file
        const fileRefusal = await writer.entityFileRefusal('objectTypes', args.name, args.subfolder);
        if (fileRefusal) return toolError(fileRefusal);

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

        await writer.writeEntityFile('objectTypes', args.name, data, args.subfolder, { createOnly: true });
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
    'Update properties of an existing object type (variables, behaviors, global status). Removing an instance variable or behavior that events still use is refused without force, listing the uses: the "instance-variable" parameter or behaviorType of conditions/actions on the object (also System actions such as Sort Z order that name the object with the variable), and "Object.name", "Object.Behavior.Expression" or (on the object) "Self.name" in expressions. Scripts are not checked; a warning names scripts that read a removed name (instVars.name, behaviors.Name).',
    {
      name: z.string().max(200).describe('Existing object name, as registered (letter case included)'),
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
      force: z.boolean().optional().default(false).describe('If true, remove instance variables and behaviors even if events use them (the uses are NOT changed)'),
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

        // The registered name only: on case-insensitive file systems another
        // spelling would open the file too, but nothing else knows it by that name
        const objectNames = await reader.listObjectTypes();
        if (!objectNames.includes(args.name)) {
          return entityNotFound('Object', args.name, objectNames, reader.findNearestName(args.name, 'objects'), 'list_objects');
        }

        // Read existing object — preserves ALL original fields
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.name);
        } catch {
          return notFoundError('Object', args.name, reader.findNearestName(args.name, 'objects'), 'list_objects');
        }

        const warnings: string[] = [];
        const addedBehaviors: string[] = [];
        const removedBehaviors: string[] = [];

        // Before any change: events that use an instance variable or behavior being removed
        const variablesToRemove = existingNames(obj.instanceVariables, args.removeVariables);
        const behaviorsToRemove = existingNames(obj.behaviorTypes, args.removeBehaviors);
        const removal: MemberRemoval = {
          variables: new Map([[args.name, variablesToRemove]]),
          behaviors: new Map([[args.name, behaviorsToRemove]]),
        };
        if (variablesToRemove.length > 0 || behaviorsToRemove.length > 0) {
          const index = await getProjectIndex(reader);
          const broken = index.findReferencesBrokenBy(removal);
          if (broken.length > 0 && !args.force) {
            return toolResult(removalBlocked(args.name, 'object', broken));
          }
          warnings.push(...removalForcedWarnings(args.name, broken));
          warnings.push(...await scriptReadWarnings(reader, index, removal, [
            ...variablesToRemove.map(name => ({ objectClass: args.name, kind: 'instance variable' as const, name })),
            ...behaviorsToRemove.map(name => ({ objectClass: args.name, kind: 'behavior' as const, name })),
          ]));
        }

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
            addedBehaviors.push(b.name);
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
                removedBehaviors.push(bName);
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
        // add an entry for each added behavior (and any other entry an
        // instance lacks) and drop the removed ones.
        if (args.addBehaviors?.length || args.removeBehaviors?.length || args.addVariables?.length || args.removeVariables?.length) {
          const syncedLayouts: string[] = [];
          try {
            const expected = expectedInstanceBehaviors(args.name, obj, await readFamiliesForInstances(reader));
            const sync = await syncLayoutInstances(reader, writer, new Map([
              [args.name, { expected, add: addedBehaviors, drop: removedBehaviors }],
            ]), syncedLayouts);
            warnings.push(...sync.warnings);
          } catch (error) {
            return partialWriteResult(args.name, 'object', backupPath, syncedLayouts, error);
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
    'Delete an object type from the project (checks references first: events, including object parameters, expressions and runtime.objects in script actions; layout instances on any layer or sub-layer, including non-world instances; object properties of other instances; families). Refused without force while anything refers to the object; the response lists where. References in project script files and objects created by name at runtime are not detected.',
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

        // Check references: the same index find_orphaned_objects and get_object_dependencies use
        const index = await getProjectIndex(reader);
        const usage = index.getObjectUsage(args.name);
        const hasRefs = index.isObjectReferenced(args.name);
        const eventSheetRefs = [...new Set(usage.events.map(r => r.eventSheet))];
        const layoutRefs = [...new Set([...usage.placements, ...usage.instanceProperties].map(p => p.layout))];

        if (hasRefs && !args.force) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'object',
            action: 'delete_blocked',
            message: `Object is still referenced: ${describeObjectUsage(usage)}. ` +
              'Use force=true to delete anyway (references will NOT be cleaned up).',
            references: {
              eventSheets: eventSheetRefs,
              layouts: layoutRefs,
              families: usage.families,
              ...usageDetails(usage),
            },
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          warnings.push(`Object deleted but still referenced: ${describeObjectUsage(usage)}. References were NOT cleaned up.`);
          const unreported = unreportedUsesWarning(usage.events);
          if (unreported) warnings.push(unreported);
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
      name: z.string().max(200).describe('Family name (must not match an existing object type or family name, "System" or the name of the built-in Functions object, ignoring case)'),
      pluginId: z.string().max(100).describe('Plugin ID all members must share (e.g. "Sprite", "Text"); members of another plugin are refused'),
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
        // Editor load-time rule: object types and families share one name namespace that ignores case
        const nameClash = findObjectClassNameClash(args.name, await reader.listObjectTypes(), existing);
        if (nameClash) {
          return toolError(objectClassNameClashMessage(args.name, nameClash));
        }
        // ...and with the built-in System and Functions objects
        const builtinClash = findBuiltinObjectClassClash(args.name, functionsObjectName(reader));
        if (builtinClash) {
          return toolError(builtinObjectClassClashMessage(args.name, builtinClash));
        }
        if (args.subfolder) {
          const folderClash = findFolderPathClash(reader.getProject().families, args.subfolder);
          if (folderClash) return toolError(folderCaseClashError(args.subfolder, folderClash));
        }
        // Never replace an existing file
        const fileRefusal = await writer.entityFileRefusal('families', args.name, args.subfolder);
        if (fileRefusal) return toolError(fileRefusal);

        // Validate members exist
        const warnings: string[] = [];
        const memberObjects = await readMemberObjects(reader, args.members);
        for (const memberName of args.members) {
          if (!memberObjects.has(memberName)) {
            warnings.push(`Member "${memberName}" does not exist as an object type. It will be listed but C3 may warn.`);
          }
        }

        // Editor load-time rule: all members of a family must use one plugin
        const pluginIssues = checkFamilyPlugins(
          new Map([[args.name, { 'plugin-id': args.pluginId, members: args.members }]]),
          memberObjects,
        );
        const pluginErrors = pluginIssues.filter(i => i.severity === 'error');
        if (pluginErrors.length > 0) {
          return toolError(loadRuleErrorMessage(pluginErrors.map(formatLoadRuleIssue)));
        }
        warnings.push(...pluginIssues.filter(i => i.severity === 'warning').map(formatLoadRuleIssue));

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

        await writer.writeEntityFile('families', args.name, familyData, args.subfolder, { createOnly: true });
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
    'Update a family: add/remove members, shared instance variables and shared behaviors. Removing an instance variable or behavior that events still use (on the family, or through a member that gets it from this family only), or a member through which events use the family\'s instance variables or behaviors, is refused without force, listing the uses. Removing a member also warns when events use the family itself, since they no longer apply to that member. Scripts are not checked; a warning names scripts that read a name a member loses.',
    {
      name: z.string().max(200).describe('Family name to update, as registered (letter case included)'),
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
      force: z.boolean().optional().default(false).describe('If true, remove instance variables, behaviors and members even if events use them (the uses are NOT changed)'),
    },
    async (args) => {
      try {
        const hasUpdates = (args.addMembers?.length ?? 0) > 0 || (args.removeMembers?.length ?? 0) > 0 ||
          (args.addVariables?.length ?? 0) > 0 || (args.removeVariables?.length ?? 0) > 0 ||
          (args.addBehaviors?.length ?? 0) > 0 || (args.removeBehaviors?.length ?? 0) > 0;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: addMembers, removeMembers, addVariables, removeVariables, addBehaviors, removeBehaviors.');
        }

        // The registered name only, as for update_object_properties
        const familyNames = await reader.listFamilies();
        if (!familyNames.includes(args.name)) {
          return entityNotFound('Family', args.name, familyNames, [], 'list_families');
        }

        let family: Record<string, unknown>;
        try {
          family = await reader.readFamily(args.name);
        } catch {
          return toolError(`Family "${args.name}" not found. Use list_families to see available families.`);
        }

        const warnings: string[] = [];

        // Before any change: events that use an instance variable, or the family's
        // instance variables and behaviors through a member, being removed
        const currentMembers = Array.isArray(family.members) ? family.members.filter((m): m is string => typeof m === 'string') : [];
        const leaving = [...new Set((args.removeMembers ?? []).filter(m => currentMembers.includes(m)))];
        const variablesToRemove = existingNames(family.instanceVariables, args.removeVariables);
        const behaviorsToRemove = existingNames(family.behaviorTypes, args.removeBehaviors);
        const removal: MemberRemoval = {
          variables: new Map([[args.name, variablesToRemove]]),
          behaviors: new Map([[args.name, behaviorsToRemove]]),
          members: new Map([[args.name, leaving]]),
        };
        if (leaving.length > 0 || variablesToRemove.length > 0 || behaviorsToRemove.length > 0) {
          const index = await getProjectIndex(reader);
          const broken = index.findReferencesBrokenBy(removal);
          if (broken.length > 0 && !args.force) {
            return toolResult(removalBlocked(args.name, 'family', broken));
          }
          warnings.push(...removalForcedWarnings(args.name, broken));
          // What member instances lose: the removed variables and behaviors, and for a
          // leaving member all of the family's instance variables and behaviors
          const familyVariables = entryNamesOf(family.instanceVariables);
          const familyBehaviors = entryNamesOf(family.behaviorTypes);
          warnings.push(...await scriptReadWarnings(reader, index, removal, [...new Set(currentMembers)].flatMap(member => [
            ...(leaving.includes(member) ? familyVariables : variablesToRemove)
              .map(name => ({ objectClass: member, kind: 'instance variable' as const, name })),
            ...(leaving.includes(member) ? familyBehaviors : behaviorsToRemove)
              .map(name => ({ objectClass: member, kind: 'behavior' as const, name })),
          ])));
          // Not checkable: whether events that use the family itself rely on these members being in it
          const familyEvents = index.getObjectUsage(args.name).events;
          if (leaving.length > 0 && familyEvents.length > 0) {
            const sheets = [...new Set(familyEvents.map(r => `"${r.eventSheet}"`))];
            warnings.push(
              `Events use family "${args.name}" ${familyEvents.length} time(s) (in ${listSome(sheets)}); they no longer apply to ` +
              `${listSome(leaving.map(m => `"${m}"`))} once ${leaving.length === 1 ? 'it leaves' : 'they leave'} the family. ` +
              'Whether they rely on these members cannot be checked: review them.');
          }
        }

        // Manage members
        if (!Array.isArray(family.members)) family.members = [];
        const members = family.members as string[];
        const membersBefore = [...members];

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

        // Editor load-time rule: all members of a family must use one plugin.
        // Only problems this update introduces block it.
        if (args.addMembers || args.removeMembers) {
          const memberObjects = await readMemberObjects(reader, [...membersBefore, ...members]);
          const pluginIssues = newLoadRuleIssues(
            checkFamilyPlugins(new Map([[args.name, { ...family, members: membersBefore }]]), memberObjects),
            checkFamilyPlugins(new Map([[args.name, family]]), memberObjects),
          );
          const pluginErrors = pluginIssues.filter(i => i.severity === 'error');
          if (pluginErrors.length > 0) {
            family.members = membersBefore;
            return toolError(loadRuleErrorMessage(pluginErrors.map(formatLoadRuleIssue)));
          }
          warnings.push(...pluginIssues.filter(i => i.severity === 'warning').map(formatLoadRuleIssue));
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
          // Uses in events were checked with the other removals above
          const toRemove = args.removeBehaviors.filter(b => !missing.includes(b));
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
          const addedMembers = new Set(members.filter(m => !membersBefore.includes(m)));
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

        // Member instances carry an entry for every family behavior: members that
        // joined get entries for all of them, members that left lose them, and
        // the others gain the added behaviors and lose the removed ones
        const familyBehaviorNames = behaviorTypesOf(family).map(b => b.name);
        const addedBehaviorNames = newBehaviors.map(b => b.name);
        const memberChanges = [...new Set([...membersBefore, ...members])].flatMap((member): MemberSyncChange[] => {
          const joined = members.includes(member) && !membersBefore.includes(member);
          const left = !members.includes(member) && membersBefore.includes(member);
          if (joined) return [{ member, add: familyBehaviorNames }];
          if (left) return [{ member, drop: [...familyBehaviorNames, ...removedBehaviors] }];
          if (addedBehaviorNames.length > 0 || removedBehaviors.length > 0) {
            return [{ member, add: addedBehaviorNames, drop: removedBehaviors }];
          }
          return [];
        });
        const syncedLayouts: string[] = [];
        if (memberChanges.length > 0) {
          try {
            const families = new Map(await readFamiliesForInstances(reader));
            families.set(args.name, family);
            const plans = await memberSyncPlans(reader, families, memberChanges);
            warnings.push(...(await syncLayoutInstances(reader, writer, plans, syncedLayouts)).warnings);
          } catch (error) {
            return partialWriteResult(args.name, 'family', backupPath, syncedLayouts, error);
          }
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
    'Delete a family from the project (checks references first: events that name the family, including object parameters, expressions and runtime.objects in script actions; object properties of instances that hold its SID; its instance variables and behaviors used through a member object type, as the instance variable parameter or behavior of a condition/action on the member, as "Member.name" in an expression, or as "Self.name" in an expression of a condition/action on the member). Refused without force while anything refers to the family; the response lists where. The member object types are kept. References in project script files and script access to instance variables and behaviors of member instances are not detected.',
    {
      name: z.string().max(200).describe('Family name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        const existing = await reader.listFamilies();
        if (!existing.includes(args.name)) {
          return toolError(`Family "${args.name}" not found. Use list_families to see available families.`);
        }

        // Check references: uses by name (as for delete_object) and uses through members
        const index = await getProjectIndex(reader);
        const { events, instanceProperties } = index.getObjectUsage(args.name);
        const usage: ObjectUsage = { events, placements: [], instanceProperties, families: [], usedFamilies: [] };
        const memberUses = index.getFamilyMemberUses(args.name);
        const hasRefs = events.length > 0 || instanceProperties.length > 0 || memberUses.length > 0;
        const description = [describeObjectUsage(usage), describeMemberUses(memberUses)].filter(Boolean).join('; ');

        if (hasRefs && !args.force) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'family',
            action: 'delete_blocked',
            message: `Family is still referenced: ${description}. ` +
              'Use force=true to delete anyway (references will NOT be cleaned up).',
            references: {
              eventSheets: [...new Set([...events, ...memberUses].map(r => r.eventSheet))],
              layouts: [...new Set(instanceProperties.map(p => p.layout))],
              ...boundedLists({ events: eventUseList(events), instanceProperties, memberUses }),
            },
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          warnings.push(`Family deleted but still referenced: ${description}. References were NOT cleaned up.`);
          // validate_project reports the other member uses: as missing-behavior-or-variable,
          // and those under the legacy "behavior-type" key as legacy-behavior-key
          const unreportedMemberUses = index.getFamilyMemberReferences(args.name)
            .filter(ref => ref.form === 'member-expression')
            .map(toFamilyMemberUse);
          const unreported = unreportedUsesWarning(events, unreportedMemberUses);
          if (unreported) warnings.push(unreported);
        }

        // Read before deleting: the members' instances lose the entries for the family's behaviors
        let family: Record<string, unknown> | undefined;
        try {
          family = await reader.readFamily(args.name);
        } catch {
          family = undefined;
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

        const familyBehaviors = behaviorTypesOf(family).map(b => b.name);
        const formerMembers = Array.isArray(family?.members)
          ? family.members.filter((m): m is string => typeof m === 'string')
          : [];
        if (familyBehaviors.length > 0 && formerMembers.length > 0) {
          const families = new Map(await readFamiliesForInstances(reader));
          families.delete(args.name);
          const plans = await familyMemberPlans(
            reader, families, formerMembers.map(m => ({ member: m, joined: false })), familyBehaviors,
          );
          warnings.push(...(await syncLayoutInstances(reader, writer, plans)).warnings);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'family',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
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

/** At most this many uses of each kind are listed in a delete_object or delete_family response. */
const MAX_LISTED_USES = 50;

const EVENT_USE_LABELS: Record<ObjectReference['context'], string> = {
  condition: 'condition object',
  action: 'action object',
  parameter: 'object parameter',
  expression: 'expression',
  script: 'script',
  'custom-action': 'custom action definition',
};

/** A short list for messages: the first few items and how many more there are. */
function listSome(items: string[], max = 5): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/**
 * One sentence on what refers to an object, e.g. 'used 3 time(s) in events of
 * "Sheet1" (2 object parameter, 1 script); 2 instance(s) in layout "Layout1"
 * (layer "Main > Sub")'.
 */
function describeObjectUsage(usage: ObjectUsage): string {
  const parts: string[] = [];
  if (usage.events.length > 0) {
    const byContext = new Map<string, number>();
    for (const ref of usage.events) {
      const label = EVENT_USE_LABELS[ref.context] ?? ref.context;
      byContext.set(label, (byContext.get(label) ?? 0) + 1);
    }
    const sheets = [...new Set(usage.events.map(r => `"${r.eventSheet}"`))];
    const kinds = [...byContext].map(([label, count]) => `${count} ${label}`).join(', ');
    parts.push(`used ${usage.events.length} time(s) in events of ${listSome(sheets)} (${kinds})`);
  }
  if (usage.placements.length > 0) {
    const total = usage.placements.reduce((sum, p) => sum + p.instances, 0);
    const where = usage.placements.map(p =>
      `"${p.layout}" (${p.layer !== undefined ? `layer "${p.layer}"` : 'non-world'})`);
    parts.push(`${total} instance(s) in layout ${listSome(where)}`);
  }
  if (usage.instanceProperties.length > 0) {
    const where = usage.instanceProperties.map(p =>
      `"${p.property}" of "${p.objectType}" UID ${String(p.uid)} in layout "${p.layout}"`);
    parts.push(`named by the object propert${where.length === 1 ? 'y' : 'ies'} ${listSome(where)}`);
  }
  if (usage.families.length > 0) {
    parts.push(`member of family ${listSome(usage.families.map(f => `"${f}"`))}`);
  }
  return parts.join('; ');
}

/**
 * One sentence on the uses of a family's instance variables and behaviors
 * through its members, e.g. 'its instance variables or behaviors used 2
 * time(s) through members in events of "Sheet1" (instance variable "hp" of
 * "Sprite1", behavior "Fade" of "Sprite1")'; empty when there are none.
 */
function describeMemberUses(uses: FamilyMemberUse[]): string {
  if (uses.length === 0) return '';
  const sheets = [...new Set(uses.map(u => `"${u.eventSheet}"`))];
  const what = [...new Set(uses.map(u => `${u.kind} "${u.name}" of "${u.member}"`))];
  return `its instance variables or behaviors used ${uses.length} time(s) through members in events of ${listSome(sheets)} (${listSome(what)})`;
}

/** Of the requested names, those of an existing entry (instance variable or behavior), as the removal matches them. */
function existingNames(entries: unknown, requested: string[] | undefined): string[] {
  if (!Array.isArray(entries) || !requested?.length) return [];
  const names = new Set(entries.map(e => (e && typeof e === 'object' ? (e as { name?: unknown }).name : undefined)));
  return [...new Set(requested.filter(name => names.has(name)))];
}

/**
 * One sentence on uses of instance variables and behaviors, e.g.
 * 'instance variable "hp" used 3 time(s) (2 condition, 1 expression); behavior
 * "Fade" through "Sprite1" used 1 time(s) (1 action) in events of "Sheet1"'.
 * "through" names the object type or family the use goes through when it is
 * not `entity` itself.
 */
function describeMemberReferences(entity: string, uses: MemberReference[]): string {
  const groups = new Map<string, { label: string; contexts: Map<string, number>; count: number }>();
  for (const use of uses) {
    const key = [use.kind, use.name.toLowerCase(), use.objectClass].join('\0');
    const group = groups.get(key) ?? {
      label: `${use.kind} "${use.name}"${use.objectClass !== entity ? ` through "${use.objectClass}"` : ''}`,
      contexts: new Map<string, number>(),
      count: 0,
    };
    group.contexts.set(use.context, (group.contexts.get(use.context) ?? 0) + 1);
    group.count++;
    groups.set(key, group);
  }
  const parts = [...groups.values()].map(g =>
    `${g.label} used ${g.count} time(s) (${[...g.contexts].map(([label, n]) => `${n} ${label}`).join(', ')})`);
  const shown = parts.slice(0, 5).join('; ') + (parts.length > 5 ? `; and ${parts.length - 5} more` : '');
  const sheets = [...new Set(uses.map(u => `"${u.eventSheet}"`))];
  return `${shown} in events of ${listSome(sheets)}`;
}

/** Uses of instance variables and behaviors as listed in a refusal. */
function memberUseList(uses: MemberReference[]): MemberReference[] {
  return uses.map(({ eventSheet, path, eventPath, sid, objectClass, kind, name, context, form }) =>
    ({ eventSheet, path, eventPath, ...(sid !== undefined ? { sid } : {}), objectClass, kind, name, context, form }));
}

/**
 * Where a use is, e.g. '"Sheet1" block > action:0 at events[3]' (the event's
 * JSON path tells apart sibling events whose event path is the same), or
 * 'scripts/main.js' for a script file.
 */
function useLocation(use: { eventSheet?: string; path: string; eventPath?: string }): string {
  if (use.eventSheet === undefined) return use.path;
  return `"${use.eventSheet}" ${use.path}${use.eventPath !== undefined ? ` at ${use.eventPath}` : ''}`;
}

/** Names of the named entries (instance variables, behaviors) of an object type or family file. */
function entryNamesOf(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(e => (e && typeof e === 'object' ? (e as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

/**
 * One warning per instance variable or behavior that `lost` names (an object
 * type or family that has it now and no longer has it after `removal`) and
 * that scripts read by name (instVars.hp, behaviors.Fade in script actions,
 * script events and project script files). Scripts are not checked: which
 * object's instances they read cannot be told, so this only warns.
 */
async function scriptReadWarnings(
  reader: Construct3ProjectReader,
  index: ProjectIndex,
  removal: MemberRemoval,
  lost: Array<{ objectClass: string; kind: MemberReference['kind']; name: string }>,
): Promise<string[]> {
  const losers = new Map<string, { kind: MemberReference['kind']; name: string; objects: Set<string> }>();
  for (const { objectClass, kind, name } of lost) {
    if (!index.hasMember(objectClass, kind, name) || index.hasMember(objectClass, kind, name, removal)) continue;
    const key = `${kind}\0${name}`;
    if (!losers.has(key)) losers.set(key, { kind, name, objects: new Set() });
    losers.get(key)!.objects.add(objectClass);
  }
  if (losers.size === 0) return [];

  const { reads, unreadable } = await index.getScriptMemberReads(reader);
  const warnings: string[] = [];
  for (const { kind, name, objects } of losers.values()) {
    // Script property names are case-sensitive
    const where = [...new Set(reads.filter(r => r.kind === kind && r.name === name).map(useLocation))];
    if (where.length === 0) continue;
    const access = kind === 'instance variable' ? `instVars.${name}` : `behaviors.${name}`;
    const owners = listSome([...objects].map(o => `"${o}"`));
    warnings.push(`Scripts read ${kind} "${name}" by name (${access}) in ${listSome(where)}, and ${owners} ` +
      `${objects.size === 1 ? 'no longer has' : 'no longer have'} it. Scripts are not checked, so whether they read it from ` +
      `${objects.size === 1 ? 'that object' : 'these objects'} cannot be told: review them.`);
  }
  if (warnings.length > 0 && unreadable.length > 0) {
    warnings.push(`${unreadable.length} script file(s) could not be read and were not searched: ${listSome(unreadable)}.`);
  }
  return warnings;
}

/** The refusal of update_object_properties / update_family while events use what it removes. */
function removalBlocked(entity: string, category: 'object' | 'family', uses: MemberReference[]): Record<string, unknown> {
  return {
    success: false,
    entity,
    category,
    action: 'update_blocked',
    message: `Events still use what this update removes: ${describeMemberReferences(entity, uses)}. Nothing was changed. ` +
      'Use force=true to remove anyway (the uses will NOT be changed).',
    references: {
      eventSheets: [...new Set(uses.map(u => u.eventSheet))],
      ...boundedLists({ uses: memberUseList(uses) }),
    },
  };
}

/**
 * The warnings of a forced removal that leaves uses behind: what is left, and
 * the uses validate_project cannot report afterwards ("Name.member" in
 * expressions, which reads like one of the plugin's expressions once the name
 * is gone). validate_project reports the others as missing-behavior-or-variable,
 * except a behavior named under the legacy "behavior-type" key, which it reports
 * as legacy-behavior-key. Empty when nothing is left behind.
 */
function removalForcedWarnings(entity: string, uses: MemberReference[]): string[] {
  if (uses.length === 0) return [];
  const warnings = [`Removed although events still use it: ${describeMemberReferences(entity, uses)}. The uses were NOT changed.`];
  const unreported = uses.filter(u => u.form === 'member-expression');
  if (unreported.length > 0) {
    const where = [...new Set(unreported.map(useLocation))];
    const reportedAs = [
      ...(uses.some(u => u.form !== 'member-expression' && u.form !== 'legacy-behavior-type') ? ['missing-behavior-or-variable'] : []),
      ...(uses.some(u => u.form === 'legacy-behavior-type') ? ['legacy-behavior-key (the "behavior-type" key)'] : []),
    ];
    const others = reportedAs.length > 0 ? `reports the other uses as ${reportedAs.join(' or ')}, but ` : '';
    warnings.push(`validate_project ${others}will not report the ${unreported.length} use(s) written as "Name.member" or "Self.member" ` +
      `in expressions (${listSome(where)}), which it cannot tell apart from the plugin's own expressions: fix them now.`);
  }
  return warnings;
}

/**
 * Not found, for update_object_properties / update_family: names that differ
 * only in letter case get their own hint, since the name must be the
 * registered one.
 */
function entityNotFound(
  kind: 'Object' | 'Family', name: string, registered: string[], suggestions: string[], listTool: string,
): ReturnType<typeof toolError> {
  const sameIgnoringCase = registered.find(n => n.toLowerCase() === name.toLowerCase());
  if (sameIgnoringCase !== undefined) {
    return toolError(`${kind} "${name}" not found: names are matched with their letter case. Did you mean "${sameIgnoringCase}"?`);
  }
  return notFoundError(kind, name, suggestions, listTool);
}

/** Event uses as listed in a refusal: where and how. */
function eventUseList(events: ObjectReference[]): Array<Pick<ObjectReference, 'eventSheet' | 'path' | 'context'>> {
  return events.map(({ eventSheet, path, context }) => ({ eventSheet, path, context }));
}

/** The uses behind a delete_object refusal, bounded to MAX_LISTED_USES per kind. */
function usageDetails(usage: ObjectUsage): Record<string, unknown> {
  return boundedLists({
    events: eventUseList(usage.events),
    instances: usage.placements,
    instanceProperties: usage.instanceProperties,
  });
}

/** Each list cut to MAX_LISTED_USES entries, with `<kind>NotListed` counting the rest. */
function boundedLists(lists: Record<string, unknown[]>): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const [kind, list] of Object.entries(lists)) {
    details[kind] = list.slice(0, MAX_LISTED_USES);
    if (list.length > MAX_LISTED_USES) details[`${kind}NotListed`] = list.length - MAX_LISTED_USES;
  }
  return details;
}

/**
 * The force-delete warning for the uses validate_project cannot report
 * afterwards (it reports the other leftovers as broken-object-reference and
 * missing-behavior-or-variable): uses in expressions and scripts, which are
 * recognised by the names of existing objects only, and the uses of a
 * family's instance variables and behaviors through its members written as
 * "Member.name" in expressions (`memberUses`: the caller passes only those).
 * Empty when there are none.
 */
function unreportedUsesWarning(events: ObjectReference[], memberUses: FamilyMemberUse[] = []): string {
  const inCode = events.filter(r => r.context === 'expression' || r.context === 'script');
  if (inCode.length === 0 && memberUses.length === 0) return '';
  const counts: string[] = [];
  if (inCode.length > 0) counts.push(`${inCode.length} use(s) in expressions and scripts`);
  if (memberUses.length > 0) {
    counts.push(`${memberUses.length} use(s) of its instance variables and behaviors through members written as "Member.name" in expressions`);
  }
  const where = [...new Set([...inCode, ...memberUses].map(useLocation))];
  return `validate_project will not report its ${counts.join(' and ')} (${listSome(where)}): fix them now.`;
}

/** How the layout instances of one object type change (see syncInstanceBehaviors). */
interface InstanceSyncPlan {
  /** Behaviors the object's instances carry entries for, after the change */
  expected: InstanceBehavior[];
  /**
   * Behavior names the change added. Every expected entry an instance lacks
   * gets added; only those for other names are reported as missing before
   * the change.
   */
  add?: string[];
  /** Behavior names whose entries are removed unless still expected */
  drop?: string[];
}

/**
 * Update all layout instances (on every layer and sub-layer, and in
 * nonworld-instances) of the object types in `plans`: make sure they have
 * the `behaviors` and `instanceVariables` dicts C3 expects, give them a
 * default entry for every expected behavior they lack, and drop the entries
 * named in the plan's `drop` that are no longer expected. The editor stores
 * an entry for every behavior of the object and its families on each
 * instance, so besides the entries for behaviors the change added (`add`),
 * entries missing before the change are added too: older versions of these
 * tools wrote instances without them, and a hand edit can leave one out.
 * Existing entries keep their values and their saved order.
 *
 * Returns warnings naming the modified layouts, the entries that were missing
 * before the change, and any behavior that got an empty entry because its
 * defaults are not known.
 */
async function syncLayoutInstances(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  plans: ReadonlyMap<string, InstanceSyncPlan>,
  /** Filled with each layout as it is written, so a caller can report a partial write */
  modifiedLayouts: string[] = [],
): Promise<{ warnings: string[] }> {
  const layouts = await reader.readAllLayouts();
  const unknownDefaults: InstanceBehavior[] = [];
  /** Per object type: instances that lacked entries the change did not add, and those behavior names */
  const backfilled = new Map<string, { instances: number; names: Set<string> }>();

  for (const [layoutName, layout] of layouts) {
    let modified = false;
    const visit = (instance: Instance) => {
      const plan = plans.get(instance.type);
      if (!plan) return;
      modified = ensureInstanceFields(instance) || modified;
      const synced = syncInstanceBehaviors(instance, plan.expected, {
        add: plan.expected.map(b => b.name),
        drop: plan.drop,
      });
      modified = synced.modified || modified;
      unknownDefaults.push(...synced.unknownDefaults);
      const missingBefore = synced.added.filter(name => !(plan.add ?? []).includes(name));
      if (missingBefore.length > 0) {
        const entry = backfilled.get(instance.type) ?? { instances: 0, names: new Set<string>() };
        entry.instances++;
        for (const name of missingBefore) entry.names.add(name);
        backfilled.set(instance.type, entry);
      }
    };

    forEachLayoutInstance(layout, visit);

    if (modified) {
      const subfolder = writer.getSubfolderForEntity('layouts', layoutName);
      await writer.writeEntityFile('layouts', layoutName, layout, subfolder);
      modifiedLayouts.push(layoutName);
    }
  }

  const warnings: string[] = [];
  if (modifiedLayouts.length > 0) {
    warnings.push(`Updated instances in layout(s): ${modifiedLayouts.join(', ')}`);
  }
  for (const [objectType, entry] of backfilled) {
    const expected = plans.get(objectType)?.expected ?? [];
    const names = expected.map(b => b.name).filter(name => entry.names.has(name));
    warnings.push(`Also added default entries for behavior(s) ${names.map(n => `"${n}"`).join(', ')} to ${entry.instances} instance(s) of "${objectType}" `
      + 'that had none (written by an older version of construct3-mcp or edited by hand). Construct 3 stores an entry for every behavior of the object and its families on each instance.');
  }
  if (unknownDefaults.length > 0) warnings.push(unknownDefaultsWarning(unknownDefaults));
  return { warnings };
}

/**
 * Sync plans for family members whose family behaviors changed: members that
 * joined get entries for `familyBehaviors`, members that left (or whose
 * family was deleted) lose them. `families` is the project's families after
 * the change.
 */
async function familyMemberPlans(
  reader: Construct3ProjectReader,
  families: ReadonlyMap<string, unknown>,
  changes: Array<{ member: string; joined: boolean }>,
  familyBehaviors: string[],
): Promise<Map<string, InstanceSyncPlan>> {
  const memberObjects = await readMemberObjects(reader, changes.map(c => c.member));
  const plans = new Map<string, InstanceSyncPlan>();
  for (const { member, joined } of changes) {
    const obj = memberObjects.get(member);
    if (!obj) continue; // missing object type: it has no instances to update
    plans.set(member, {
      expected: expectedInstanceBehaviors(member, obj, families),
      ...(joined ? { add: familyBehaviors } : { drop: familyBehaviors }),
    });
  }
  return plans;
}

/** How the behavior entries of one family member's instances change in an update_family. */
interface MemberSyncChange {
  member: string;
  /** Behavior names the member gains */
  add?: string[];
  /** Behavior names the member loses */
  drop?: string[];
}

/**
 * Sync plans for family members after an update_family: each change names the
 * behavior entries the member's instances gain (`add`) and lose (`drop`).
 * `families` is the project's families after the change.
 */
async function memberSyncPlans(
  reader: Construct3ProjectReader,
  families: ReadonlyMap<string, unknown>,
  changes: MemberSyncChange[],
): Promise<Map<string, InstanceSyncPlan>> {
  const memberObjects = await readMemberObjects(reader, changes.map(c => c.member));
  const plans = new Map<string, InstanceSyncPlan>();
  for (const { member, add, drop } of changes) {
    const obj = memberObjects.get(member);
    if (!obj) continue; // missing object type: it has no instances to update
    plans.set(member, {
      expected: expectedInstanceBehaviors(member, obj, families),
      ...(add !== undefined ? { add } : {}),
      ...(drop !== undefined ? { drop } : {}),
    });
  }
  return plans;
}

/** Construct behavior names: the default for 8 Direction is "8Direction". */
const BEHAVIOR_NAME = /^[A-Za-z0-9_][A-Za-z0-9_ ]*$/;

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

/** The given object types that exist, by name (missing ones are left out). */
async function readMemberObjects(
  reader: Construct3ProjectReader,
  names: Iterable<string>,
): Promise<Map<string, Record<string, unknown>>> {
  const objects = new Map<string, Record<string, unknown>>();
  for (const name of new Set(names)) {
    try {
      objects.set(name, await reader.readObjectType(name) as unknown as Record<string, unknown>);
    } catch {
      // Missing member: reported separately where it matters
    }
  }
  return objects;
}
