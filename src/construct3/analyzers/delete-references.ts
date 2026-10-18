/**
 * Names a delete_event_from_sheet or delete_event_sheet delete would leave
 * pointing at nothing.
 *
 * After the Construct 3 editor loads a project it resolves the names stored in
 * event parameters (projectResources.js r495.2: a pass over every parameter,
 * run once the project's files are read):
 * - the "variable" parameter of the System ACEs that read or set an event
 *   variable (EVENT_VARIABLE_ACE_IDS) throws `cannot find event variable
 *   '<name>'` when no event variable or function parameter of that name is in
 *   scope;
 * - a "Call function" action throws `invalid function name '<name>'` when no
 *   function block has that name;
 * - the "function" parameter of the Functions object's "Map function" and
 *   "Map function default" throws `cannot find function '<name>'`.
 * The editor compares these names ignoring case. Whether such an exception
 * stops the project from opening has not been confirmed in the editor.
 * `Functions.Name(...)` calls in expressions are not part of that pass as far
 * as the loader code shows (unverified); after the delete they name a
 * function that no longer exists. The same holds for event variables named in
 * expressions (`Score * 2`, a function call argument `Score`): every string
 * parameter is read as an expression (findExpressionIdentifiers), except the
 * parameters that hold a name rather than an expression
 * (NAME_PARAMETER_KEYS: objects, instance variables, layouts, audio files)
 * and the "variable" parameter above. A combo parameter whose value is spelled
 * like the variable is counted as well; the caller lists what it found, so
 * such a reference can be checked and the delete forced.
 *
 * Scope of event variables (the editor's lookup, the same scope as the name
 * rules for new variables): a variable at the top level of a sheet is global
 * and visible in every sheet; any other variable is visible to the events
 * beside it and below them; function parameters are visible inside their
 * function block. Only references that resolve before the delete and no longer
 * resolve after it are reported, so a reference that still finds another
 * variable or function of the same name (another sheet's global, a duplicate
 * function) is not reported, and neither is one that was already dangling.
 *
 * Scripts (script actions, script blocks, project scripts) are not scanned.
 */

import { findExpressionCalls, findExpressionIdentifiers, mappedFunctionName, parameterValues } from '../event-shapes.js';

/** Events (sub-events included, across all event sheets) a check visits before it stops, reporting complete: false */
export const REFERENCE_CHECK_MAX_EVENTS = 100_000;
const MAX_NODES = REFERENCE_CHECK_MAX_EVENTS;
const MAX_DEPTH = 50;
/** Nesting depth (lists inside lists) beyond which a check stops, reporting complete: false */
export const REFERENCE_CHECK_MAX_DEPTH = MAX_DEPTH;

/** Which traversal limit stopped a check: more events than the event limit, or events nested deeper than the depth limit. */
export type ReferenceCheckLimit = 'events' | 'depth';

/**
 * System ACEs whose "variable" parameter names an event variable (parameter
 * types eventvar, eventvarbool and eventvarany in the editor's System ACE
 * definitions); keys are "condition:<id>" and "action:<id>".
 */
export const EVENT_VARIABLE_ACE_IDS: ReadonlySet<string> = new Set([
  'condition:compare-eventvar',
  'condition:compare-boolean-eventvar',
  'action:set-eventvar-value',
  'action:add-to-eventvar',
  'action:subtract-from-eventvar',
  'action:set-boolean-eventvar',
  'action:toggle-boolean-eventvar',
  'action:reset-eventvar',
]);

/**
 * Parameter keys whose value is a name, not an expression: object parameters
 * ("object", "object-to-create", Pin's "pin-to", the hierarchy "child"),
 * instance variable, layout and audio file parameters. In editor-saved
 * projects every value under these keys is such a name, so a name there that
 * equals an event variable's is not a use of the variable.
 */
export const NAME_PARAMETER_KEYS: ReadonlySet<string> = new Set([
  'object',
  'object-to-create',
  'pin-to',
  'child',
  'instance-variable',
  'layout',
  'audio-file',
]);

/**
 * What names the deleted function or variable: a "Call function" action, a
 * function map registration, a `Functions.Name(...)` call in an expression,
 * the "variable" parameter of a System event variable ACE, or an expression
 * that uses the variable by name.
 */
export type DeleteReferenceKind = 'callFunction' | 'function-map' | 'expression' | 'event-variable' | 'variable-expression';

export interface DeleteReference {
  kind: DeleteReferenceKind;
  sheet: string;
  /** Path of the condition/action, e.g. "group:Title > block > action:0" (the get_function_map format) */
  path: string;
  /** SID of the event that holds the condition/action */
  sid?: number;
}

export interface DeleteReferenceReport {
  /** Functions defined in the deleted events that are still referenced from outside them */
  functions: Array<{ name: string; references: DeleteReference[] }>;
  /** Event variables declared in the deleted events that are still referenced from outside them */
  variables: Array<{ name: string; references: DeleteReference[] }>;
  /** False when a traversal limit stopped the scan early */
  complete: boolean;
  /** The limit that stopped the scan, when it did */
  limit?: ReferenceCheckLimit;
}

type EventRecord = Record<string, unknown>;

function isRecord(value: unknown): value is EventRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function childList(ev: EventRecord): unknown[] {
  return Array.isArray(ev.children) ? ev.children : [];
}

/** The parameter records of a function block or custom action block (empty for any other event). */
function functionParameterRecords(ev: EventRecord): EventRecord[] {
  if ((ev.eventType !== 'function-block' && ev.eventType !== 'custom-ace-block') || !Array.isArray(ev.functionParameters)) return [];
  return ev.functionParameters.filter(isRecord);
}

/** Lower-cased parameter names of a function block or custom action block. */
function functionParameterNames(ev: EventRecord): string[] {
  return functionParameterRecords(ev)
    .map(p => p.name)
    .filter((n): n is string => typeof n === 'string')
    .map(n => n.toLowerCase());
}

/** True when `event` is, or holds among its sub-events, a function block or an event variable. */
export function definesFunctionsOrVariables(event: object): boolean {
  const stack: Array<{ ev: unknown; depth: number }> = [{ ev: event, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { ev, depth } = stack.pop()!;
    if (!isRecord(ev) || depth > MAX_DEPTH || ++nodes > MAX_NODES) continue;
    if (ev.eventType === 'function-block' || ev.eventType === 'variable') return true;
    for (const child of childList(ev)) stack.push({ ev: child, depth: depth + 1 });
  }
  return false;
}

// ─── Walking conditions and actions with their scope ─────────

/** A condition or action, where it stands and what is in scope there. */
interface AceSite {
  sheet: string;
  /** Path of the condition/action, e.g. "group:Title > block > action:0" */
  path: string;
  /** SID of the event that holds the condition/action */
  sid?: number;
  ace: EventRecord;
  kind: 'condition' | 'action';
  /** Lower-cased parameters of the function blocks enclosing it */
  params: string[];
  /** The parameter records of the function and custom action blocks enclosing it, outermost first */
  paramDecls: EventRecord[];
  /** Lists of the events enclosing it, below the top level: their variables are local variables in scope */
  localScopes: unknown[][];
}

/**
 * Visit every condition and action of `sheets`, except those of the events in
 * `skip` (and below them). Returns the limit that stopped the walk, or
 * undefined when it reached everything (the event limit when both stopped it).
 */
function walkAces(sheets: ReadonlyMap<string, unknown>, skip: ReadonlySet<object>, visit: (site: AceSite) => void): ReferenceCheckLimit | undefined {
  interface Frame {
    list: unknown[];
    scopes: unknown[][];
    params: string[];
    paramDecls: EventRecord[];
    path: string;
    depth: number;
  }
  let stopped: ReferenceCheckLimit | undefined;
  let nodes = 0;
  for (const [sheet, events] of sheets) {
    if (!Array.isArray(events)) continue;
    const stack: Frame[] = [{ list: events, scopes: [], params: [], paramDecls: [], path: '', depth: 0 }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.depth > MAX_DEPTH) {
        stopped ??= 'depth';
        continue;
      }
      // Variables beside an event are local unless the list is a sheet's top level (globals)
      const localScopes = frame.depth === 0 ? frame.scopes : [...frame.scopes, frame.list];
      for (const ev of frame.list) {
        if (++nodes > MAX_NODES) {
          stopped = 'events';
          break;
        }
        if (!isRecord(ev) || skip.has(ev)) continue;
        const declaresParameters = ev.eventType === 'function-block' || ev.eventType === 'custom-ace-block';
        const params = declaresParameters ? [...frame.params, ...functionParameterNames(ev)] : frame.params;
        const paramDecls = declaresParameters ? [...frame.paramDecls, ...functionParameterRecords(ev)] : frame.paramDecls;
        const segment = ev.eventType === 'function-block'
          ? `function:${String(ev.functionName ?? 'unknown')}`
          : ev.eventType === 'custom-ace-block'
            ? `custom-action:${String(ev.objectClass ?? 'unknown')}.${String(ev.aceName ?? 'unknown')}`
            : ev.eventType === 'group' ? `group:${String(ev.title ?? '')}` : 'block';
        const path = frame.path ? `${frame.path} > ${segment}` : segment;
        const sid = typeof ev.sid === 'number' ? ev.sid : undefined;
        for (const kind of ['condition', 'action'] as const) {
          const aces = kind === 'condition' ? ev.conditions : ev.actions;
          if (!Array.isArray(aces)) continue;
          aces.forEach((ace, i) => {
            if (!isRecord(ace)) return;
            visit({ sheet, path: `${path} > ${kind}:${i}`, ...(sid !== undefined ? { sid } : {}), ace, kind, params, paramDecls, localScopes });
          });
        }
        const children = childList(ev);
        if (children.length > 0) {
          stack.push({ list: children, scopes: localScopes, params, paramDecls, path, depth: frame.depth + 1 });
        }
      }
    }
  }
  return stopped;
}

/**
 * The event variable names a condition or action uses (as written): the
 * "variable" parameter of a System event variable ACE, and the identifiers of
 * its expressions, every string parameter but those that hold a name
 * (NAME_PARAMETER_KEYS). `mentions` is a cheap test of a whole parameter value
 * before it is tokenized.
 */
function variableNamesUsedBy(
  ace: EventRecord,
  kind: 'condition' | 'action',
  mentions: (value: string) => boolean,
): Array<{ name: string; kind: 'event-variable' | 'variable-expression' }> {
  const uses: Array<{ name: string; kind: 'event-variable' | 'variable-expression' }> = [];
  const variableAce = ace.objectClass === 'System' && typeof ace.id === 'string'
    && EVENT_VARIABLE_ACE_IDS.has(`${kind}:${ace.id}`);
  if (variableAce) {
    const variable = isRecord(ace.parameters) ? ace.parameters.variable : undefined;
    if (typeof variable === 'string') uses.push({ name: variable, kind: 'event-variable' });
  }
  // Uses by name in expressions: every string parameter but the names
  const params = ace.parameters;
  const entries: Array<[string | undefined, unknown]> = Array.isArray(params)
    ? params.map(value => [undefined, value])
    : isRecord(params) ? Object.entries(params) : [];
  for (const [paramKey, value] of entries) {
    if (typeof value !== 'string' || !mentions(value)) continue;
    if (paramKey !== undefined && (NAME_PARAMETER_KEYS.has(paramKey) || (variableAce && paramKey === 'variable'))) continue;
    for (const name of findExpressionIdentifiers(value)) uses.push({ name, kind: 'variable-expression' });
  }
  return uses;
}

/** Cheap test before an expression is tokenized: does it contain one of `keys` (lower-cased) at all? */
function mentionsAny(keys: readonly string[]): (value: string) => boolean {
  return value => {
    const lower = value.toLowerCase();
    return keys.some(key => lower.includes(key));
  };
}

/**
 * True when an event variable named `key` (lower-cased) is in scope at
 * `site`: a parameter of an enclosing function, a variable in one of its
 * local scopes (except those `gone` says are removed) or a global variable
 * (`globals`, lower-cased).
 */
function variableInScope(
  key: string,
  site: AceSite,
  globals: ReadonlySet<string>,
  gone: (variable: EventRecord) => boolean = () => false,
): boolean {
  if (site.params.includes(key) || globals.has(key)) return true;
  return site.localScopes.some(list => list.some(v =>
    isRecord(v) && v.eventType === 'variable' && typeof v.name === 'string' && v.name.toLowerCase() === key && !gone(v)));
}

/** Lower-cased names of the variables at the top level of `sheets` (the global variables), except those in `skip`. */
export function globalVariableNames(sheets: ReadonlyMap<string, unknown>, skip: ReadonlySet<object> = new Set()): Set<string> {
  const names = new Set<string>();
  for (const events of sheets.values()) {
    if (!Array.isArray(events)) continue;
    for (const ev of events) {
      if (isRecord(ev) && ev.eventType === 'variable' && typeof ev.name === 'string' && !skip.has(ev)) {
        names.add(ev.name.toLowerCase());
      }
    }
  }
  return names;
}

function addReference(map: Map<string, DeleteReference[]>, key: string, ref: DeleteReference): void {
  const list = map.get(key) ?? [];
  list.push(ref);
  map.set(key, list);
}

function referenceAt(site: AceSite, kind: DeleteReferenceKind): DeleteReference {
  return { kind, sheet: site.sheet, path: site.path, ...(site.sid !== undefined ? { sid: site.sid } : {}) };
}

// ─── Deletes ─────────────────────────────────────────────────

/**
 * References the delete of `deleted` (an event object in one of `sheets`,
 * with all its sub-events, or several such events, e.g. every top-level event
 * of a sheet that is deleted) would leave unresolved. `sheets` maps each event
 * sheet name to its events; the sheet holding `deleted` must be the same
 * object tree. `functionsName` is the project's name for the built-in
 * Functions object (project.c3proj "functionsName").
 */
export function findReferencesLeftByDelete(
  sheets: ReadonlyMap<string, unknown>,
  deleted: object | readonly object[],
  functionsName: string,
): DeleteReferenceReport {
  const report: DeleteReferenceReport = { functions: [], variables: [], complete: true };

  // ── The deleted subtrees and the functions/variables they define ──
  const removed = new Set<object>();
  const deletedFunctions = new Map<string, string>();
  const deletedVariables = new Map<string, string>();
  const roots: readonly object[] = Array.isArray(deleted) ? deleted : [deleted as object];
  const subtree: Array<{ ev: unknown; depth: number }> = roots.map(ev => ({ ev, depth: 0 }));
  while (subtree.length > 0) {
    const { ev, depth } = subtree.pop()!;
    if (!isRecord(ev) || depth > MAX_DEPTH || removed.has(ev)) continue;
    removed.add(ev);
    if (removed.size > MAX_NODES) {
      report.complete = false;
      report.limit = 'events';
      break;
    }
    if (ev.eventType === 'function-block' && typeof ev.functionName === 'string') {
      deletedFunctions.set(ev.functionName.toLowerCase(), ev.functionName);
    } else if (ev.eventType === 'variable' && typeof ev.name === 'string') {
      deletedVariables.set(ev.name.toLowerCase(), ev.name);
    }
    for (const child of childList(ev)) subtree.push({ ev: child, depth: depth + 1 });
  }
  if (deletedFunctions.size === 0 && deletedVariables.size === 0) return report;

  // ── Function blocks and global variables, before and after the delete ──
  const functionsBefore = new Set<string>();
  const functionsAfter = new Set<string>();
  const globalsBefore = globalVariableNames(sheets);
  const globalsAfter = globalVariableNames(sheets, removed);
  let nodes = 0;
  for (const events of sheets.values()) {
    if (!Array.isArray(events)) continue;
    const stack: Array<{ list: unknown[]; depth: number }> = [{ list: events, depth: 0 }];
    while (stack.length > 0) {
      const { list, depth } = stack.pop()!;
      if (depth > MAX_DEPTH) continue;
      for (const ev of list) {
        if (++nodes > MAX_NODES) {
          report.complete = false;
          report.limit = 'events';
          break;
        }
        if (!isRecord(ev)) continue;
        if (ev.eventType === 'function-block' && typeof ev.functionName === 'string') {
          functionsBefore.add(ev.functionName.toLowerCase());
          if (!removed.has(ev)) functionsAfter.add(ev.functionName.toLowerCase());
        }
        stack.push({ list: childList(ev), depth: depth + 1 });
      }
    }
  }

  // ── References outside the deleted subtrees ──
  const functionRefs = new Map<string, DeleteReference[]>();
  const variableRefs = new Map<string, DeleteReference[]>();
  const functionLost = (name: string) => {
    const key = name.toLowerCase();
    return deletedFunctions.has(key) && functionsBefore.has(key) && !functionsAfter.has(key) ? key : undefined;
  };
  const mentionsDeletedVariable = mentionsAny([...deletedVariables.keys()]);
  const gone = (v: EventRecord) => removed.has(v);

  const stopped = walkAces(sheets, removed, site => {
    const { ace } = site;
    if (deletedFunctions.size > 0) {
      const called = typeof ace.callFunction === 'string' ? functionLost(ace.callFunction) : undefined;
      if (called) addReference(functionRefs, called, referenceAt(site, 'callFunction'));
      const mapped = mappedFunctionName(ace, functionsName);
      const mappedKey = mapped !== undefined ? functionLost(mapped) : undefined;
      if (mappedKey) addReference(functionRefs, mappedKey, referenceAt(site, 'function-map'));
      for (const value of parameterValues(ace)) {
        if (typeof value !== 'string') continue;
        for (const call of findExpressionCalls(value, functionsName)) {
          const key = functionLost(call.name);
          if (key) addReference(functionRefs, key, referenceAt(site, 'expression'));
        }
      }
    }
    if (deletedVariables.size > 0) {
      for (const use of variableNamesUsedBy(ace, site.kind, mentionsDeletedVariable)) {
        const key = use.name.toLowerCase();
        if (!deletedVariables.has(key)) continue;
        const before = variableInScope(key, site, globalsBefore);
        const after = variableInScope(key, site, globalsAfter, gone);
        if (before && !after) addReference(variableRefs, key, referenceAt(site, use.kind));
      }
    }
  });
  if (stopped) {
    report.complete = false;
    report.limit ??= stopped;
  }

  for (const [key, references] of functionRefs) report.functions.push({ name: deletedFunctions.get(key)!, references });
  for (const [key, references] of variableRefs) report.variables.push({ name: deletedVariables.get(key)!, references });
  return report;
}

/** A use of a function by name, with the stored condition or action, so a tool can rewrite a call or a function map in place. */
export interface FunctionReference extends DeleteReference {
  ace: Record<string, unknown>;
}

/**
 * Every use of the function `name` in `sheets` (sheet name to events),
 * matched ignoring case as the editor looks functions up: Call function
 * actions ("callFunction"), function map registrations of the Functions
 * object (`functionsName`), and Functions.Name(...) calls in expressions.
 * The walk and its limits are those of findReferencesLeftByDelete; `limit`
 * names the limit that stopped it, when one did.
 */
export function findFunctionReferences(
  sheets: ReadonlyMap<string, unknown>,
  name: string,
  functionsName: string,
): { references: FunctionReference[]; complete: boolean; limit?: ReferenceCheckLimit } {
  const key = name.toLowerCase();
  const references: FunctionReference[] = [];
  const stopped = walkAces(sheets, new Set(), site => {
    const { ace } = site;
    // A script or comment row is no call (index-builder's rule for call sites)
    if (ace.type === 'script' || ace.type === 'comment') return;
    if (typeof ace.callFunction === 'string' && ace.callFunction.toLowerCase() === key) {
      references.push({ ...referenceAt(site, 'callFunction'), ace });
    }
    const mapped = mappedFunctionName(ace, functionsName);
    if (mapped !== undefined && mapped.toLowerCase() === key) references.push({ ...referenceAt(site, 'function-map'), ace });
    for (const value of parameterValues(ace)) {
      if (typeof value !== 'string') continue;
      if (findExpressionCalls(value, functionsName).some(call => call.name.toLowerCase() === key)) {
        references.push({ ...referenceAt(site, 'expression'), ace });
        break;
      }
    }
  });
  return { references, complete: stopped === undefined, ...(stopped !== undefined ? { limit: stopped } : {}) };
}

// ─── Moves ───────────────────────────────────────────────────

/**
 * Where the uses of some event variables resolve before a change, per
 * condition/action (compared by identity): recorded by recordVariableScopes()
 * before the change, checked by findVariableReferencesLostByChange() after it.
 */
export interface VariableScopeRecord {
  /** Lower-cased name → the name as declared */
  variables: ReadonlyMap<string, string>;
  /** Condition/action → the lower-cased names it uses that resolved there */
  resolved: Map<object, Set<string>>;
  complete: boolean;
  /** The limit that stopped the recording, when it did */
  limit?: ReferenceCheckLimit;
}

/** Lower-cased name → name of the event variables declared in `events` or below them. */
export function variablesDeclaredIn(events: readonly object[]): Map<string, string> {
  const names = new Map<string, string>();
  const stack: Array<{ ev: unknown; depth: number }> = events.map(ev => ({ ev, depth: 0 }));
  let nodes = 0;
  while (stack.length > 0) {
    const { ev, depth } = stack.pop()!;
    if (!isRecord(ev) || depth > MAX_DEPTH || ++nodes > MAX_NODES) continue;
    if (ev.eventType === 'variable' && typeof ev.name === 'string' && !names.has(ev.name.toLowerCase())) {
      names.set(ev.name.toLowerCase(), ev.name);
    }
    for (const child of childList(ev)) stack.push({ ev: child, depth: depth + 1 });
  }
  return names;
}

/**
 * Record, before a change, which uses of `variables` (lower-cased name →
 * name) in `sheets` resolve: the System event variable ACEs and expressions
 * that findReferencesLeftByDelete looks at, with the same scope rules.
 */
export function recordVariableScopes(
  sheets: ReadonlyMap<string, unknown>,
  variables: ReadonlyMap<string, string>,
): VariableScopeRecord {
  const record: VariableScopeRecord = { variables, resolved: new Map(), complete: true };
  if (variables.size === 0) return record;
  const globals = globalVariableNames(sheets);
  const mentions = mentionsAny([...variables.keys()]);
  const stopped = walkAces(sheets, new Set(), site => {
    for (const use of variableNamesUsedBy(site.ace, site.kind, mentions)) {
      const key = use.name.toLowerCase();
      if (!variables.has(key) || !variableInScope(key, site, globals)) continue;
      const names = record.resolved.get(site.ace) ?? new Set<string>();
      names.add(key);
      record.resolved.set(site.ace, names);
    }
  });
  if (stopped) {
    record.complete = false;
    record.limit = stopped;
  }
  return record;
}

/**
 * The uses of the recorded variables that resolved before a change and no
 * longer resolve in `sheets` after it, e.g. the users of a global variable
 * that a move put into a group, where it is a local variable. Conditions and
 * actions are compared by identity; `originalOf` maps a copied condition or
 * action (in copied events) to the one it was copied from. Reported like the
 * variables of findReferencesLeftByDelete; `functions` stays empty, since a
 * moved or copied function block is still visible in every sheet.
 */
export function findVariableReferencesLostByChange(
  before: VariableScopeRecord,
  sheets: ReadonlyMap<string, unknown>,
  originalOf: (ace: object) => object = ace => ace,
): DeleteReferenceReport {
  const report: DeleteReferenceReport = { functions: [], variables: [], complete: before.complete, ...(before.limit ? { limit: before.limit } : {}) };
  if (before.resolved.size === 0) return report;
  const globals = globalVariableNames(sheets);
  const mentions = mentionsAny([...before.variables.keys()]);
  const refs = new Map<string, DeleteReference[]>();
  const stopped = walkAces(sheets, new Set(), site => {
    const resolvedBefore = before.resolved.get(originalOf(site.ace));
    if (!resolvedBefore) return;
    for (const use of variableNamesUsedBy(site.ace, site.kind, mentions)) {
      const key = use.name.toLowerCase();
      if (!resolvedBefore.has(key) || variableInScope(key, site, globals)) continue;
      addReference(refs, key, referenceAt(site, use.kind));
    }
  });
  if (stopped) {
    report.complete = false;
    report.limit ??= stopped;
  }
  for (const [key, references] of refs) report.variables.push({ name: before.variables.get(key)!, references });
  return report;
}

/** What a use that now finds another declaration of its name does, for the tools' messages. */
export const REBOUND_USE_CONSEQUENCE =
  'A use that now finds another event variable or function parameter of that name reads or sets that one instead: ' +
  'the use still resolves, and the events do something else.';

/**
 * The declaration each use of some event variables and function parameters
 * finds before a change (a variable event or a parameter record, compared
 * by identity), per condition/action: recorded by recordVariableBindings()
 * before the change and compared by findVariableBindingChanges() after it.
 */
export interface VariableBindingRecord {
  /** Lower-cased name -> the name as declared */
  variables: ReadonlyMap<string, string>;
  /** Condition/action -> lower-cased name -> the declaration it found */
  bindings: Map<object, Map<string, object>>;
  complete: boolean;
  /** The limit that stopped the recording, when it did */
  limit?: ReferenceCheckLimit;
}

/** The uses whose declaration is gone (`lost`) and those that now find another one (`rebound`). */
export interface VariableBindingChanges {
  lost: DeleteReferenceReport;
  rebound: DeleteReferenceReport;
}

/** Lower-cased name -> the global variable of that name, the first in sheet order. */
function globalVariableDeclarations(sheets: ReadonlyMap<string, unknown>): Map<string, EventRecord> {
  const found = new Map<string, EventRecord>();
  for (const events of sheets.values()) {
    if (!Array.isArray(events)) continue;
    for (const ev of events) {
      if (isRecord(ev) && ev.eventType === 'variable' && typeof ev.name === 'string' && !found.has(ev.name.toLowerCase())) {
        found.set(ev.name.toLowerCase(), ev);
      }
    }
  }
  return found;
}

/**
 * The declaration a use of `key` at `site` finds: a variable of the
 * innermost local scope that has one, else a parameter of the innermost
 * enclosing function or custom action that has one, else a global
 * variable. Where a project has a local variable and a parameter of one name
 * in scope, the local variable is taken.
 */
function declarationOf(key: string, site: AceSite, globals: ReadonlyMap<string, EventRecord>): object | undefined {
  for (let i = site.localScopes.length - 1; i >= 0; i--) {
    const local = site.localScopes[i].find(v =>
      isRecord(v) && v.eventType === 'variable' && typeof v.name === 'string' && v.name.toLowerCase() === key);
    if (local !== undefined) return local as object;
  }
  for (let i = site.paramDecls.length - 1; i >= 0; i--) {
    const name = site.paramDecls[i].name;
    if (typeof name === 'string' && name.toLowerCase() === key) return site.paramDecls[i];
  }
  return globals.get(key);
}

/** Record, before a change, the declaration each use of `variables` (lower-cased name -> name) in `sheets` finds. */
export function recordVariableBindings(
  sheets: ReadonlyMap<string, unknown>,
  variables: ReadonlyMap<string, string>,
): VariableBindingRecord {
  const record: VariableBindingRecord = { variables, bindings: new Map(), complete: true };
  if (variables.size === 0) return record;
  const globals = globalVariableDeclarations(sheets);
  const mentions = mentionsAny([...variables.keys()]);
  const stopped = walkAces(sheets, new Set(), site => {
    for (const use of variableNamesUsedBy(site.ace, site.kind, mentions)) {
      const key = use.name.toLowerCase();
      if (!variables.has(key)) continue;
      const declaration = declarationOf(key, site, globals);
      if (declaration === undefined) continue;
      const found = record.bindings.get(site.ace) ?? new Map<string, object>();
      found.set(key, declaration);
      record.bindings.set(site.ace, found);
    }
  });
  if (stopped) {
    record.complete = false;
    record.limit = stopped;
  }
  return record;
}

/**
 * The recorded uses that, after a change, find no declaration (`lost`) or
 * another one (`rebound`). Conditions and actions are compared by
 * identity; `originalOf` maps a copied condition or action to the one it
 * was copied from. A declaration that moved keeps its identity, so a use
 * that moved with it stays bound.
 */
export function findVariableBindingChanges(
  before: VariableBindingRecord,
  sheets: ReadonlyMap<string, unknown>,
  originalOf: (ace: object) => object = ace => ace,
): VariableBindingChanges {
  const limit = before.limit ? { limit: before.limit } : {};
  const lost: DeleteReferenceReport = { functions: [], variables: [], complete: before.complete, ...limit };
  const rebound: DeleteReferenceReport = { functions: [], variables: [], complete: before.complete, ...limit };
  if (before.bindings.size === 0) return { lost, rebound };
  const globals = globalVariableDeclarations(sheets);
  const mentions = mentionsAny([...before.variables.keys()]);
  const lostRefs = new Map<string, DeleteReference[]>();
  const reboundRefs = new Map<string, DeleteReference[]>();
  const stopped = walkAces(sheets, new Set(), site => {
    const found = before.bindings.get(originalOf(site.ace));
    if (!found) return;
    for (const use of variableNamesUsedBy(site.ace, site.kind, mentions)) {
      const key = use.name.toLowerCase();
      const declaration = found.get(key);
      if (declaration === undefined) continue;
      const now = declarationOf(key, site, globals);
      if (now === undefined) addReference(lostRefs, key, referenceAt(site, use.kind));
      else if (now !== declaration) addReference(reboundRefs, key, referenceAt(site, use.kind));
    }
  });
  if (stopped) {
    lost.complete = false;
    rebound.complete = false;
    lost.limit ??= stopped;
    rebound.limit ??= stopped;
  }
  for (const [key, references] of lostRefs) lost.variables.push({ name: before.variables.get(key)!, references });
  for (const [key, references] of reboundRefs) rebound.variables.push({ name: before.variables.get(key)!, references });
  return { lost, rebound };
}

/**
 * Map each condition and action of `copies[i]` (and of its sub-events) to
 * the one at the same place in `originals[i]`, for events copied as a deep
 * clone.
 */
export function mapCopiedAces(originals: readonly object[], copies: readonly object[]): Map<object, object> {
  const map = new Map<object, object>();
  const stack: Array<{ a: unknown; b: unknown; depth: number }> = copies.map((b, i) => ({ a: originals[i], b, depth: 0 }));
  let nodes = 0;
  while (stack.length > 0) {
    const { a, b, depth } = stack.pop()!;
    if (!isRecord(a) || !isRecord(b) || depth > MAX_DEPTH || ++nodes > MAX_NODES) continue;
    for (const key of ['conditions', 'actions'] as const) {
      const listA = a[key];
      const listB = b[key];
      if (!Array.isArray(listA) || !Array.isArray(listB)) continue;
      listB.forEach((ace, i) => {
        if (isRecord(ace) && isRecord(listA[i])) map.set(ace, listA[i] as object);
      });
    }
    const childrenA = childList(a);
    childList(b).forEach((child, i) => stack.push({ a: childrenA[i], b: child, depth: depth + 1 }));
  }
  return map;
}

/**
 * The names other event sheets can use of what deleting `event` removes: the
 * functions it holds (function blocks are visible in every sheet) and, when
 * `event` is a variable at the top level of its sheet (`topLevel`), that
 * global variable. Variables in groups, blocks and function blocks are local
 * to their sheet. delete_event_from_sheet searches event sheets it could not
 * parse for these names (issue #55).
 */
export function namesVisibleToOtherSheets(event: object, topLevel: boolean): string[] {
  const names = new Set<string>();
  if (topLevel && isRecord(event) && event.eventType === 'variable' && typeof event.name === 'string') {
    names.add(event.name);
  }
  const stack: Array<{ ev: unknown; depth: number }> = [{ ev: event, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { ev, depth } = stack.pop()!;
    if (!isRecord(ev) || depth > MAX_DEPTH || ++nodes > MAX_NODES) continue;
    if (ev.eventType === 'function-block' && typeof ev.functionName === 'string') names.add(ev.functionName);
    for (const child of childList(ev)) stack.push({ ev: child, depth: depth + 1 });
  }
  return [...names];
}

/** Number of references in a report. */
export function countDeleteReferences(report: DeleteReferenceReport): number {
  return [...report.functions, ...report.variables].reduce((n, entry) => n + entry.references.length, 0);
}
