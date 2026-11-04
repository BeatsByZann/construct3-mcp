/**
 * Event sheet tools: create_event_sheet, add_event_to_sheet, add_event_block, delete_event_sheet.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { C3Event, EventSheet, FunctionBlockEvent, VariableEvent, WriteResult } from '../construct3/types.js';
import {
  validateName,
  validateSubfolder,
  toolResult,
  toolError,
  notFoundError,
  boundedRecord,
  caseClashError,
  folderCaseClashError,
  deleteRegisteredEntity,
} from './shared.js';
import { findFolderPathClash, findNameClash, nameKey } from '../construct3/names.js';
import type { CustomActionCall } from '../construct3/types.js';
import {
  SYSTEM_EXPRESSIONS_NOT_IN_R449,
  eventVariableNameUses,
  listEventVariableDeclarations,
  findEnclosingEvents,
  findEventVariableNameProblem,
  findNewEventVariableNameClashes,
  findFunctionNameProblem,
  functionBlockNames,
  newDuplicateFunctionNames,
} from '../construct3/event-variable-names.js';
import type { EventVariableNameProblem, FunctionBlockName, FunctionNameProblem, NewEventVariableNameClash } from '../construct3/event-variable-names.js';
import {
  conditionSchema,
  actionSchema,
  childEventSchema,
  nothingChanged,
  resolveGroupPath,
  describeGroupPathProblem,
  isInFunctionBlock,
  validateObjectClasses,
  collectObjectRefs,
  buildBlockEvent,
  locatorShape,
  resolveContainer,
  containerParents,
  containerInFunction,
  eventPathOf,
  eventAtEventPath,
  elsePredecessorWarnings,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_NODES,
  type ResolvedContainer,
  buildCondition,
  buildAction,
  isCustomActionCall,
  CustomActionCallError,
  customActionCallError,
  customActionCallWarnings,
  loadCustomActionContext,
  resolveEventBySid,
  parseEventPath,
  ambiguousSidMessage,
  insertIntoContainer,
  placementError,
  placedKindOf,
  type PlacedEventKind,
  eventPathSchema,
  collectEventSids,
  MAX_ITEMS_PER_BLOCK,
  eventSidsMatchingSeveral,
  countDescendants,
  summarizeEvents,
  loadBehaviorLookup,
  buildScriptEvent,
  normalizeLegacyBehaviorKeys,
  snapshotEvents,
  checkLoadRulesBeforeWrite,
  checkLoadRulesBeforeSheetPairWrite,
  loadRuleErrorMessage,
  loadFunctionSignatures,
  resolveFunctionMapParameter,
  functionCallArgumentSchema,
  unknownKeysErrorMap,
  EVENT_INPUT_DESCRIPTIONS,
  commentColorSchema,
  buildCommentEvent,
} from './event-helpers.js';
import {
  isElseCondition,
  createElseCondition,
  setKeyAfterSid,
  setConditionParameters,
  isFunctionCall,
  isLegacyFunctionCall,
  toPositionalArguments,
  rewriteFunctionCallInPlace,
  checkFunctionCallArguments,
  mergeCallArguments,
  collectFunctionSignatures,
  resolveCallName,
  functionsObjectName,
  type FunctionArgument,
} from '../construct3/event-shapes.js';
import {
  findReferencesLeftByDelete,
  findVariableReferencesLostByChange,
  recordVariableScopes,
  recordVariableBindings,
  findVariableBindingChanges,
  REBOUND_USE_CONSEQUENCE,
  REFERENCE_CHECK_MAX_DEPTH,
  type ReferenceCheckLimit,
  variablesDeclaredIn,
  findFunctionReferences,
  mapCopiedAces,
  definesFunctionsOrVariables,
  countDeleteReferences,
  globalVariableNames,
  REFERENCE_CHECK_MAX_EVENTS,
  namesVisibleToOtherSheets,
  type DeleteReference,
  type DeleteReferenceKind,
  type DeleteReferenceReport,
} from '../construct3/analyzers/delete-references.js';
import { scanLegacyEventShapes, type LegacyEventShapeHit } from '../construct3/analyzers/legacy-event-shapes.js';
import { isTriggerId } from '../construct3/analyzers/load-rules.js';
import type { ObjectRef, SidMatch } from './event-helpers.js';
import { getProjectIndex, resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  blocksWithoutForce,
  checkUnscannedFiles,
  ownFileReports,
  unscannedFields,
  unscannedFilesOf,
  unscannedRefusal,
  unscannedWarnings,
  type UnscannedFileReport,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../construct3/raw-text-search.js';
import { writeEntityOrRollBack } from './call-rollback.js';
import { scanLegacyBehaviorKeys } from '../construct3/analyzers/legacy-behavior-keys.js';
import { rollBackFailedCall } from './call-rollback.js';
import { checkBehaviorName } from '../construct3/analyzers/behavior-refs.js';
import type { LegacyBehaviorKeyHit, LegacyBehaviorKeyConflict } from '../construct3/analyzers/legacy-behavior-keys.js';
import {
  customActionCallSites,
  customActionDefinitionClashes,
  customActionOwnerError,
  customActionRenameCaptures,
  customActionScan,
  newCustomActionDuplicates,
  type CustomActionCallSite,
  type CustomActionDefinition,
} from '../construct3/custom-actions.js';
import {
  createEmptySheet,
  createVariableEvent,
  createGroupEvent,
  createFunctionEvent,
  createIncludeEvent,
  createCustomActionEvent,
} from '../construct3/templates.js';
import { withProjectSync } from './project-sync.js';

/** Per-sheet cap on change details returned by fix_legacy_behavior_keys. */
const MAX_REPORTED_CHANGES = 100;

/** What happens to the references delete_event_from_sheet reports (see delete-references.ts). */
const DANGLING_REFERENCE_CONSEQUENCE =
  'After loading a project, Construct 3 resolves these names and throws "invalid function name", ' +
  '"cannot find function" or "cannot find event variable" when one is missing (loader code; whether the project ' +
  'then fails to open has not been confirmed in the editor). A Functions.Name(...) expression would call a ' +
  'function that no longer exists, and an expression that uses an event variable by name would name a variable ' +
  'that no longer exists.';

const DANGLING_KIND_LABELS: Record<DeleteReferenceKind, string> = {
  callFunction: 'Call function action(s)',
  'function-map': 'function map registration(s)',
  expression: 'expression call(s)',
  'event-variable': 'condition(s)/action(s) reading or setting it',
  'variable-expression': 'expression(s) using it by name',
};

/**
 * Why a reference check that stopped at its traversal limit refuses without
 * force: what it did not reach is unknown, as for a file it could not parse.
 * `limit` says which limit it was: the event count (the default) or the depth
 * events are nested to.
 */
function traversalLimitReason(checked: string, limit: ReferenceCheckLimit = 'events'): string {
  if (limit === 'depth') {
    return `The check for ${checked} stopped at its nesting-depth limit (events nested more than ${REFERENCE_CHECK_MAX_DEPTH} deep), ` +
      'so uses further on are unknown.';
  }
  return `The check for ${checked} stopped at its traversal limit (${REFERENCE_CHECK_MAX_EVENTS.toLocaleString('en-US')} events ` +
    'across all event sheets), so uses further on are unknown.';
}

/** What happens to the uses a move takes out of their variable's scope (see findVariableReferencesLostByChange). */
const SCOPE_LOSS_CONSEQUENCE =
  'A variable that is not at the top level of a sheet is local: only the events beside it and below them see it. ' +
  'After loading a project, Construct 3 resolves these names and throws "cannot find event variable" when one is ' +
  'not in scope (loader code; whether the project then fails to open has not been confirmed in the editor), and an ' +
  'expression that uses it by name would name a variable that is not there.';

/** Why two custom actions of one name on one object type or family are refused. */
const DUPLICATE_CUSTOM_ACTION_RULE =
  'A call names a custom action by its name, so it could not tell two apart (Construct 3 r506-2 (Free edition) opened such a project, ' +
  'ran the first definition, and renamed the second one when it saved: DoK became DoK2). Choose another name.';

/**
 * One sentence per deleted function or variable that is still referenced
 * `outside` what is deleted ("outside the deleted events").
 */
function describeDanglingReferences(report: DeleteReferenceReport, outside = 'outside the deleted events'): string {
  const kinds = (refs: DeleteReference[]) => {
    const counts = new Map<DeleteReferenceKind, number>();
    for (const r of refs) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    return [...counts].map(([kind, n]) => `${n} ${DANGLING_KIND_LABELS[kind]}`).join(', ');
  };
  return [
    ...report.functions.map(f => `Function "${f.name}" is still referenced ${f.references.length} time(s) ${outside} (${kinds(f.references)}).`),
    ...report.variables.map(v => `Event variable "${v.name}" is still used ${v.references.length} time(s) ${outside} (${kinds(v.references)}).`),
  ].join(' ');
}

/** The references of a report, for the delete_blocked result. */
function danglingReferenceList(report: DeleteReferenceReport): Record<string, unknown> {
  const entry = (r: DeleteReference) => ({ sheet: r.sheet, path: r.path, ...(r.sid !== undefined ? { sid: r.sid } : {}) });
  return {
    ...(report.functions.length > 0
      ? { callers: report.functions.flatMap(f => f.references.map(r => ({ function: f.name, via: r.kind, ...entry(r) }))) }
      : {}),
    ...(report.variables.length > 0
      ? {
        variableReferences: report.variables.flatMap(v => v.references.map(r => ({
          variable: v.name,
          via: r.kind === 'variable-expression' ? 'expression' : r.kind,
          ...entry(r),
        }))),
      }
      : {}),
  };
}

/**
 * Error for a parameter update on an action row that has no parameters:
 * editor-saved comment rows are { type, text, colours? } and script actions
 * { type, language, script, disabled? }. Null for other actions.
 */
function parameterlessRowError(action: Record<string, unknown>, index: number): string | null {
  if (action.type === 'comment') {
    return `Action ${index} is a comment row, which has no parameters. To change its text or colours, use update_event_block with updateActions [{ index: ${index}, text, "text-color", "background-color" }]: the row keeps its place and the keys it has.`;
  }
  if (action.type === 'script') {
    return `Action ${index} is a script action, which has no parameters. To change its code, remove it and add a new { type: "script", script } with update_event_block.`;
  }
  return null;
}

export function registerEventTools({ server: mcpServer, reader, writer, idGen }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);
  // ─── create_event_sheet ───────────────────────────────────

  server.tool(
    'create_event_sheet',
    'Create a new event sheet in the project',
    {
      name: z.string().max(200).describe('Event sheet name (must not match an existing event sheet name, ignoring case)'),
      subfolder: z.string().max(500).optional().describe('Subfolder path'),
      includeSheets: z.array(z.string()).optional().describe('Event sheets to auto-include'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Check uniqueness: the editor compares event sheet names ignoring case, project-wide
        const existing = await reader.listEventSheets();
        if (existing.includes(args.name)) {
          return toolError(`Event sheet "${args.name}" already exists.`);
        }
        const nameClash = findNameClash(args.name, existing);
        if (nameClash) {
          return toolError(caseClashError('event sheet', args.name, nameClash));
        }
        if (args.subfolder) {
          const folderClash = findFolderPathClash(reader.getProject().eventSheets, args.subfolder);
          if (folderClash) return toolError(folderCaseClashError(args.subfolder, folderClash));
        }
        // Never replace an existing file
        const fileRefusal = await writer.entityFileRefusal('eventSheets', args.name, args.subfolder);
        if (fileRefusal) return toolError(fileRefusal);

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

        await writer.writeEntityFile('eventSheets', args.name, data, args.subfolder, { createOnly: true });
        await writer.addToProject('eventSheets', args.name, args.subfolder);
        resetProjectIndex(reader);

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

  // The arguments add_event_to_sheet takes; the object schema built from them is strict, so any other top-level argument is refused
  const addEventToSheetShape = {
    sheetName: z.string().max(200).describe('Target event sheet, as registered (letter case included)'),
    eventType: z.enum(['group', 'function', 'variable', 'include', 'comment', 'script']).describe('Type of event to add'),
    title: z.string().max(500).optional().describe('For groups: the group title'),
    functionName: z.string().max(200).optional().describe('For functions: function name. Refused like in the editor: a name that matches, ignoring case, another function in the project or a System expression; with a return type also whitespace, punctuation such as - . : or a leading underscore (the name is used in expressions). Without a return type the editor accepts any name that is not empty'),
    functionParams: z.array(z.object({
      name: z.string().describe('Parameter name'),
      type: z.enum(['number', 'string', 'boolean']).describe('Parameter type'),
    })).optional().describe('For functions: parameter definitions. Names are refused like in the editor: a name that matches, ignoring case, a global variable of the project, another parameter of the function or a System expression, or that has whitespace, punctuation such as - . : or a leading underscore'),
    functionReturnType: z.enum(['none', 'number', 'string', 'any']).optional()
      .describe('For functions: the editor\'s "Return type" (default "none"); a function with a return type sets its value with the Functions "Set return value" action'),
    functionIsAsync: z.boolean().optional().describe('For functions: the editor\'s "Asynchronous" option, so a call can be waited for with "Wait for previous actions to complete" (default false)'),
    functionCopyPicked: z.boolean().optional().describe('For functions: the editor\'s "Copy picked" option, which passes the instances picked where the function is called into the function (default false)'),
    variableName: z.string().max(200).optional().describe('For variables: name of the new variable (global at the top level, local elsewhere). Refused like in the editor: a name that matches, ignoring case, an event variable or function parameter in its scope (for a global variable: anywhere in the project) or a System expression, or that has whitespace, punctuation such as - . : or a leading underscore'),
    variableType: z.enum(['number', 'string', 'boolean']).optional().describe('For variables: variable type'),
    initialValue: z.string().max(500).optional().default('').describe('For variables: initial value'),
    variableComment: z.string().max(2000).optional().describe('For variables: the declaration comment (default empty)'),
    variableIsStatic: z.boolean().optional().describe('For variables: "Static", which keeps a local variable\'s value between runs of its event (default false)'),
    variableIsConstant: z.boolean().optional().describe('For variables: "Constant" (default false)'),
    includeSheet: z.string().max(200).optional().describe('For includes: sheet name to include'),
    commentText: z.string().max(2000).optional().describe('For comments: comment text'),
    commentTextColor: commentColorSchema.optional().describe('For comments: the text colour, written as "text-color": [red, green, blue, alpha], each 0-1, as the editor saves it'),
    commentBackgroundColor: commentColorSchema.optional().describe('For comments: the background colour, written as "background-color": [red, green, blue, alpha], each 0-1'),
    script: z.union([z.string().max(200_000), z.array(z.string().max(10_000)).max(10_000)]).optional().describe('For script events: JavaScript as one string (split into lines) or an array of lines, written as the editor saves it'),
    ...locatorShape,
  };

  // Registered with a strict object schema, so unknown top-level arguments are
  // refused (server.tool() with a raw shape would drop them; see Strict Input in
  // event-helpers.ts) (#ISSUE).
  server.registerTool(
    'add_event_to_sheet',
    {
      description: 'Add an event (group, function, variable, include, comment or script) to an event sheet: at the top level, in a group (groupPath), among the sub-events of an event (parentSid) or beside one (siblingSid with position "before" or "after"); a place that no editor-saved project on record or checked editor case shows for that kind of event is refused, and includes go only at the top level. A function block is refused under or below a block that has a trigger condition and under or below a function block or a custom action block. A variable at the top level is a global variable, anywhere else a local one. Returns the SID of a new group, function or variable (generatedSid), the SIDs of the function\'s parameters (functionParameterSids), the new event\'s eventPath and the backupFile. Unknown top-level arguments are refused, never dropped; keys inside a functionParams entry other than name and type are still dropped.',
      inputSchema: z.object(addEventToSheetShape, {
        errorMap: unknownKeysErrorMap('the arguments of add_event_to_sheet', 'add_event_to_sheet takes sheetName, eventType, groupPath, parentSid, parentEventPath, siblingSid, siblingEventPath, position, title (group), functionName, functionParams, functionReturnType, functionIsAsync, functionCopyPicked (function), variableName, variableType, initialValue, variableComment, variableIsStatic, variableIsConstant (variable), includeSheet (include), commentText, commentTextColor, commentBackgroundColor (comment) and script (script). Block events are added with add_event_block.'),
      }).strict(),
    },
    async (args) => {
      // Once the event is placed in memory, an error puts the sheet back (see the catch below)
      let undoPlacement: (() => void) | undefined;
      let writeStarted = false;
      try {
        // Its checks compare the sheet with the other sheets by registered name
        const unregistered = await unregisteredSheetError(reader, args.sheetName);
        if (unregistered) return unregistered;

        // Read existing sheet — preserves ALL original events and fields
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }
        const beforeEvents = snapshotEvents(sheet.events);

        const PLACED: Record<typeof args.eventType, PlacedEventKind> = {
          group: 'group', function: 'function-block', variable: 'variable', include: 'include', comment: 'comment', script: 'script',
        };
        const resolution = resolveContainer(sheet.events as Record<string, unknown>[], args.sheetName, {
          groupPath: args.groupPath, parentSid: args.parentSid, parentEventPath: args.parentEventPath,
          siblingSid: args.siblingSid, siblingEventPath: args.siblingEventPath, position: args.position,
        });
        if ('error' in resolution) return toolError(nothingChanged(resolution.error));
        const container = resolution.container;
        const placement = placementError(PLACED[args.eventType], container);
        if (placement) return toolError(nothingChanged(placement));
        // The events enclosing the new event, for the name rules of its scope (empty at the top level)
        const parents = containerParents(sheet.events, container);
        if (args.eventType === 'function') {
          const triggered = functionBlockTriggerRefusal(parents);
          if (triggered) return toolError(nothingChanged(triggered));
        }

        let event: C3Event;
        // SIDs of what is created, for the result (includes and comments have none)
        let generatedSid: number | undefined;
        let functionParameterSids: Array<{ name: string; sid: number }> | undefined;

        switch (args.eventType) {
          case 'group': {
            if (!args.title) return toolError('title is required for group events');
            const sid = await idGen.generateSid(reader);
            event = createGroupEvent(args.title, sid);
            generatedSid = sid;
            break;
          }
          case 'function': {
            if (!args.functionName) return toolError('functionName is required for function events');
            // The name is checked like in the editor's Function dialog, against every function in the project
            const allSheets = await readEventSheetsFresh(reader, [[args.sheetName, sheet.events]]);
            const nameProblem = findFunctionNameProblem(args.functionName, args.functionReturnType ?? 'none', functionBlockNames(allSheets));
            if (nameProblem) return toolError(functionNameMessage(nameProblem, args.functionName, args.functionReturnType ?? 'none'));
            // Parameter names are checked like in the editor's Function parameter dialog
            if (args.functionParams && args.functionParams.length > 0) {
              const paramError = functionParameterNamesError(allSheets, args.sheetName, args.functionParams.map(p => p.name), parents);
              if (paramError) return toolError(paramError);
            }
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
            generatedSid = sid;
            functionParameterSids = paramsWithSids?.map(p => ({ name: p.name, sid: p.sid }));
            break;
          }
          case 'variable': {
            if (!args.variableName) return toolError('variableName is required for variable events');
            // At the top level a global variable, anywhere else a local one
            const sheets = await readEventSheetsFresh(reader, [[args.sheetName, sheet.events]]);
            const nameError = eventVariableNameError(sheets, args.sheetName, parents, args.variableName);
            if (nameError) return toolError(nameError);
            const varType = args.variableType || 'number';
            const defaultValue = args.initialValue || (varType === 'number' ? '0' : varType === 'boolean' ? 'false' : '');
            const sid = await idGen.generateSid(reader);
            event = createVariableEvent(args.variableName, varType, defaultValue, sid);
            const variable = event as VariableEvent;
            if (args.variableComment !== undefined) variable.comment = args.variableComment;
            if (args.variableIsStatic !== undefined) variable.isStatic = args.variableIsStatic;
            if (args.variableIsConstant !== undefined) variable.isConstant = args.variableIsConstant;
            generatedSid = sid;
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
            event = buildCommentEvent({
              eventType: 'comment',
              text: args.commentText,
              'text-color': args.commentTextColor,
              'background-color': args.commentBackgroundColor,
            });
            break;
          }
          case 'script': {
            if (args.script === undefined) return toolError(nothingChanged('script is required for script events.'));
            event = buildScriptEvent({ eventType: 'script', script: args.script });
            break;
          }
        }

        undoPlacement = () => { sheet.events = beforeEvents; };
        insertIntoContainer(container, args.position, event as unknown as Record<string, unknown>);
        const eventPath = eventPathOf(sheet.events as Record<string, unknown>[], event as unknown as Record<string, unknown>);

        // Editor load-time rules: block the write if it introduces an error
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        // A new event right before an else block makes that block continue it; both arrangements load, so the gate does not report it
        const warnings = [...loadCheck.warnings, ...elsePredecessorWarnings(beforeEvents, sheet.events)];

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        writeStarted = true;
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex(reader);

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          ...(generatedSid !== undefined ? { generatedSid } : {}),
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult({
          ...result,
          ...(functionParameterSids && functionParameterSids.length > 0 ? { functionParameterSids } : {}),
          eventPath,
        });
      } catch (error) {
        console.error('[add_event_to_sheet] failed:', error);
        if (undoPlacement) {
          undoPlacement();
          if (!writeStarted) return toolError(stoppedBeforeWriteMessage(error));
        }
        return toolError(`Error adding event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_event_block ──────────────────────────────────────

  // Registered with a strict object schema, so unknown arguments are refused
  // (server.tool() with a raw shape would drop them; see Strict Input in event-helpers.ts).
  server.registerTool(
    'add_event_block',
    {
      description: 'Add a block event (conditions + actions) to an event sheet — the core of gameplay logic. Written in the shapes the Construct 3 editor saves: sub-events (blocks, also without conditions, which run whenever their parent runs; comments; scripts), else and else-if blocks (a System "else" first condition), OR blocks (isOrBlock), function calls ({ callFunction, parameters: [...] }), script actions (lines, language "javascript"), comment rows and per-condition/per-action disabling. Unknown keys, in the arguments and at any depth, are refused, never dropped. Writes that would break a checked editor load-time rule (expression syntax, empty expressions, trigger placement) are refused. Place it at the top level, in a group (groupPath), among the sub-events of an event (parentSid) or beside one (siblingSid with position "before" or "after"); a place that no editor-saved project on record or checked editor case shows for that kind of event is refused (see the API reference). Returns generatedSid, eventPath and backupFile.',
      inputSchema: z.object({
        sheetName: z.string().max(200).describe('Target event sheet'),
        eventType: z.literal('block', {
          errorMap: (_issue, ctx) => ({
            message: `add_event_block adds a block event, not ${JSON.stringify(ctx.data)}; the call is refused. ` +
              'Comments, groups, variables, functions and includes are added with add_event_to_sheet; a comment or script can also be a sub-event in children.',
          }),
        }).optional().describe('Optional, only "block": this tool adds block events. Comments, groups, variables, functions and includes: add_event_to_sheet (comments and scripts can also be sub-events in children)'),
        sid: z.number().optional().describe('Ignored: a block copied from get_eventsheet_details may carry its SID, but the new block always gets a new one'),
        conditions: z.array(conditionSchema).optional().default([]).describe(EVENT_INPUT_DESCRIPTIONS.conditions),
        actions: z.array(actionSchema).optional().default([]).describe('Actions: plugin/behavior/System actions, function calls { callFunction, parameters: [...] }, custom action calls { customAction, objectClass, customActionObjectClass?, parameters: [...] }, script actions { type: "script", script } and comment rows { type: "comment", text, "text-color"?, "background-color"? }'),
        ...locatorShape,
        disabled: z.boolean().optional().default(false).describe('Create the event block disabled'),
        isElse: z.boolean().optional().default(false).describe(EVENT_INPUT_DESCRIPTIONS.isElse),
        isOrBlock: z.boolean().optional().describe(EVENT_INPUT_DESCRIPTIONS.isOrBlock),
        children: z.array(childEventSchema).optional().default([]).describe('Sub-events nested inside this block (recursive, max depth 10, max 200 total events): blocks { conditions?, actions?, disabled?, isElse?, isOrBlock?, children? }, comments { eventType: "comment", text } and scripts { eventType: "script", script }. Other event types (variables, groups, functions, includes) and unknown keys are refused'),
      }, {
        errorMap: unknownKeysErrorMap('the arguments of add_event_block', 'add_event_block takes sheetName, eventType, conditions, actions, groupPath, parentSid, parentEventPath, siblingSid, siblingEventPath, position, disabled, isElse, isOrBlock and children; a "sid" is ignored. Comments, groups, variables, functions and includes are added with add_event_to_sheet.'),
      }).strict(),
    },
    async (args) => {
      // Once the event is placed in memory, an error puts the sheet back (see the catch below)
      let undoPlacement: (() => void) | undefined;
      let writeStarted = false;
      try {
        // Read the target event sheet
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }
        const beforeEvents = snapshotEvents(sheet.events);

        // Where the block goes, resolved before any SID is drawn, so a refusal changes nothing
        const events = sheet.events as Record<string, unknown>[];
        const resolution = resolveContainer(events, args.sheetName, {
          groupPath: args.groupPath, parentSid: args.parentSid, parentEventPath: args.parentEventPath,
          siblingSid: args.siblingSid, siblingEventPath: args.siblingEventPath, position: args.position,
        });
        if ('error' in resolution) return toolError(nothingChanged(resolution.error));
        const container = resolution.container;
        const placement = placementError('block', container);
        if (placement) return toolError(nothingChanged(placement));

        // Collect all objectClass references from entire tree (parent + descendants)
        const allRefs: ObjectRef[] = [];
        collectObjectRefs(
          args.conditions,
          args.actions as Array<Record<string, unknown>>,
          args.children,
          allRefs,
        );

        // The Set return value warning is checked against the block's destination
        const { errors, warnings } = await validateObjectClasses(reader, allRefs, { insideFunction: containerInFunction(events, container) });
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

        undoPlacement = () => { sheet.events = beforeEvents; };
        insertIntoContainer(container, args.position, blockEvent as unknown as Record<string, unknown>);
        const eventPath = eventPathOf(events, blockEvent as unknown as Record<string, unknown>);

        // Editor load-time rules, checked on the whole sheet so the insertion
        // context (the new block's ancestors, the event before an else block) counts too
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);
        // A block right before an else block (or between a block and its else block) makes that block continue it; both arrangements load, so the gate does not report it
        warnings.push(...elsePredecessorWarnings(beforeEvents, sheet.events));

        // Write back
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        writeStarted = true;
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex(reader);

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          generatedSid: blockSid,
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult({ ...result, eventPath });
      } catch (error) {
        if (error instanceof CustomActionCallError) return toolError(nothingChanged(error.message));
        console.error('[add_event_block] failed:', error);
        if (undoPlacement) {
          undoPlacement();
          if (!writeStarted) return toolError(stoppedBeforeWriteMessage(error));
        }
        return toolError(`Error adding event block: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_custom_action ────────────────────────────────────

  // Registered with a strict object schema, so unknown arguments are refused (see add_event_block).
  server.registerTool(
    'add_custom_action',
    {
      description: 'Add a custom action definition (a custom action block) to an event sheet. A custom action belongs to an object type or family and is called on it with { customAction, objectClass, parameters: [...] } in add_event_block or update_event_block; its conditions and actions are added with update_event_block on the returned SID. Placed at the top level, in a group, or beside an event there, and only where every event above it is a group: Construct 3 r506-2 (Free edition) was seen accepting a custom action block only at the top level and in a top-level group, and a group below a block, a block with conditions, a function block or a custom action block is refused (a custom action block is a trigger root for the load check). Runs the load-time gate (new warnings are returned). Event sheets that could not be parsed are searched as text for the name; a possible match refuses without force=true. Refused, changing nothing: an owner that is no object type or family, an empty name, a second custom action of the same name on the same owner (ignoring case), parameter names the editor refuses, and a place that no editor-saved project on record or checked editor case shows for custom action blocks (below a block, a function block or a custom action block, also through a group). Returns generatedSid, parameterSids, eventPath and backupFile.',
      inputSchema: z.object({
        sheetName: z.string().max(200).describe('Target event sheet, as registered (letter case included)'),
        objectClass: z.string().max(200).describe('The object type or family the custom action belongs to'),
        aceName: z.string().max(200).describe('The custom action\'s name, as calls give it in customAction'),
        description: z.string().max(2000).optional().describe('The description shown in the editor'),
        category: z.string().max(200).optional().describe('The category it is listed under in the editor'),
        isAsync: z.boolean().optional().describe('The editor\'s "Asynchronous" option (default false)'),
        copyPicked: z.boolean().optional().describe('The editor\'s "Copy picked" option (default false)'),
        parameters: z.array(z.object({
          name: z.string().max(200).describe('Parameter name'),
          type: z.enum(['number', 'string', 'boolean']).describe('Parameter type'),
          initialValue: z.string().max(500).optional().describe('Default value (by type: "0", "" or "false")'),
          comment: z.string().max(500).optional().describe('Parameter comment'),
        }, {
          errorMap: unknownKeysErrorMap('a parameter', 'A parameter has name, type, initialValue and comment.'),
        }).strict()).max(100).optional().describe('Parameters in call order; names follow the editor\'s function parameter rules'),
        ...locatorShape,
        force: z.boolean().optional().default(false).describe('Add even while an event sheet the server could not parse may define a custom action of that name (the sheets are listed in unscannedFiles and a warning)'),
      }, {
        errorMap: unknownKeysErrorMap('the arguments of add_custom_action', 'add_custom_action takes sheetName, objectClass, aceName, description, category, isAsync, copyPicked, parameters, groupPath, parentSid, parentEventPath, siblingSid, siblingEventPath, position and force.'),
      }).strict(),
    },
    async (args) => {
      // Set once the new block is in the sheet in memory, so a throw before the write puts the sheet back
      let undoInsert: (() => void) | undefined;
      let writeStarted = false;
      try {
        const unregistered = await unregisteredSheetError(reader, args.sheetName);
        if (unregistered) return toolError(nothingChanged(unregistered.content[0].text));
        const ownerError = customActionOwnerError(args.objectClass, await reader.listObjectTypes(), await reader.listFamilies());
        if (ownerError) return toolError(nothingChanged(ownerError));
        if (args.aceName.trim() === '') return toolError(nothingChanged('aceName is empty or only spaces.'));

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return toolError(nothingChanged(`Event sheet "${args.sheetName}" is registered in the project but could not be read.`));
        }
        const events = sheet.events as Record<string, unknown>[];
        const resolution = resolveContainer(events, args.sheetName, {
          groupPath: args.groupPath, parentSid: args.parentSid, parentEventPath: args.parentEventPath,
          siblingSid: args.siblingSid, siblingEventPath: args.siblingEventPath, position: args.position,
        });
        if ('error' in resolution) return toolError(nothingChanged(resolution.error));
        const container = resolution.container;
        const placement = placementError('custom-ace-block', container);
        if (placement) return toolError(nothingChanged(placement));
        // Only groups may stand above the new definition: a group below a block, a function block or a custom action block is refused
        const nonGroup = containerParents(sheet.events, container).find(parent => parent.eventType !== 'group');
        if (nonGroup !== undefined) {
          const what = nonGroup.eventType === 'block' ? (Array.isArray(nonGroup.conditions) && nonGroup.conditions.length > 0 ? 'a block with conditions' : 'a block')
            : nonGroup.eventType === 'function-block' ? 'a function block'
              : nonGroup.eventType === 'custom-ace-block' ? 'a custom action block' : `an event of type "${String(nonGroup.eventType)}"`;
          return toolError(nothingChanged(
            `A custom action block is not placed in a group that stands below ${what}${nonGroup.sid !== undefined ? ` (SID ${nonGroup.sid})` : ''}: ` +
            'Construct 3 r506-2 (Free edition) was seen accepting one only at the top level and in a top-level group, and the load check this tool follows ' +
            'treats a custom action block as a trigger root, as it does a function block, which r506-2 (Free edition) refused to open under an "On start" block. ' +
            'This is the tool\'s own rule, not checked in the editor. It can go at the top level, in a group, or in a group that has only groups above it.'));
        }

        // One custom action of a name per owner, across the project
        const sheets = await readEventSheetsFresh(reader, [[args.sheetName, sheet.events]]);
        const scan = customActionScan(sheets);
        const clashes = customActionDefinitionClashes(scan.definitions, args.objectClass, args.aceName);
        if (clashes.length > 0) {
          const c = clashes[0];
          return toolError(nothingChanged(`"${args.objectClass}" already has a custom action "${c.name}" (sheet "${c.sheet}", ${c.eventPath}${c.sid !== undefined ? `, SID ${c.sid}` : ''}). ${DUPLICATE_CUSTOM_ACTION_RULE}`));
        }
        // A definition past the scan's limits is unknown, as in a sheet that could not be parsed
        const scanChecked = 'custom actions of that name';
        if (!scan.complete && !args.force) {
          return toolResult({
            success: false, entity: args.sheetName, category: 'eventsheet', action: 'add_blocked',
            message: nothingChanged(`${traversalLimitReason(scanChecked)} Use force=true to add it anyway.`),
          }, { projectWritten: false });
        }
        const skipped = unscannedFilesOf('eventSheets', await reader.listEventSheets(), await reader.readAllEventSheets(), reader.getReadFailures('eventSheets'))
          .filter(f => f.name !== args.sheetName);
        const unscanned = await checkUnscannedFiles(reader, skipped, [{ categories: ['eventSheets'], allOf: [[nameTerm(args.aceName)], [nameTerm(args.objectClass)]] }]);
        if (blocksWithoutForce(unscanned) && !args.force) {
          return toolResult({
            success: false, entity: args.sheetName, category: 'eventsheet', action: 'add_blocked',
            message: nothingChanged(`${unscannedRefusal(unscanned)} One of them may already define a custom action "${args.aceName}" on "${args.objectClass}". Use force=true to add it anyway.`),
            ...unscannedFields(unscanned),
          }, { projectWritten: false });
        }

        const names = (args.parameters ?? []).map(p => p.name);
        if (names.length > 0) {
          const paramError = functionParameterNamesError(sheets, args.sheetName, names, containerParents(sheet.events, container), 'parameters');
          if (paramError) return toolError(nothingChanged(paramError));
        }

        const beforeEvents = snapshotEvents(sheet.events);
        const sid = await idGen.generateSid(reader);
        const params: Array<NonNullable<typeof args.parameters>[number] & { sid: number }> = [];
        for (const p of args.parameters ?? []) params.push({ ...p, sid: await idGen.generateSid(reader) });
        const event = createCustomActionEvent(args.aceName, args.objectClass, sid, params, {
          description: args.description, category: args.category, isAsync: args.isAsync, copyPicked: args.copyPicked,
        }) as unknown as Record<string, unknown>;
        undoInsert = () => { sheet.events = beforeEvents; };
        insertIntoContainer(container, args.position, event);
        const eventPath = eventPathOf(events, event);

        // The load-time gate, as add_event_block runs it: the new block may stand between a block and its else block
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(nothingChanged(loadRuleErrorMessage(loadCheck.errors)));
        }
        // With force, the sheets that may define the name; without a block, those searched as text without a match
        const warnings = [...loadCheck.warnings, ...elsePredecessorWarnings(beforeEvents, sheet.events), ...unscannedWarnings(unscanned, 'Added')];
        if (!scan.complete) warnings.push(`Added with force=true: ${traversalLimitReason(scanChecked)}`);

        writeStarted = true;
        const backupPath = await writeEntityOrRollBack(writer, 'eventSheets', args.sheetName, sheet);
        resetProjectIndex(reader);
        return toolResult({
          success: true, entity: args.sheetName, category: 'eventsheet', action: 'updated', generatedSid: sid,
          ...(params.length > 0 ? { parameterSids: params.map(p => ({ name: p.name, sid: p.sid })) } : {}),
          eventPath,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...unscannedFields(unscanned),
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[add_custom_action] failed:', error);
        if (undoInsert) {
          undoInsert();
          // Nothing reached the disk: the sheet in memory is as it was
          if (!writeStarted) {
            return toolError(nothingChanged(`The change was stopped before anything was written: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
        return toolError(`Error adding custom action: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_function ──────────────────────────────────────

  // Registered with a strict object schema, so unknown arguments are refused (see add_event_block).
  server.registerTool(
    'update_function',
    {
      description: 'Update a function block or a custom action block: name (functionName; for a custom action its aceName), return type (function blocks only; refused for a custom action), description, category, options, and parameters (add, remove, rename). Calls and function map registrations are rewritten only with updateCallers=true. A custom action call is matched to the definition it runs (its object type\'s own action, else its family\'s, or the family named in customActionObjectClass; names ignoring case); a custom action name its owner already has is refused, and so, even with force, is a rename that would make a call the scan reached run another definition or stop running this one (with force past the scan\'s traversal limit, the calls and definitions beyond it are not checked). A change that Functions.Name(...) expression calls or event sheets that could not be parsed may depend on is refused without force, since this tool cannot rewrite those; such a sheet is searched as text for the old name and, for a rename, the new one. Scripts are not checked. Removing or renaming a parameter that the body still uses by its old name, or renames that make a use in the body find another parameter, are refused without force. A new parameter\'s initial value must be one the calls can take as an argument (a number, a one-line string, true or false). A call is rewritten only when it passes the parameter count from before the update, so a repeated run of a change that alters the parameter count changes nothing more; removing and adding the same number of parameters in one call is refused while calls exist (make two calls). Caller sheets are written first and the definition last; a failed write puts back what the call wrote, except a file saved meanwhile by another program, which is left as it is and named with its .bak. dryRun reports the plan without writing.',
      inputSchema: z.object({
        sheetName: z.string().max(200).describe('Event sheet that holds the function, as registered (letter case included)'),
        sid: z.number().int().positive().describe('SID of the function block or custom action block'),
        eventPath: eventPathSchema,
        functionName: z.string().min(1).max(200).optional().describe('New name (for a custom action, its aceName); calls and function maps follow only with updateCallers=true'),
        description: z.string().max(10_000).optional().describe('The editor\'s Description'),
        category: z.string().max(200).optional().describe('The editor\'s Category'),
        returnType: z.enum(['none', 'number', 'string', 'any']).optional().describe('The editor\'s Return type (function blocks only)'),
        isAsync: z.boolean().optional().describe('The editor\'s Asynchronous option'),
        copyPicked: z.boolean().optional().describe('The editor\'s Copy picked option'),
        addParameters: z.array(z.object({
          name: z.string().min(1).max(200),
          type: z.enum(['number', 'string', 'boolean']),
          initialValue: z.string().max(10_000).optional(),
          comment: z.string().max(10_000).optional(),
        }, { errorMap: unknownKeysErrorMap('an addParameters entry', 'An entry has name, type, initialValue and comment.') }).strict()).max(100).optional()
          .describe('Parameters to append, in order; with updateCallers=true each call gets the initial value as its argument'),
        removeParameters: z.array(z.string().max(200)).max(100).optional().describe('Names of parameters to remove; with updateCallers=true each call loses the argument at that position'),
        renameParameters: z.array(z.object({ from: z.string().max(200), to: z.string().min(1).max(200) },
          { errorMap: unknownKeysErrorMap('a renameParameters entry', 'An entry has from and to.') }).strict()).max(100).optional()
          .describe('Parameter renames; uses in the body are not rewritten'),
        updateCallers: z.boolean().optional().default(false).describe('Rewrite Call function actions and function map registrations'),
        force: z.boolean().optional().default(false).describe('Update even when Functions.Name(...) expressions, unparsed sheets or parameter uses in the body depend on the change (listed, left as they are)'),
        dryRun: z.boolean().optional().default(false).describe('Report what would change and write nothing'),
      }, {
        errorMap: unknownKeysErrorMap('the arguments of update_function', 'update_function takes sheetName, sid, eventPath, functionName, description, category, returnType, isAsync, copyPicked, addParameters, removeParameters, renameParameters, updateCallers, force and dryRun.'),
      }).strict(),
    },
    async (args) => {
      // Set once every sheet has its snapshot, so a throw puts every sheet in memory back
      let restoreAll: (() => void) | undefined;
      let writeStarted = false;
      try {
        // 1. Nothing given and not dryRun: refuse
        const removed = args.removeParameters ?? [];
        const renames = args.renameParameters ?? [];
        const added = args.addParameters ?? [];
        const given = [args.functionName, args.description, args.category, args.returnType, args.isAsync, args.copyPicked].some(v => v !== undefined)
          || removed.length + renames.length + added.length > 0;
        if (!given && !args.dryRun) {
          return toolError(nothingChanged('No update given. Give at least one of functionName, description, category, returnType, isAsync, copyPicked, addParameters, removeParameters and renameParameters.'));
        }

        // 2. The sheet and the function block
        const unregistered = await unregisteredSheetError(reader, args.sheetName);
        if (unregistered) return toolError(nothingChanged(unregistered.content[0].text));
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return toolError(nothingChanged(`Event sheet "${args.sheetName}" is registered in the project but could not be read.`));
        }
        const found = resolveEventBySid(sheet.events as Record<string, unknown>[], args.sid, { sheetName: args.sheetName, action: 'update', eventPath: args.eventPath });
        if ('error' in found) return toolError(nothingChanged(found.error));
        const func = found.match.event;
        if (func.eventType !== 'function-block' && func.eventType !== 'custom-ace-block') {
          return toolError(nothingChanged(`The event with SID ${args.sid} is a "${String(func.eventType)}", not a function block or custom action block.`));
        }
        const kind = func.eventType === 'function-block' ? 'function' : 'custom-action';
        if (kind === 'custom-action' && args.returnType !== undefined) {
          return toolError(nothingChanged('returnType applies to function blocks only; this tool refuses it for a custom action block.'));
        }

        // 3. Every sheet, read once here as the whole object the write needs, with a snapshot, and the uses of the function by name
        const sheetObjects = new Map<string, EventSheet>();
        for (const name of await reader.listEventSheets()) {
          if (name === args.sheetName) { sheetObjects.set(name, sheet); continue; }
          try {
            const data = await reader.readEventSheet(name);
            if (Array.isArray(data.events)) sheetObjects.set(name, data);
          } catch {
            // An unreadable sheet is searched as text below, as readEventSheetsFresh's callers do
          }
        }
        const sheets = new Map([...sheetObjects].map(([name, data]) => [name, data.events as C3Event[]] as const));
        const snapshots = new Map([...sheets].map(([name, events]) => [name, snapshotEvents(events)] as const));
        restoreAll = () => {
          for (const [name, data] of sheetObjects) data.events = snapshots.get(name)!;
        };
        // Only the definition's sheet changes before the last refusal, so putting it back undoes everything
        const restore = () => { sheet.events = snapshots.get(args.sheetName)!; };
        const refuse = (message: string) => {
          restore();
          return toolError(nothingChanged(message));
        };
        const blocked = (reason: string, references: unknown, reports: UnscannedFileReport[] = []) => {
          restore();
          return toolResult({
            success: false, entity: args.sheetName, category: 'eventsheet', action: 'update_blocked',
            message: nothingChanged(reason), references, ...unscannedFields(reports),
          }, { projectWritten: false });
        };
        // A function is named by functionName and called by callFunction; a custom action by aceName and customAction
        const definitionNameKey = kind === 'function' ? 'functionName' : 'aceName';
        const callNameKey = kind === 'function' ? 'callFunction' : 'customAction';
        const oldName = String(func[definitionNameKey]);
        const owner = String(func.objectClass);
        const shownName = kind === 'function' ? oldName : `${owner}.${oldName}`;
        let references: CallReference[] = [];
        let maps: CallReference[] = [];
        let expressions: CallReference[] = [];
        let complete: boolean;
        let limit: ReferenceCheckLimit | undefined;
        // For a custom action: the definitions, this one among them, every call, and the families of each object type
        let customActions: {
          definitions: CustomActionDefinition[]; self: CustomActionDefinition; sites: CustomActionCallSite[];
          familiesOf: (objectClass: string) => readonly string[];
        } | undefined;
        if (kind === 'function') {
          ({ references, complete, limit } = findFunctionReferences(sheets, oldName, functionsObjectName(reader)));
          maps = references.filter(r => r.kind === 'function-map');
          expressions = references.filter(r => r.kind === 'expression');
        } else {
          const scan = customActionScan(sheets);
          const callSites = customActionCallSites(sheets);
          // A definition past the scan's limits is not listed; it is still the one the calls are checked against
          const listed = scan.definitions.find(d => d.sheet === args.sheetName && d.eventPath === found.match.path);
          const self = listed ?? { owner, name: oldName, sheet: args.sheetName, eventPath: found.match.path, parameters: [] };
          customActions = {
            definitions: listed ? scan.definitions : [...scan.definitions, self], self, sites: callSites.sites,
            familiesOf: (await loadCustomActionContext(reader)).familiesOf,
          };
          complete = scan.complete && callSites.complete;
          limit = scan.limit ?? callSites.limit;
        }

        // 4. The new name and return type, checked like the editor's Function dialog against every other function;
        // for a custom action, against the other custom actions of its owner and what each call runs
        const newName = args.functionName ?? oldName;
        const oldReturn = String(func.functionReturnType ?? 'none');
        const newReturn = args.returnType ?? oldReturn;
        let calls: CallReference[];
        const renameWarnings: string[] = [];
        if (customActions === undefined) {
          if (newName !== oldName || newReturn !== oldReturn) {
            const others = functionBlockNames(sheets).filter(f => !(f.sheet === args.sheetName && f.eventPath === found.match.path));
            const problem = findFunctionNameProblem(newName, newReturn, others);
            if (problem) return refuse(functionNameMessage(problem, newName, newReturn));
          }
          calls = references.filter(r => r.kind === 'callFunction');
        } else {
          const { definitions, self, sites, familiesOf } = customActions;
          // Only a new name is checked (a case-only one included), as for functions: a duplicate the project already holds does not stop other changes
          if (newName !== oldName) {
            if (newName.trim() === '') return refuse('functionName is empty or only spaces.');
            const clash = customActionDefinitionClashes(definitions.filter(d => d !== self), owner, newName)[0];
            if (clash !== undefined) {
              return refuse(`"${owner}" already has a custom action "${clash.name}" (sheet "${clash.sheet}", ${clash.eventPath}${clash.sid !== undefined ? `, SID ${clash.sid}` : ''}). ${DUPLICATE_CUSTOM_ACTION_RULE}`);
            }
          }
          const { rewrite, captured } = customActionRenameCaptures(sites, definitions, self, newName, familiesOf);
          if (captured.length > 0) {
            const runs = (d?: CustomActionDefinition) => (d ? `${d.owner}.${d.name}` : null);
            // A captured call always runs a definition after the rename: one not rewritten keeps its own, a rewritten one finds the renamed one
            const shown = captured.slice(0, 10).map(({ site, before, after }) =>
              `${site.sheet} ${site.path}${site.sid !== undefined ? ` (SID ${site.sid})` : ''} ${before ? `runs "${runs(before)}" now` : 'runs no custom action now'}` +
              ` and would run "${runs(after)}"`);
            return blocked(`Renaming "${shownName}" to "${newName}" would change which custom action ${captured.length} call(s) run: ` +
              `${shown.join('; ')}${captured.length > 10 ? `; and ${captured.length - 10} more` : ''}. ` +
              'A call names a custom action by its name, so this rename would make the game do something else; force does not override it. Choose another name.',
            captured.map(({ site, before, after }) => ({ ...referenceEntry(customCallReference(site)), runs: runs(before), wouldRun: runs(after) })));
          }
          calls = rewrite.map(customCallReference);
          references = calls;
          // A plain call on an object in several families that define the new name: the one it runs is the first, as the other custom action tools warn
          if (newName !== oldName) {
            let omitted = 0;
            for (const site of rewrite) {
              if (site.call.customActionObjectClass !== undefined || self.owner === site.call.objectClass) continue;
              const others = familiesOf(site.call.objectClass).filter(family => family !== self.owner
                && definitions.some(d => d !== self && d.owner === family && nameKey(d.name) === nameKey(newName)));
              if (others.length === 0) continue;
              if (renameWarnings.length >= 10) {
                omitted++;
                continue;
              }
              renameWarnings.push(`${site.sheet} ${site.path}${site.sid !== undefined ? ` (SID ${site.sid})` : ''}: "${site.call.objectClass}" belongs to the families "${self.owner}" and ` +
                `${others.map(f => `"${f}"`).join(', ')}, which both define a custom action of that name. The call uses the one on "${self.owner}"; which one Construct 3 runs was not checked in the editor.`);
            }
            if (omitted > 0) {
              renameWarnings.push(`And ${omitted} more rewritten call(s) whose object belongs to several families that define a custom action of that name; each uses the one on "${self.owner}".`);
            }
          }
        }

        // 5. Parameters: where the removed and renamed names resolve now, then removals, renames and additions in that order
        const params = (Array.isArray(func.functionParameters) ? func.functionParameters : []) as Array<Record<string, unknown>>;
        const oldNames = params.map(p => String(p.name));
        const oldCount = params.length;
        for (const name of removed) {
          if (!oldNames.includes(name)) {
            return refuse(`The function "${oldName}" has no parameter "${name}" to remove. Its parameters are ${oldNames.length > 0 ? oldNames.map(n => `"${n}"`).join(', ') : 'none'}.`);
          }
        }
        // Every name a rename or removal touches, the new names included, so a use that ends up finding another parameter is seen
        const watched = new Map([...removed, ...renames.flatMap(r => [r.from, r.to])].map(n => [n.toLowerCase(), n] as const));
        const bindingsBefore = recordVariableBindings(sheets, watched);
        const removedIndexes = new Set(removed.map(n => oldNames.indexOf(n)));
        const current = params.filter((_p, i) => !removedIndexes.has(i));
        func.functionParameters = current;
        const parents = [...((findEnclosingEvents(sheet.events, func as unknown as C3Event) ?? []) as C3Event[]), func as unknown as C3Event];
        for (const { from, to } of renames) {
          const param = current.find(p => p.name === from);
          if (!param) return refuse(`The function "${oldName}" has no parameter "${from}" to rename${removed.includes(from) ? ': this update also removes it' : ''}.`);
          const problem = findEventVariableNameProblem(to, eventVariableNameUses(sheets, args.sheetName, parents, param), from);
          if (problem) return refuse(eventVariableNameMessage(problem, to, 'function parameter', NAME_SCOPE_RULE.parameter));
          param.name = to;
        }
        // The argument each call gets for a new parameter, built and checked here, before anything is written
        const addedArguments: FunctionArgument[] = [];
        for (const p of added) {
          const argument = callArgumentFor(p.type, p.initialValue);
          if ('problem' in argument) return refuse(argument.problem);
          addedArguments.push(argument.value);
        }
        for (const p of added) {
          // Checked against the parameters so far, so a name twice in one call is refused, as functionParameterNamesError does
          const problem = findEventVariableNameProblem(p.name, eventVariableNameUses(sheets, args.sheetName, parents));
          if (problem) return refuse(eventVariableNameMessage(problem, p.name, 'function parameter', NAME_SCOPE_RULE.parameter));
          // The template's key order (createFunctionEvent in templates.ts)
          current.push({ name: p.name, type: p.type, initialValue: p.initialValue ?? defaultInitialValue(p.type), comment: p.comment ?? '', sid: await idGen.generateSid(reader) });
        }

        // 6. What the change touches; a case-only rename counts, since calls are rewritten to the new spelling
        const renamed = newName !== oldName;
        const shapeChanged = removed.length + added.length > 0;
        const returnToNone = newReturn === 'none' && oldReturn !== 'none';

        // 7. Blocks: calls without updateCallers, an argument change a repeated run could not recognise, expressions, unparsed sheets, the traversal limit
        const callerRefs = [...calls, ...(renamed ? maps : [])];
        if ((renamed || shapeChanged) && callerRefs.length > 0 && !args.updateCallers) {
          const using = kind === 'function' ? `call(s) or function map registration(s) use "${oldName}"` : `call(s) run the custom action "${shownName}"`;
          return blocked(`${callerRefs.length} ${using}: ${listReferences(callerRefs)}. Set updateCallers=true to rewrite them, or change them first.`,
            callerRefs.map(referenceEntry));
        }
        if (removed.length > 0 && added.length > 0 && current.length === oldCount && calls.length > 0) {
          return refuse(`This update removes ${removed.length} and adds ${added.length} parameter(s), so each call would keep ${oldCount} argument(s), and a run repeated after a stop could not tell a call already rewritten from one not yet rewritten. Make two calls: one that removes the parameters, then one that adds them.`);
        }
        if ((renamed || shapeChanged || returnToNone) && expressions.length > 0 && !args.force) {
          return blocked(`${expressions.length} expression(s) call Functions.${oldName}(...): ${listReferences(expressions)}. Functions.Name(...) calls in expressions are not rewritten: change them by hand, or use force=true and change them after.`,
            expressions.map(referenceEntry));
        }
        let unscanned: UnscannedFileReport[] = [];
        // An unparsed sheet may call Functions.Name(...) in an expression, which a removed return type breaks too
        if (renamed || shapeChanged || returnToNone) {
          const skipped = unscannedFilesOf('eventSheets', await reader.listEventSheets(), await reader.readAllEventSheets(), reader.getReadFailures('eventSheets'));
          // The new name too: such a sheet may hold a call the rename would capture, or a definition the new name would clash with
          const searched = renamed ? [nameTerm(oldName), nameTerm(newName)] : [nameTerm(oldName)];
          unscanned = await checkUnscannedFiles(reader, skipped, [{ categories: ['eventSheets'], allOf: [searched] }]);
          if (blocksWithoutForce(unscanned) && !args.force) {
            return blocked(`${unscannedRefusal(unscanned)} Use force=true to update anyway.`, [], unscanned);
          }
        }
        const usesChecked = kind === 'function' ? `uses of the function "${oldName}"` : `uses of the custom action "${shownName}"`;
        if (!complete && !args.force) return blocked(`${traversalLimitReason(usesChecked, limit)} Use force=true to update anyway.`, references.map(referenceEntry));

        // 8. Parameter uses in the body: a use whose parameter is gone, or that now finds another parameter of its name
        const { lost, rebound } = findVariableBindingChanges(bindingsBefore, sheets);
        const lostCount = countDeleteReferences(lost);
        const reboundCount = countDeleteReferences(rebound);
        const whereLost = 'where the parameter no longer exists after the update';
        const whereRebound = 'where the name now finds another parameter after the update';
        const paramsChecked = `uses of the parameters of "${shownName}"`;
        if ((lostCount > 0 || reboundCount > 0 || !lost.complete) && !args.force) {
          const reasons = [
            ...(lostCount > 0 ? [`${describeDanglingReferences(lost, whereLost)} ${SCOPE_LOSS_CONSEQUENCE}`] : []),
            ...(reboundCount > 0 ? [`${describeDanglingReferences(rebound, whereRebound)} ${REBOUND_USE_CONSEQUENCE}`] : []),
            ...(!lost.complete ? [traversalLimitReason(paramsChecked, lost.limit)] : []),
          ];
          return blocked(`${reasons.join(' ')} Change those uses first, or use force=true to update anyway.`,
            { ...danglingReferenceList(lost), ...(reboundCount > 0 ? { rebound: danglingReferenceList(rebound) } : {}) });
        }
        const warnings: string[] = [];
        if (lostCount > 0) warnings.push(`Updated with force=true: ${describeDanglingReferences(lost, whereLost)} ${SCOPE_LOSS_CONSEQUENCE} Fix them before opening the project in Construct 3.`);
        if (reboundCount > 0) warnings.push(`Updated with force=true: ${describeDanglingReferences(rebound, whereRebound)} ${REBOUND_USE_CONSEQUENCE}`);
        if (!lost.complete) warnings.push(`Updated with force=true: ${traversalLimitReason(paramsChecked, lost.limit)}`);
        if ((renamed || shapeChanged || returnToNone) && expressions.length > 0) {
          warnings.push(`Updated with force=true: ${expressions.length} Functions.${oldName}(...) expression call(s) were left as they are: ${listReferences(expressions)}. Change them before opening the project in Construct 3.`);
        }
        if (!complete) warnings.push(`Updated with force=true: ${traversalLimitReason(usesChecked, limit)}`);
        warnings.push(...unscannedWarnings(unscanned, 'Updated'));
        warnings.push(...renameWarnings);
        const parameterList = () => current.map(p => ({ name: p.name, type: p.type, sid: p.sid }));

        // 9. dryRun: report the plan, put the definition back, write nothing
        if (args.dryRun) {
          const plan = {
            dryRun: true, kind, name: oldName, newName, ...(kind === 'function' ? { returnType: newReturn } : {}), parameters: parameterList(),
            calls: calls.map(referenceEntry), maps: maps.map(referenceEntry), expressions: expressions.map(referenceEntry),
            ...(warnings.length > 0 ? { warnings } : {}),
            ...unscannedFields(unscanned),
          };
          restore();
          return toolResult(plan, { projectWritten: false });
        }

        // 10. The definition (the parameters were changed in step 5); a key the stored block lacks is added after the others
        if (renamed) func[definitionNameKey] = newName;
        if (args.description !== undefined) func.functionDescription = args.description;
        if (args.category !== undefined) func.functionCategory = args.category;
        if (args.returnType !== undefined) func.functionReturnType = args.returnType;
        if (args.isAsync !== undefined) func.functionIsAsync = args.isAsync;
        if (args.copyPicked !== undefined) func.functionCopyPicked = args.copyPicked;

        // 11. The callers, with updateCallers only; a call is renamed always, and its arguments change only when it passes oldCount of them
        let rewrittenCalls = 0;
        let rewrittenMaps = 0;
        const leftAlone: CallReference[] = [];
        if (args.updateCallers) {
          for (const ref of calls) {
            let changed = false;
            if (renamed) { ref.ace[callNameKey] = newName; changed = true; }
            if (shapeChanged) {
              if (rewriteCallArguments(ref.ace, oldCount, removedIndexes, addedArguments)) changed = true;
              else leftAlone.push(ref);
            }
            if (changed) rewrittenCalls++;
          }
          if (renamed) {
            for (const ref of maps) {
              (ref.ace.parameters as Record<string, unknown>).function = newName;
              rewrittenMaps++;
            }
          }
        }
        if (leftAlone.length > 0) {
          warnings.push(`${leftAlone.length} call(s) pass a number of arguments other than the ${oldCount} parameter(s) "${shownName}" had, so their arguments were left as they are (a call this update already rewrote in a run that stopped is one of them): ${listReferences(leftAlone)}.`);
        }

        // 12. Unchanged: no sheet differs from its snapshot
        const changedSheets = [...sheets.keys()].filter(name => JSON.stringify(sheets.get(name)) !== JSON.stringify(snapshots.get(name)));
        if (changedSheets.length === 0) {
          return toolResult({
            success: true, entity: args.sheetName, category: 'eventsheet', action: 'unchanged', updatedSid: args.sid, kind,
            name: newName, previousName: oldName, parameters: parameterList(), updatedSheets: [], rewrittenCalls: 0, rewrittenMaps: 0,
            ...(warnings.length > 0 ? { warnings } : {}),
          }, { projectWritten: false });
        }

        // 13. Write the caller sheets in registered order, then the definition's sheet. Every sheet object was read in
        // step 3, so nothing reads between the writes; any error after the first write rolls back what this call wrote
        const order = [...changedSheets.filter(name => name !== args.sheetName), ...(changedSheets.includes(args.sheetName) ? [args.sheetName] : [])];
        const backupFiles: string[] = [];
        let writing: string | undefined;
        writeStarted = true;
        try {
          for (const name of order) {
            writing = name;
            backupFiles.push(await writeEntityOrRollBack(writer, 'eventSheets', name, sheetObjects.get(name)!));
            writing = undefined;
          }
          resetProjectIndex(reader);
        } catch (error) {
          // writeEntityOrRollBack has rolled the call back and worded the message; any other error is rolled back here
          if (writing !== undefined) throw error;
          throw new Error(await rollBackFailedCall(writer, error));
        }
        return toolResult({
          success: true, entity: args.sheetName, category: 'eventsheet', action: 'updated', updatedSid: args.sid, kind,
          name: newName, previousName: oldName, parameters: parameterList(), updatedSheets: order, rewrittenCalls, rewrittenMaps,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(lostCount > 0 ? { references: danglingReferenceList(lost) } : {}),
          ...(reboundCount > 0 ? { reboundReferences: danglingReferenceList(rebound) } : {}),
          ...unscannedFields(unscanned),
          backupFiles,
        });
      } catch (error) {
        console.error('[update_function] failed:', error);
        const message = error instanceof Error ? error.message : String(error);
        if (restoreAll) {
          restoreAll();
          // Nothing reached the disk: every sheet in memory is as it was
          if (!writeStarted) return toolError(nothingChanged(`The change was stopped before anything was written: ${message}`));
        }
        return toolError(`Error updating function: ${message}`);
      }
    }
  );

  // ─── delete_event_sheet ───────────────────────────────────

  server.tool(
    'delete_event_sheet',
    'Delete an event sheet from the project (checks references first; refused without force while there are any): sheets that include it, layouts bound to it, and uses in other event sheets of the functions and global variables it defines (Call function actions, function map registrations, Functions.Name(...) expression calls, System conditions/actions on the variable, expressions that use the variable by name; scripts are not checked). Event sheets and layouts that could not be parsed (over the size limit (10MB by default), not valid JSON) are searched as text for the sheet name, and event sheets also for those functions and global variables: a match (a possible use), or such a file that cannot be read at all, refuses without force (listed in unscannedFiles), as does a sheet to delete that could not be parsed itself or a check that stopped at its traversal limit (100,000 events).',
    {
      name: z.string().max(200).describe('Event sheet name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references; the uses of its functions and global variables left behind are listed in "references" and a warning)'),
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

        // 3. Functions and global variables the sheet defines that other
        // sheets still use (issue #58): the same check as
        // delete_event_from_sheet, with every event of the sheet deleted
        const sheets = await reader.readAllEventSheets();
        const ownEvents = sheets.get(args.name)?.events;
        let dangling: DeleteReferenceReport = { functions: [], variables: [], complete: true };
        const visibleNames = new Set<string>();
        if (Array.isArray(ownEvents)) {
          const sheetEvents = new Map<string, unknown>();
          for (const [name, other] of sheets) sheetEvents.set(name, other.events);
          dangling = findReferencesLeftByDelete(sheetEvents, ownEvents as object[], functionsObjectName(reader));
          for (const event of ownEvents) {
            for (const name of namesVisibleToOtherSheets(event, true)) visibleNames.add(name);
          }
        }
        const danglingCount = countDeleteReferences(dangling);

        // 4. Event sheets (includes; the functions and globals it defines) and
        // layouts (bindings) that could not be parsed. When the sheet itself
        // could not be parsed, what it defines is unknown.
        const otherFiles = index.unscannedFiles.filter(f => !(f.category === 'eventSheets' && f.name === args.name));
        const unscanned = [
          ...ownFileReports(index.unscannedFiles, [{
            category: 'eventSheets',
            name: args.name,
            unchecked: 'the functions and global variables it defines are unknown, so their uses in other event sheets could not be checked',
          }]),
          ...await checkUnscannedFiles(reader, otherFiles, [
            { categories: ['eventSheets', 'layouts'], allOf: [[nameTerm(args.name)]] },
            { categories: ['eventSheets'], allOf: [[...visibleNames].map(n => nameTerm(n))] },
          ]),
        ];
        const unscannedBlock = blocksWithoutForce(unscanned);
        const outsideSheet = `in other event sheets than "${args.name}"`;
        const checked = 'uses of the functions and global variables the sheet defines';

        if ((hasRefs || danglingCount > 0 || unscannedBlock || !dangling.complete) && !args.force) {
          const reasons = [
            ...(hasRefs ? ['Event sheet is still referenced.'] : []),
            ...(danglingCount > 0 ? [`${describeDanglingReferences(dangling, outsideSheet)} ${DANGLING_REFERENCE_CONSEQUENCE}`] : []),
            ...(unscannedBlock ? [unscannedRefusal(unscanned)] : []),
            ...(!dangling.complete ? [traversalLimitReason(checked, dangling.limit)] : []),
          ];
          return toolResult({
            success: false,
            entity: args.name,
            category: 'eventsheet',
            action: 'delete_blocked',
            message: `${reasons.join(' ')} Use force=true to delete anyway (references will NOT be cleaned up).`,
            references: {
              includedBy,
              boundLayouts,
              ...danglingReferenceList(dangling),
            },
            ...unscannedFields(unscanned),
          });
        }

        const warnings: string[] = [];
        if (hasRefs && args.force) {
          const refList = [...includedBy.map(s => `included by "${s}"`), ...boundLayouts.map(l => `bound to layout "${l}"`)];
          warnings.push(`Event sheet deleted but still referenced: ${refList.join(', ')}. References were NOT cleaned up.`);
        }
        if (danglingCount > 0) {
          warnings.push(`Deleted with force=true: ${describeDanglingReferences(dangling, outsideSheet)} ` +
            `${DANGLING_REFERENCE_CONSEQUENCE} Fix them before opening the project in Construct 3.`);
        }
        if (!dangling.complete) {
          warnings.push(`Deleted with force=true: ${traversalLimitReason(checked, dangling.limit)}`);
        }
        warnings.push(...unscannedWarnings(unscanned, 'Deleted'));

        const backupPath = await deleteRegisteredEntity(writer, 'eventSheets', args.name);
        resetProjectIndex(reader);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'eventsheet',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
          ...unscannedFields(unscanned),
        };
        // With force=true, the uses of its functions and global variables left dangling
        return toolResult(danglingCount > 0 ? { ...result, references: danglingReferenceList(dangling) } : result);
      } catch (error) {
        console.error('[delete_event_sheet] failed:', error);
        return toolError(`Error deleting event sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_event_from_sheet ────────────────────────────────

  server.tool(
    'delete_event_from_sheet',
    'Delete an event from an event sheet by SID (for blocks, groups, variables, functions) or by includeSheet name (for includes). Sub-events are deleted with their event. Use get_eventsheet_details to find SIDs. A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one. Refuses (unless force=true) when a function or event variable it removes is still named outside the deleted events: Call function actions, function map registrations, Functions.Name(...) expression calls, System conditions/actions on the variable, expressions that use the variable by name (scripts are not checked). Other event sheets that could not be parsed (over the size limit (10MB by default), not valid JSON) are searched as text for the deleted functions and global variables: a match (a possible use), or such a sheet that cannot be read at all, also refuses without force (listed in unscannedFiles), as does a check that stopped at its traversal limit (100,000 events). Reports an else block the delete leaves without the block it belonged to (else-placement warning).',
    {
      sheetName: z.string().max(200).describe('Target event sheet, as registered (letter case included)'),
      sid: z.number().int().positive().optional().describe('SID of the event to delete (for block, group, variable, function events)'),
      eventPath: eventPathSchema,
      includeSheet: z.string().max(200).optional().describe('For removing includes: the included sheet name'),
      dryRun: z.boolean().optional().default(false).describe('If true, report what would be deleted without actually deleting'),
      force: z.boolean().optional().default(false).describe('If true, delete even when functions or event variables it removes are still referenced (the references are listed in "references" and a warning and left dangling; with dryRun, lists what the delete would leave dangling)'),
    },
    async (args) => {
      try {
        // Validate exactly one identifier
        if ((args.sid === undefined) === (args.includeSheet === undefined)) {
          return toolError('Specify exactly one of: sid (for blocks/groups/variables/functions) or includeSheet (for includes).');
        }
        if (args.eventPath !== undefined && args.sid === undefined) {
          return toolError('eventPath picks one of several events that share a SID; pass it together with sid.');
        }
        // Its reference check compares the sheet with the other sheets by registered name
        const unregistered = await unregisteredSheetError(reader, args.sheetName);
        if (unregistered) return unregistered;

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
          resetProjectIndex(reader);

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

        // ── SID deletion path ── (a SID shared by several events is refused, dry run included)
        const found = resolveEventBySid(events, args.sid!, {
          sheetName: args.sheetName,
          action: 'delete',
          eventPath: args.eventPath,
        });
        if ('error' in found) return toolError(found.error);

        const { event, parentArray, index, path } = found.match;
        const eventType = event.eventType as string;
        const childCount = countDescendants(event);

        // Names the delete would leave dangling: calls, function map
        // registrations and Functions.Name(...) expression calls of the
        // function blocks it removes (the event itself or ones inside a
        // deleted group), and event variable parameters naming the variables
        // it removes, anywhere in the project outside the deleted events.
        // Event sheets that could not be parsed are searched as text for the
        // functions and global variables the delete removes (issue #55).
        let dangling: DeleteReferenceReport = { functions: [], variables: [], complete: true };
        let unscanned: UnscannedFileReport[] = [];
        if (definesFunctionsOrVariables(event)) {
          const sheets = await reader.readAllEventSheets();
          const sheetFailures = reader.getReadFailures('eventSheets');
          const sheetEvents = new Map<string, unknown>();
          for (const [name, other] of sheets) {
            sheetEvents.set(name, name === args.sheetName ? sheet.events : other.events);
          }
          sheetEvents.set(args.sheetName, sheet.events);
          dangling = findReferencesLeftByDelete(sheetEvents, event, functionsObjectName(reader));
          const names = namesVisibleToOtherSheets(event, parentArray === events);
          if (names.length > 0) {
            const skipped = unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, sheetFailures)
              .filter(f => f.name !== args.sheetName);
            unscanned = await checkUnscannedFiles(reader, skipped, [
              { categories: ['eventSheets'], allOf: [names.map(n => nameTerm(n))] },
            ]);
          }
        }
        const danglingCount = countDeleteReferences(dangling);
        const unscannedBlock = blocksWithoutForce(unscanned);
        const checked = 'references to the deleted functions and variables';
        if ((danglingCount > 0 || unscannedBlock || !dangling.complete) && !args.force) {
          const reasons = [
            ...(danglingCount > 0 ? [`${describeDanglingReferences(dangling)} ${DANGLING_REFERENCE_CONSEQUENCE}`] : []),
            ...(unscannedBlock ? [unscannedRefusal(unscanned)] : []),
            ...(!dangling.complete ? [traversalLimitReason(checked, dangling.limit)] : []),
          ];
          return toolResult({
            success: false,
            entity: args.sheetName,
            category: 'eventsheet',
            action: 'delete_blocked',
            message: `${reasons.join(' ')} Remove or change these references first, or use force=true to delete anyway.`,
            references: danglingReferenceList(dangling),
            ...unscannedFields(unscanned),
          });
        }
        if (danglingCount > 0) {
          warnings.push(`${args.dryRun ? 'Would delete' : 'Deleted'} with force=true: ${describeDanglingReferences(dangling)} ` +
            `${DANGLING_REFERENCE_CONSEQUENCE} ${args.dryRun ? 'The delete would leave these references dangling; fix' : 'Fix'} ` +
            'them before opening the project in Construct 3.');
        }
        warnings.push(...unscannedWarnings(unscanned, args.dryRun ? 'Would delete' : 'Deleted'));
        if (!dangling.complete) {
          warnings.push(`${args.dryRun ? 'Would delete' : 'Deleted'} with force=true: ${traversalLimitReason(checked, dangling.limit)}`);
        }

        // Report children for groups
        if (childCount > 0) {
          warnings.push(args.dryRun
            ? `The ${eventType} contains ${childCount} child event(s) that would also be removed.`
            : `Deleted ${eventType} contained ${childCount} child event(s) that were also removed.`);
        }

        // Editor load-time rules of the gate (expression-syntax,
        // empty-expression, trigger-placement, else-placement). A delete
        // removes an event together with all its sub-events. The expression
        // rules look at an event's own parameters and the trigger rules at its
        // own conditions and its ancestors, and no remaining event gains an
        // ancestor or changes its conditions, so a delete cannot introduce an
        // issue of those rules. Else placement also looks at the event before
        // an else block (the nearest one that is not a comment): deleting the
        // block an else belongs to leaves the else after another event (or
        // first), which is reported as a warning. An error would still block
        // the delete. Names left dangling are checked above. The event is
        // taken out of the sheet for the check and put back for a dry run or
        // a refusal.
        const beforeEvents = snapshotEvents(sheet.events);
        parentArray.splice(index, 1);
        let loadCheck: Awaited<ReturnType<typeof checkLoadRulesBeforeWrite>>;
        try {
          loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        } catch (error) {
          parentArray.splice(index, 0, event);
          throw error;
        }
        if (args.dryRun || loadCheck.errors.length > 0) {
          parentArray.splice(index, 0, event);
        }
        if (loadCheck.errors.length > 0) {
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);
        // With force=true, the references the delete leaves dangling (a dry run lists them too)
        const references = danglingCount > 0 ? { references: danglingReferenceList(dangling) } : {};

        if (args.dryRun) {
          return toolResult({
            success: true,
            dryRun: true,
            entity: args.sheetName,
            category: 'eventsheet',
            action: 'would_delete',
            deletedType: eventType,
            deletedSid: args.sid,
            eventPath: path,
            childrenCount: childCount,
            ...(eventType === 'group' ? { deletedTitle: event.title as string } : {}),
            ...(eventType === 'function-block' ? { deletedFunction: event.functionName as string } : {}),
            ...references,
            ...(warnings.length > 0 ? { warnings } : {}),
            ...unscannedFields(unscanned),
          });
        }

        // The event is already out of the sheet (load-time check above)
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex(reader);

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
          eventPath: path,
          childrenRemoved: childCount,
          ...references,
          ...unscannedFields(unscanned),
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
        resetProjectIndex(reader);

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
    'Replace parameters on a single action within an existing event block. Identify the block by SID and the action by its 0-based index. Use get_eventsheet_details to find SIDs and action indices. A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one. Function calls take their arguments as an array in parameter order. A custom action call takes its arguments as an array in parameter order, which replaces the stored ones. Comment rows and script actions have no parameters and are refused. Parameters that would break a checked editor load-time rule (expression syntax, empty expressions) are refused.',
    {
      sheetName: z.string().max(200).describe('Target event sheet'),
      blockSid: z.number().int().positive().describe('SID of the block event containing the action'),
      eventPath: eventPathSchema,
      actionIndex: z.number().int().min(0).describe('0-based index of the action to update'),
      parameters: z.union([boundedRecord(), z.array(functionCallArgumentSchema).max(100)])
        .describe('New parameter values — replaces existing parameters entirely. Key-value pairs for plugin/behavior/System actions (max 100 keys, depth 6); for a function call, the arguments in parameter order as an array (an object keyed "0", "1", … or by parameter name is converted); for a custom action call, an array in parameter order (an object is refused)'),
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
        const found = resolveEventBySid(events, args.blockSid, {
          sheetName: args.sheetName,
          action: 'update',
          eventPath: args.eventPath,
        });
        if ('error' in found) return toolError(found.error);

        const { event, path } = found.match;
        const eventType = event.eventType as string;

        if (eventType !== 'block' && eventType !== 'function-block' && eventType !== 'custom-ace-block') {
          return toolError(`Event with SID ${args.blockSid} is a "${eventType}", not a block, function-block or custom action block. Only those have actions.`);
        }

        const actions = event.actions as Record<string, unknown>[];
        if (args.actionIndex < 0 || args.actionIndex >= actions.length) {
          return toolError(
            `Action index ${args.actionIndex} is out of range (block has ${actions.length} action(s), ` +
            `indices 0-${Math.max(0, actions.length - 1)}).`,
          );
        }

        const beforeEvents = snapshotEvents(sheet.events);
        const action = actions[args.actionIndex];
        const rowProblem = parameterlessRowError(action, args.actionIndex);
        if (rowProblem) return toolError(rowProblem);
        let warnings: string[];
        if (isCustomActionCall(action)) {
          // A custom action call takes its arguments as an array; the refusal and the project read come before the call changes
          if (!Array.isArray(args.parameters)) {
            return toolError(nothingChanged(`Action ${args.actionIndex} is a custom action call: pass its arguments as an array in parameter order.`));
          }
          const customContext = await loadCustomActionContext(reader);
          const argumentsGiven = args.parameters.map(value => (typeof value === 'boolean' ? value : String(value)));
          if (argumentsGiven.length > 0) action.parameters = argumentsGiven;
          else delete action.parameters;
          warnings = customActionCallWarnings(action as unknown as CustomActionCall, customContext,
            `Action ${args.actionIndex}, custom action call "${String(action.customAction)}" on "${String(action.objectClass)}"`, 'kept');
        } else if (isFunctionCall(action)) {
          // Function calls take positional arguments, as the editor saves them
          const name = action.callFunction as string;
          const label = `Call to "${name}"`;
          const signature = (await loadFunctionSignatures(reader)).get(name.toLowerCase());
          let callArgs: FunctionArgument[];
          try {
            callArgs = toPositionalArguments(args.parameters, signature, label);
          } catch (error) {
            return toolError(error instanceof Error ? error.message : String(error));
          }
          warnings = checkFunctionCallArguments(callArgs, signature, name, label);
          if (isLegacyFunctionCall(action)) {
            warnings.push(`${label} was stored in an old shape; it was rewritten as { callFunction, sid, parameters: [...] } without id/objectClass, the shape Construct 3 saves.`);
          }
          rewriteFunctionCallInPlace(action, callArgs);
          action.callFunction = resolveCallName(name, signature, label, warnings);
        } else {
          if (Array.isArray(args.parameters)) {
            return toolError(`Action ${args.actionIndex} is not a function call: pass its parameters as key-value pairs, not an array.`);
          }
          action.parameters = args.parameters;
          // Don't re-emit a legacy "behavior-type" key on the edited action (issue #16)
          warnings = await normalizeLegacyBehaviorKeys(reader, [{ ace: action, kind: 'action' }]);
          await resolveFunctionMapParameter(reader, action, `Action ${args.actionIndex} ("${String(action.id)}")`, warnings,
            () => loadFunctionSignatures(reader));
        }

        // Editor load-time rules (expression syntax, empty expressions)
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex(reader);

        return toolResult({
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          updatedBlockSid: args.blockSid,
          eventPath: path,
          updatedActionIndex: args.actionIndex,
          ...(isFunctionCall(action) ? { callFunction: action.callFunction } : isCustomActionCall(action) ? { customAction: action.customAction } : { actionId: action.id }),
          ...(warnings.length > 0 ? { warnings } : {}),
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
    'Copy (or move) top-level event blocks from one event sheet to another by SID. Set deleteSource=true to remove the events from the source sheet after copying (move semantics). SIDs and all nested children are preserved; the result warns when a copied SID then matches more than one event in the target sheet. A SID shared by several top-level events of the source is refused with a list of candidates; pass eventPaths to pick one. Runs the editor load-time gate over both sheets: moving an event that already breaks a load-time rule is allowed, copying it (deleteSource=false) is refused because it adds the problem to a second sheet. Refuses (unless force=true) a move that takes an event variable out of the scope of events that use it, e.g. a used global variable moved into a group (targetGroupPath), where it is a local variable; the uses are listed. Other event sheets that could not be parsed are searched as text for such a global variable; a check that stopped at its traversal limit (100,000 events) also refuses without force. A copy (deleteSource=false) that would leave two custom actions of one name on one object type or family is refused, and so is any copy while the check for custom actions stopped at its traversal limit; a move is not (Construct 3 r506-2 (Free edition) renamed the second of two such definitions on save).',
    {
      sourceSheet: z.string().max(200).describe('Event sheet to copy/move events from, as registered (letter case included)'),
      targetSheet: z.string().max(200).describe('Event sheet to copy/move events into, as registered (letter case included)'),
      sids: z.array(z.number().int().positive()).min(1).describe('SIDs of the top-level events to copy/move (each SID once)'),
      eventPaths: z.array(z.string().max(500)).max(100).optional().describe(
        'Only needed when a SID in sids matches more than one top-level event of the source sheet (the call is then refused with a list of candidates): ' +
        'the paths of the events you mean, e.g. ["events[4]"], one per ambiguous SID. Each must point at a top-level event whose SID is in sids.',
      ),
      deleteSource: z.boolean().optional().default(false).describe('If true, remove the events from the source sheet after copying (move semantics). A copy or move that would leave two event variables or function parameters whose names match ignoring case in one scope is refused, e.g. a copy of a global variable (its original keeps the name)'),
      targetGroupPath: z.string().max(500).optional().describe('Insert into a group in the target sheet by title path (e.g. "Movement > Collision"), matched like groupPath of add_event_block'),
      position: z.enum(['start', 'end']).optional().default('end').describe('Where to insert events in the target sheet or group'),
      force: z.boolean().optional().default(false).describe('If true, move even when events still use an event variable the move takes out of their scope (the uses are listed in "references" and a warning, and left dangling)'),
    },
    async (args) => {
      try {
        if (args.sourceSheet === args.targetSheet) {
          return toolError('sourceSheet and targetSheet must be different sheets.');
        }
        // Its checks compare both sheets with the other sheets by registered
        // name, and a target that is the source in another case would be
        // written twice, the second time without the moved events
        for (const name of [args.sourceSheet, args.targetSheet]) {
          const unregistered = await unregisteredSheetError(reader, name);
          if (unregistered) return unregistered;
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

        // A SID listed twice would copy its event twice
        const repeated = [...new Set(args.sids.filter((sid, i) => args.sids.indexOf(sid) !== i))];
        if (repeated.length > 0) {
          return toolError(
            `sids lists ${repeated.map(sid => `SID ${sid}`).join(', ')} more than once. List each SID once; ` +
            'top-level events that share a SID are moved one per call, picked with eventPaths.',
          );
        }

        // eventPaths pick one of several top-level events sharing a SID
        const picked = new Map<number, number>(); // SID → index in the source's top-level events
        for (const eventPath of args.eventPaths ?? []) {
          const indices = parseEventPath(eventPath);
          if (!indices || indices.length !== 1) {
            return toolError(`eventPaths entry "${eventPath}" is not the path of a top-level event. Only top-level events can be moved; use the form events[3].`);
          }
          const event = sourceEvents[indices[0]] as Record<string, unknown> | undefined;
          const sid = typeof event === 'object' && event !== null ? event.sid : undefined;
          if (typeof sid !== 'number' || !args.sids.includes(sid)) {
            const what = typeof event === 'object' && event !== null
              ? `a ${String(event.eventType)}${typeof sid === 'number' ? ` with SID ${sid}` : ' without a SID'}`
              : 'no event';
            return toolError(`eventPaths entry "${eventPath}" points at ${what} in "${args.sourceSheet}", not at an event whose SID is listed in sids.`);
          }
          if (picked.has(sid) && picked.get(sid) !== indices[0]) {
            return toolError(`eventPaths names two events with SID ${sid}. Pick one per SID and move the other in a separate call.`);
          }
          picked.set(sid, indices[0]);
        }

        // Find each requested SID in the source top-level events only
        const eventsToMove: Record<string, unknown>[] = [];
        const notFoundSids: number[] = [];
        const ambiguous: Array<{ sid: number; matches: SidMatch[] }> = [];

        for (const sid of args.sids) {
          const pickedIndex = picked.get(sid);
          if (pickedIndex !== undefined) {
            eventsToMove.push(sourceEvents[pickedIndex]);
            continue;
          }
          const matches: SidMatch[] = [];
          sourceEvents.forEach((event, index) => {
            if (event.sid === sid) matches.push({ event, parentArray: sourceEvents, index, path: `events[${index}]`, depth: 0 });
          });
          if (matches.length === 0) {
            notFoundSids.push(sid);
          } else if (matches.length > 1) {
            ambiguous.push({ sid, matches });
          } else {
            eventsToMove.push(matches[0].event);
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

        if (ambiguous.length > 0) {
          return toolError(ambiguous.map(({ sid, matches }) => ambiguousSidMessage(args.sourceSheet, sourceEvents, sid, matches, {
            action: args.deleteSource ? 'move' : 'copy',
            argument: 'eventPaths (one entry per ambiguous SID)',
            scope: 'top-level',
          })).join('\n\n'));
        }

        // Source events are only replaced (never mutated), the target is edited in place
        const targetBefore = snapshotEvents(targetSheetData.events);

        // Where the uses of the variables the events declare resolve now, per
        // condition/action (compared by identity), for the scope check below
        const otherSheets = await readEventSheetsFresh(reader, [
          [args.sourceSheet, sourceEvents as unknown as C3Event[]],
          [args.targetSheet, targetEvents as unknown as C3Event[]],
        ]);
        const movedVariables = variablesDeclaredIn(eventsToMove);
        const scopesBefore = recordVariableScopes(otherSheets, movedVariables);
        const globalsBefore = globalVariableNames(otherSheets);

        // Determine target insertion array
        let insertTarget: Record<string, unknown>[];
        if (args.targetGroupPath) {
          const resolved = resolveGroupPath(targetEvents, args.targetGroupPath);
          if (resolved.problem) {
            return toolError(describeGroupPathProblem(resolved.problem, args.targetGroupPath, args.targetSheet));
          }
          insertTarget = resolved.children;
        } else {
          insertTarget = targetEvents;
        }

        // Deep-copy events to avoid reference aliasing between sheets
        const copiedEvents = eventsToMove.map(e => JSON.parse(JSON.stringify(e)) as Record<string, unknown>);

        // Insert into target
        if (args.position === 'start') {
          insertTarget.unshift(...copiedEvents);
        } else {
          insertTarget.push(...copiedEvents);
        }

        // If move semantics: remove exactly the copied events from source
        if (args.deleteSource) {
          const moved = new Set(eventsToMove);
          sourceSheetData.events = sourceEvents.filter(e => !moved.has(e)) as unknown as C3Event[];
        }

        // Event variable names: copies keep their names (the editor renames a
        // pasted variable whose name is taken), so refuse a copy or move that
        // would leave two names in one scope that the editor treats as the same
        const sheetsBefore = new Map(otherSheets);
        sheetsBefore.set(args.targetSheet, targetBefore);
        const sheetsAfter = new Map(otherSheets);
        sheetsAfter.set(args.sourceSheet, sourceSheetData.events);
        sheetsAfter.set(args.targetSheet, targetSheetData.events);
        const nameClashes = findNewEventVariableNameClashes(
          sheetsBefore, args.sourceSheet, eventsToMove as unknown as C3Event[],
          sheetsAfter, args.targetSheet, copiedEvents as unknown as C3Event[],
        );
        if (nameClashes.length > 0) {
          sourceSheetData.events = sourceEvents as unknown as C3Event[];
          targetSheetData.events = targetBefore;
          return toolError(movedEventVariableNameClashMessage(args.targetSheet, args.deleteSource, nameClashes));
        }
        // Function names: a copied function block keeps its name, which its original still has
        const functionClashes = newDuplicateFunctionNames(functionBlockNames(sheetsBefore), functionBlockNames(sheetsAfter));
        if (functionClashes.length > 0) {
          sourceSheetData.events = sourceEvents as unknown as C3Event[];
          targetSheetData.events = targetBefore;
          return toolError(copiedFunctionNameClashMessage(args.targetSheet, functionClashes));
        }
        // Custom actions: a copied definition keeps its name, which its original still has on the same owner
        const scanBefore = customActionScan(sheetsBefore);
        const scanAfter = customActionScan(sheetsAfter);
        if ((!scanBefore.complete || !scanAfter.complete) && !args.deleteSource) {
          sourceSheetData.events = sourceEvents as unknown as C3Event[];
          targetSheetData.events = targetBefore;
          return toolError(nothingChanged(`${traversalLimitReason('custom actions the copy would duplicate')} Move the events instead (deleteSource: true).`));
        }
        const customDuplicates = newCustomActionDuplicates(scanBefore.definitions, scanAfter.definitions);
        if (customDuplicates.length > 0) {
          sourceSheetData.events = sourceEvents as unknown as C3Event[];
          targetSheetData.events = targetBefore;
          const listed = customDuplicates.slice(0, 10).map(g => `- "${g[0].owner}.${g[0].name}": ${g.map(d => `sheet "${d.sheet}" (${d.eventPath})`).join(', ')}`);
          return toolError(nothingChanged(`Copying these events to "${args.targetSheet}" would leave two custom actions of one name on one object type or family:\n${listed.join('\n')}\n\n${DUPLICATE_CUSTOM_ACTION_RULE} Move the custom action instead (deleteSource: true).`));
        }

        // Editor load-time rules over both sheets: a copy of an event that
        // breaks a rule adds the problem to the target, a move only relocates it
        const loadCheck = await checkLoadRulesBeforeSheetPairWrite(reader, [
          { name: args.sourceSheet, before: sourceEvents as unknown as C3Event[], after: sourceSheetData.events },
          { name: args.targetSheet, before: targetBefore, after: targetSheetData.events },
        ]);
        if (loadCheck.errors.length > 0) {
          sourceSheetData.events = sourceEvents as unknown as C3Event[];
          targetSheetData.events = targetBefore;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }

        // Uses of an event variable that the move takes out of their scope,
        // e.g. a used global variable moved into a group, where it is local
        // (issue #38). Copies are compared with the events they were copied from.
        const copiedAces = mapCopiedAces(eventsToMove, copiedEvents);
        const lost = findVariableReferencesLostByChange(scopesBefore, sheetsAfter, ace => copiedAces.get(ace) ?? ace);
        const lostCount = countDeleteReferences(lost);
        // Global variables that are global no longer: sheets that could not be parsed may use them
        const globalsAfter = globalVariableNames(sheetsAfter);
        const noLongerGlobal = [...movedVariables]
          .filter(([key]) => globalsBefore.has(key) && !globalsAfter.has(key))
          .map(([, name]) => name);
        let unscanned: UnscannedFileReport[] = [];
        if (noLongerGlobal.length > 0) {
          const allSheets = await reader.readAllEventSheets();
          const skipped = unscannedFilesOf('eventSheets', await reader.listEventSheets(), allSheets, reader.getReadFailures('eventSheets'))
            .filter(f => f.name !== args.sourceSheet && f.name !== args.targetSheet);
          unscanned = await checkUnscannedFiles(reader, skipped, [
            { categories: ['eventSheets'], allOf: [noLongerGlobal.map(n => nameTerm(n))] },
          ]);
        }
        const unscannedBlock = blocksWithoutForce(unscanned);
        const whereLost = 'where it is no longer in scope after the move';
        const checked = 'uses of the moved event variables';
        if ((lostCount > 0 || unscannedBlock || !lost.complete) && !args.force) {
          sourceSheetData.events = sourceEvents as unknown as C3Event[];
          targetSheetData.events = targetBefore;
          const reasons = [
            ...(lostCount > 0 ? [`${describeDanglingReferences(lost, whereLost)} ${SCOPE_LOSS_CONSEQUENCE}`] : []),
            ...(unscannedBlock ? [unscannedRefusal(unscanned)] : []),
            ...(!lost.complete ? [traversalLimitReason(checked, lost.limit)] : []),
          ];
          return toolResult({
            success: false,
            sourceSheet: args.sourceSheet,
            targetSheet: args.targetSheet,
            category: 'eventsheet',
            action: 'move_blocked',
            message: `${reasons.join(' ')} Move the events that use it along, pick another place (a global variable stays global at the top level of a sheet), or use force=true to move anyway. Nothing was written.`,
            references: danglingReferenceList(lost),
            ...unscannedFields(unscanned),
          });
        }

        // Copies keep their SIDs, so a copied event whose SID the target already
        // has leaves several events with that SID there. The editor opens such
        // sheets, so this is a warning, not a refusal.
        const warnings = [...loadCheck.warnings];
        if (lostCount > 0) {
          warnings.push(`Moved with force=true: ${describeDanglingReferences(lost, whereLost)} ` +
            `${SCOPE_LOSS_CONSEQUENCE} Fix them before opening the project in Construct 3.`);
        }
        if (!lost.complete) {
          warnings.push(`Moved with force=true: ${traversalLimitReason(checked, lost.limit)}`);
        }
        warnings.push(...unscannedWarnings(unscanned, 'Moved'));
        const sharedSids = copiedSidsWarning(args.targetSheet, targetSheetData.events as unknown as Record<string, unknown>[], copiedEvents);
        if (sharedSids) warnings.push(sharedSids);

        // Write target sheet first, then source (if modified)
        const targetSubfolder = writer.getSubfolderForEntity('eventSheets', args.targetSheet);
        const targetBackup = await writer.writeEntityFile('eventSheets', args.targetSheet, targetSheetData, targetSubfolder);

        let sourceBackup: string | undefined;
        if (args.deleteSource) {
          const sourceSubfolder = writer.getSubfolderForEntity('eventSheets', args.sourceSheet);
          sourceBackup = await writer.writeEntityFile('eventSheets', args.sourceSheet, sourceSheetData, sourceSubfolder);
        }

        resetProjectIndex(reader);

        return toolResult({
          success: true,
          sourceSheet: args.sourceSheet,
          targetSheet: args.targetSheet,
          movedSids: args.sids,
          movedCount: eventsToMove.length,
          deleteSource: args.deleteSource,
          backupFiles: [targetBackup, ...(sourceBackup ? [sourceBackup] : [])].filter(Boolean),
          warnings: warnings.length > 0 ? warnings : undefined,
          ...(lostCount > 0 ? { references: danglingReferenceList(lost) } : {}),
          ...unscannedFields(unscanned),
        });
      } catch (error) {
        console.error('[move_events_between_sheets] failed:', error);
        return toolError(`Error moving events: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_event_block_items ───────────────────────────────

  /** Event types that hold conditions and actions. */
  const ITEM_HOLDERS: ReadonlySet<string> = new Set(['block', 'function-block', 'custom-ace-block']);

  // Registered with a strict object schema, so unknown arguments are refused (see add_event_block).
  server.registerTool(
    'move_event_block_items',
    {
      description: 'Move, reorder or copy conditions or actions within a block, function block or custom action block, or into another one of the same event sheet. A move keeps the items\' SIDs; copies (copy=true) get new SIDs and the source keeps its items. Refused, changing nothing: a System "else" condition (it stays first in its block) and an item put before one, indexes that do not fit, a target that would hold more than 100 items, an object class that is no object type, family, System or the Functions object, a new load-time error, and (unless force=true) a move after which an item uses an event variable or function parameter outside its scope. "Set return value" moved out of a function block is written with a warning, as add_event_block gives it.',
      inputSchema: z.object({
        sheetName: z.string().max(200).describe('Event sheet, as registered (letter case included)'),
        sourceBlockSid: z.number().int().positive().describe('SID of the block, function block or custom action block the items are in'),
        sourceEventPath: z.string().max(500).optional().describe('Only when sourceBlockSid matches several events: the path of the one you mean'),
        targetBlockSid: z.number().int().positive().describe('SID of the block, function block or custom action block the items go to (the same SID to reorder)'),
        targetEventPath: z.string().max(500).optional().describe('Only when targetBlockSid matches several events: the path of the one you mean'),
        itemType: z.enum(['actions', 'conditions']).describe('Which list the items are in'),
        indices: z.array(z.number().int().min(0)).min(1).max(100).describe('Indexes of the items in the source, each once; they keep their order'),
        targetIndex: z.number().int().min(0).describe('Where the items go in the target; within one block, counted after the items are taken out'),
        copy: z.boolean().optional().default(false).describe('Copy instead of move: the copies get new SIDs, the source keeps its items'),
        force: z.boolean().optional().default(false).describe('Move even when an item then uses an event variable or function parameter outside its scope (the uses are listed in "references" and a warning)'),
      }, {
        errorMap: unknownKeysErrorMap('the arguments of move_event_block_items', 'move_event_block_items takes sheetName, sourceBlockSid, sourceEventPath, targetBlockSid, targetEventPath, itemType, indices, targetIndex, copy and force.'),
      }).strict(),
    },
    async (args) => {
      // Set once the events are read: puts them back as they were read
      let restoreSheet: (() => void) | undefined;
      let writeStarted = false;
      try {
        const unregistered = await unregisteredSheetError(reader, args.sheetName);
        if (unregistered) return toolError(nothingChanged(unregistered.content[0].text));
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          const missing = notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
          return toolError(nothingChanged(missing.content[0].text));
        }
        const events = sheet.events as Record<string, unknown>[];
        const beforeEvents = snapshotEvents(sheet.events);
        restoreSheet = () => { sheet.events = beforeEvents; };
        const refuse = (message: string) => {
          sheet.events = beforeEvents;
          return toolError(nothingChanged(message));
        };
        const source = resolveEventBySid(events, args.sourceBlockSid, { sheetName: args.sheetName, action: 'take items from', eventPath: args.sourceEventPath, argument: 'sourceEventPath' });
        if ('error' in source) return refuse(`Source: ${source.error}`);
        const target = resolveEventBySid(events, args.targetBlockSid, { sheetName: args.sheetName, action: 'put items into', eventPath: args.targetEventPath, argument: 'targetEventPath' });
        if ('error' in target) return refuse(`Target: ${target.error}`);
        const from = source.match.event;
        const to = target.match.event;
        for (const [role, ev, sid] of [['Source', from, args.sourceBlockSid], ['Target', to, args.targetBlockSid]] as const) {
          if (!ITEM_HOLDERS.has(String(ev.eventType))) {
            return refuse(`${role} event with SID ${sid} is a "${String(ev.eventType)}", not a block, function block or custom action block.`);
          }
        }
        if (!Array.isArray(from[args.itemType])) from[args.itemType] = [];
        if (!Array.isArray(to[args.itemType])) to[args.itemType] = [];
        const sourceItems = from[args.itemType] as Record<string, unknown>[];
        const targetItems = to[args.itemType] as Record<string, unknown>[];
        const kind = args.itemType === 'actions' ? 'action' : 'condition';

        if (new Set(args.indices).size !== args.indices.length) return refuse('indices lists an index more than once.');
        const outOfRange = args.indices.find(i => i >= sourceItems.length);
        if (outOfRange !== undefined) return refuse(`Index ${outOfRange} is out of range: the source has ${sourceItems.length} ${kind}(s).`);
        const sameBlock = from === to;
        const room = sameBlock && !args.copy ? sourceItems.length - args.indices.length : targetItems.length;
        if (args.targetIndex > room) return refuse(`targetIndex ${args.targetIndex} is out of range: the target has ${room} ${kind}(s) there, so 0-${room}.`);
        if ((args.copy || !sameBlock) && targetItems.length + args.indices.length > MAX_ITEMS_PER_BLOCK) {
          return refuse(`The target would hold ${targetItems.length + args.indices.length} ${kind}s (max ${MAX_ITEMS_PER_BLOCK}).`);
        }
        if (args.itemType === 'conditions') {
          if (args.indices.some(i => isElseCondition(sourceItems[i]))) {
            return refuse(`An else condition cannot be ${args.copy ? 'copied' : 'moved'}: it stays first in its own block. ${args.copy ? 'Copy' : 'Move'} the other conditions instead.`);
          }
          if (args.targetIndex === 0 && isElseCondition(targetItems[0])) {
            return refuse('The else condition of the target block stays first (also when it is disabled); use targetIndex 1 or later.');
          }
        }
        const ordered = [...args.indices].sort((x, y) => x - y);
        const selected = ordered.map(i => sourceItems[i]);

        // Object classes, against the destination's function context: the target block (upstream warns when
        // "Set return value" stands outside a function block)
        const refs: ObjectRef[] = [];
        collectObjectRefs(args.itemType === 'conditions' ? selected as Array<Record<string, unknown> & { objectClass: string }> : [],
          args.itemType === 'actions' ? selected : [], [], refs);
        const classWarnings: string[] = [];
        if (refs.length > 0) {
          const { errors, warnings: found } = await validateObjectClasses(reader, refs, { insideFunction: isInFunctionBlock(events, to) });
          if (errors.length > 0) return refuse(`Object class validation failed:\n${errors.join('\n')}`);
          classWarnings.push(...found);
        }

        // The declaration each use of this sheet's variables and parameters finds now
        const sheetsNow = await readEventSheetsFresh(reader, [[args.sheetName, sheet.events]]);
        const declared = new Map(listEventVariableDeclarations(sheet.events).map(d => [d.name.toLowerCase(), d.name] as const));
        const bindingsBefore = recordVariableBindings(sheetsNow, declared);

        let moved: Record<string, unknown>[];
        const copies = new Map<object, object>();
        if (args.copy) {
          moved = [];
          for (const item of selected) {
            const copy = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
            if (typeof copy.sid === 'number') copy.sid = await idGen.generateSid(reader);
            copies.set(copy, item);
            moved.push(copy);
          }
          targetItems.splice(args.targetIndex, 0, ...moved);
        } else if (sameBlock) {
          const keep = sourceItems.filter((_item, i) => !ordered.includes(i));
          keep.splice(args.targetIndex, 0, ...selected);
          sourceItems.splice(0, sourceItems.length, ...keep);
          moved = selected;
        } else {
          for (const i of [...ordered].reverse()) sourceItems.splice(i, 1);
          targetItems.splice(args.targetIndex, 0, ...selected);
          moved = selected;
        }
        if (JSON.stringify(sheet.events) === JSON.stringify(beforeEvents)) {
          return toolResult({
            success: true, entity: args.sheetName, category: 'eventsheet', action: 'unchanged',
            sourceBlockSid: args.sourceBlockSid, targetBlockSid: args.targetBlockSid, itemType: args.itemType, copy: args.copy,
            sids: moved.map(m => m.sid).filter((s): s is number => typeof s === 'number'), targetIndex: args.targetIndex,
          }, { projectWritten: false });
        }

        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) return refuse(loadRuleErrorMessage(loadCheck.errors));
        const warnings = [...classWarnings, ...loadCheck.warnings];
        // Only a move out of another block empties the source: a reorder puts the items back and a copy leaves them
        if (args.itemType === 'conditions' && sourceItems.length === 0) {
          // A function block or custom action block has no parent to run it: it runs when it is called
          const runsWhen = from.eventType === 'function-block' ? 'it now runs on every call of the function.'
            : from.eventType === 'custom-ace-block' ? 'it now runs on every call of the custom action.'
              : 'it now runs whenever its parent runs (every tick at the top level, every call in a function or custom action).';
          warnings.push(`All conditions of the source (SID ${args.sourceBlockSid}) were moved: ${runsWhen}`);
        }

        // A copy is compared with the item it was copied from
        const { lost, rebound } = findVariableBindingChanges(bindingsBefore, sheetsNow, ace => copies.get(ace) ?? ace);
        const lostCount = countDeleteReferences(lost);
        const reboundCount = countDeleteReferences(rebound);
        const whereLost = 'where it is no longer in scope after the move';
        const whereRebound = 'where the name now finds another event variable or function parameter after the move';
        const checked = 'uses of the event variables and function parameters of this sheet';
        if ((lostCount > 0 || reboundCount > 0 || !lost.complete) && !args.force) {
          sheet.events = beforeEvents;
          const reasons = [
            ...(lostCount > 0 ? [`${describeDanglingReferences(lost, whereLost)} ${SCOPE_LOSS_CONSEQUENCE}`] : []),
            ...(reboundCount > 0 ? [`${describeDanglingReferences(rebound, whereRebound)} ${REBOUND_USE_CONSEQUENCE}`] : []),
            ...(!lost.complete ? [traversalLimitReason(checked, lost.limit)] : []),
          ];
          return toolResult({
            success: false, entity: args.sheetName, category: 'eventsheet', action: 'move_blocked',
            message: nothingChanged(`${reasons.join(' ')} ${lostCount > 0 || reboundCount > 0 ? 'Move them to a place where the same declaration is in scope, or use force=true to move anyway.' : 'Use force=true to move anyway.'}`),
            references: danglingReferenceList(lost),
            ...(reboundCount > 0 ? { reboundReferences: danglingReferenceList(rebound) } : {}),
          }, { projectWritten: false });
        }
        if (lostCount > 0) {
          warnings.push(`Moved with force=true: ${describeDanglingReferences(lost, whereLost)} ${SCOPE_LOSS_CONSEQUENCE} Fix them before opening the project in Construct 3.`);
        }
        if (reboundCount > 0) {
          warnings.push(`Moved with force=true: ${describeDanglingReferences(rebound, whereRebound)} ${REBOUND_USE_CONSEQUENCE}`);
        }
        if (!lost.complete) warnings.push(`Moved with force=true: ${traversalLimitReason(checked, lost.limit)}`);

        writeStarted = true;
        const backupPath = await writeEntityOrRollBack(writer, 'eventSheets', args.sheetName, sheet);
        resetProjectIndex(reader);
        return toolResult({
          success: true, entity: args.sheetName, category: 'eventsheet', action: 'updated',
          sourceBlockSid: args.sourceBlockSid, targetBlockSid: args.targetBlockSid, itemType: args.itemType, copy: args.copy,
          sids: moved.map(m => m.sid).filter((s): s is number => typeof s === 'number'), targetIndex: args.targetIndex,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(lostCount > 0 ? { references: danglingReferenceList(lost) } : {}),
          ...(reboundCount > 0 ? { reboundReferences: danglingReferenceList(rebound) } : {}),
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[move_event_block_items] failed:', error);
        if (restoreSheet) {
          restoreSheet();
          if (!writeStarted) {
            return toolError(nothingChanged(`The change was stopped before anything was written: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
        return toolError(`Error moving items: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_event_block ─────────────────────────────────────

  // Registered with a strict object schema, so unknown arguments are refused (see add_event_block).
  server.registerTool(
    'update_event_block',
    {
      description: 'Update an existing block, function block or custom action block in an event sheet — modify action parameters, add/remove actions or conditions, insert them at an index, replace conditions in place, toggle disabled state, make it an else or OR block. Identify the block by its SID (use get_eventsheet_details to find it). A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one. A trigger condition added to a block that holds a function block or a custom action block, at any depth below it, is refused by the load-time check. Unknown arguments and keys are refused, never dropped.',
      inputSchema: z.object({
        sheetName: z.string().max(200).describe('Target event sheet'),
        sid: z.number().int().positive().describe('SID of the block, function block or custom action block to update'),
        eventPath: eventPathSchema,
        disabled: z.boolean().optional().describe('Enable or disable the entire block'),
        isElse: z.boolean().optional().describe('true: make the block an else block (puts the System "else" condition first; existing conditions then make an else-if). false: remove the leading "else" condition. Applied after all other condition changes.'),
        isOrBlock: z.boolean().optional().describe('true: make the block an OR block (its conditions are ORed); false: AND-combine them again'),
        updateActions: z.array(z.object({
          index: z.number().int().min(0).describe('Action index (0-based)'),
          parameters: z.union([boundedRecord(), z.array(functionCallArgumentSchema).max(100)]).optional()
            .describe('New parameter values — merged with existing (max 100 keys, depth 6). For a function call: an array replaces the arguments; an object keyed by position ("0", "1", …) or parameter name replaces single arguments. For a custom action call: an array in parameter order replaces them, and an object is refused'),
          disabled: z.boolean().optional().describe('Enable or disable this action'),
          text: z.string().max(10_000).optional().describe('Comment rows only: the new text; the row keeps its place and colours'),
          'text-color': commentColorSchema.nullable().optional().describe('Comment rows only: the new text colour [red, green, blue, alpha], each 0-1; null removes it'),
          'background-color': commentColorSchema.nullable().optional().describe('Comment rows only: the new background colour [red, green, blue, alpha], each 0-1; null removes it'),
        }, {
          errorMap: unknownKeysErrorMap('an updateActions entry', 'An entry has index, parameters and disabled, and for a comment row text, "text-color" and "background-color"; to change anything else, remove the action (removeActionIndices) and add a new one (addActions).'),
        }).strict()).optional().describe('Actions to update by index. A comment row is edited in place with text, "text-color" and "background-color"'),
        updateConditions: z.array(z.object({
          index: z.number().int().min(0).describe('Condition index (0-based)'),
          parameters: boundedRecord().optional().describe('New parameter values — merged with existing (max 100 keys, depth 6)'),
          isInverted: z.boolean().optional().describe('Toggle inversion'),
          disabled: z.boolean().optional().describe('Enable or disable this condition'),
        }, {
          errorMap: unknownKeysErrorMap('an updateConditions entry', 'An entry has index, parameters, isInverted and disabled; to change anything else, remove the condition (removeConditionIndices) and add a new one (addConditions).'),
        }).strict()).optional().describe('Conditions to update by index'),
        insertActions: z.array(z.object({
          index: z.number().int().min(0).describe('Where the action goes: its index in the actions after removeActionIndices, before this call\'s other inserts and addActions'),
          action: actionSchema.describe('The action, in the shapes of add_event_block'),
        }, {
          errorMap: unknownKeysErrorMap('an insertActions entry', 'An entry has index and action.'),
        }).strict()).max(100).optional().describe('Insert actions at indexes; two inserts at one index are refused'),
        insertConditions: z.array(z.object({
          index: z.number().int().min(0).describe('Where the condition goes: its index in the conditions after removeConditionIndices, before this call\'s other inserts and addConditions'),
          condition: conditionSchema.describe('The condition'),
        }, {
          errorMap: unknownKeysErrorMap('an insertConditions entry', 'An entry has index and condition.'),
        }).strict()).max(100).optional().describe('Insert conditions at indexes; a System "else" condition in first place stays first'),
        replaceConditions: z.array(z.object({
          index: z.number().int().min(0).describe('Index of the condition to replace (before this call\'s removals)'),
          condition: conditionSchema.describe('The new condition; it gets a new SID'),
        }, {
          errorMap: unknownKeysErrorMap('a replaceConditions entry', 'An entry has index and condition.'),
        }).strict()).max(100).optional().describe('Replace conditions in place'),
        addActions: z.array(actionSchema).optional().describe('Append new actions to the block (same shapes as add_event_block)'),
        addConditions: z.array(conditionSchema).optional().describe('Append new conditions to the block'),
        removeActionIndices: z.array(z.number().int().min(0)).optional().describe('Remove actions by index (0-based, applied before adds)'),
        removeConditionIndices: z.array(z.number().int().min(0)).optional().describe('Remove conditions by index (0-based, applied before adds)'),
      }, {
        errorMap: unknownKeysErrorMap('the arguments of update_event_block', 'update_event_block takes sheetName, sid, eventPath, disabled, isElse, isOrBlock, updateActions, updateConditions, addActions, addConditions, insertActions, insertConditions, replaceConditions, removeActionIndices and removeConditionIndices. It does not add sub-events.'),
      }).strict(),
    },
    async (args) => {
      // Set once the sheet is changed in memory: puts the events back as they were read
      let restoreSheet: (() => void) | undefined;
      let writeStarted = false;
      try {
        // Validate at least one update is provided
        const hasUpdate = args.disabled !== undefined
          || args.isElse !== undefined
          || args.isOrBlock !== undefined
          || (args.updateActions && args.updateActions.length > 0)
          || (args.updateConditions && args.updateConditions.length > 0)
          || (args.addActions && args.addActions.length > 0)
          || (args.addConditions && args.addConditions.length > 0)
          || (args.insertActions && args.insertActions.length > 0)
          || (args.insertConditions && args.insertConditions.length > 0)
          || (args.replaceConditions && args.replaceConditions.length > 0)
          || (args.removeActionIndices && args.removeActionIndices.length > 0)
          || (args.removeConditionIndices && args.removeConditionIndices.length > 0);

        if (!hasUpdate) {
          return toolError('No updates provided. Specify at least one of: disabled, isElse, isOrBlock, updateActions, updateConditions, addActions, addConditions, insertActions, insertConditions, replaceConditions, removeActionIndices, removeConditionIndices.');
        }

        // Read the event sheet
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const events = sheet.events as Record<string, unknown>[];
        const beforeEvents = snapshotEvents(sheet.events);
        const found = resolveEventBySid(events, args.sid, {
          sheetName: args.sheetName,
          action: 'update',
          eventPath: args.eventPath,
        });
        if ('error' in found) return toolError(found.error);

        const { event, path } = found.match;
        const eventType = event.eventType as string;

        // Must be a block, function-block or custom action block (not a group, variable, include, etc.)
        if (eventType !== 'block' && eventType !== 'function-block' && eventType !== 'custom-ace-block') {
          return toolError(`Event with SID ${args.sid} is a "${eventType}", not a block, function-block or custom action block. Only those can be updated with this tool.`);
        }
        if (args.isElse !== undefined && eventType !== 'block') {
          return toolError('isElse applies to block events only; a function block or custom action block cannot be an else block.');
        }

        // Custom action calls: checked before anything changes, so a refusal leaves the block as it was
        const customAdds = (args.addActions ?? []).filter(a => isCustomActionCall(a as Record<string, unknown>));
        const storedActions = Array.isArray(event.actions) ? event.actions as Record<string, unknown>[] : [];
        const customUpdates = (args.updateActions ?? []).filter(u => storedActions[u.index] !== undefined && isCustomActionCall(storedActions[u.index]));
        for (const upd of customUpdates) {
          if (upd.parameters !== undefined && !Array.isArray(upd.parameters)) {
            return toolError(nothingChanged(`Action ${upd.index} is a custom action call: pass its arguments as an array in parameter order.`));
          }
        }
        const customContext = customAdds.length > 0 || customUpdates.length > 0 ? await loadCustomActionContext(reader) : undefined;
        for (const add of customAdds) {
          const callError = customActionCallError(add as { objectClass: string; customActionObjectClass?: string }, customContext!);
          if (callError) return toolError(nothingChanged(callError));
        }

        if (!Array.isArray(event.conditions)) event.conditions = [];
        if (!Array.isArray(event.actions)) event.actions = [];
        const conditions = event.conditions as Record<string, unknown>[];
        const actions = event.actions as Record<string, unknown>[];
        const conditionCountBefore = conditions.length;
        const warnings: string[] = [];
        // Existing conditions/actions edited in place (checked for the legacy behavior key before writing)
        const touched: Array<{ ace: Record<string, unknown>; kind: 'condition' | 'action' }> = [];
        const where = `Block (SID ${args.sid})`;

        // ── Validate objectClasses of all additions up front, in one pass ──
        // (normalizes the deprecated behavior-type alias; throws on conflicting keys before anything changes)
        const addRefs: ObjectRef[] = [];
        collectObjectRefs(
          [...(args.addConditions ?? []), ...(args.insertConditions ?? []).map(i => i.condition), ...(args.replaceConditions ?? []).map(r => r.condition)],
          [...(args.addActions ?? []), ...(args.insertActions ?? []).map(i => i.action)] as Array<Record<string, unknown>>,
          [],
          addRefs,
        );
        if (addRefs.length > 0) {
          const { errors, warnings: valWarnings } = await validateObjectClasses(reader, addRefs, {
            insideFunction: isInFunctionBlock(events, event),
          });
          if (errors.length > 0) {
            return toolError(`Object class validation failed:\n${errors.join('\n')}`);
          }
          warnings.push(...valWarnings);
        }

        // The deprecated per-condition isOr flag is never written: it only
        // passes when the block ends up an OR block anyway.
        if ([...(args.addConditions ?? []), ...(args.insertConditions ?? []).map(i => i.condition), ...(args.replaceConditions ?? []).map(r => r.condition)].some(c => c.isOr === true)) {
          const willBeOrBlock = args.isOrBlock ?? event.isOrBlock === true;
          if (!willBeOrBlock) {
            return toolError('isOr on a condition is not written: Construct 3 ORs a whole event. Set isOrBlock: true to make this block an OR block.');
          }
          warnings.push(`${where}: the deprecated per-condition isOr flag is not written; the block is an OR block.`);
        }

        // Function signatures, loaded once if any call is added or edited
        let functions: Awaited<ReturnType<typeof loadFunctionSignatures>> | undefined;
        const signatureOf = async (name: string) => {
          functions ??= await loadFunctionSignatures(reader);
          return functions.get(name.toLowerCase());
        };

        // Check inserts and replacements before anything changes
        // A removal index past the end is named before the inserts are counted, which count the list after the removals
        const badConditionRemoval = (args.removeConditionIndices ?? []).find(i => i < 0 || i >= conditions.length);
        if (badConditionRemoval !== undefined) {
          return toolError(nothingChanged(`Condition index ${badConditionRemoval} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`));
        }
        const badActionRemoval = (args.removeActionIndices ?? []).find(i => i < 0 || i >= actions.length);
        if (badActionRemoval !== undefined) {
          return toolError(nothingChanged(`Action index ${badActionRemoval} is out of range (block has ${actions.length} action(s), indices 0-${actions.length - 1}).`));
        }
        const removedConditionCount = new Set(args.removeConditionIndices ?? []).size;
        const removedActionCount = new Set(args.removeActionIndices ?? []).size;
        const conditionsAfterRemoval = conditions.length - removedConditionCount;
        const actionsAfterRemoval = actions.length - removedActionCount;
        const insertProblem = (kind: 'Action' | 'Condition', items: ReadonlyArray<{ index: number }>, length: number): string | undefined => {
          const seen = new Set<number>();
          for (const item of items) {
            if (item.index > length) {
              return `${kind} insert index ${item.index} is out of range: after the removals the block has ${length} ${kind.toLowerCase()}(s), so indexes 0-${length}.`;
            }
            if (seen.has(item.index)) return `Two ${kind.toLowerCase()} inserts at index ${item.index}; give each insert its own index.`;
            seen.add(item.index);
          }
          return undefined;
        };
        const insertError = insertProblem('Condition', args.insertConditions ?? [], conditionsAfterRemoval)
          ?? insertProblem('Action', args.insertActions ?? [], actionsAfterRemoval);
        if (insertError) return toolError(nothingChanged(insertError));
        const replaced = new Set<number>();
        for (const r of args.replaceConditions ?? []) {
          if (r.index >= conditions.length) {
            return toolError(nothingChanged(`Condition index ${r.index} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`));
          }
          if (replaced.has(r.index)) return toolError(nothingChanged(`replaceConditions names condition ${r.index} twice.`));
          if ((args.removeConditionIndices ?? []).includes(r.index)) return toolError(nothingChanged(`Condition ${r.index} is both replaced and removed.`));
          if ((args.updateConditions ?? []).some(u => u.index === r.index)) return toolError(nothingChanged(`Condition ${r.index} is both updated and replaced; replace it with the condition you want.`));
          replaced.add(r.index);
        }
        // The list the inserts go into: the conditions after this call's replacements and removals
        const replacementAt = new Map((args.replaceConditions ?? []).map(r => [r.index, r.condition as unknown] as const));
        const removedConditionIndices = new Set(args.removeConditionIndices ?? []);
        const keptConditions = conditions.map((c, i) => replacementAt.get(i) ?? c).filter((_c, i) => !removedConditionIndices.has(i));
        // With isElse: false the else condition is taken out at the end, so an insert in front of it is a valid way to put a condition first
        if (isElseCondition(keptConditions[0]) && args.isElse !== false && (args.insertConditions ?? []).some(i => i.index === 0)) {
          return toolError(nothingChanged('Condition 0 of this block is a System "else" condition, which stays first (also when it is disabled); insert at index 1 or later.'));
        }
        // A block that starts with an else condition (or gets one through isElse: true) holds Else once, first
        const startsWithElse = args.isElse !== false && (args.isElse === true || isElseCondition(keptConditions[0]));
        // The cap applies to a call that adds items; a block already over it can still be edited otherwise.
        // isElse: true adds the else condition unless the block's first condition is one then.
        const firstCondition = (args.insertConditions ?? []).find(i => i.index === 0)?.condition ?? keptConditions[0] ?? args.addConditions?.[0];
        const elseAdded = args.isElse === true && !isElseCondition(firstCondition) ? 1 : 0;
        const tooMany = (kind: string, after: number, added: number) => (added > 0 && after + added > MAX_ITEMS_PER_BLOCK
          ? `${where} would hold ${after + added} ${kind} (max ${MAX_ITEMS_PER_BLOCK}).` : undefined);
        const sizeError = tooMany('conditions', conditionsAfterRemoval, (args.insertConditions?.length ?? 0) + (args.addConditions?.length ?? 0) + elseAdded)
          ?? tooMany('actions', actionsAfterRemoval, (args.insertActions?.length ?? 0) + (args.addActions?.length ?? 0));
        if (sizeError) return toolError(nothingChanged(sizeError));

        // From here the sheet changes in memory: a failure before the write puts the events back
        restoreSheet = () => { sheet.events = beforeEvents; };

        // ── Apply block-level toggles (in the editor's key order: disabled right after sid) ──
        if (args.disabled !== undefined) {
          if (args.disabled) {
            setKeyAfterSid(event, 'disabled', true);
          } else {
            delete event.disabled;
          }
        }
        if (args.isOrBlock !== undefined) {
          if (args.isOrBlock) {
            event.isOrBlock = true;
          } else {
            delete event.isOrBlock;
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
            touched.push({ ace: cond, kind: 'condition' });
            if (upd.parameters) {
              // Parameters go before isInverted, where the editor writes them
              setConditionParameters(cond, { ...(cond.parameters as Record<string, unknown> || {}), ...upd.parameters });
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
                setKeyAfterSid(cond, 'disabled', true);
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
            const commentEdit = upd.text !== undefined || upd['text-color'] !== undefined || upd['background-color'] !== undefined;
            if (commentEdit) {
              if (act.type !== 'comment') {
                return toolError(`Action ${upd.index} is not a comment row: text, "text-color" and "background-color" apply to comment rows only.`);
              }
              editCommentRowInPlace(act, upd);
            }
            if (upd.parameters) {
              const rowProblem = parameterlessRowError(act, upd.index);
              if (rowProblem) return toolError(rowProblem);
            }
            if (upd.disabled !== undefined && act.type === 'comment') {
              return toolError(`Action ${upd.index} is a comment row, which cannot be disabled (editor-saved comment rows are { type, text } with optional "text-color" and "background-color"; none carries "disabled").`);
            }
            if (upd.parameters) {
              if (isCustomActionCall(act)) {
                const argumentsGiven = (upd.parameters as unknown[]).map(value => (typeof value === 'boolean' ? value : String(value)));
                if (argumentsGiven.length > 0) act.parameters = argumentsGiven;
                else delete act.parameters;
                warnings.push(...customActionCallWarnings(act as unknown as CustomActionCall, customContext!,
                  `${where}, action ${upd.index}, custom action call "${String(act.customAction)}" on "${String(act.objectClass)}"`, 'kept'));
              } else if (isFunctionCall(act)) {
                const name = act.callFunction as string;
                const label = `${where}, action ${upd.index} (call to "${name}")`;
                const signature = await signatureOf(name);
                const merged = mergeCallArguments(act.parameters, upd.parameters, signature, label);
                warnings.push(...checkFunctionCallArguments(merged, signature, name, label));
                if (isLegacyFunctionCall(act)) {
                  warnings.push(`${label} was stored in an old shape; it was rewritten as { callFunction, sid, parameters: [...] } without id/objectClass, the shape Construct 3 saves.`);
                }
                rewriteFunctionCallInPlace(act, merged);
                act.callFunction = resolveCallName(name, signature, label, warnings);
              } else {
                if (Array.isArray(upd.parameters)) {
                  return toolError(`Action ${upd.index} is not a function call: pass its parameters as key-value pairs, not an array.`);
                }
                touched.push({ ace: act, kind: 'action' });
                act.parameters = { ...(act.parameters as Record<string, unknown> || {}), ...upd.parameters };
                await resolveFunctionMapParameter(reader, act, `${where}, action ${upd.index} ("${String(act.id)}")`, warnings, async () => {
                  functions ??= await loadFunctionSignatures(reader);
                  return functions;
                });
              }
            } else if (!isFunctionCall(act) && !isCustomActionCall(act)) {
              touched.push({ ace: act, kind: 'action' });
            }
            if (upd.disabled !== undefined) {
              if (upd.disabled) {
                setKeyAfterSid(act, 'disabled', true);
              } else {
                delete act.disabled;
              }
            }
          }
        }

        // Replace conditions in place (a new SID each)
        for (const r of args.replaceConditions ?? []) {
          // isElse: true puts an else condition back in front, so the block stays an else block
          if (r.index === 0 && isElseCondition(conditions[0]) && !isElseCondition(r.condition) && args.isElse !== true) {
            warnings.push(`${where}: condition 0 was the System "else" condition; replacing it makes the block an ordinary block.`);
          }
          if (isElseCondition(r.condition) && r.index !== 0) {
            warnings.push(misplacedElseWarning(where, 'a replacing', r.index, args.isElse, startsWithElse));
          }
          conditions[r.index] = buildCondition(r.condition, await idGen.generateSid(reader)) as unknown as Record<string, unknown>;
        }

        // ── Remove conditions by index (descending order to avoid index shifting) ──
        let removedConditions = false;
        if (args.removeConditionIndices && args.removeConditionIndices.length > 0) {
          const sorted = [...new Set(args.removeConditionIndices)].sort((a, b) => b - a);
          for (const idx of sorted) {
            if (idx < 0 || idx >= conditions.length) {
              return toolError(`Condition index ${idx} is out of range (block has ${conditions.length} condition(s), indices 0-${conditions.length - 1}).`);
            }
            conditions.splice(idx, 1);
            removedConditions = true;
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

        // The else condition the block starts with, which isElse: false takes out even when an insert at 0 put another condition in front of it
        const leadingElse = isElseCondition(conditions[0]) ? conditions[0] : undefined;
        // Insert at indexes counted after the removals (highest first, so each index counts in that list)
        for (const insert of [...(args.insertConditions ?? [])].sort((x, y) => y.index - x.index)) {
          if (isElseCondition(insert.condition) && insert.index !== 0) {
            warnings.push(misplacedElseWarning(where, 'an inserted', insert.index, args.isElse, startsWithElse));
          }
          conditions.splice(insert.index, 0, buildCondition(insert.condition, await idGen.generateSid(reader)) as unknown as Record<string, unknown>);
        }
        if ((args.insertActions ?? []).length > 0) {
          const insertCtx = { warnings, functions };
          for (const insert of [...(args.insertActions ?? [])].sort((x, y) => y.index - x.index)) {
            actions.splice(insert.index, 0, await buildAction(reader, idGen, insert.action, insertCtx, where) as unknown as Record<string, unknown>);
          }
          functions = insertCtx.functions;
        }

        // ── Add new conditions (validated up front) ──
        if (args.addConditions && args.addConditions.length > 0) {
          for (const c of args.addConditions) {
            // An added "else" condition is appended: fine on a block without
            // conditions, a duplicate in an else block (or one isElse makes), misplaced otherwise
            if (isElseCondition(c) && conditions.length > 0) {
              if (args.isElse === true || isElseCondition(conditions[0])) {
                warnings.push(`${where}: dropped the added System "else" condition: the block ${args.isElse === true ? 'gets one first through isElse: true' : 'already starts with one'}, and Construct 3 saves Else once, as the first condition.`);
                continue;
              }
              warnings.push(`${where}: an added System "else" condition goes after the existing conditions, but Construct 3 saves Else as the first condition. Use isElse: true instead.`);
            }
            const condSid = await idGen.generateSid(reader);
            conditions.push(buildCondition(c, condSid));
          }
        }

        // ── Add new actions (validated up front) ──
        if (args.addActions && args.addActions.length > 0) {
          const ctx = { warnings, functions, customActions: customContext };
          for (const a of args.addActions) {
            actions.push(await buildAction(reader, idGen, a, ctx, where) as unknown as Record<string, unknown>);
          }
          functions = ctx.functions;
        }

        // ── Else: the System "else" condition first, applied after all other condition changes ──
        // (where the else block stands is checked by the load-time gate below)
        if (args.isElse !== undefined) {
          const hadLegacyFlag = 'isElse' in event;
          delete event.isElse;
          if (args.isElse && !isElseCondition(conditions[0])) {
            conditions.unshift(createElseCondition(await idGen.generateSid(reader)));
          } else if (!args.isElse) {
            const at = leadingElse !== undefined && conditions.includes(leadingElse) ? conditions.indexOf(leadingElse) : isElseCondition(conditions[0]) ? 0 : -1;
            if (at >= 0) {
              conditions.splice(at, 1);
              removedConditions = true;
            }
          }
          if (hadLegacyFlag) {
            warnings.push(`${where}: dropped the block-level "isElse" key written by older versions (Construct 3 marks an else block with a System "else" first condition instead).`);
          }
        }

        // Only warn when this call removed the last condition. Blocks that
        // never had conditions (function blocks, sub-events) are normal.
        if (removedConditions && conditionCountBefore > 0 && conditions.length === 0) {
          warnings.push(eventType === 'block'
            ? 'All conditions were removed: the block now runs whenever its parent runs (every tick at the top level).'
            : eventType === 'function-block'
              ? 'All conditions were removed: the function body now runs on every call.'
              : 'All conditions were removed: the custom action body now runs on every call.');
        }

        // Edited conditions/actions written by older versions may still carry
        // "behavior-type" (issue #16): normalize them instead of re-emitting it.
        warnings.push(...await normalizeLegacyBehaviorKeys(
          reader,
          touched.filter(t => (t.kind === 'condition' ? conditions : actions).includes(t.ace)),
        ));

        // Editor load-time rules, checked on the whole sheet so the block's
        // ancestors (an enclosing trigger or function) count too
        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) {
          sheet.events = beforeEvents;
          return toolError(loadRuleErrorMessage(loadCheck.errors));
        }
        warnings.push(...loadCheck.warnings);

        // Write back
        writeStarted = true;
        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex(reader);

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult({ ...result, eventPath: path });
      } catch (error) {
        console.error('[update_event_block] failed:', error);
        if (restoreSheet) {
          restoreSheet();
          if (!writeStarted) {
            return toolError(nothingChanged(`The change was stopped before anything was written: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
        return toolError(`Error updating event block: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_event_block ─────────────────────────────

  // Registered with a strict object schema, so unknown arguments are refused (see add_event_block).
  server.registerTool(
    'move_event_block',
    {
      description: 'Move an event, with its sub-events, to another place in the same event sheet: the top level, a group (groupPath), the sub-events of an event (parentSid) or beside one (siblingSid with position "before" or "after"). Blocks, groups, variables, function blocks and custom action blocks are moved by SID (comments, includes and script events have none). The event keeps its SID and everything in it. Refused, changing nothing: a move into the event itself or its sub-events, a place that no editor-saved project on record or checked editor case shows for that kind of event, a function block (or an event holding one) under or below a block that has a trigger condition or under or below a function block or a custom action block, a custom action block (or an event holding one) with an event that is not a group above it (it goes at the top level or in groups only), a new load-time error, a name that would clash in the new scope, and (unless force=true) a move that leaves events using an event variable or function parameter out of its scope. Event sheets that could not be parsed are searched as text for a global variable the move makes local. A move to where the event already is changes nothing.',
      inputSchema: z.object({
        sheetName: z.string().max(200).describe('Event sheet, as registered (letter case included)'),
        sid: z.number().int().positive().describe('SID of the event to move'),
        eventPath: eventPathSchema,
        ...locatorShape,
        force: z.boolean().optional().default(false).describe('Move even when events then use an event variable or function parameter outside its scope (the uses are listed in "references" and a warning, and left as they are)'),
      }, {
        errorMap: unknownKeysErrorMap('the arguments of move_event_block', 'move_event_block takes sheetName, sid, eventPath, groupPath, parentSid, parentEventPath, siblingSid, siblingEventPath, position and force.'),
      }).strict(),
    },
    async (args) => {
      // Once the event is placed in memory, an error puts the sheet back (see the catch below)
      let undoPlacement: (() => void) | undefined;
      let writeStarted = false;
      try {
        // Its scope check compares the sheet with the other sheets by registered name
        const unregistered = await unregisteredSheetError(reader, args.sheetName);
        if (unregistered) return toolError(nothingChanged(unregistered.content[0].text));
        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          const missing = notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
          return toolError(nothingChanged(missing.content[0].text));
        }
        const events = sheet.events as Record<string, unknown>[];
        const beforeEvents = snapshotEvents(sheet.events);
        // A refusal after the move below puts the sheet's events back first
        const refuse = (message: string) => {
          sheet.events = beforeEvents;
          return toolError(nothingChanged(message));
        };

        const found = resolveEventBySid(events, args.sid, { sheetName: args.sheetName, action: 'move', eventPath: args.eventPath });
        if ('error' in found) return refuse(`${found.error}\nComments, includes and script events have no SID and cannot be moved with this tool.`);
        const moving = found.match.event;
        const kind = placedKindOf(moving.eventType);
        if (kind === undefined) return refuse(`The event with SID ${args.sid} is a "${String(moving.eventType)}", which this tool does not move.`);

        const resolution = resolveContainer(events, args.sheetName, {
          groupPath: args.groupPath, parentSid: args.parentSid, parentEventPath: args.parentEventPath,
          siblingSid: args.siblingSid, siblingEventPath: args.siblingEventPath, position: args.position,
        });
        if ('error' in resolution) return refuse(resolution.error);
        const container = resolution.container;
        if (container.siblingEvent === moving) return refuse('An event cannot be placed beside itself.');
        let intoItself: boolean;
        try {
          intoItself = container.owner !== undefined && (container.owner === moving || isWithin(moving, container.owner));
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        if (intoItself) {
          return refuse(`The event with SID ${args.sid} cannot go into its own sub-events: the destination is inside the event being moved.`);
        }
        const placement = placementError(kind, container);
        if (placement) return refuse(placement);
        // A function block, or an event that holds one, goes only where a function block is placed
        const functionRefusal = movedFunctionBlockRefusal(moving, containerParents(sheet.events, container));
        if (functionRefusal) return refuse(functionRefusal);
        // A custom action block, or an event that holds one, goes only where every event above it is a group
        const customActionRefusal = movedCustomActionBlockRefusal(moving, containerParents(sheet.events, container));
        if (customActionRefusal) return refuse(customActionRefusal);

        // The declaration each use of this sheet's variables and parameters finds now, for the scope check after the move
        const sheetsNow = await readEventSheetsFresh(reader, [[args.sheetName, sheet.events]]);
        const declared = new Map(listEventVariableDeclarations(sheet.events).map(d => [d.name.toLowerCase(), d.name] as const));
        const bindingsBefore = recordVariableBindings(sheetsNow, declared);
        const globalsBefore = globalVariableNames(sheetsNow);

        // Take the event out, then insert it (the sibling's index is read after the removal)
        const from = found.match.path;
        const sourceOwner = (findEnclosingEvents(sheet.events, moving as unknown as C3Event) ?? []).at(-1) as Record<string, unknown> | undefined;
        undoPlacement = () => { sheet.events = beforeEvents; };
        found.match.parentArray.splice(found.match.index, 1);
        insertIntoContainer(container, args.position, moving);
        // An event left without sub-events is written without the key, as the editor and the builders do (templates.ts:535)
        if (sourceOwner !== undefined && sourceOwner.eventType !== 'group'
          && Array.isArray(sourceOwner.children) && sourceOwner.children.length === 0) {
          delete sourceOwner.children;
        }
        if (JSON.stringify(sheet.events) === JSON.stringify(beforeEvents)) {
          return toolResult({
            success: true, entity: args.sheetName, category: 'eventsheet', action: 'unchanged',
            movedSid: args.sid, movedType: moving.eventType, from, to: from, childrenMoved: countDescendants(moving),
          }, { projectWritten: false });
        }
        const to = eventPathOf(events, moving) ?? from;

        // Names: the variables and parameters in the moved event, in their new scope
        const sheetsBefore = new Map(sheetsNow);
        sheetsBefore.set(args.sheetName, beforeEvents);
        const original = eventAtEventPath(beforeEvents as unknown as Record<string, unknown>[], from);
        const clashes = findNewEventVariableNameClashes(
          sheetsBefore, args.sheetName, [original as unknown as C3Event], sheetsNow, args.sheetName, [moving as unknown as C3Event]);
        if (clashes.length > 0) return refuse(sameSheetNameClashMessage(args.sheetName, clashes));

        const loadCheck = await checkLoadRulesBeforeWrite(reader, args.sheetName, beforeEvents, sheet.events);
        if (loadCheck.errors.length > 0) return refuse(loadRuleErrorMessage(loadCheck.errors));

        // Uses that found a declaration before and now find none, or another one, in this sheet and the others
        const { lost, rebound } = findVariableBindingChanges(bindingsBefore, sheetsNow);
        const lostCount = countDeleteReferences(lost);
        const reboundCount = countDeleteReferences(rebound);
        const globalsAfter = globalVariableNames(sheetsNow);
        const noLongerGlobal = [...declared].filter(([key]) => globalsBefore.has(key) && !globalsAfter.has(key)).map(([, name]) => name);
        let unscanned: UnscannedFileReport[] = [];
        if (noLongerGlobal.length > 0) {
          const allSheets = await reader.readAllEventSheets();
          const skipped = unscannedFilesOf('eventSheets', await reader.listEventSheets(), allSheets, reader.getReadFailures('eventSheets'))
            .filter(f => f.name !== args.sheetName);
          unscanned = await checkUnscannedFiles(reader, skipped, [{ categories: ['eventSheets'], allOf: [noLongerGlobal.map(n => nameTerm(n))] }]);
        }
        const unscannedBlock = blocksWithoutForce(unscanned);
        const whereLost = 'where it is no longer in scope after the move';
        const whereRebound = 'where the name now finds another event variable or function parameter after the move';
        const checked = 'uses of the event variables and function parameters of this sheet';
        if ((lostCount > 0 || reboundCount > 0 || unscannedBlock || !lost.complete) && !args.force) {
          sheet.events = beforeEvents;
          const reasons = [
            ...(lostCount > 0 ? [`${describeDanglingReferences(lost, whereLost)} ${SCOPE_LOSS_CONSEQUENCE}`] : []),
            ...(reboundCount > 0 ? [`${describeDanglingReferences(rebound, whereRebound)} ${REBOUND_USE_CONSEQUENCE}`] : []),
            ...(unscannedBlock ? [unscannedRefusal(unscanned)] : []),
            ...(!lost.complete ? [traversalLimitReason(checked, lost.limit)] : []),
          ];
          return toolResult({
            success: false, entity: args.sheetName, category: 'eventsheet', action: 'move_blocked',
            message: nothingChanged(`${reasons.join(' ')} ${lostCount > 0
              ? 'Move the events that use it along, pick another place, or use force=true to move anyway.'
              : 'Pick another place, or use force=true to move anyway.'}`),
            references: danglingReferenceList(lost),
            ...(reboundCount > 0 ? { reboundReferences: danglingReferenceList(rebound) } : {}),
            ...unscannedFields(unscanned),
          }, { projectWritten: false });
        }
        const warnings = [...loadCheck.warnings, ...elsePredecessorWarnings(beforeEvents, sheet.events)];
        if (lostCount > 0) {
          warnings.push(`Moved with force=true: ${describeDanglingReferences(lost, whereLost)} ${SCOPE_LOSS_CONSEQUENCE} Fix them before opening the project in Construct 3.`);
        }
        if (reboundCount > 0) {
          warnings.push(`Moved with force=true: ${describeDanglingReferences(rebound, whereRebound)} ${REBOUND_USE_CONSEQUENCE}`);
        }
        if (!lost.complete) warnings.push(`Moved with force=true: ${traversalLimitReason(checked, lost.limit)}`);
        warnings.push(...unscannedWarnings(unscanned, 'Moved'));

        writeStarted = true;
        const backupPath = await writeEntityOrRollBack(writer, 'eventSheets', args.sheetName, sheet);
        resetProjectIndex(reader);
        return toolResult({
          success: true, entity: args.sheetName, category: 'eventsheet', action: 'updated',
          movedSid: args.sid, movedType: moving.eventType, from, to, childrenMoved: countDescendants(moving),
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(lostCount > 0 ? { references: danglingReferenceList(lost) } : {}),
          ...(reboundCount > 0 ? { reboundReferences: danglingReferenceList(rebound) } : {}),
          ...unscannedFields(unscanned),
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[move_event_block] failed:', error);
        if (undoPlacement) {
          undoPlacement();
          if (!writeStarted) return toolError(stoppedBeforeWriteMessage(error));
        }
        return toolError(`Error moving event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── fix_legacy_behavior_keys ───────────────────────────────

  server.tool(
    'fix_legacy_behavior_keys',
    'Repair event sheets written by older versions of this server: rename the legacy "behavior-type" key on conditions/actions to "behaviorType", the key Construct 3 reads. Without it C3 looks behavior ACEs up on the base plugin and fails to open the project ("missing action id"). Only names that match a behavior on the object or its families are renamed; the rest is reported. Dry run by default.',
    {
      dryRun: z.boolean().optional().default(true).describe('If true (default), only report what would change. Set false to rewrite the affected sheets (each is backed up first).'),
    },
    async (args) => {
      const writtenSheets: string[] = [];
      try {
        const sheetNames = await reader.listEventSheets();
        const unreadableSheets: string[] = [];
        const loaded: Array<{ sheetName: string; sheet: EventSheet }> = [];
        for (const sheetName of sheetNames) {
          try {
            const sheet = await reader.readEventSheet(sheetName);
            if (Array.isArray(sheet.events)) loaded.push({ sheetName, sheet });
          } catch {
            unreadableSheets.push(sheetName);
          }
        }

        // Load only the object types the legacy keys point at, then check each
        // name before renaming it: renaming turns the key into an active
        // behavior lookup, so a name C3 cannot resolve is reported instead.
        const referenced = new Set<string>();
        for (const { sheet } of loaded) {
          for (const hit of scanLegacyBehaviorKeys(sheet.events).fixable) {
            if (hit.objectClass) referenced.add(hit.objectClass);
          }
        }
        const lookup = await loadBehaviorLookup(reader, referenced);
        const resolve = (objectClass: string, behaviorName: string) => checkBehaviorName(objectClass, behaviorName, lookup);

        const sheets: Array<{
          sheetName: string;
          renamed: number;
          changes: LegacyBehaviorKeyHit[];
          changesTruncated?: boolean;
          unresolved?: LegacyBehaviorKeyConflict[];
          conflicts?: LegacyBehaviorKeyConflict[];
          scanTruncated?: boolean;
          backupFile?: string;
        }> = [];
        let totalRenamed = 0;
        let totalUnverified = 0;
        let totalUnresolved = 0;
        let totalConflicts = 0;
        const truncatedSheets: string[] = [];

        for (const { sheetName, sheet } of loaded) {
          const scan = scanLegacyBehaviorKeys(sheet.events, { apply: !args.dryRun, resolve });
          if (scan.truncated) truncatedSheets.push(sheetName);
          if (scan.fixable.length === 0 && scan.unresolved.length === 0 && scan.conflicts.length === 0) continue;

          const entry: (typeof sheets)[number] = {
            sheetName,
            renamed: scan.fixable.length,
            changes: scan.fixable.slice(0, MAX_REPORTED_CHANGES),
          };
          if (scan.fixable.length > MAX_REPORTED_CHANGES) entry.changesTruncated = true;
          if (scan.unresolved.length > 0) entry.unresolved = scan.unresolved;
          if (scan.conflicts.length > 0) entry.conflicts = scan.conflicts;
          if (scan.truncated) entry.scanTruncated = true;

          if (!args.dryRun && scan.fixable.length > 0) {
            const subfolder = writer.getSubfolderForEntity('eventSheets', sheetName);
            entry.backupFile = await writer.writeEntityFile('eventSheets', sheetName, sheet, subfolder);
            writtenSheets.push(sheetName);
          }

          totalRenamed += scan.fixable.length;
          totalUnverified += scan.fixable.filter(h => h.warning).length;
          totalUnresolved += scan.unresolved.length;
          totalConflicts += scan.conflicts.length;
          sheets.push(entry);
        }

        if (writtenSheets.length > 0) resetProjectIndex(reader);

        const parts: string[] = [];
        if (totalRenamed > 0) {
          const verb = args.dryRun ? 'would be renamed' : 'renamed';
          parts.push(`${totalRenamed} condition(s)/action(s) in ${sheets.filter(s => s.renamed > 0).length} sheet(s) ${verb} from "behavior-type" to "behaviorType".`);
          if (totalUnverified > 0) {
            parts.push(`${totalUnverified} of them could not be checked against the object's behaviors (see the warning on each change).`);
          }
        }
        if (totalUnresolved > 0) {
          parts.push(`${totalUnresolved} condition(s)/action(s) were left untouched because their "behavior-type" value matches no behavior on the object or its families (see unresolved) — set "behaviorType" to the behavior's name by hand.`);
        }
        if (totalConflicts > 0) {
          parts.push(`${totalConflicts} condition(s)/action(s) were left untouched because their keys conflict or hold no behavior name (see conflicts) — resolve them by hand.`);
        }
        if (parts.length === 0) {
          parts.push(unreadableSheets.length > 0
            ? `No legacy "behavior-type" keys found in the ${loaded.length} readable sheet(s).`
            : 'No legacy "behavior-type" keys found.');
        }
        if (unreadableSheets.length > 0) {
          parts.push(`${unreadableSheets.length} sheet(s) could not be read and were not checked: ${unreadableSheets.join(', ')}.`);
        }
        if (truncatedSheets.length > 0) {
          parts.push(`The scan stopped at its size limit in ${truncatedSheets.join(', ')}; some conditions/actions there were not checked.`);
        }
        if (args.dryRun && totalRenamed > 0) {
          parts.push('Run again with dryRun: false to apply.');
        }

        return toolResult({
          success: true,
          dryRun: args.dryRun,
          category: 'eventsheet',
          action: args.dryRun ? 'would_fix' : 'fixed',
          sheetsScanned: loaded.length,
          totalRenamed,
          totalUnresolved,
          totalConflicts,
          sheets,
          ...(unreadableSheets.length > 0 ? { unreadableSheets } : {}),
          message: parts.join(' '),
          // A run with nothing to rename writes no sheet: no editor reload note
        }, { projectWritten: writtenSheets.length > 0 });
      } catch (error) {
        console.error('[fix_legacy_behavior_keys] failed:', error);
        const partial = writtenSheets.length > 0
          ? ` Sheets already rewritten before the failure: ${writtenSheets.join(', ')}.`
          : '';
        return toolError(`Error fixing legacy behavior keys: ${error instanceof Error ? error.message : String(error)}${partial}`);
      }
    }
  );

  // ─── fix_legacy_event_shapes ────────────────────────────────

  server.tool(
    'fix_legacy_event_shapes',
    'Repair event sheets written by construct3-mcp 1.8.1 and earlier: convert event shapes Construct 3 itself never writes into the editor\'s own. A block-level "isElse" becomes a System "else" first condition, per-condition "isOr" flags become the block\'s "isOrBlock", and function calls with id/objectClass or keyed parameters become { callFunction, sid, parameters: [...] }. Scripts stored as one string or without "language" (also the shape older Construct 3 releases saved) become lines with language "javascript", as current releases save them; that conversion is harmless. Only unambiguous cases are converted; the rest is reported for a decision by hand. Converted else and OR blocks can run differently than before, so test them in the game. Dry run by default.',
    {
      dryRun: z.boolean().optional().default(true).describe('If true (default), only report what would change. Set false to rewrite the affected sheets (each is backed up first).'),
    },
    async (args) => {
      const writtenSheets: string[] = [];
      try {
        const sheetNames = await reader.listEventSheets();
        const unreadableSheets: string[] = [];
        const loaded: Array<{ sheetName: string; sheet: EventSheet }> = [];
        for (const sheetName of sheetNames) {
          try {
            const sheet = await reader.readEventSheet(sheetName);
            if (Array.isArray(sheet.events)) loaded.push({ sheetName, sheet });
          } catch {
            unreadableSheets.push(sheetName);
          }
        }
        // Named call parameters map to positions through the function's parameters
        const functions = collectFunctionSignatures(loaded.map(l => l.sheet));

        const sheets: Array<{
          sheetName: string;
          converted: number;
          changes: LegacyEventShapeHit[];
          changesTruncated?: boolean;
          manual?: LegacyEventShapeHit[];
          scanTruncated?: boolean;
          backupFile?: string;
        }> = [];
        let totalConverted = 0;
        let totalManual = 0;
        let totalBehaviorChanges = 0;
        const truncatedSheets: string[] = [];

        for (const { sheetName, sheet } of loaded) {
          const scan = await scanLegacyEventShapes(sheet.events, {
            apply: !args.dryRun,
            newSid: () => idGen.generateSid(reader),
            functions,
          });
          if (scan.truncated) truncatedSheets.push(sheetName);
          if (scan.fixable.length === 0 && scan.manual.length === 0) continue;

          const entry: (typeof sheets)[number] = {
            sheetName,
            converted: scan.fixable.length,
            changes: scan.fixable.slice(0, MAX_REPORTED_CHANGES),
          };
          if (scan.fixable.length > MAX_REPORTED_CHANGES) entry.changesTruncated = true;
          if (scan.manual.length > 0) entry.manual = scan.manual;
          if (scan.truncated) entry.scanTruncated = true;

          if (!args.dryRun && scan.fixable.length > 0) {
            const subfolder = writer.getSubfolderForEntity('eventSheets', sheetName);
            entry.backupFile = await writer.writeEntityFile('eventSheets', sheetName, sheet, subfolder);
            writtenSheets.push(sheetName);
          }

          totalConverted += scan.fixable.length;
          totalManual += scan.manual.length;
          totalBehaviorChanges += scan.fixable.filter(h => h.changesBehavior).length;
          sheets.push(entry);
        }

        if (writtenSheets.length > 0) resetProjectIndex(reader);

        const parts: string[] = [];
        if (totalConverted > 0) {
          const verb = args.dryRun ? 'would be converted' : 'converted';
          parts.push(`${totalConverted} legacy event shape(s) in ${sheets.filter(s => s.converted > 0).length} sheet(s) ${verb} to the shapes Construct 3 saves.`);
        }
        if (totalBehaviorChanges > 0) {
          parts.push(
            `${totalBehaviorChanges} of them (else and OR blocks) ${args.dryRun ? 'can' : 'may'} change how the event runs: ` +
            'if Construct 3 ignored the old keys, an isElse block ran like an ordinary block and isOr conditions were AND-combined until now. ' +
            'Test those events in the game (see the details under changes).',
          );
        }
        if (totalManual > 0) {
          parts.push(`${totalManual} were left untouched because the conversion is ambiguous (see manual) — fix them by hand, e.g. with update_event_block (isElse, isOrBlock) or update_event_block_action (call arguments as an array).`);
        }
        if (parts.length === 0) {
          parts.push(unreadableSheets.length > 0
            ? `No legacy event shapes found in the ${loaded.length} readable sheet(s).`
            : 'No legacy event shapes found.');
        }
        if (unreadableSheets.length > 0) {
          parts.push(`${unreadableSheets.length} sheet(s) could not be read and were not checked: ${unreadableSheets.join(', ')}.`);
        }
        if (truncatedSheets.length > 0) {
          parts.push(`The scan stopped at its size limit in ${truncatedSheets.join(', ')}; some events there were not checked.`);
        }
        if (args.dryRun && totalConverted > 0) {
          parts.push('Run again with dryRun: false to apply.');
        }

        return toolResult({
          success: true,
          dryRun: args.dryRun,
          category: 'eventsheet',
          action: args.dryRun ? 'would_fix' : 'fixed',
          sheetsScanned: loaded.length,
          totalConverted,
          totalManual,
          totalBehaviorChanges,
          sheets,
          ...(unreadableSheets.length > 0 ? { unreadableSheets } : {}),
          message: parts.join(' '),
          // A run with nothing to convert writes no sheet: no editor reload note
        }, { projectWritten: writtenSheets.length > 0 });
      } catch (error) {
        console.error('[fix_legacy_event_shapes] failed:', error);
        const partial = writtenSheets.length > 0
          ? ` Sheets already rewritten before the failure: ${writtenSheets.join(', ')}.`
          : '';
        return toolError(`Error fixing legacy event shapes: ${error instanceof Error ? error.message : String(error)}${partial}`);
      }
    }
  );

  // ─── update_event_variable ────────────────────────────────

  server.tool(
    'update_event_variable',
    'Update an existing event variable declaration (rename, change type, change initial value). A SID shared by several events in the sheet is refused with a list of candidates; pass eventPath to pick one.',
    {
      sheetName: z.string().max(200).describe('Event sheet containing the variable, as registered (letter case included)'),
      sid: z.number().int().describe('SID of the variable event to update'),
      eventPath: eventPathSchema,
      newName: z.string().max(200).optional().describe('New variable name. Refused like in the editor: a name that matches, ignoring case, an event variable or function parameter in the variable\'s scope (for a global variable: anywhere in the project) or a System expression, or that has whitespace, punctuation such as - . : or a leading underscore'),
      newType: z.enum(['number', 'string', 'boolean']).optional().describe('New variable type'),
      newInitialValue: z.string().max(1000).optional().describe('New initial value (as string — use "0", "false", or "" for defaults)'),
      isStatic: z.boolean().optional().describe('Mark as static (value persists between calls)'),
      isConstant: z.boolean().optional().describe('Mark as constant (cannot be changed at runtime)'),
    },
    async (args) => {
      try {
        const hasUpdates = args.newName !== undefined || args.newType !== undefined ||
          args.newInitialValue !== undefined || args.isStatic !== undefined || args.isConstant !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: newName, newType, newInitialValue, isStatic, isConstant.');
        }
        // Its name check compares the sheet with the other sheets by registered name
        const unregistered = await unregisteredSheetError(reader, args.sheetName);
        if (unregistered) return unregistered;

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(args.sheetName);
        } catch {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }

        // Find the variable event by SID (search flat and nested)
        const found = resolveEventBySid(sheet.events as Record<string, unknown>[], args.sid, {
          sheetName: args.sheetName,
          action: 'update',
          eventPath: args.eventPath,
        });
        if ('error' in found) return toolError(found.error);
        const findResult = found.match;
        if (findResult.event.eventType !== 'variable') {
          return toolError(`Event SID ${args.sid} is a "${findResult.event.eventType}" event, not a variable event.`);
        }

        const varEvent = findResult.event as unknown as import('../construct3/types.js').VariableEvent;

        // Check the new name against the variable's scope, as the editor does;
        // changing the case of this variable's own name is fine
        if (args.newName !== undefined && args.newName !== varEvent.name) {
          const parents = findEnclosingEvents(sheet.events, findResult.event as C3Event) ?? [];
          const sheets = await readEventSheetsFresh(reader, [[args.sheetName, sheet.events]]);
          const nameError = eventVariableNameError(
            sheets, args.sheetName, parents, args.newName, findResult.event as C3Event);
          if (nameError) return toolError(nameError);
          varEvent.name = args.newName;
        }

        if (args.newType !== undefined) varEvent.type = args.newType;
        if (args.newInitialValue !== undefined) varEvent.initialValue = args.newInitialValue;
        if (args.isStatic !== undefined) varEvent.isStatic = args.isStatic;
        if (args.isConstant !== undefined) varEvent.isConstant = args.isConstant;

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const backupPath = await writer.writeEntityFile('eventSheets', args.sheetName, sheet, subfolder);
        resetProjectIndex(reader);

        const result: WriteResult = {
          success: true,
          entity: args.sheetName,
          category: 'eventsheet',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult({ ...result, eventPath: findResult.path });
      } catch (error) {
        console.error('[update_event_variable] failed:', error);
        return toolError(`Error updating event variable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/**
 * Edit a comment row in place: its text and colours keep their place, a new
 * colour goes where the editor writes it ({ type, text, "text-color",
 * "background-color" }), and null removes a colour.
 */
function editCommentRowInPlace(
  row: Record<string, unknown>,
  edit: { text?: string; 'text-color'?: number[] | null; 'background-color'?: number[] | null },
): void {
  if (edit.text !== undefined) row.text = edit.text;
  for (const key of ['text-color', 'background-color'] as const) {
    const color = edit[key];
    if (color === undefined) continue;
    if (color === null) {
      delete row[key];
    } else if (key in row) {
      row[key] = [...color];
    } else {
      // After the keys the editor writes before it
      const before = key === 'text-color' ? ['type', 'text'] : ['type', 'text', 'text-color'];
      const entries = Object.entries(row);
      let at = 0;
      entries.forEach(([k], i) => { if (before.includes(k)) at = i + 1; });
      entries.splice(at, 0, [key, [...color]]);
      for (const k of Object.keys(row)) delete row[k];
      for (const [k, v] of entries) row[k] = v;
    }
  }
}

/** SIDs listed in the copied-SIDs warning; the rest are counted. */
const MAX_LISTED_SHARED_SIDS = 10;

/**
 * Warning for events copied into a sheet (already inserted there) whose SIDs,
 * or those of their sub-events, now match more than one event of that sheet,
 * or undefined when every copied SID is unique there. Such SIDs are refused by
 * the SID-based tools in that sheet unless an eventPath picks one.
 */
function copiedSidsWarning(
  sheetName: string,
  sheetEvents: Record<string, unknown>[],
  copiedEvents: Record<string, unknown>[],
): string | undefined {
  let shared: Map<number, string[]>;
  try {
    shared = eventSidsMatchingSeveral(sheetEvents, collectEventSids(copiedEvents));
  } catch {
    return undefined; // Past the traversal limits: skip the warning, it must not block the write
  }
  if (shared.size === 0) return undefined;

  const entries = [...shared].map(([sid, paths]) => `SID ${sid} at ${paths.join(', ')}`);
  const listed = entries.slice(0, MAX_LISTED_SHARED_SIDS).join('; ');
  const more = entries.length > MAX_LISTED_SHARED_SIDS ? `; and ${entries.length - MAX_LISTED_SHARED_SIDS} more` : '';
  const one = shared.size === 1;
  return (
    `${one ? 'A SID' : `${shared.size} SIDs`} of the copied events now ${one ? 'matches' : 'match'} more than one event in "${sheetName}", ` +
    `because copied events keep their SIDs: ${listed}${more}. ` +
    `update_event_block, update_event_block_action, update_event_variable and delete_event_from_sheet refuse ${one ? 'this SID' : 'these SIDs'} ` +
    `in "${sheetName}" unless eventPath names one of the events.`
  );
}

/**
 * The refusal for an error thrown after a tool placed an event in the sheet's
 * events in memory and before it wrote the file (for example a scan that
 * exceeds its depth limit): the tool has put the events back, so nothing was
 * changed.
 */
function stoppedBeforeWriteMessage(error: unknown): string {
  return nothingChanged(`The change was stopped before anything was written: ${error instanceof Error ? error.message : String(error)}`);
}

/** True when `target` (compared by identity) is among the sub-events of `event`, at any depth. */
function isWithin(event: Record<string, unknown>, target: Record<string, unknown>): boolean {
  const stack: unknown[] = Array.isArray(event.children) ? [...event.children] : [];
  let nodes = 0;
  while (stack.length > 0) {
    if (++nodes > MAX_SEARCH_NODES) throw new Error(`Sub-event scan exceeded ${MAX_SEARCH_NODES} nodes`);
    const current = stack.pop();
    if (current === target) return true;
    if (typeof current === 'object' && current !== null && Array.isArray((current as Record<string, unknown>).children)) {
      stack.push(...((current as Record<string, unknown>).children as unknown[]));
    }
  }
  return false;
}

/**
 * Why `moving`, once it stands below `parents` (the events enclosing its new
 * place, outermost first), puts a function block where one is not placed
 * (functionBlockTriggerRefusal), or undefined. The function block is `moving`
 * itself or one inside it at any depth; what stands between it and `moving`
 * does not change with the move, so only `parents` decides, and the first
 * function block found is the one the message names.
 */
function movedFunctionBlockRefusal(moving: Record<string, unknown>, parents: readonly C3Event[]): string | undefined {
  const stack: Array<Record<string, unknown>> = [moving];
  while (stack.length > 0) {
    const event = stack.pop()!;
    if (event.eventType === 'function-block') {
      const refusal = functionBlockTriggerRefusal(parents);
      if (refusal === undefined || event === moving) return refusal;
      const sid = typeof event.sid === 'number' ? ` with SID ${event.sid}` : '';
      return `The event with SID ${String(moving.sid)} holds the function block${sid}. ${refusal}`;
    }
    if (!Array.isArray(event.children)) continue;
    for (const child of [...event.children as unknown[]].reverse()) {
      if (typeof child === 'object' && child !== null) stack.push(child as Record<string, unknown>);
    }
  }
  return undefined;
}

/**
 * Why `moving`, once it stands below `parents` (the events enclosing its new
 * place, outermost first), puts a custom action block where an event that is
 * not a group stands above it, or undefined. The custom action block is
 * `moving` itself or one inside it at any depth; the events between `moving`
 * and that block count as well as `parents`, and the first block found with a
 * non-group above it is the one the message names. Construct 3 r506-2 (Free
 * edition) was seen accepting a custom action block only at the top level and
 * in a top-level group, and the load-time check treats a custom action block
 * as a trigger root; the rule is this tool's own and was not checked in the
 * editor.
 */
function movedCustomActionBlockRefusal(moving: Record<string, unknown>, parents: readonly C3Event[]): string | undefined {
  const stack: Array<{ event: Record<string, unknown>; above: Array<Record<string, unknown>> }> = [
    { event: moving, above: [...parents as ReadonlyArray<Record<string, unknown>>] },
  ];
  while (stack.length > 0) {
    const { event, above } = stack.pop()!;
    if (event.eventType === 'custom-ace-block') {
      const nonGroup = above.find(parent => parent.eventType !== 'group');
      if (nonGroup === undefined) continue;
      const what = nonGroup.eventType === 'block' ? (Array.isArray(nonGroup.conditions) && nonGroup.conditions.length > 0 ? 'a block with conditions' : 'a block')
        : nonGroup.eventType === 'function-block' ? 'a function block'
          : nonGroup.eventType === 'custom-ace-block' ? 'a custom action block' : `an event of type "${String(nonGroup.eventType)}"`;
      const held = event === moving ? '' : `The event with SID ${String(moving.sid)} holds the custom action block${typeof event.sid === 'number' ? ` with SID ${event.sid}` : ''}. `;
      return `${held}A custom action block is not placed below ${what}${typeof nonGroup.sid === 'number' ? ` (SID ${nonGroup.sid})` : ''}: ` +
        'Construct 3 r506-2 (Free edition) was seen accepting one only at the top level and in a top-level group, and the load check this tool follows ' +
        'treats a custom action block as a trigger root, as it does a function block, which r506-2 (Free edition) refused to open under an "On start" block. ' +
        'This is the tool\'s own rule, not checked in the editor. It can go at the top level, in a group, or in a group that has only groups above it.';
    }
    if (!Array.isArray(event.children)) continue;
    for (const child of [...event.children as unknown[]].reverse()) {
      if (typeof child === 'object' && child !== null) stack.push({ event: child as Record<string, unknown>, above: [...above, event] });
    }
  }
  return undefined;
}

/** Error text for a move within one sheet that would put names Construct 3 treats as the same into one scope; a name in another sheet is placed by its sheet. */
function sameSheetNameClashMessage(sheetName: string, clashes: readonly NewEventVariableNameClash[]): string {
  const lines = clashes.slice(0, 10).map(({ declaration, use }) => {
    const what = declaration.kind === 'function parameter' ? 'function parameter' : declaration.parents.length === 0 ? 'global variable' : 'local variable';
    const other = use.kind === 'variable' ? 'event variable' : 'function parameter';
    const relation = use.name === declaration.name ? 'has the same name as' : 'differs only in case from';
    return `- the ${what} "${declaration.name}" ${relation} the ${other} "${use.name}"${use.sheet === sheetName ? '' : ` in sheet "${use.sheet}"`}`;
  });
  if (clashes.length > 10) lines.push(`- and ${clashes.length - 10} more`);
  return 'Moving the event would put names that Construct 3 treats as the same (ignoring case) into one event variable scope:\n' +
    `${lines.join('\n')}\n\nRename one of them first (update_event_variable).`;
}

/**
 * The warning for a System "else" condition that update_event_block inserts or
 * puts in place of a condition anywhere but first. `startsWithElse` is true
 * when the block starts with an else condition or gets one through isElse:
 * true; the advice to use isElse: true then does not apply, because Else is
 * saved once, as the first condition.
 */
function misplacedElseWarning(where: string, what: 'an inserted' | 'a replacing', index: number, isElse: boolean | undefined, startsWithElse: boolean): string {
  const start = `${where}: ${what} System "else" condition is condition ${index}, but `;
  if (startsWithElse) {
    return `${start}this block ${isElse === true ? 'gets an else condition first through isElse: true' : 'already starts with one'}, and Construct 3 saves Else once, as the first condition.`;
  }
  return `${start}Construct 3 saves Else as the first condition. Use isElse: true instead.`;
}

/**
 * A "not found" error when the project registers no event sheet under exactly
 * `name`, else undefined. On a file system that ignores case the reader also
 * opens a sheet by a name that differs in case, but the tools that check a
 * sheet together with the other event sheets key them by their registered
 * names: they would see that sheet twice, once as saved, and miss what the
 * change does to it (issue #38). A name that differs only in letter case gets
 * its own hint, as in update_object_properties.
 */
async function unregisteredSheetError(
  reader: MutationToolDeps['reader'],
  name: string,
): Promise<ReturnType<typeof toolError> | undefined> {
  const registered = await reader.listEventSheets();
  if (registered.includes(name)) return undefined;
  const sameIgnoringCase = registered.find(n => n.toLowerCase() === name.toLowerCase());
  if (sameIgnoringCase !== undefined) {
    return toolError(`Event sheet "${name}" not found: names are matched with their letter case. Did you mean "${sameIgnoringCase}"?`);
  }
  return notFoundError('Event sheet', name, reader.findNearestName(name, 'eventsheets'), 'list_eventsheets');
}

/**
 * Rewrite a call's positional arguments for a parameter list change:
 * drop the arguments at `removed` (indexes in the old list) and append
 * `added`. Only a call that passes exactly `oldCount` arguments is
 * changed, so a call this rewrite already changed (a run repeated after
 * the process stopped, for a change that alters the count) is left as it
 * is. Returns false for a call left alone.
 */
function rewriteCallArguments(call: Record<string, unknown>, oldCount: number, removed: ReadonlySet<number>, added: readonly FunctionArgument[]): boolean {
  const args = Array.isArray(call.parameters) ? call.parameters as FunctionArgument[] : [];
  if (args.length !== oldCount) return false;
  const next = [...args.filter((_a, i) => !removed.has(i)), ...added];
  rewriteFunctionCallInPlace(call, next);
  return true;
}

/** A new parameter's initial value when none is given, as createFunctionEvent writes it (templates.ts). */
function defaultInitialValue(type: 'number' | 'string' | 'boolean'): string {
  return type === 'number' ? '0' : type === 'boolean' ? 'false' : '';
}

/**
 * The argument a call passes for a new parameter, or why the initial value
 * cannot be one: a number as its numeric literal, a string as a Construct
 * string literal (a quote inside is written twice, as layerNameLiteral does
 * in layer-references.ts; a line break is refused), a boolean as JSON true
 * or false, as calls store booleans.
 */
function callArgumentFor(
  type: 'number' | 'string' | 'boolean',
  initialValue: string | undefined,
): { value: FunctionArgument } | { problem: string } {
  if (type === 'boolean') {
    const text = initialValue ?? 'false';
    if (text !== 'true' && text !== 'false') return { problem: `The initial value of a boolean parameter is "true" or "false", not "${text}".` };
    return { value: text === 'true' };
  }
  if (type === 'number') {
    const text = (initialValue ?? '0').trim();
    if (!/^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text)) {
      return { problem: `The initial value of a number parameter is a number, such as "0" or "2.5", not "${initialValue}"; the calls get it as their argument.` };
    }
    return { value: text };
  }
  // This tool's own rule: whether the editor accepts a line break inside a string literal has not been checked
  if (/[\r\n]/.test(initialValue ?? '')) {
    return {
      problem: 'The initial value of a string parameter cannot hold a line break (a newline or carriage return): this tool writes it into each call ' +
        'as a one-line string literal, and whether Construct 3 accepts a line break there has not been checked.',
    };
  }
  return { value: `"${(initialValue ?? '').replace(/"/g, '""')}"` };
}

/** A call or other use of a function or custom action where it stands, with the stored action for a rewrite in place. */
interface CallReference {
  kind: DeleteReferenceKind | 'customAction';
  sheet: string;
  path: string;
  sid?: number;
  ace: Record<string, unknown>;
}

/** A custom action call as update_function lists and rewrites calls. */
function customCallReference(site: CustomActionCallSite): CallReference {
  return { kind: 'customAction', sheet: site.sheet, path: site.path, ...(site.sid !== undefined ? { sid: site.sid } : {}), ace: site.ace };
}

/** A reference as a result lists it. */
function referenceEntry(r: Omit<CallReference, 'ace'>): Record<string, unknown> {
  return { sheet: r.sheet, path: r.path, ...(r.sid !== undefined ? { sid: r.sid } : {}), kind: r.kind };
}

/** Up to ten references for a message, then how many more. */
function listReferences(refs: readonly Omit<CallReference, 'ace'>[]): string {
  const shown = refs.slice(0, 10).map(r => `${r.sheet} ${r.path}${r.sid !== undefined ? ` (SID ${r.sid})` : ''}`);
  return `${shown.join('; ')}${refs.length > 10 ? `; and ${refs.length - 10} more` : ''}`;
}

/**
 * The events of every event sheet registered in the project, read from disk
 * rather than from the reader's cache (which does not see sheets saved
 * outside this server since its last write), with `overrides` (sheet name and
 * events) in place of the saved events. Unreadable sheets are skipped, as in
 * readAllEventSheets.
 */
async function readEventSheetsFresh(
  reader: MutationToolDeps['reader'],
  overrides: ReadonlyArray<readonly [string, C3Event[]]>,
): Promise<Map<string, C3Event[]>> {
  const sheets = new Map<string, C3Event[]>();
  for (const name of await reader.listEventSheets()) {
    try {
      const data = await reader.readEventSheet(name);
      if (Array.isArray(data.events)) sheets.set(name, data.events);
    } catch {
      // Skip unreadable sheets
    }
  }
  for (const [name, events] of overrides) sheets.set(name, events);
  return sheets;
}

/** The scope rules of the editor's Event variable and Function parameter dialogs, for error messages. */
const NAME_SCOPE_RULE = {
  global: 'Construct 3 requires a global variable name to differ, ignoring case, from every event variable and ' +
    'function parameter in the project.',
  local: 'Construct 3 requires a local variable name to differ, ignoring case, from every global variable, from the ' +
    'variables and function parameters of the events enclosing it and from those below its parent event.',
  parameter: 'Construct 3 requires a function parameter name to differ, ignoring case, from every global variable, ' +
    'from the other parameters of its function and from the variables below the function.',
};

/**
 * Error text for an event variable or function parameter name the editor
 * would refuse. `scopeRule` is one of NAME_SCOPE_RULE.
 */
function eventVariableNameMessage(
  problem: EventVariableNameProblem,
  name: string,
  what: 'event variable' | 'function parameter',
  scopeRule: string,
): string {
  const article = what === 'event variable' ? 'an' : 'a';
  if (problem.problem === 'invalid') {
    return `"${name}" is not a valid ${what} name: ${problem.reason}. Construct 3 does not accept whitespace, ` +
      'the characters . , " ( ) ? : \\ / ; * | \' - ` ! $ % ^ & + = < > { } [ ] @ # ~ ¬ £, the soft hyphen, ' +
      'the ideographic full stop 。, the full-width forms ， （ ） ？ ： of , ( ) ? :, ' +
      'the typographic double quotes “ ”, a leading underscore or a name made only of digits. ' +
      'Choose a different name.';
  }
  if (problem.problem === 'system-expression') {
    const newer = SYSTEM_EXPRESSIONS_NOT_IN_R449.has(problem.expression)
      ? ' Newer Construct 3 releases such as r495.2 have this System expression (r449 does not have it) and'
      : ' Construct 3';
    return `"${name}" is the name of the System expression "${problem.expression}"` +
      `${problem.expression === name ? '' : ' (ignoring case)'}.${newer} does not accept ${article} ${what} ` +
      'named like a System expression. Choose a different name.';
  }
  const { use } = problem;
  if (use.name === name) {
    return `A ${use.kind} named "${name}" already exists in sheet "${use.sheet}". ${scopeRule}`;
  }
  const kind = use.kind === 'variable' ? 'event variable' : 'function parameter';
  return `Sheet "${use.sheet}": ${caseClashError(kind, name, use.name)} ${scopeRule}`;
}

/**
 * Why the editor would refuse `name` for an event variable declared in sheet
 * `sheetName` under `parents` (the enclosing events, outermost first; empty
 * for a global variable), or undefined when it would accept it. `sheets` holds
 * the events of every event sheet (from readEventSheetsFresh); `self` is the
 * variable being renamed. See construct3/event-variable-names.ts for the rules.
 */
function eventVariableNameError(
  sheets: ReadonlyMap<string, readonly C3Event[]>,
  sheetName: string,
  parents: readonly C3Event[],
  name: string,
  self?: C3Event,
): string | undefined {
  const ownName = self ? (self as { name?: unknown }).name : undefined;
  const problem = findEventVariableNameProblem(
    name,
    eventVariableNameUses(sheets, sheetName, parents, self),
    typeof ownName === 'string' ? ownName : undefined,
  );
  if (!problem) return undefined;
  return eventVariableNameMessage(problem, name, 'event variable',
    parents.length === 0 ? NAME_SCOPE_RULE.global : NAME_SCOPE_RULE.local);
}

/**
 * Why the editor would refuse the parameter `names` of a new function that
 * goes into sheet `sheetName` under `parents` (the events enclosing it,
 * outermost first; empty at the top level), checked in order like the
 * editor's Function parameter dialog when the parameters are added one by
 * one; undefined when it would accept them all. `sheets` holds the events of
 * every event sheet (from readEventSheetsFresh). `argument` is the tool
 * argument that lists the names, for the messages about duplicates.
 */
export function functionParameterNamesError(
  sheets: ReadonlyMap<string, readonly C3Event[]>,
  sheetName: string,
  names: readonly string[],
  parents: readonly C3Event[] = [],
  argument = 'functionParams',
): string | undefined {
  // The new function has no sub-events yet, so a parameter's scope is every global variable, the variables of the events enclosing it and the parameters before it
  const fn = { eventType: 'function-block', functionParameters: [] as Array<{ name: string }>, children: [] };
  const parameterRule = parents.length === 0
    ? NAME_SCOPE_RULE.parameter
    : `${NAME_SCOPE_RULE.parameter} This tool also refuses a name the variables of the events enclosing the new function have (its own rule for a function in a group or event, not checked in the Construct 3 editor).`;
  for (const name of names) {
    const problem = findEventVariableNameProblem(name, eventVariableNameUses(sheets, sheetName, [...parents, fn as unknown as C3Event]));
    if (problem?.problem === 'in-use' && problem.use.kind === 'function parameter'
      && !fn.functionParameters.some(p => p.name === problem.use.name)) {
      // Not one of the new function's own parameters: a parameter of a function enclosing it
      return `${argument} lists "${name}", which ${problem.use.name === name ? 'is also a parameter of' : `differs only in case from the parameter "${problem.use.name}" of`} the function that encloses the new function (sheet "${problem.use.sheet}"). ` +
        'This tool refuses a parameter name that a function enclosing the new function has (its own rule, not checked in the Construct 3 editor). Choose a different name.';
    }
    if (problem?.problem === 'in-use' && problem.use.kind === 'function parameter') {
      return problem.use.name === name
        ? `${argument} lists "${name}" more than once. ${NAME_SCOPE_RULE.parameter}`
        : `${argument} lists "${problem.use.name}" and "${name}", which differ only in case. Construct 3 treats ` +
          `them as the same function parameter name. ${NAME_SCOPE_RULE.parameter}`;
    }
    if (problem) return eventVariableNameMessage(problem, name, 'function parameter', parameterRule);
    fn.functionParameters.push({ name });
  }
  return undefined;
}

/**
 * Why a function block may not go below `parents` (the events enclosing it,
 * outermost first; empty at the top level), or undefined. An event branch
 * holds one trigger, and a function block is a trigger root, so a function
 * block is refused under or below a block that holds a trigger condition and
 * under or below a function block or a custom action block (the load-time
 * check, load-rules.ts, counts both kinds of block as triggers). Recorded
 * editor case: Construct 3 r506-2 (Free edition) refused to open a function
 * block under an "On start" block. The other arrangements follow the
 * load-time check and were not tried in the editor. Groups do not count. A
 * condition is a trigger by its id (isTriggerId: the id starts with "on-"),
 * as in the load-time check, whatever addon it belongs to; the editor was
 * seen refusing only the built-in "On start of layout".
 */
function functionBlockTriggerRefusal(parents: readonly C3Event[]): string | undefined {
  const recorded = 'Construct 3 r506-2 (Free edition) refused to open a project with a function block under an "On start" block ("cannot add another trigger to event branch")';
  const goes = 'It can go at the top level, in a group, or among the sub-events of blocks that have no trigger in them or above them and are not inside a function block or a custom action block.';
  for (const parent of parents as ReadonlyArray<Record<string, unknown>>) {
    const sid = typeof parent.sid === 'number' ? ` with SID ${parent.sid}` : '';
    if (parent.eventType === 'function-block' || parent.eventType === 'custom-ace-block') {
      const kind = parent.eventType === 'function-block' ? 'function block' : 'custom action block';
      return `A function block is not placed under or below the ${kind}${sid}: the load-time check of this tool counts a function block and a custom action block as a trigger, and an event branch holds one trigger. ` +
        `${recorded}; this arrangement was not tried in the editor. ${goes}`;
    }
    if (!Array.isArray(parent.conditions)) continue;
    const trigger = (parent.conditions as Array<Record<string, unknown> | null>).find(c => isTriggerId(c?.id));
    if (!trigger) continue;
    return `A function block is not placed under the block${sid}, which has a condition with the trigger id "${String(trigger.id)}", which this tool takes for a trigger because the id starts with "on-", whatever addon the condition belongs to, or below it: ${recorded}, and the load-time check of this tool treats a trigger in an enclosing event the same way. ${goes}`;
  }
  return undefined;
}

/** Error text for a function name the editor would refuse (see event-variable-names.ts, Function names). */
function functionNameMessage(problem: FunctionNameProblem, name: string, returnType: string): string {
  if (problem.problem === 'invalid') {
    return `"${name}" is not a valid name for a function with return type "${returnType}": ${problem.reason}. ` +
      'A function with a return type is used in expressions (Functions.Name(...)), so Construct 3 gives it only a name ' +
      'it accepts for an event variable: no whitespace, no punctuation such as - . : ( ), no leading underscore, not ' +
      'only digits. A function without a return type (functionReturnType "none") may have such a name. Choose a different name.';
  }
  if (problem.problem === 'reserved') {
    return `"${name}" is the name of the System expression "${problem.expression}"${problem.expression === name ? '' : ' (ignoring case)'}. ` +
      'Construct 3 reserves the names of its built-in System functions for functions; choose a different name.';
  }
  const { use } = problem;
  const same = use.name === name ? `A function named "${name}"` : `The function "${use.name}", which differs from "${name}" only in case,`;
  return `${same} already exists in sheet "${use.sheet}" (${use.eventPath}${use.sid !== undefined ? `, SID ${use.sid}` : ''}). ` +
    'Construct 3 requires a function name to differ, ignoring case, from every other function in the project (it looks ' +
    'functions up ignoring case, so a call could not tell them apart). Choose a different name.';
}

/** Error text for a copy that would leave two function blocks whose names match ignoring case. */
function copiedFunctionNameClashMessage(targetSheet: string, groups: readonly FunctionBlockName[][]): string {
  const lines = groups.slice(0, 10).map(g =>
    `- ${g.map(f => `"${f.name}" in sheet "${f.sheet}" (${f.eventPath})`).join(', ')}`);
  if (groups.length > 10) lines.push(`- and ${groups.length - 10} more`);
  return `Copying these events to "${targetSheet}" would leave function blocks whose names match, ignoring case:\n` +
    `${lines.join('\n')}\n\n` +
    'Construct 3 requires a function name to differ, ignoring case, from every other function in the project, and ' +
    'renames a pasted function block; this tool keeps the names, so nothing was written. Move the function instead ' +
    '(deleteSource: true).';
}

/** Error text for copied or moved events whose variable or parameter names clash in their new scope. */
function movedEventVariableNameClashMessage(
  targetSheet: string,
  deleteSource: boolean,
  clashes: readonly NewEventVariableNameClash[],
): string {
  const MAX_LISTED = 10;
  const lines = clashes.slice(0, MAX_LISTED).map(({ declaration, use }) => {
    const what = declaration.kind === 'function parameter'
      ? 'function parameter'
      : declaration.parents.length === 0 ? 'global variable' : 'local variable';
    const other = use.kind === 'variable' ? 'event variable' : 'function parameter';
    const relation = use.name === declaration.name ? 'has the same name as' : 'differs only in case from';
    return `- the ${what} "${declaration.name}" ${relation} the ${other} "${use.name}" in sheet "${use.sheet}"`;
  });
  if (clashes.length > MAX_LISTED) lines.push(`- and ${clashes.length - MAX_LISTED} more`);
  return `${deleteSource ? 'Moving' : 'Copying'} these events to "${targetSheet}" would put names that Construct 3 ` +
    'treats as the same (ignoring case) into one event variable scope:\n' +
    `${lines.join('\n')}\n\n` +
    'Construct 3 requires a global variable name to differ from every event variable and function parameter in ' +
    'the project, and a local variable or function parameter name to differ from every global variable, from those ' +
    'of the events enclosing it and from those below its parent event. The editor renames a pasted variable in this ' +
    'case; this tool keeps the names, so nothing was written. Rename one of them first (update_event_variable)' +
    `${deleteSource ? '' : ', or move a global variable to the other sheet (deleteSource: true) instead of copying it'}.`;
}
