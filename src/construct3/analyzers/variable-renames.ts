/**
 * The uses of one event variable a rename points at the new name, and
 * those it cannot.
 *
 * A use belongs to the variable when its lookup finds this declaration
 * (declarationOf in delete-references.ts: the innermost local scope, then
 * the parameters of the enclosing function or custom action, then the
 * globals), so a local of the same name in another group, one that hides a
 * global, and a parameter keep their uses.
 *
 * What a rename may change depends on what each parameter holds, which the
 * server knows only for some parameters (parameterSlots):
 * - the "variable" parameter of the System event variable conditions and
 *   actions (EVENT_VARIABLE_ACE_IDS) holds the variable's name itself;
 * - the arguments of function and custom action calls are expressions;
 * - the parameters of System conditions and actions that hold a name
 *   (NAME_PARAMETER_KEYS) are never a use, except the "layout" of the two
 *   by-name layout actions, which is an expression.
 * Any other string parameter may be an expression, a combo choice or a name
 * of another kind (a group, a timeline): the server has no parameter types
 * for plugin, behavior or System conditions and actions. Such a parameter
 * whose names include the variable is listed as a use the rename does not
 * update, and is never changed; so is a value under a name key of a plugin
 * or behavior ACE that names the variable (an addon's ACE may keep an
 * expression there). So is a call argument with a backtick outside its
 * string literals (text the expression tokenizer does not read as code),
 * every call argument naming a variable whose name starts with a digit
 * (the tokenizer reads that as a number), and every call argument use when
 * the new name starts with a digit (the rewritten use could not be read
 * back). Script text that reads the variable (runtime.globalVars.Name,
 * localVars.Name, an access split over lines included) is listed the same
 * way: script text is not parsed.
 */

import {
  childList,
  declarationOf,
  EVENT_VARIABLE_ACE_IDS,
  functionParameterRecords,
  globalVariableDeclarations,
  isRecord,
  mentionsAny,
  NAME_PARAMETER_KEYS,
  referenceAt,
  REFERENCE_CHECK_MAX_DEPTH,
  REFERENCE_CHECK_MAX_EVENTS,
  variableNamesUsedBy,
  walkAces,
  type AceSite,
  type DeleteReference,
  type EventRecord,
  type ReferenceCheckLimit,
} from './delete-references.js';
import { c3StringEnd, findExpressionIdentifiers, renameExpressionIdentifier, toScriptLines } from '../event-shapes.js';

// ─── Parameters ──────────────────────────────────────────────

/**
 * System actions that keep an expression (type string) under a name key:
 * "layout" of Go to layout (by name) and Load layout images (by name), as
 * the editor's System definitions give them.
 */
const SYSTEM_EXPRESSION_NAME_KEYS: ReadonlySet<string> = new Set([
  'action:go-to-layout-by-name:layout',
  'action:load-layout-images-by-name:layout',
]);

/**
 * What a string parameter of a condition or action holds, as far as the
 * server can tell: the name of an event variable, an expression (a call
 * argument), a name that is never a variable use, or something it cannot
 * tell.
 */
export type ParameterSlotKind = 'variable-name' | 'call-argument' | 'name' | 'unclassified';

/** One string parameter of a condition or action. */
export interface ParameterSlot {
  /** The parameter's key, or its position in a call's argument list */
  parameter: string | number;
  value: string;
  kind: ParameterSlotKind;
  /** Replace the parameter's value in the condition or action */
  set: (text: string) => void;
}

/**
 * The string parameters of one condition or action, classified (see the
 * module comment): the parameters variableNamesUsedBy reads, plus the name
 * parameters it skips.
 */
export function parameterSlots(ace: EventRecord, kind: 'condition' | 'action'): ParameterSlot[] {
  const slots: ParameterSlot[] = [];
  const params = ace.parameters;
  const variableAce = ace.objectClass === 'System' && typeof ace.id === 'string'
    && EVENT_VARIABLE_ACE_IDS.has(`${kind}:${ace.id}`);
  if (variableAce && isRecord(params) && typeof params.variable === 'string') {
    slots.push({ parameter: 'variable', value: params.variable, kind: 'variable-name', set: text => { params.variable = text; } });
  }
  const call = typeof ace.callFunction === 'string' || typeof ace.customAction === 'string';
  if (Array.isArray(params)) {
    params.forEach((value, i) => {
      if (typeof value !== 'string') return;
      slots.push({ parameter: i, value, kind: call ? 'call-argument' : 'unclassified', set: text => { params[i] = text; } });
    });
  } else if (isRecord(params)) {
    const system = ace.objectClass === 'System';
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== 'string' || (variableAce && key === 'variable')) continue;
      const expressionKey = system && SYSTEM_EXPRESSION_NAME_KEYS.has(`${kind}:${String(ace.id)}:${key}`);
      const slotKind: ParameterSlotKind = NAME_PARAMETER_KEYS.has(key) && !expressionKey ? 'name' : 'unclassified';
      slots.push({ parameter: key, value, kind: slotKind, set: text => { params[key] = text; } });
    }
  }
  return slots;
}

/** True when `value` has a backtick outside its string literals. */
function hasBacktickOutsideStrings(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"') {
      const end = c3StringEnd(value, i);
      if (end === -1) return false;
      i = end;
    } else if (value[i] === '`') {
      return true;
    }
  }
  return false;
}

// ─── Uses ────────────────────────────────────────────────────

/** A use a rename points at the new name. */
export interface VariableUse extends DeleteReference {
  /** The parameter's key, or its position in a call's argument list */
  parameter: string | number;
  /** The parameter's text before the rename */
  value: string;
  /** Point this use at `newName`, in memory */
  apply: (newName: string) => void;
}

/**
 * Why a use keeps the old name: a parameter whose type the server does not
 * know, a plugin's or behavior's name parameter whose value names the
 * variable, a call argument with a backtick, a variable whose name starts
 * with a digit, a new name that starts with a digit, a script line.
 */
export type UseNotUpdatedReason =
  'parameter-type-unknown' | 'name-parameter' | 'template-text' | 'number-like-name' | 'number-like-new-name' | 'script';

/** A use a rename leaves naming the old name. */
export interface UseNotUpdated {
  sheet: string;
  /** Path of the condition or action (of the event, for a script line) */
  path: string;
  sid?: number;
  /** The parameter's key or position; none for a script line */
  parameter?: string | number;
  /** The parameter's text, or the script line */
  value: string;
  reason: UseNotUpdatedReason;
}

/** The uses of one variable, found before any change. */
export interface VariableUseReport {
  uses: VariableUse[];
  notUpdated: UseNotUpdated[];
  /** Uses of the new name that find no declaration now and would find the variable once it has that name */
  captured: DeleteReference[];
  /** False when a traversal limit stopped the walk */
  complete: boolean;
  limit?: ReferenceCheckLimit;
}

/** The use or the use left behind that one parameter holds, at a site whose lookup of `key` finds the variable. */
function slotUse(
  site: AceSite, slot: ParameterSlot, key: string, numberLike: boolean, newNumberLike: boolean,
): { use?: VariableUse; notUpdated?: UseNotUpdated } {
  const where = referenceAt(site, slot.kind === 'variable-name' ? 'event-variable' : 'variable-expression');
  const left = (reason: UseNotUpdatedReason): { notUpdated: UseNotUpdated } => ({
    notUpdated: { sheet: site.sheet, path: site.path, ...(site.sid !== undefined ? { sid: site.sid } : {}), parameter: slot.parameter, value: slot.value, reason },
  });
  const mentioned = slot.value.toLowerCase().includes(key);
  const named = findExpressionIdentifiers(slot.value).includes(key) || slot.value.toLowerCase() === key;
  switch (slot.kind) {
    case 'name':
      // A name in a System ACE; in a plugin's or behavior's ACE, the server cannot tell
      return site.ace.objectClass !== 'System' && named ? left('name-parameter') : {};
    case 'variable-name':
      return slot.value.toLowerCase() === key
        ? { use: { ...where, parameter: slot.parameter, value: slot.value, apply: newName => slot.set(newName) } }
        : {};
    case 'call-argument':
      if (numberLike && mentioned) return left('number-like-name');
      if (hasBacktickOutsideStrings(slot.value) && mentioned) return left('template-text');
      if (!findExpressionIdentifiers(slot.value).includes(key)) return {};
      // The rewritten name would read as a number, so the use could not be found again
      if (newNumberLike) return left('number-like-new-name');
      return { use: { ...where, parameter: slot.parameter, value: slot.value, apply: newName => slot.set(renameExpressionIdentifier(slot.value, key, newName).text) } };
    case 'unclassified':
      return findExpressionIdentifiers(slot.value).includes(key) || (numberLike && mentioned) ? left('parameter-type-unknown') : {};
  }
}

/**
 * The uses of the event variable `variable` (a variable event of
 * `sheets`, compared by identity) that find it, by the lookup of the
 * reference checks (declarationOf), split into those a rename can point at
 * `newName` and those it leaves (see the module comment); and the uses of
 * `newName` the rename would capture. Changes nothing: each use's `apply`
 * makes its change.
 */
export function findVariableUses(sheets: ReadonlyMap<string, unknown>, variable: object, newName: string): VariableUseReport {
  const report: VariableUseReport = { uses: [], notUpdated: [], captured: [], complete: true };
  if (!isRecord(variable) || typeof variable.name !== 'string') return report;
  const key = variable.name.toLowerCase();
  const newKey = newName.toLowerCase();
  const numberLike = /^[0-9]/.test(key);
  const newNumberLike = /^[0-9]/.test(newKey);
  const globals = globalVariableDeclarations(sheets);
  const isGlobal = [...sheets.values()].some(events => Array.isArray(events) && events.includes(variable));
  const mentionsNew = mentionsAny([newKey]);
  const stopped = walkAces(sheets, new Set(), site => {
    const slots = parameterSlots(site.ace, site.kind);
    // Name slots too: a plugin's name parameter that names the variable is listed
    if (slots.some(s => s.value.toLowerCase().includes(key)) && declarationOf(key, site, globals) === variable) {
      for (const slot of slots) {
        const found = slotUse(site, slot, key, numberLike, newNumberLike);
        if (found.use) report.uses.push(found.use);
        if (found.notUpdated) report.notUpdated.push(found.notUpdated);
      }
    }
    if (newKey === key || declarationOf(newKey, site, globals) !== undefined) return;
    if (!isGlobal && !site.localScopes.some(list => list.includes(variable))) return;
    for (const use of variableNamesUsedBy(site.ace, site.kind, mentionsNew)) {
      if (use.name.toLowerCase() === newKey) report.captured.push(referenceAt(site, use.kind));
    }
  });
  if (stopped) {
    report.complete = false;
    report.limit = stopped;
  }
  return report;
}

// ─── Script lines ────────────────────────────────────────────

/** A script line in an event sheet that reads an event variable by name. */
export interface ScriptVariableRead {
  sheet: string;
  /** Path of the event that holds the script, in the uses' path format */
  path: string;
  sid?: number;
  line: string;
}

/** `name` as a regular expression that matches it literally. */
function escapeRegExp(name: string): string {
  return name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Every read of `<holder>.<name>`, `<holder>?.<name>` or `<holder>["<name>"]`,
 * ignoring case; whitespace (line breaks included) may separate the parts.
 * Global: run it on a whole script with matchAll.
 */
function scriptReadPattern(holder: 'globalVars' | 'localVars', name: string): RegExp {
  const n = escapeRegExp(name);
  const lead = `(?<![\\p{L}\\p{N}_$])${holder}\\s*`;
  return new RegExp(`${lead}\\??\\.\\s*${n}(?![\\p{L}\\p{N}_$])|${lead}(?:\\?\\.)?\\s*\\[\\s*(["'\`])${n}\\1\\s*\\]`, 'giu');
}

/**
 * The lines of a script that hold a read `pattern` finds, the whole
 * script searched at once (an access may be split over lines): one entry
 * per distinct text, the lines it spans joined with "\n".
 */
function scriptReadLines(lines: readonly string[], pattern: RegExp): string[] {
  const source = lines.join('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (index: number) => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > index) i--;
    return i;
  };
  const found = new Set<string>();
  for (const match of source.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const first = lineAt(match.index);
    const last = lineAt(match.index + match[0].length - 1);
    found.add(lines.slice(first, last + 1).join('\n'));
  }
  return [...found];
}

/**
 * The script lines of script actions and script events in `sheets` (one
 * entry per line, or the older shape: one string) that read `variable`
 * by name: for a global, `globalVars.<name>` in every scope (the global is
 * reached that way from anywhere); for a local, `localVars.<name>` where
 * the lookup of the reference checks finds this variable. Name matched
 * ignoring case. Keeps the scopes and limits walkAces keeps; `complete` is
 * false when a limit stopped it.
 */
export function variableScriptReads(
  sheets: ReadonlyMap<string, unknown>,
  variable: object,
  isGlobal: boolean,
): { reads: ScriptVariableRead[]; complete: boolean; limit?: ReferenceCheckLimit } {
  const result: { reads: ScriptVariableRead[]; complete: boolean; limit?: ReferenceCheckLimit } = { reads: [], complete: true };
  if (!isRecord(variable) || typeof variable.name !== 'string') return result;
  const key = variable.name.toLowerCase();
  const pattern = scriptReadPattern(isGlobal ? 'globalVars' : 'localVars', variable.name);
  const globals = globalVariableDeclarations(sheets);
  let nodes = 0;
  for (const [sheet, events] of sheets) {
    if (!Array.isArray(events)) continue;
    const stack: Array<{ list: unknown[]; scopes: unknown[][]; paramDecls: EventRecord[]; path: string; depth: number }> =
      [{ list: events, scopes: [], paramDecls: [], path: '', depth: 0 }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.depth > REFERENCE_CHECK_MAX_DEPTH) {
        result.complete = false;
        result.limit ??= 'depth';
        continue;
      }
      const localScopes = frame.depth === 0 ? frame.scopes : [...frame.scopes, frame.list];
      for (const ev of frame.list) {
        if (++nodes > REFERENCE_CHECK_MAX_EVENTS) {
          result.complete = false;
          result.limit = 'events';
          return result;
        }
        if (!isRecord(ev)) continue;
        const declaresParameters = ev.eventType === 'function-block' || ev.eventType === 'custom-ace-block';
        const paramDecls = declaresParameters ? [...frame.paramDecls, ...functionParameterRecords(ev)] : frame.paramDecls;
        const segment = ev.eventType === 'function-block'
          ? `function:${String(ev.functionName ?? 'unknown')}`
          : ev.eventType === 'custom-ace-block'
            ? `custom-action:${String(ev.objectClass ?? 'unknown')}.${String(ev.aceName ?? 'unknown')}`
            : ev.eventType === 'group' ? `group:${String(ev.title ?? '')}` : 'block';
        const path = frame.path ? `${frame.path} > ${segment}` : segment;
        const sid = typeof ev.sid === 'number' ? ev.sid : undefined;
        const site: AceSite = { sheet, path, ...(sid !== undefined ? { sid } : {}), ace: ev, kind: 'action', params: [], paramDecls, localScopes };
        if (isGlobal || declarationOf(key, site, globals) === variable) {
          const holders = [ev, ...(Array.isArray(ev.actions) ? ev.actions : [])];
          for (const holder of holders) {
            if (!isRecord(holder) || (holder.type !== 'script' && holder.eventType !== 'script')) continue;
            if (typeof holder.script !== 'string' && !Array.isArray(holder.script)) continue;
            const lines = toScriptLines(holder.script as string | string[]).filter((l): l is string => typeof l === 'string');
            for (const line of scriptReadLines(lines, pattern)) result.reads.push({ sheet, path, ...(sid !== undefined ? { sid } : {}), line });
          }
        }
        const children = childList(ev);
        if (children.length > 0) stack.push({ list: children, scopes: localScopes, paramDecls, path, depth: frame.depth + 1 });
      }
    }
  }
  return result;
}
