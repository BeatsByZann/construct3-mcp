/**
 * Event sheet tools: create_event_sheet, add_event_to_sheet, add_event_block, delete_event_sheet.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { C3Event, EventSheet, FunctionBlockEvent, WriteResult } from '../construct3/types.js';
import { validateName, validateSubfolder, toolResult, toolError, notFoundError, orphanedFileError, boundedRecord } from './shared.js';
import {
  conditionSchema,
  actionSchema,
  childEventSchema,
  findGroupByPath,
  validateObjectClasses,
  collectObjectRefs,
  buildBlockEvent,
  buildCondition,
  buildAction,
  actionObjectRefs,
  isElseBlock,
  isElseCondition,
  normalizeLegacyBlock,
  reassignSids,
  findEventBySid,
  countDescendants,
  summarizeEvents,
  toScriptLines,
  validateLocator,
  resolveContainer,
  commitContainer,
  insertIntoContainer,
  collectSubtree,
  MAX_ITEMS_PER_BLOCK,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_NODES,
  type ResolvedContainer,
} from './event-helpers.js';
import { getProjectIndex, resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  createEmptySheet,
  createVariableEvent,
  createGroupEvent,
  createFunctionEvent,
  createIncludeEvent,
  createCommentEvent,
  createCustomActionEvent,
} from '../construct3/templates.js';

/** RGBA color as C3 serializes it on groups and comments: four 0-1 numbers. */
const colorSchema = z.array(z.number().min(0).max(1)).length(4);

/**
 * Visit an event and every descendant, iteratively, with the same node and
 * depth guards findEventBySid uses.
 */
function walkEvents(
  events: Record<string, unknown>[],
  visit: (event: Record<string, unknown>) => void,
): void {
  const stack: Array<{ events: Record<string, unknown>[]; depth: number }> = [{ events, depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const { events: current, depth } = stack.pop()!;
    if (depth > MAX_SEARCH_DEPTH) continue;
    for (const event of current) {
      if (++nodeCount > MAX_SEARCH_NODES) {
        throw new Error(`Event walk exceeded ${MAX_SEARCH_NODES} nodes`);
      }
      visit(event);
      if (Array.isArray(event.children)) {
        stack.push({ events: event.children as Record<string, unknown>[], depth: depth + 1 });
      }
    }
  }
}

/** Event types that hold conditions and actions. */
const BLOCK_LIKE = new Set(['block', 'function-block', 'custom-ace-block']);

/** Escape a name for safe use inside a RegExp literal. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function registerEventTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_event_sheet ───────────────────────────────────

  server.tool(
    'create_event_sheet',
    'Create a new event sheet in the project',
    {
      name: z.string().max(200).describe('Event sheet name'),
      subfolder: z.string().max(500).optional().describe('Subfolder path'),
      includeSheets: z.array(z.string()).optional().describe('Event sheets to auto-include'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Check uniqueness
        const existing = await reader.listEventSheets();
        if (existing.includes(args.name)) {
          return toolError(`Event sheet "${args.name}" already exists.`);
        }

        // Validate include sheets exist
        if (args.includeSheets) {
          for (const sheet of args.includeSheets) {
            if (!existing.includes(sheet)) {
              return toolError(`Include sheet "${sheet}" does not exist. Use list_eventsheets to see available sheets.`);
            }
          }
        }

        const sid = await idGen.generateSid(reader);
        const data = createEmptySheet(args.name, sid);

        // Add include events
        if (args.includeSheets) {
          for (const sheet of args.includeSheets) {
            data.events.push(createIncludeEvent(sheet));
          }
        }

        await writer.writeEntityFile('eventSheets', args.name, data, args.subfolder);
        await writer.addToProject('eventSheets', args.name, args.subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'eventsheet',
          action: 'created',
          generatedSid: sid,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_event_sheet] failed:', error);
        return toolError(`Error creating event sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_event_to_sheet ───────────────────────────────────

  server.tool(
    'add_event_to_sheet',
    'Add an event (group, function, variable, include, comment, or script block) to an event sheet',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      eventType: z.enum(['group', 'function', 'variable', 'include', 'comment', 'script']).describe('Type of event to add; "script" adds a standalone JavaScript block (C3 stores it without a SID)'),
      title: z.string().max(500).optional().describe('For groups: the group title'),
      functionName: z.string().max(200).optional().describe('For functions: function name'),
      functionParams: z.array(z.object({
        name: z.string().describe('Parameter name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Parameter type'),
      })).optional().describe('For functions: parameter definitions'),
      functionReturnType: z.enum(['none', 'number', 'string', 'any']).optional()
        .describe('For functions: return type (default: none)'),
      functionIsAsync: z.boolean().optional().describe('For functions: mark as async (default: false)'),
      functionCopyPicked: z.boolean().optional().describe('For functions: copy picked instances into the function (default: false)'),
      variableName: z.string().max(200).optional().describe('For variables: variable name'),
      variableType: z.enum(['number', 'string', 'boolean']).optional().describe('For variables: variable type'),
      initialValue: z.string().max(500).optional().default('').describe('For variables: initial value'),
      variableComment: z.string().max(2000).optional().describe('For variables: the declaration comment'),
      variableIsStatic: z.boolean().optional().describe('For local variables: keep the value between runs of the event'),
      variableIsConstant: z.boolean().optional().describe('For variables: constant'),
      script: z.union([z.string().max(200_000), z.array(z.string().max(10_000)).max(10_000)]).optional()
        .describe('For script blocks: JavaScript as one string (split on newlines) or an array of lines'),
      includeSheet: z.string().max(200).optional().describe('For includes: sheet name to include'),
      commentText: z.string().max(2000).optional().describe('For comments: comment text'),
      groupPath: z.string().max(500).optional().describe('Insert inside a group by title path (e.g., "Movement > Collision")'),
      parentSid: z.number().int().positive().optional().describe('Insert inside this group, block, or function-block SID'),
      position: z.enum(['start', 'end']).optional().default('end').describe('Where to insert the event'),
    },
    async (args) => {
      try {
        const locatorError = validateLocator({
          groupPath: args.groupPath,
          parentSid: args.parentSid,
          position: args.position,
        });
        if (locatorError) return toolError(locatorError);

        // Read existing sheet — preserves ALL original events and fields
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const hasLocator = args.groupPath !== undefined || args.parentSid !== undefined;
        // C3 only ever serializes includes at the sheet root (verified against
        // a real project: 15 root includes, 0 nested), so refuse a nested one.
        if (hasLocator && args.eventType === 'include') {
          return toolError('Include events can only be added at the event-sheet root; omit groupPath and parentSid.');
        }

        // Resolve the destination before minting any SIDs so an invalid
        // locator leaves the sheet untouched.
        const resolution = resolveContainer(sheet.events as Record<string, unknown>[], args.sheetName, {
          groupPath: args.groupPath,
          parentSid: args.parentSid,
          position: args.position,
        });
        if ('error' in resolution) return toolError(resolution.error);
        const container = resolution.container;

        let event: C3Event;

        switch (args.eventType) {
          case 'group': {
            if (!args.title) return toolError('title is required for group events');
            const sid = await idGen.generateSid(reader);
            event = createGroupEvent(args.title, sid);
            break;
          }
          case 'function': {
            if (!args.functionName) return toolError('functionName is required for function events');
            const sid = await idGen.generateSid(reader);
            // Pre-generate real SIDs for each parameter before passing to the template.
            const paramsWithSids = args.functionParams
              ? await Promise.all(
                  args.functionParams.map(async (p) => ({
                    ...p,
                    sid: await idGen.generateSid(reader),
                  }))
                )
              : undefined;
            event = createFunctionEvent(args.functionName, sid, paramsWithSids, {
              returnType: args.functionReturnType,
              isAsync: args.functionIsAsync,
              copyPicked: args.functionCopyPicked,
            });
            break;
          }
          case 'variable': {
            if (!args.variableName) return toolError('variableName is required for variable events');
            const varType = args.variableType || 'number';
            const defaultValue = args.initialValue || (varType === 'number' ? '0' : varType === 'boolean' ? 'false' : '');
            const sid = await idGen.generateSid(reader);
            event = createVariableEvent(args.variableName, varType, defaultValue, sid);
            const variable = event as unknown as Record<string, unknown>;
            if (args.variableComment !== undefined) variable.comment = args.variableComment;
            if (args.variableIsStatic !== undefined) variable.isStatic = args.variableIsStatic;
            if (args.variableIsConstant !== undefined) variable.isConstant = args.variableIsConstant;
            break;
          }
          case 'include': {
            if (!args.includeSheet) return toolError('includeSheet is required for include events');
            const sheets = await reader.listEventSheets();
            if (!sheets.includes(args.includeSheet)) {
              return toolError(`Include sheet "${args.includeSheet}" does not exist.`);
            }
            event = createIncludeEvent(args.includeSheet);
            break;
          }
          case 'comment': {
            if (!args.commentText) return toolError('commentText is required for comment events');
            event = createCommentEvent(args.commentText);
            break;
          }
          case 'script': {
            if (args.script === undefined) return toolError('script is required for script blocks');
            // C3 r495 stores a standalone script block as { eventType, language, script: [lines] } with no SID.
            event = { eventType: 'script', language: 'javascript', script: toScriptLines(args.script) } as unknown as C3Event;
            break;
          }
        }

        commitContainer(container);
        insertIntoContainer(container, args.position, event as unknown as Record<string, unknown>);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_event_to_sheet] failed:', error);
        return toolError(`Error adding event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_event_block ──────────────────────────────────────

  server.tool(
    'add_event_block',
    'Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Supports sub-events, else blocks (a leading System "else" condition), OR blocks, disabled conditions and actions, function calls, custom action calls, action comments and script actions.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      conditions: z.array(conditionSchema).optional().default([]).describe('Conditions array (at least one required, unless isElse is true)'),
      actions: z.array(actionSchema).optional().default([]).describe('Actions array (standard actions or script actions)'),
      groupPath: z.string().max(500).optional().describe('Insert inside group by title path (e.g., "Movement > Collision")'),
      parentSid: z.number().int().positive().optional().describe('Insert as a sub-event under this block, function-block, or group SID'),
      siblingSid: z.number().int().positive().optional().describe('Insert beside this event SID; use position before or after'),
      position: z.enum(['start', 'end', 'before', 'after']).optional().default('end').describe('Where to insert the event block'),
      disabled: z.boolean().optional().default(false).describe('Create the event block disabled'),
      isElse: z.boolean().optional().default(false).describe('Make an else block: written as a leading System "else" condition; further conditions make it an else-if'),
      isOrBlock: z.boolean().optional().default(false).describe('Make an OR block: true when any condition is true'),
      children: z.array(childEventSchema).optional().default([]).describe('Sub-events nested inside this block (recursive, max depth 5, max 50 total events)'),
    },
    async (args) => {
      try {
        const locatorError = validateLocator({
          groupPath: args.groupPath,
          parentSid: args.parentSid,
          siblingSid: args.siblingSid,
          position: args.position,
        });
        if (locatorError) return toolError(locatorError);
        // Validate: non-else blocks must have at least one condition
        if (!args.isElse && args.conditions.length === 0) {
          return toolError('At least one condition is required (unless isElse is true).');
        }

        // Read the target event sheet
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        // Resolve the destination before minting any SIDs. This keeps invalid
        // locators side-effect free and supports root, group, parent-SID, and
        // sibling-SID insertion with one consistent target array.
        const events = sheet.events as Record<string, unknown>[];
        const resolution = resolveContainer(events, args.sheetName, {
          groupPath: args.groupPath,
          parentSid: args.parentSid,
          siblingSid: args.siblingSid,
          position: args.position,
        });
        if ('error' in resolution) return toolError(resolution.error);
        const container = resolution.container;

        // Collect all objectClass references from entire tree (parent + descendants)
        const allRefs: Array<{ objectClass: string; behaviorType?: string }> = [];
        collectObjectRefs(
          args.conditions,
          args.actions as Array<Record<string, unknown>>,
          args.children,
          allRefs,
        );

        const { errors, warnings } = await validateObjectClasses(reader, allRefs);
        if (errors.length > 0) {
          return toolError(`Object class validation failed:\n${errors.join('\n')}`);
        }

        // Build the block event recursively (handles children, SIDs, safety limits)
        const counter = { count: 0, warnings: [] as string[] };
        const blockEvent = await buildBlockEvent(
          reader,
          idGen,
          {
            conditions: args.conditions,
            actions: args.actions,
            disabled: args.disabled,
            isElse: args.isElse,
            isOrBlock: args.isOrBlock,
            children: args.children,
          },
          1,
          counter,
        );
        warnings.push(...counter.warnings);
        const blockSid = blockEvent.sid as number;

        // Commit deferred children-array creation only after all validation and
        // block construction have succeeded.
        commitContainer(container);
        insertIntoContainer(container, args.position, blockEvent as unknown as Record<string, unknown>);

        // Write back
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          generatedSid: blockSid,
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_event_block] failed:', error);
        return toolError(`Error adding event block: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_event_sheet ───────────────────────────────────

  server.tool(
    'delete_event_sheet',
    'Delete an event sheet from the project (checks references first)',
    {
      name: z.string().max(200).describe('Event sheet name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        // Verify the event sheet exists
        const existing = await reader.listEventSheets();
        if (!existing.includes(args.name)) {
          return notFoundError('Event sheet', args.name, reader.findNearestName(args.name, 'eventsheets'), 'list_eventsheets');
        }

        // Check references via project index
        const index = await getProjectIndex(reader);

        // 1. Sheets that include this one
        const includedBy = index.eventSheetIncludedBy.get(args.name) || [];

        // 2. Layouts bound to this event sheet
        const boundLayouts: string[] = [];
        for (const [layoutName, sheetName] of index.layoutToEventSheet) {
          if (sheetName === args.name) {
            boundLayouts.push(layoutName);
          }
        }

        const hasRefs = includedBy.length > 0 || boundLayouts.length > 0;

        if (hasRefs && !args.force) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'eventsheet',
            action: 'delete_blocked',
            message: 'Event sheet is still referenced. Use force=true to delete anyway (references will NOT be cleaned up).',
            references: {
              includedBy,
              boundLayouts,
            },
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          const refList = [...includedBy.map(s => `included by "${s}"`), ...boundLayouts.map(l => `bound to layout "${l}"`)];
          warnings.push(`Event sheet deleted but still referenced: ${refList.join(', ')}. References were NOT cleaned up.`);
        }

        // Capture the subfolder first: removeFromProject reloads project.c3proj,
        // after which the name is no longer resolvable.
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.name);
        // Deregister before deleting the file. A failure in the second step
        // then leaves an orphaned file (info-level) instead of a dangling
        // registration (a file-existence error).
        await writer.removeFromProject('eventSheets', args.name);
        let backupPath: string;
        try {
          backupPath = await writer.deleteEntityFile('eventSheets', args.name, subfolder);
        } catch (error) {
          console.error('[delete_event_sheet] file delete failed after deregistration:', error);
          return orphanedFileError('eventSheets', args.name, subfolder, error);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'eventsheet',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_event_sheet] failed:', error);
        return toolError(`Error deleting event sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_event_from_sheet ────────────────────────────────

  server.tool(
    'delete_event_from_sheet',
    'Delete an event from an event sheet by SID (for blocks, groups, variables, functions) or by includeSheet name (for includes). Use get_eventsheet_details to find SIDs.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      sid: z.number().int().positive().optional().describe('SID of the event to delete (for block, group, variable, function events)'),
      includeSheet: z.string().max(200).optional().describe('For removing includes: the included sheet name'),
      dryRun: z.boolean().optional().default(false).describe('If true, report what would be deleted without actually deleting'),
      force: z.boolean().optional().default(false).describe('If true, delete function-blocks even if they have callers'),
    },
    async (args) => {
      try {
        // Validate exactly one identifier
        if ((args.sid === undefined) === (args.includeSheet === undefined)) {
          return toolError('Specify exactly one of: sid (for blocks/groups/variables/functions) or includeSheet (for includes).');
        }

        // Read the event sheet
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const warnings: string[] = [];

        // ── Include deletion path ──
        if (args.includeSheet !== undefined) {
          const matchIndex = events.findIndex(
            e => e.eventType === 'include' && e.includeSheet === args.includeSheet,
          );

          if (matchIndex === -1) {
            const currentIncludes = events
              .filter(e => e.eventType === 'include')
              .map(e => e.includeSheet as string);
            const hint = currentIncludes.length > 0
              ? `\nIncludes in "${args.sheetName}": ${currentIncludes.join(', ')}`
              : `\nNo includes found in "${args.sheetName}".`;
            return toolError(`No include for sheet "${args.includeSheet}" found in "${args.sheetName}".${hint}`);
          }

          if (args.dryRun) {
            return toolResult({
              success: true,
              dryRun: true,
              entity: args.sheetName,
              category: 'eventsheet',
              action: 'would_delete',
              deletedType: 'include',
              deletedTarget: args.includeSheet,
            });
          }

          events.splice(matchIndex, 1);

          const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
          const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
          resetProjectIndex();

          return toolResult({
            success: true,
            entity: args.sheetName,
            category: 'eventsheet',
            action: 'updated',
            deletedType: 'include',
            deletedTarget: args.includeSheet,
            warnings: warnings.length > 0 ? warnings : undefined,
            backupFile: backupPath,
          });
        }

        // ── SID deletion path ──
        const found = findEventBySid(events, args.sid!);

        if (!found) {
          const summary = summarizeEvents(events);
          return toolError(
            `Event with SID ${args.sid} not found in sheet "${args.sheetName}".\n\n` +
            `Sheet "${args.sheetName}" contains ${events.length} top-level events:\n${summary}\n\n` +
            `Use get_eventsheet_details to see the full event tree with SIDs.`,
          );
        }

        const { event, parentArray, index } = found;
        const eventType = event.eventType as string;
        const childCount = countDescendants(event);

        // Check function-block references
        if (eventType === 'function-block' && !args.force) {
          const funcName = event.functionName as string;
          const projectIndex = await getProjectIndex(reader);
          const callers = projectIndex.functionCalls.get(funcName) || [];
          if (callers.length > 0) {
            return toolResult({
              success: false,
              entity: args.sheetName,
              category: 'eventsheet',
              action: 'delete_blocked',
              message: `Function "${funcName}" is called by ${callers.length} action(s). Use force=true to delete anyway.`,
              references: {
                callers: callers.map(c => ({ sheet: c.sheet, path: c.path })),
              },
            });
          }
        }

        // Report children for groups
        if (childCount > 0) {
          warnings.push(`Deleted ${eventType} contained ${childCount} child event(s) that were also removed.`);
        }

        if (args.dryRun) {
          return toolResult({
            success: true,
            dryRun: true,
            entity: args.sheetName,
            category: 'eventsheet',
            action: 'would_delete',
            deletedType: eventType,
            deletedSid: args.sid,
            childrenCount: childCount,
            ...(eventType === 'group' ? { deletedTitle: event.title as string } : {}),
            ...(eventType === 'function-block' ? { deletedFunction: event.functionName as string } : {}),
          });
        }

        parentArray.splice(index, 1);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult({
          ...result,
          deletedType: eventType,
          deletedSid: args.sid,
          childrenRemoved: childCount,
        });
      } catch (error) {
        console.error('[delete_event_from_sheet] failed:', error);
        return toolError(`Error deleting event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── remove_event_from_sheet ─────────────────────────────────

  server.tool(
    'remove_event_from_sheet',
    'Remove an include block from an event sheet by target sheet name. Use delete_event_from_sheet with a SID to remove other event types.',
    {
      sheetName: z.string().max(200).describe('Event sheet to modify'),
      includeSheet: z.string().max(200).describe('Name of the included sheet to remove'),
    },
    async (args) => {
      try {
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const before = events.length;
        const filtered = events.filter(
          e => !(e.eventType === 'include' && e.includeSheet === args.includeSheet),
        );
        const removed = before - filtered.length;

        if (removed === 0) {
          const currentIncludes = events
            .filter(e => e.eventType === 'include')
            .map(e => e.includeSheet as string);
          const hint = currentIncludes.length > 0
            ? `\nIncludes in "${args.sheetName}": ${currentIncludes.join(', ')}`
            : `\nNo includes found in "${args.sheetName}".`;
          return toolError(`No include for sheet "${args.includeSheet}" found in "${args.sheetName}".${hint}`);
        }

        sheet.events = filtered as unknown as C3Event[];

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        return toolResult({
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          removedCount: removed,
          removedInclude: args.includeSheet,
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[remove_event_from_sheet] failed:', error);
        return toolError(`Error removing include: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_event_block_action ───────────────────────────────

  server.tool(
    'update_event_block_action',
    'Replace parameters on a single action within an existing event block. Identify the block by SID and the action by its 0-based index. Use get_eventsheet_details to find SIDs and action indices.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      blockSid: z.number().int().positive().describe('SID of the block event containing the action'),
      actionIndex: z.number().int().min(0).describe('0-based index of the action to update'),
      parameters: boundedRecord().describe('New parameter values — replaces existing parameters entirely (max 100 keys, depth 6)'),
    },
    async (args) => {
      try {
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const found = findEventBySid(events, args.blockSid);

        if (!found) {
          const summary = summarizeEvents(events);
          return toolError(
            `Event with SID ${args.blockSid} not found in sheet "${args.sheetName}".\n\n` +
            `Sheet "${args.sheetName}" contains ${events.length} top-level events:\n${summary}\n\n` +
            `Use get_eventsheet_details to see the full event tree with SIDs.`,
          );
        }

        const { event } = found;
        const eventType = event.eventType as string;

        if (eventType !== 'block' && eventType !== 'function-block') {
          return toolError(`Event with SID ${args.blockSid} is a "${eventType}", not a block or function-block. Only block events have actions.`);
        }

        const actions = event.actions as Record<string, unknown>[];
        if (args.actionIndex < 0 || args.actionIndex >= actions.length) {
          return toolError(
            `Action index ${args.actionIndex} is out of range (block has ${actions.length} action(s), ` +
            `indices 0-${Math.max(0, actions.length - 1)}).`,
          );
        }

        const action = actions[args.actionIndex];
        action.parameters = args.parameters;

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        return toolResult({
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          updatedBlockSid: args.blockSid,
          updatedActionIndex: args.actionIndex,
          actionId: action.id,
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[update_event_block_action] failed:', error);
        return toolError(`Error updating action: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_events_between_sheets ──────────────────────────────

  server.tool(
    'move_events_between_sheets',
    'Copy (or move) top-level event blocks from one event sheet to another by SID. With deleteSource=true (move) SIDs and nested children are preserved; a copy gets fresh SIDs throughout, because SIDs must be unique in the project.',
    {
      sourceSheet: z.string().max(200).describe('Event sheet to copy/move events from'),
      targetSheet: z.string().max(200).describe('Event sheet to copy/move events into'),
      sids: z.array(z.number().int().positive()).min(1).describe('SIDs of the top-level events to copy/move'),
      deleteSource: z.boolean().optional().default(false).describe('If true, remove the events from the source sheet after copying (move semantics)'),
      targetGroupPath: z.string().max(500).optional().describe('Insert into a group in the target sheet by title path (e.g. "Movement > Collision")'),
      position: z.enum(['start', 'end']).optional().default('end').describe('Where to insert events in the target sheet or group'),
    },
    async (args) => {
      try {
        if (args.sourceSheet === args.targetSheet) {
          return toolError('sourceSheet and targetSheet must be different sheets.');
        }

        // Read source sheet
        let sourceSheetData: EventSheet;
        try {
          sourceSheetData = await reader.readEventSheet(args.sourceSheet);
        } catch {
          return notFoundError('Event sheet', args.sourceSheet, reader.findNearestName(args.sourceSheet, 'eventsheets'), 'list_eventsheets');
        }

        // Read target sheet
        let targetSheetData: EventSheet;
        try {
          targetSheetData = await reader.readEventSheet(args.targetSheet);
        } catch {
          return notFoundError('Event sheet', args.targetSheet, reader.findNearestName(args.targetSheet, 'eventsheets'), 'list_eventsheets');
        }

        const sourceEvents = sourceSheetData.events as Record<string, unknown>[];
        const targetEvents = targetSheetData.events as Record<string, unknown>[];

        // Find each requested SID in the source top-level events only
        const eventsToMove: Record<string, unknown>[] = [];
        const notFoundSids: number[] = [];

        for (const sid of args.sids) {
          const idx = sourceEvents.findIndex(e => e.sid === sid);
          if (idx === -1) {
            notFoundSids.push(sid);
          } else {
            eventsToMove.push(sourceEvents[idx]);
          }
        }

        if (notFoundSids.length > 0) {
          const summary = summarizeEvents(sourceEvents);
          return toolError(
            `SIDs not found as top-level events in "${args.sourceSheet}": ${notFoundSids.join(', ')}.\n\n` +
            `Only top-level events can be moved. Source sheet events:\n${summary}\n\n` +
            `Use get_eventsheet_details to see the full tree.`,
          );
        }

        // Determine target insertion array
        let insertTarget: Record<string, unknown>[];
        if (args.targetGroupPath) {
          const resolved = findGroupByPath(targetEvents, args.targetGroupPath);
          if (!resolved) {
            const topGroups = targetEvents
              .filter(e => e.eventType === 'group')
              .map(e => e.title as string);
            const hint = topGroups.length > 0
              ? `\nAvailable top-level groups in "${args.targetSheet}": ${topGroups.join(', ')}`
              : `\nNo groups found in "${args.targetSheet}".`;
            return toolError(`Group path "${args.targetGroupPath}" not found in "${args.targetSheet}".${hint}`);
          }
          insertTarget = resolved;
        } else {
          insertTarget = targetEvents;
        }

        // Deep-copy events to avoid reference aliasing between sheets
        const copiedEvents = eventsToMove.map(e => JSON.parse(JSON.stringify(e)) as Record<string, unknown>);
        let reassigned = 0;
        if (!args.deleteSource) {
          reassigned = await reassignSids(reader, idGen, copiedEvents);
        }

        // Insert into target
        if (args.position === 'start') {
          insertTarget.unshift(...copiedEvents);
        } else {
          insertTarget.push(...copiedEvents);
        }

        // If move semantics: remove from source
        if (args.deleteSource) {
          const sidSet = new Set(args.sids);
          sourceSheetData.events = sourceEvents.filter(e => !sidSet.has(e.sid as number)) as unknown as C3Event[];
        }

        // Write target sheet first, then source (if modified)
        const targetSubfolder = writer.getSubfolderForEntity('eventSheets', args.targetSheet);
        const targetBackup = await writer.writeEntityFile('eventSheets', args.targetSheet, targetSheetData, targetSubfolder);

        let sourceBackup: string | undefined;
        if (args.deleteSource) {
          const sourceSubfolder = writer.getSubfolderForEntity('eventSheets', args.sourceSheet);
          sourceBackup = await writer.writeEntityFile('eventSheets', args.sourceSheet, sourceSheetData, sourceSubfolder);
        }

        resetProjectIndex();

        return toolResult({
          success: true,
          sourceSheet: args.sourceSheet,
          targetSheet: args.targetSheet,
          movedSids: args.sids,
          movedCount: eventsToMove.length,
          deleteSource: args.deleteSource,
          copiedTopLevelSids: args.deleteSource ? undefined : copiedEvents.map(e => e.sid),
          reassignedSids: args.deleteSource ? undefined : reassigned,
          backupFiles: [targetBackup, ...(sourceBackup ? [sourceBackup] : [])].filter(Boolean),
        });
      } catch (error) {
        console.error('[move_events_between_sheets] failed:', error);
        return toolError(`Error moving events: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_event_block_items ────────────────────────────────

  server.tool(
    'move_event_block_items',
    'Move or reorder actions or conditions within and between block events. Existing item SIDs are preserved.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      sourceBlockSid: z.number().int().positive().describe('SID of the source block or function-block'),
      targetBlockSid: z.number().int().positive().describe('SID of the target block or function-block'),
      itemType: z.enum(['actions', 'conditions']).describe('Array to move: actions or conditions'),
      indices: z.array(z.number().int().min(0)).min(1).describe('Source indexes to move, in their existing order'),
      targetIndex: z.number().int().min(0).describe('Destination index; for same-block moves, measured after removal'),
    },
    async (args) => {
      try {
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const sourceFound = findEventBySid(events, args.sourceBlockSid);
        const targetFound = findEventBySid(events, args.targetBlockSid);
        if (!sourceFound) return toolError(`Source block with SID ${args.sourceBlockSid} not found in sheet "${args.sheetName}".`);
        if (!targetFound) return toolError(`Target block with SID ${args.targetBlockSid} not found in sheet "${args.sheetName}".`);
        const sourceType = sourceFound.event.eventType as string;
        const targetType = targetFound.event.eventType as string;
        if (!BLOCK_LIKE.has(sourceType)) {
          return toolError(`Source event with SID ${args.sourceBlockSid} is a "${sourceType}", not a block, function-block or custom action.`);
        }
        if (!BLOCK_LIKE.has(targetType)) {
          return toolError(`Target event with SID ${args.targetBlockSid} is a "${targetType}", not a block, function-block or custom action.`);
        }
        if (args.itemType === 'conditions' && args.targetIndex === 0 && isElseBlock(targetFound.event)) {
          return toolError('The else condition must stay first in an else block; use targetIndex 1 or later.');
        }

        const sourceItems = sourceFound.event[args.itemType];
        const targetItems = targetFound.event[args.itemType];
        if (!Array.isArray(sourceItems) || !Array.isArray(targetItems)) {
          return toolError(`Source or target block has no ${args.itemType} array.`);
        }
        const uniqueIndices = [...new Set(args.indices)];
        if (uniqueIndices.length !== args.indices.length) {
          return toolError('Move indexes must be unique.');
        }
        if (uniqueIndices.some(index => index >= sourceItems.length)) {
          return toolError(`Move index is out of range (source has ${sourceItems.length} ${args.itemType}).`);
        }
        const orderedIndices = [...uniqueIndices].sort((a, b) => a - b);
        const selected = orderedIndices.map(index => sourceItems[index]);
        const remainingLength = sourceFound.event === targetFound.event
          ? sourceItems.length - selected.length
          : targetItems.length;
        if (args.targetIndex > remainingLength) {
          return toolError(`targetIndex ${args.targetIndex} is out of range (valid range 0-${remainingLength}).`);
        }
        if (sourceFound.event !== targetFound.event && targetItems.length + selected.length > MAX_ITEMS_PER_BLOCK) {
          return toolError(`Target block would exceed the maximum of ${MAX_ITEMS_PER_BLOCK} ${args.itemType}.`);
        }

        const warnings: string[] = [];

        if (sourceFound.event === targetFound.event) {
          const selectedSet = new Set(orderedIndices);
          const remaining = sourceItems.filter((_item, index) => !selectedSet.has(index));
          remaining.splice(args.targetIndex, 0, ...selected);
          sourceFound.event[args.itemType] = remaining;
        } else {
          for (let i = orderedIndices.length - 1; i >= 0; i--) {
            sourceItems.splice(orderedIndices[i], 1);
          }
          targetItems.splice(args.targetIndex, 0, ...selected);
          if (args.itemType === 'conditions' && sourceItems.length === 0 && !isElseBlock(sourceFound.event)) {
            warnings.push('All conditions were removed — block will match unconditionally (always true).');
          }
        }

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();
        return toolResult({
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          sourceBlockSid: args.sourceBlockSid,
          targetBlockSid: args.targetBlockSid,
          itemType: args.itemType,
          movedSids: selected.map(item => item.sid).filter((sid): sid is number => typeof sid === 'number'),
          targetIndex: args.targetIndex,
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[move_event_block_items] failed:', error);
        return toolError(`Error moving event block items: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_event_block ─────────────────────────────────────

  server.tool(
    'update_event_block',
    'Update an existing block, function-block or custom action body in an event sheet — modify action parameters, call arguments and comment rows, add/remove actions or conditions, toggle disabled state and OR mode. Identify the block by its SID (use get_eventsheet_details to find it).',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      sid: z.number().int().positive().describe('SID of the block, function-block or custom-ace-block to update'),
      disabled: z.boolean().optional().describe('Enable or disable the entire block'),
      isOrBlock: z.boolean().optional().describe('Make the block an OR block (true) or an AND block (false)'),
      updateActions: z.array(z.object({
        index: z.number().int().min(0).describe('Action index (0-based)'),
        parameters: boundedRecord().optional().describe('New parameter values — merged with existing (max 100 keys, depth 6); for standard actions'),
        arguments: z.array(z.string().max(50_000)).max(100).optional().describe('Replacement positional arguments for a function call or custom action call'),
        text: z.string().max(10_000).optional().describe('New text for an action comment'),
        textColor: z.array(z.number().min(0).max(1)).length(4).optional().describe('Action comment text color [r,g,b,a]'),
        backgroundColor: z.array(z.number().min(0).max(1)).length(4).optional().describe('Action comment background color [r,g,b,a]'),
        disabled: z.boolean().optional().describe('Enable or disable this action'),
      })).optional().describe('Actions to update by index'),
      updateConditions: z.array(z.object({
        index: z.number().int().min(0).describe('Condition index (0-based)'),
        parameters: boundedRecord().optional().describe('New parameter values — merged with existing (max 100 keys, depth 6)'),
        isInverted: z.boolean().optional().describe('Toggle inversion'),
        disabled: z.boolean().optional().describe('Enable or disable this condition'),
      })).optional().describe('Conditions to update by index'),
      insertActions: z.array(z.object({
        index: z.number().int().min(0).describe('Insertion index (0-based, after removals)'),
        action: actionSchema.describe('Action to insert'),
      })).optional().describe('Insert actions at indexes; duplicate indexes are rejected'),
      insertConditions: z.array(z.object({
        index: z.number().int().min(0).describe('Insertion index (0-based, after removals)'),
        condition: conditionSchema.describe('Condition to insert'),
      })).optional().describe('Insert conditions at indexes; duplicate indexes are rejected'),
      replaceConditions: z.array(z.object({
        index: z.number().int().min(0).describe('Condition index (0-based)'),
        condition: conditionSchema.describe('Replacement condition; a fresh SID is minted'),
      })).optional().describe('Replace condition ACEs in place'),
      addActions: z.array(actionSchema).optional().describe('Append new actions to the block'),
      addConditions: z.array(conditionSchema).optional().describe('Append new conditions to the block'),
      removeActionIndices: z.array(z.number().int().min(0)).optional().describe('Remove actions by index (0-based, applied before adds)'),
      removeConditionIndices: z.array(z.number().int().min(0)).optional().describe('Remove conditions by index (0-based, applied before adds)'),
    },
    async (args) => {
      try {
        // Validate at least one update is provided
        const hasUpdate = args.disabled !== undefined
          || args.isOrBlock !== undefined
          || (args.updateActions && args.updateActions.length > 0)
          || (args.updateConditions && args.updateConditions.length > 0)
          || (args.insertActions && args.insertActions.length > 0)
          || (args.insertConditions && args.insertConditions.length > 0)
          || (args.replaceConditions && args.replaceConditions.length > 0)
          || (args.addActions && args.addActions.length > 0)
          || (args.addConditions && args.addConditions.length > 0)
          || (args.removeActionIndices && args.removeActionIndices.length > 0)
          || (args.removeConditionIndices && args.removeConditionIndices.length > 0);

        if (!hasUpdate) {
          return toolError('No updates provided. Specify at least one of: disabled, isOrBlock, updateActions, updateConditions, insertActions, insertConditions, replaceConditions, addActions, addConditions, removeActionIndices, removeConditionIndices.');
        }

        // Read the event sheet
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const found = findEventBySid(events, args.sid);

        if (!found) {
          const summary = summarizeEvents(events);
          return toolError(
            `Event with SID ${args.sid} not found in sheet "${args.sheetName}".\n\n` +
            `Sheet "${args.sheetName}" contains ${events.length} top-level events:\n${summary}\n\n` +
            `Use get_eventsheet_details to see the full event tree with SIDs.`,
          );
        }

        const { event } = found;
        const eventType = event.eventType as string;

        // Must hold conditions and actions (not a group, variable, include, etc.)
        if (!BLOCK_LIKE.has(eventType)) {
          return toolError(`Event with SID ${args.sid} is a "${eventType}", not a block, function-block or custom action. Only those can be updated with this tool.`);
        }

        if (!Array.isArray(event.conditions) || !Array.isArray(event.actions)) {
          return toolError(`Event with SID ${args.sid} has malformed conditions/actions arrays and cannot be updated.`);
        }
        const conditions = event.conditions as Record<string, unknown>[];
        const actions = event.actions as Record<string, unknown>[];
        const warnings: string[] = [];
        const elseBlock = isElseBlock(event) && isElseCondition(conditions[0]);
        if (elseBlock) {
          if ((args.insertConditions ?? []).some(item => item.index === 0)) {
            return toolError('The else condition must stay first in an else block; insert at index 1 or later.');
          }
          if ((args.replaceConditions ?? []).some(item => item.index === 0) || (args.removeConditionIndices ?? []).includes(0)) {
            warnings.push('Condition 0 of this block is its else condition; replacing or removing it turns the block into an ordinary block.');
          }
        }
        for (const upd of args.updateActions ?? []) {
          const target = actions[upd.index];
          if (!target) continue;
          const isComment = target.type === 'comment';
          const isCall = typeof target.callFunction === 'string' || typeof target.customAction === 'string';
          if ((upd.text !== undefined || upd.textColor !== undefined || upd.backgroundColor !== undefined) && !isComment) {
            return toolError(`Action ${upd.index} is not an action comment; text and colors apply to comment rows only.`);
          }
          if (upd.arguments !== undefined && !isCall) {
            return toolError(`Action ${upd.index} is not a function or custom action call; use parameters for standard actions.`);
          }
          if (upd.parameters !== undefined && (isCall || isComment || target.type === 'script')) {
            return toolError(`Action ${upd.index} does not take keyed parameters; use arguments for calls or text for comments.`);
          }
        }

        // Preflight every index and structural conflict before mutating the
        // event. Existing update/remove indexes remain relative to the
        // original arrays; insertion indexes are relative to post-removal
        // arrays and are applied in descending order below.
        for (const upd of args.updateConditions ?? []) {
          if (upd.index >= conditions.length) {
            return toolError(`Condition index ${upd.index} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`);
          }
        }
        for (const upd of args.updateActions ?? []) {
          if (upd.index >= actions.length) {
            return toolError(`Action index ${upd.index} is out of range (block has ${actions.length} action(s), indices 0-${actions.length - 1}).`);
          }
        }
        const removedConditionSet = new Set(args.removeConditionIndices ?? []);
        const removedActionSet = new Set(args.removeActionIndices ?? []);
        const updatedConditionSet = new Set((args.updateConditions ?? []).map(update => update.index));
        const updatedActionSet = new Set((args.updateActions ?? []).map(update => update.index));
        if (updatedConditionSet.size !== (args.updateConditions ?? []).length || updatedActionSet.size !== (args.updateActions ?? []).length) {
          return toolError('Update indexes must be unique.');
        }
        if ([...updatedConditionSet].some(index => removedConditionSet.has(index)) || [...updatedActionSet].some(index => removedActionSet.has(index))) {
          return toolError('An item cannot be updated and removed in the same update.');
        }
        for (const index of removedConditionSet) {
          if (index >= conditions.length) {
            return toolError(`Condition index ${index} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`);
          }
        }
        for (const index of removedActionSet) {
          if (index >= actions.length) {
            return toolError(`Action index ${index} is out of range (block has ${actions.length} action(s), indices 0-${actions.length - 1}).`);
          }
        }
        const replacementConditionSet = new Set((args.replaceConditions ?? []).map(replacement => replacement.index));
        if (replacementConditionSet.size !== (args.replaceConditions ?? []).length) {
          return toolError('Replacement condition indexes must be unique.');
        }
        for (const replacement of args.replaceConditions ?? []) {
          if (replacement.index >= conditions.length) {
            return toolError(`Condition index ${replacement.index} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`);
          }
          if (removedConditionSet.has(replacement.index)) {
            return toolError(`Condition index ${replacement.index} cannot be replaced and removed in the same update.`);
          }
          if (updatedConditionSet.has(replacement.index)) {
            return toolError(`Condition index ${replacement.index} cannot be updated and replaced in the same update.`);
          }
        }
        const checkInsertionIndexes = (
          items: Array<{ index: number }> | undefined,
          length: number,
          removed: Set<number>,
          label: string,
        ): ReturnType<typeof toolError> | undefined => {
          if (!items || items.length === 0) return undefined;
          const indexes = items.map(item => item.index);
          if (new Set(indexes).size !== indexes.length) {
            return toolError(`${label} insertion indexes must be unique.`);
          }
          const postRemovalLength = length - removed.size;
          if (indexes.some(index => index > postRemovalLength)) {
            return toolError(`${label} insertion index is out of range after removals (valid range 0-${postRemovalLength}).`);
          }
          return undefined;
        };
        const conditionInsertError = checkInsertionIndexes(args.insertConditions, conditions.length, removedConditionSet, 'Condition');
        if (conditionInsertError) return conditionInsertError;
        const actionInsertError = checkInsertionIndexes(args.insertActions, actions.length, removedActionSet, 'Action');
        if (actionInsertError) return actionInsertError;
        const resultingConditionCount = conditions.length - removedConditionSet.size
          + (args.insertConditions?.length ?? 0) + (args.addConditions?.length ?? 0);
        const resultingActionCount = actions.length - removedActionSet.size
          + (args.insertActions?.length ?? 0) + (args.addActions?.length ?? 0);
        if (resultingConditionCount > MAX_ITEMS_PER_BLOCK || resultingActionCount > MAX_ITEMS_PER_BLOCK) {
          return toolError(`Updated block exceeds the maximum of ${MAX_ITEMS_PER_BLOCK} conditions and actions per block.`);
        }

        // Validate all newly introduced object references before changing the
        // event. Behavior types remain soft warnings; W67's behaviorType key
        // is the only serialized spelling used here.
        const newRefs: Array<{ objectClass: string; behaviorType?: string }> = [];
        for (const c of [...(args.insertConditions ?? []).map(item => item.condition), ...(args.replaceConditions ?? []).map(item => item.condition), ...(args.addConditions ?? [])]) {
          newRefs.push({ objectClass: c.objectClass, behaviorType: c.behaviorType });
        }
        for (const a of [...(args.insertActions ?? []).map(item => item.action), ...(args.addActions ?? [])]) {
          newRefs.push(...actionObjectRefs(a as Record<string, unknown>));
        }
        if (newRefs.length > 0) {
          const { errors, warnings: validationWarnings } = await validateObjectClasses(reader, newRefs);
          if (errors.length > 0) return toolError(`Object class validation failed:\n${errors.join('\n')}`);
          warnings.push(...validationWarnings);
        }

        // Rewrite unknown keys older builds wrote (isElse, condition isOr).
        if (await normalizeLegacyBlock(reader, idGen, event)) {
          warnings.push('The block carried keys older builds of this server wrote (isElse or condition-level isOr); they were rewritten to C3\'s else condition and isOrBlock.');
        }

        if (args.isOrBlock !== undefined) {
          if (args.isOrBlock) event.isOrBlock = true;
          else delete event.isOrBlock;
        }

        // ── Apply block-level disabled toggle ──
        if (args.disabled !== undefined) {
          if (args.disabled) {
            event.disabled = true;
          } else {
            delete event.disabled;
          }
        }

        // All index-based operations reference the ORIGINAL array positions.
        // Order: updates first (non-mutating on length), then removals (shrink array).
        // This ensures user-supplied indices are consistent across all operations.

        // ── Update existing conditions by index (merge parameters) ──
        if (args.updateConditions) {
          for (const upd of args.updateConditions) {
            if (upd.index < 0 || upd.index >= conditions.length) {
              return toolError(`Condition index ${upd.index} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`);
            }
            const cond = conditions[upd.index];
            if (upd.parameters) {
              cond.parameters = { ...(cond.parameters as Record<string, unknown> || {}), ...upd.parameters };
            }
            if (upd.isInverted !== undefined) {
              if (upd.isInverted) {
                cond.isInverted = true;
              } else {
                delete cond.isInverted;
              }
            }
            if (upd.disabled !== undefined) {
              if (upd.disabled) {
                cond.disabled = true;
              } else {
                delete cond.disabled;
              }
            }
          }
        }

        // ── Update existing actions by index (merge parameters) ──
        if (args.updateActions) {
          for (const upd of args.updateActions) {
            if (upd.index < 0 || upd.index >= actions.length) {
              return toolError(`Action index ${upd.index} is out of range (block has ${actions.length} action(s), indices 0-${actions.length - 1}).`);
            }
            const act = actions[upd.index];
            if (upd.parameters) {
              act.parameters = { ...(act.parameters as Record<string, unknown> || {}), ...upd.parameters };
            }
            if (upd.arguments !== undefined) {
              if (upd.arguments.length > 0) act.parameters = upd.arguments;
              else delete act.parameters;
            }
            if (upd.text !== undefined) act.text = upd.text;
            if (upd.textColor !== undefined) act['text-color'] = upd.textColor;
            if (upd.backgroundColor !== undefined) act['background-color'] = upd.backgroundColor;
            if (upd.disabled !== undefined) {
              if (upd.disabled) {
                act.disabled = true;
              } else {
                delete act.disabled;
              }
            }
          }
        }

        // ── Replace condition ACEs in place (fresh SID, same array index) ──
        if (args.replaceConditions) {
          for (const replacement of args.replaceConditions) {
            conditions[replacement.index] = await buildCondition(reader, idGen, replacement.condition) as unknown as Record<string, unknown>;
          }
        }

        // ── Remove conditions by index (descending order to avoid index shifting) ──
        if (args.removeConditionIndices && args.removeConditionIndices.length > 0) {
          const sorted = [...new Set(args.removeConditionIndices)].sort((a, b) => b - a);
          for (const idx of sorted) {
            if (idx < 0 || idx >= conditions.length) {
              return toolError(`Condition index ${idx} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`);
            }
            conditions.splice(idx, 1);
          }
        }

        // ── Remove actions by index (descending order) ──
        if (args.removeActionIndices && args.removeActionIndices.length > 0) {
          const sorted = [...new Set(args.removeActionIndices)].sort((a, b) => b - a);
          for (const idx of sorted) {
            if (idx < 0 || idx >= actions.length) {
              return toolError(`Action index ${idx} is out of range (block has ${actions.length} action(s), indices 0-${actions.length - 1}).`);
            }
            actions.splice(idx, 1);
          }
        }

        // ── Insert new conditions/actions at post-removal indexes ──
        if (args.insertConditions && args.insertConditions.length > 0) {
          const sorted = [...args.insertConditions].sort((a, b) => b.index - a.index);
          for (const insertion of sorted) {
            const built = await buildCondition(reader, idGen, insertion.condition);
            conditions.splice(insertion.index, 0, built as unknown as Record<string, unknown>);
          }
        }
        if (args.insertActions && args.insertActions.length > 0) {
          const sorted = [...args.insertActions].sort((a, b) => b.index - a.index);
          for (const insertion of sorted) {
            const built = await buildAction(reader, idGen, insertion.action, warnings);
            actions.splice(insertion.index, 0, built as unknown as Record<string, unknown>);
          }
        }

        // ── Add new conditions ──
        if (args.addConditions && args.addConditions.length > 0) {
          // Validate objectClasses
          const refs = args.addConditions.map(c => ({
            objectClass: c.objectClass,
            behaviorType: c.behaviorType,
          }));
          const { errors, warnings: valWarnings } = await validateObjectClasses(reader, refs);
          if (errors.length > 0) {
            return toolError(`Object class validation failed:\n${errors.join('\n')}`);
          }
          warnings.push(...valWarnings);

          for (const c of args.addConditions) {
            conditions.push(await buildCondition(reader, idGen, c) as unknown as Record<string, unknown>);
          }
        }

        // ── Add new actions ──
        if (args.addActions && args.addActions.length > 0) {
          // Validate objectClasses for standard actions
          const refs: Array<{ objectClass: string; behaviorType?: string }> = [];
          for (const a of args.addActions) {
            refs.push(...actionObjectRefs(a as Record<string, unknown>));
          }
          if (refs.length > 0) {
            const { errors, warnings: valWarnings } = await validateObjectClasses(reader, refs);
            if (errors.length > 0) {
              return toolError(`Object class validation failed:\n${errors.join('\n')}`);
            }
            warnings.push(...valWarnings);
          }

          for (const a of args.addActions) {
            actions.push(await buildAction(reader, idGen, a, warnings) as unknown as Record<string, unknown>);
          }
        }

        if (conditions.length > MAX_ITEMS_PER_BLOCK || actions.length > MAX_ITEMS_PER_BLOCK) {
          return toolError(`Updated block exceeds the maximum of ${MAX_ITEMS_PER_BLOCK} conditions and actions per block.`);
        }

        if (event.isOrBlock && conditions.filter(c => !isElseCondition(c)).length < 2) {
          warnings.push('The block is an OR block with fewer than two conditions; OR has no effect until another condition is added.');
        }

        // Warn if all conditions were removed (checked after adds, not just removals)
        if (conditions.length === 0 && eventType === 'block') {
          warnings.push('All conditions were removed — block will match unconditionally (always true).');
        }

        // Write back
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_event_block] failed:', error);
        return toolError(`Error updating event block: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_custom_action ──────────────────────────────────────

  server.tool(
    'add_custom_action',
    'Add a custom action definition (eventType "custom-ace-block") to an event sheet. A custom action belongs to an object type or family, not to System. Conditions and actions are added afterwards with update_event_block using the returned SID.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      objectClass: z.string().max(200).describe('Object type or family that owns the custom action'),
      aceName: z.string().max(200).describe('Custom action name as it appears in the editor (spaces and punctuation allowed)'),
      description: z.string().max(2000).optional().describe('functionDescription'),
      category: z.string().max(200).optional().describe('functionCategory — the editor grouping, e.g. "_AI_Behavior Tree"'),
      returnType: z.enum(['none', 'number', 'string', 'any']).optional().describe('functionReturnType (default: none)'),
      isAsync: z.boolean().optional().describe('functionIsAsync (default: false)'),
      copyPicked: z.boolean().optional().describe('functionCopyPicked (default: false)'),
      parameters: z.array(z.object({
        name: z.string().max(200).describe('Parameter name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Parameter type'),
        initialValue: z.string().max(500).optional().describe('Default value (defaults by type)'),
        comment: z.string().max(500).optional().describe('Parameter comment'),
      })).optional().describe('Parameter definitions, in call order'),
      groupPath: z.string().max(500).optional().describe('Insert inside a group by title path (e.g., "Movement > Collision")'),
      parentSid: z.number().int().positive().optional().describe('Insert inside this group, block, or function-block SID'),
      siblingSid: z.number().int().positive().optional().describe('Insert beside this event SID; requires position before or after'),
      position: z.enum(['start', 'end', 'before', 'after']).optional().default('end').describe('Where to insert the definition'),
    },
    async (args) => {
      try {
        const locatorError = validateLocator({
          groupPath: args.groupPath,
          parentSid: args.parentSid,
          siblingSid: args.siblingSid,
          position: args.position,
        });
        if (locatorError) return toolError(locatorError);
        if (args.aceName.trim().length === 0) {
          return toolError('aceName cannot be empty.');
        }

        // A custom ACE hangs off an object type or family; "System" has no
        // custom actions, so validateObjectClasses' System allowance is too
        // permissive here.
        const objects = await reader.listObjectTypes();
        const families = await reader.listFamilies();
        if (!objects.includes(args.objectClass) && !families.includes(args.objectClass)) {
          const suggestions = reader.findNearestName(args.objectClass, 'objects');
          const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
          return toolError(`Unknown objectClass "${args.objectClass}". A custom action must belong to an object type or family, not System.${hint}`);
        }

        const parameterNames = (args.parameters ?? []).map(p => p.name);
        if (new Set(parameterNames).size !== parameterNames.length) {
          return toolError('Parameter names must be unique.');
        }
        if (parameterNames.some(name => name.trim().length === 0)) {
          return toolError('Parameter name cannot be empty.');
        }
        if (parameterNames.length > MAX_ITEMS_PER_BLOCK) {
          return toolError(`Custom action has ${parameterNames.length} parameters (max ${MAX_ITEMS_PER_BLOCK}).`);
        }

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        // The editor keys a custom ACE by object class plus name, so refuse a
        // duplicate anywhere in the project.
        for (const name of await reader.listEventSheets()) {
          const data = name === args.sheetName ? sheet : await reader.readEventSheet(name).catch(() => null);
          if (!data) continue;
          let clash = false;
          walkEvents(data.events as Record<string, unknown>[], event => {
            if (event.eventType === 'custom-ace-block'
              && event.objectClass === args.objectClass
              && event.aceName === args.aceName) {
              clash = true;
            }
          });
          if (clash) {
            return toolError(`"${args.objectClass}" already defines a custom action named "${args.aceName}" (in sheet "${name}").`);
          }
        }

        const events = sheet.events as Record<string, unknown>[];
        const resolution = resolveContainer(events, args.sheetName, {
          groupPath: args.groupPath,
          parentSid: args.parentSid,
          siblingSid: args.siblingSid,
          position: args.position,
        });
        if ('error' in resolution) return toolError(resolution.error);
        const container = resolution.container;

        const sid = await idGen.generateSid(reader);
        const paramsWithSids = args.parameters
          ? await Promise.all(args.parameters.map(async (p) => ({
              ...p,
              sid: await idGen.generateSid(reader),
            })))
          : undefined;
        const event = createCustomActionEvent(args.aceName, args.objectClass, sid, paramsWithSids, {
          description: args.description,
          category: args.category,
          returnType: args.returnType,
          isAsync: args.isAsync,
          copyPicked: args.copyPicked,
        });

        commitContainer(container);
        insertIntoContainer(container, args.position, event as unknown as Record<string, unknown>);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          generatedSid: sid,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_custom_action] failed:', error);
        return toolError(`Error adding custom action: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_event_block ───────────────────────────────────────

  server.tool(
    'move_event_block',
    'Move an existing event (block, group, variable, comment, function-block, custom-ace-block) to another container in the same event sheet. The event keeps its SID and every descendant. Use move_events_between_sheets to move top-level events across sheets.',
    {
      sheetName: z.string().max(200).describe('Event sheet containing the event'),
      sid: z.number().int().positive().describe('SID of the event to move'),
      groupPath: z.string().max(500).optional().describe('Move inside a group by title path (e.g., "Movement > Collision")'),
      parentSid: z.number().int().positive().optional().describe('Move inside this group, block, or function-block SID'),
      siblingSid: z.number().int().positive().optional().describe('Move beside this event SID; requires position before or after'),
      position: z.enum(['start', 'end', 'before', 'after']).optional().default('end').describe('Where to place the moved event'),
    },
    async (args) => {
      try {
        const locatorError = validateLocator({
          groupPath: args.groupPath,
          parentSid: args.parentSid,
          siblingSid: args.siblingSid,
          position: args.position,
        });
        if (locatorError) return toolError(locatorError);
        if (args.siblingSid !== undefined && args.siblingSid === args.sid) {
          return toolError(`siblingSid ${args.sid} is the event being moved; an event cannot be placed beside itself.`);
        }
        if (args.parentSid !== undefined && args.parentSid === args.sid) {
          return toolError(`parentSid ${args.sid} is the event being moved; an event cannot be placed inside itself.`);
        }

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const found = findEventBySid(events, args.sid);
        if (!found) {
          const summary = summarizeEvents(events);
          return toolError(
            `Event with SID ${args.sid} not found in sheet "${args.sheetName}".\n\n` +
            `Sheet "${args.sheetName}" contains ${events.length} top-level events:\n${summary}\n\n` +
            `Comments and includes carry no SID in C3 and cannot be moved with this tool. ` +
            `Use get_eventsheet_details to see the full event tree with SIDs.`,
          );
        }

        const moving = found.event;
        const movedType = moving.eventType as string;

        // Resolve the destination before detaching anything, so an invalid
        // locator leaves the sheet exactly as it was.
        const resolution = resolveContainer(events, args.sheetName, {
          groupPath: args.groupPath,
          parentSid: args.parentSid,
          siblingSid: args.siblingSid,
          position: args.position,
        });
        if ('error' in resolution) return toolError(resolution.error);
        const container: ResolvedContainer = resolution.container;

        // A destination inside the moved event's own subtree would detach the
        // whole branch from the sheet. Check the owner, the sibling, and the
        // target array itself by object identity.
        const subtree = collectSubtree(moving);
        const ownerInSubtree = container.owner !== undefined && subtree.events.has(container.owner);
        const siblingInSubtree = container.siblingEvent !== undefined && subtree.events.has(container.siblingEvent);
        if (ownerInSubtree || siblingInSubtree || subtree.childArrays.has(container.targetEvents)) {
          return toolError(
            `Cannot move event SID ${args.sid} into its own descendants — the destination is inside the event being moved.`,
          );
        }

        const childCount = countDescendants(moving);

        // Detach first, then insert. insertIntoContainer reads the sibling
        // index at insert time, so a move within one array still lands beside
        // the intended sibling after the removal shifted it.
        found.parentArray.splice(found.index, 1);
        commitContainer(container);
        insertIntoContainer(container, args.position, moving);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        return toolResult({
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          movedSid: args.sid,
          movedType,
          childrenMoved: childCount,
          destination: args.groupPath !== undefined
            ? { groupPath: args.groupPath, position: args.position }
            : args.parentSid !== undefined
              ? { parentSid: args.parentSid, position: args.position }
              : args.siblingSid !== undefined
                ? { siblingSid: args.siblingSid, position: args.position }
                : { root: true, position: args.position },
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[move_event_block] failed:', error);
        return toolError(`Error moving event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_event_group ─────────────────────────────────────

  server.tool(
    'update_event_group',
    'Update a group event in place — title, description, active-on-start, disabled state, and the group colors C3 serializes (background-color, text-color). Children are untouched.',
    {
      sheetName: z.string().max(200).describe('Event sheet containing the group'),
      sid: z.number().int().positive().describe('SID of the group event to update'),
      title: z.string().max(500).optional().describe('New group title; must be unique among sibling groups so group paths stay unambiguous'),
      description: z.string().max(2000).optional().describe('New group description'),
      isActiveOnStart: z.boolean().optional().describe('Whether the group is active when the layout starts'),
      disabled: z.boolean().optional().describe('Disable or enable the group in the editor'),
      backgroundColor: colorSchema.optional().describe('Group background color, written as the "background-color" key'),
      textColor: colorSchema.optional().describe('Group text color, written as the "text-color" key'),
    },
    async (args) => {
      try {
        const hasUpdate = args.title !== undefined || args.description !== undefined
          || args.isActiveOnStart !== undefined || args.disabled !== undefined
          || args.backgroundColor !== undefined || args.textColor !== undefined;
        if (!hasUpdate) {
          return toolError('No updates provided. Specify at least one of: title, description, isActiveOnStart, disabled, backgroundColor, textColor.');
        }
        if (args.title !== undefined && args.title.trim().length === 0) {
          return toolError('title cannot be empty.');
        }

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const found = findEventBySid(events, args.sid);
        if (!found) {
          const summary = summarizeEvents(events);
          return toolError(
            `Event with SID ${args.sid} not found in sheet "${args.sheetName}".\n\n` +
            `Sheet "${args.sheetName}" contains ${events.length} top-level events:\n${summary}`,
          );
        }
        const group = found.event;
        if (group.eventType !== 'group') {
          return toolError(`Event with SID ${args.sid} is a "${group.eventType}", not a group.`);
        }

        const warnings: string[] = [];
        if (args.title !== undefined && args.title !== group.title) {
          // findGroupByPath resolves one title per container, so a duplicate
          // sibling title would make "A > B" paths ambiguous.
          const siblingClash = found.parentArray.some(
            e => e !== group && e.eventType === 'group' && e.title === args.title,
          );
          if (siblingClash) {
            return toolError(`A sibling group titled "${args.title}" already exists in the same container of "${args.sheetName}"; group paths would be ambiguous.`);
          }
          let elsewhere = 0;
          walkEvents(events, e => {
            if (e !== group && e.eventType === 'group' && e.title === args.title) elsewhere++;
          });
          if (elsewhere > 0) {
            warnings.push(`${elsewhere} other group(s) in "${args.sheetName}" already use the title "${args.title}" in a different container.`);
          }
          group.title = args.title;
        }

        if (args.description !== undefined) group.description = args.description;
        if (args.isActiveOnStart !== undefined) group.isActiveOnStart = args.isActiveOnStart;
        if (args.disabled !== undefined) group.disabled = args.disabled;
        if (args.backgroundColor !== undefined) group['background-color'] = args.backgroundColor;
        if (args.textColor !== undefined) group['text-color'] = args.textColor;

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult({ ...result, updatedSid: args.sid, title: group.title });
      } catch (error) {
        console.error('[update_event_group] failed:', error);
        return toolError(`Error updating event group: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_comment ─────────────────────────────────────────

  server.tool(
    'update_comment',
    'Update a comment event. C3 does not give comments a SID, so address one by its 0-based index among its container\'s events (optionally with groupPath or parentSid); sid is accepted for the rare comment that carries one.',
    {
      sheetName: z.string().max(200).describe('Event sheet containing the comment'),
      sid: z.number().int().positive().optional().describe('SID of the comment, when it has one'),
      index: z.number().int().min(0).optional().describe('0-based index of the comment among its container\'s events'),
      groupPath: z.string().max(500).optional().describe('With index: the container group by title path (e.g., "Movement > Collision")'),
      parentSid: z.number().int().positive().optional().describe('With index: the container group, block, or function-block SID'),
      text: z.string().max(2000).optional().describe('New comment text'),
      backgroundColor: colorSchema.optional().describe('Comment background color, written as the "background-color" key'),
      textColor: colorSchema.optional().describe('Comment text color, written as the "text-color" key'),
    },
    async (args) => {
      try {
        if ((args.sid === undefined) === (args.index === undefined)) {
          return toolError('Specify exactly one of: sid, or index (optionally with groupPath or parentSid).');
        }
        if (args.sid !== undefined && (args.groupPath !== undefined || args.parentSid !== undefined)) {
          return toolError('groupPath and parentSid apply to index addressing only; omit them when using sid.');
        }
        if (args.text === undefined && args.backgroundColor === undefined && args.textColor === undefined) {
          return toolError('No updates provided. Specify at least one of: text, backgroundColor, textColor.');
        }

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        let comment: Record<string, unknown>;

        if (args.sid !== undefined) {
          const found = findEventBySid(events, args.sid);
          if (!found) {
            return toolError(`Event with SID ${args.sid} not found in sheet "${args.sheetName}". Comments usually carry no SID — address one by index instead.`);
          }
          if (found.event.eventType !== 'comment') {
            return toolError(`Event with SID ${args.sid} is a "${found.event.eventType}", not a comment.`);
          }
          comment = found.event;
        } else {
          const locatorError = validateLocator({
            groupPath: args.groupPath,
            parentSid: args.parentSid,
            position: 'end',
          });
          if (locatorError) return toolError(locatorError);
          const resolution = resolveContainer(events, args.sheetName, {
            groupPath: args.groupPath,
            parentSid: args.parentSid,
            position: 'end',
          });
          if ('error' in resolution) return toolError(resolution.error);
          const target = resolution.container.targetEvents;
          const index = args.index!;
          if (index >= target.length) {
            return toolError(`Index ${index} is out of range (the container holds ${target.length} event(s), indices 0-${Math.max(0, target.length - 1)}).`);
          }
          const candidate = target[index];
          if (candidate.eventType !== 'comment') {
            return toolError(`Event at index ${index} is a "${candidate.eventType}", not a comment. Indices count every event in the container, not only comments.`);
          }
          comment = candidate;
        }

        if (args.text !== undefined) comment.text = args.text;
        if (args.backgroundColor !== undefined) comment['background-color'] = args.backgroundColor;
        if (args.textColor !== undefined) comment['text-color'] = args.textColor;

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_comment] failed:', error);
        return toolError(`Error updating comment: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_function ────────────────────────────────────────

  server.tool(
    'update_function',
    'Update a function-block definition — name, description, category, return type, async/copy-picked flags, and its parameter list. Renaming the function rewrites every callFunction action across all sheets when renameCallers is true, and is refused otherwise.',
    {
      sheetName: z.string().max(200).describe('Event sheet containing the function'),
      sid: z.number().int().positive().describe('SID of the function-block to update'),
      functionName: z.string().max(200).optional().describe('New function name'),
      renameCallers: z.boolean().optional().default(false).describe('Rewrite every callFunction action that targets the old name; without it a rename with callers is refused'),
      description: z.string().max(2000).optional().describe('New functionDescription'),
      category: z.string().max(200).optional().describe('New functionCategory'),
      returnType: z.enum(['none', 'number', 'string', 'any']).optional().describe('New functionReturnType'),
      isAsync: z.boolean().optional().describe('New functionIsAsync'),
      copyPicked: z.boolean().optional().describe('New functionCopyPicked'),
      addParameters: z.array(z.object({
        name: z.string().max(200).describe('Parameter name'),
        type: z.enum(['number', 'string', 'boolean']).describe('Parameter type'),
        initialValue: z.string().max(500).optional().describe('Default value (defaults by type)'),
        comment: z.string().max(500).optional().describe('Parameter comment'),
      })).optional().describe('Parameters appended to the end of the list; existing callers keep passing their current arguments'),
      removeParameters: z.array(z.string().max(200)).optional().describe('Parameter names to remove; refused while callers exist because callers pass arguments positionally'),
      renameParameters: z.array(z.object({
        from: z.string().max(200).describe('Current parameter name'),
        to: z.string().max(200).describe('New parameter name'),
      })).optional().describe('Rename parameters in place; the position is unchanged so callers keep working'),
    },
    async (args) => {
      try {
        const hasUpdate = args.functionName !== undefined || args.description !== undefined
          || args.category !== undefined || args.returnType !== undefined
          || args.isAsync !== undefined || args.copyPicked !== undefined
          || (args.addParameters?.length ?? 0) > 0
          || (args.removeParameters?.length ?? 0) > 0
          || (args.renameParameters?.length ?? 0) > 0;
        if (!hasUpdate) {
          return toolError('No updates provided. Specify at least one of: functionName, description, category, returnType, isAsync, copyPicked, addParameters, removeParameters, renameParameters.');
        }

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const found = findEventBySid(events, args.sid);
        if (!found) {
          const summary = summarizeEvents(events);
          return toolError(
            `Event with SID ${args.sid} not found in sheet "${args.sheetName}".\n\n` +
            `Sheet "${args.sheetName}" contains ${events.length} top-level events:\n${summary}`,
          );
        }
        const func = found.event;
        if (func.eventType !== 'function-block') {
          return toolError(`Event with SID ${args.sid} is a "${func.eventType}", not a function-block.`);
        }
        const oldName = func.functionName as string;

        // Load every sheet once: the same pass finds duplicate function names
        // and the call sites, using index-builder's rule that a call site is a
        // non-script action carrying callFunction.
        const sheetNames = await reader.listEventSheets();
        const loaded = new Map<string, EventSheet>([[args.sheetName, sheet]]);
        for (const name of sheetNames) {
          if (loaded.has(name)) continue;
          try {
            loaded.set(name, await reader.readEventSheet(name));
          } catch {
            // A sheet that cannot be read holds no rewritable call site; the
            // rename reports it rather than silently claiming full coverage.
            loaded.set(name, { name, events: [], sid: 0 } as unknown as EventSheet);
          }
        }

        const callSites: Array<{ sheet: string; action: Record<string, unknown> }> = [];
        const otherFunctionNames = new Set<string>();
        for (const [name, data] of loaded) {
          walkEvents(data.events as Record<string, unknown>[], event => {
            if (event.eventType === 'function-block' && event !== func && typeof event.functionName === 'string') {
              otherFunctionNames.add(event.functionName);
            }
            if (!Array.isArray(event.actions)) return;
            for (const action of event.actions as Record<string, unknown>[]) {
              if (action.type === 'script') continue;
              if (action.callFunction === oldName) callSites.push({ sheet: name, action });
            }
          });
        }

        const warnings: string[] = [];
        const parameters = Array.isArray(func.functionParameters)
          ? func.functionParameters as Array<Record<string, unknown>>
          : [];

        // ── Preflight the rename ──
        if (args.functionName !== undefined && args.functionName !== oldName) {
          try {
            validateName(args.functionName);
          } catch (error) {
            return toolError(`Invalid functionName: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (otherFunctionNames.has(args.functionName)) {
            return toolError(`A function named "${args.functionName}" already exists in this project.`);
          }
          if (callSites.length > 0 && !args.renameCallers) {
            const bySheet = [...new Set(callSites.map(c => c.sheet))];
            return toolError(
              `Function "${oldName}" is called by ${callSites.length} action(s) in: ${bySheet.join(', ')}. ` +
              `Set renameCallers=true to rewrite every callFunction action, or remove the callers first.`,
            );
          }
        }

        // ── Preflight the parameter edits ──
        const paramNames = parameters.map(p => p.name as string);
        for (const name of args.removeParameters ?? []) {
          if (!paramNames.includes(name)) {
            return toolError(`Function "${oldName}" has no parameter named "${name}". Parameters: ${paramNames.join(', ') || '(none)'}.`);
          }
        }
        if ((args.removeParameters?.length ?? 0) > 0 && callSites.length > 0) {
          const bySheet = [...new Set(callSites.map(c => c.sheet))];
          return toolError(
            `Cannot remove parameters from "${oldName}": ${callSites.length} caller action(s) in ${bySheet.join(', ')} pass arguments positionally ` +
            `(callFunction actions store a "parameters" array indexed by position), so dropping a parameter would silently shift every later argument. ` +
            `Update or delete the callers first.`,
          );
        }
        const projectedNames = paramNames.filter(n => !(args.removeParameters ?? []).includes(n));
        for (const rename of args.renameParameters ?? []) {
          const at = projectedNames.indexOf(rename.from);
          if (at === -1) {
            return toolError(`Function "${oldName}" has no parameter named "${rename.from}" to rename. Parameters: ${projectedNames.join(', ') || '(none)'}.`);
          }
          if (rename.to.trim().length === 0) {
            return toolError('Parameter rename target cannot be empty.');
          }
          if (projectedNames.includes(rename.to) && rename.to !== rename.from) {
            return toolError(`Function "${oldName}" already has a parameter named "${rename.to}".`);
          }
          projectedNames[at] = rename.to;
        }
        for (const added of args.addParameters ?? []) {
          if (added.name.trim().length === 0) {
            return toolError('Parameter name cannot be empty.');
          }
          if (projectedNames.includes(added.name)) {
            return toolError(`Function "${oldName}" already has a parameter named "${added.name}".`);
          }
          projectedNames.push(added.name);
        }
        if (projectedNames.length > MAX_ITEMS_PER_BLOCK) {
          return toolError(`Function would have ${projectedNames.length} parameters (max ${MAX_ITEMS_PER_BLOCK}).`);
        }

        // ── Apply ──
        const modifiedSheets = new Set<string>([args.sheetName]);
        let renamedCallers = 0;
        if (args.functionName !== undefined && args.functionName !== oldName) {
          for (const site of callSites) {
            site.action.callFunction = args.functionName;
            renamedCallers++;
            modifiedSheets.add(site.sheet);
          }
          func.functionName = args.functionName;
          // Expression references such as Functions.oldName(...) live inside
          // parameter strings and are not rewritten here.
          const expression = new RegExp(`Functions\\.${escapeRegExp(oldName)}\\b`, 'g');
          let expressionRefs = 0;
          for (const data of loaded.values()) {
            expressionRefs += (JSON.stringify(data.events).match(expression) ?? []).length;
          }
          if (expressionRefs > 0) {
            warnings.push(`${expressionRefs} expression reference(s) to "Functions.${oldName}" were left unchanged; update them by hand.`);
          }
        }

        if (args.description !== undefined) func.functionDescription = args.description;
        if (args.category !== undefined) func.functionCategory = args.category;
        if (args.returnType !== undefined) func.functionReturnType = args.returnType;
        if (args.isAsync !== undefined) func.functionIsAsync = args.isAsync;
        if (args.copyPicked !== undefined) func.functionCopyPicked = args.copyPicked;

        let nextParameters = parameters;
        if ((args.removeParameters?.length ?? 0) > 0) {
          const drop = new Set(args.removeParameters);
          nextParameters = nextParameters.filter(p => !drop.has(p.name as string));
        }
        for (const rename of args.renameParameters ?? []) {
          const target = nextParameters.find(p => p.name === rename.from);
          if (target) {
            target.name = rename.to;
            // A parameter is referenced by bare name inside the function body,
            // so report the hits rather than rewriting expressions blindly.
            const bare = new RegExp(`\\b${escapeRegExp(rename.from)}\\b`, 'g');
            const hits = (JSON.stringify(func.conditions ?? []).match(bare) ?? []).length
              + (JSON.stringify(func.actions ?? []).match(bare) ?? []).length
              + (JSON.stringify(func.children ?? []).match(bare) ?? []).length;
            if (hits > 0) {
              warnings.push(`${hits} expression reference(s) to parameter "${rename.from}" remain inside "${func.functionName}"; update them by hand.`);
            }
          }
        }
        for (const added of args.addParameters ?? []) {
          nextParameters.push({
            name: added.name,
            type: added.type,
            initialValue: added.initialValue ?? (added.type === 'number' ? '0' : added.type === 'boolean' ? 'false' : ''),
            comment: added.comment ?? '',
            sid: await idGen.generateSid(reader),
          });
        }
        if ((args.addParameters?.length ?? 0) > 0 && callSites.length > 0) {
          warnings.push(`${callSites.length} existing caller action(s) do not pass the newly added parameter(s); they fall back to the declared initial values.`);
        }
        func.functionParameters = nextParameters;

        const backupFiles: string[] = [];
        for (const name of modifiedSheets) {
          const data = loaded.get(name)!;
          const subfolder = writer.getSubfolderForEntity('eventSheets', name);
          backupFiles.push(await writer.writeEntityFile('eventSheets', name, data, subfolder));
        }
        resetProjectIndex();

        return toolResult({
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          updatedSid: args.sid,
          functionName: func.functionName,
          previousFunctionName: oldName,
          renamedCallers,
          updatedSheets: [...modifiedSheets],
          parameters: (func.functionParameters as Array<Record<string, unknown>>).map(p => p.name),
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFiles,
        });
      } catch (error) {
        console.error('[update_function] failed:', error);
        return toolError(`Error updating function: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_event_variable ────────────────────────────────

  server.tool(
    'update_event_variable',
    'Update an existing event variable declaration (rename, change type, change initial value)',
    {
      sheetName: z.string().max(200).describe('Event sheet containing the variable'),
      sid: z.number().int().describe('SID of the variable event to update'),
      newName: z.string().max(200).optional().describe('New variable name'),
      newType: z.enum(['number', 'string', 'boolean']).optional().describe('New variable type'),
      newInitialValue: z.string().max(1000).optional().describe('New initial value (as string — use "0", "false", or "" for defaults)'),
      isStatic: z.boolean().optional().describe('Mark as static (value persists between calls)'),
      isConstant: z.boolean().optional().describe('Mark as constant (cannot be changed at runtime)'),
      comment: z.string().max(2000).optional().describe('New declaration comment'),
    },
    async (args) => {
      try {
        const hasUpdates = args.newName !== undefined || args.newType !== undefined ||
          args.newInitialValue !== undefined || args.isStatic !== undefined || args.isConstant !== undefined ||
          args.comment !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: newName, newType, newInitialValue, isStatic, isConstant, comment.');
        }

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        // Find the variable event by SID (search flat and nested)
        const findResult = findEventBySid(sheet.events as Record<string, unknown>[], args.sid);
        if (!findResult) {
          return toolError(`No event with SID ${args.sid} found in sheet "${args.sheetName}".`);
        }
        if (findResult.event.eventType !== 'variable') {
          return toolError(`Event SID ${args.sid} is a "${findResult.event.eventType}" event, not a variable event.`);
        }

        const varEvent = findResult.event as unknown as import('../construct3/types.js').VariableEvent;

        // Check name uniqueness if renaming
        if (args.newName !== undefined && args.newName !== varEvent.name) {
          const nameInUse = findVariableNameInUse(sheet.events, args.newName, args.sid);
          if (nameInUse) {
            return toolError(`A variable named "${args.newName}" already exists in sheet "${args.sheetName}".`);
          }
          varEvent.name = args.newName;
        }

        if (args.newType !== undefined) varEvent.type = args.newType;
        if (args.newInitialValue !== undefined) varEvent.initialValue = args.newInitialValue;
        if (args.isStatic !== undefined) varEvent.isStatic = args.isStatic;
        if (args.isConstant !== undefined) varEvent.isConstant = args.isConstant;
        if (args.comment !== undefined) (varEvent as unknown as Record<string, unknown>).comment = args.comment;

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_event_variable] failed:', error);
        return toolError(`Error updating event variable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/**
 * Check whether a variable name is already used in the event list (excluding the event with the given SID).
 */
function findVariableNameInUse(events: C3Event[], name: string, excludeSid: number): boolean {
  for (const ev of events) {
    if (ev.eventType === 'variable' && (ev as import('../construct3/types.js').VariableEvent).name === name) {
      if ((ev as { sid?: number }).sid !== excludeSid) return true;
    }
    if ('children' in ev && Array.isArray((ev as { children?: C3Event[] }).children)) {
      if (findVariableNameInUse((ev as { children: C3Event[] }).children, name, excludeSid)) return true;
    }
  }
  return false;
}
