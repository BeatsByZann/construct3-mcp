/**
 * Where an object type or a family is named, for renaming one.
 *
 * Both are named in project.c3proj's project-bar tree and in their own
 * file (its "name", and the file name), and besides, as definite
 * references a rename rewrites:
 * - in event sheets: the "objectClass" of conditions and actions and of
 *   custom action blocks (their owner), the "customActionObjectClass" of a
 *   call to a family's custom action, a parameter whose whole value is the
 *   name where the reference index counts it as the object
 *   (isObjectParameterValue: object keys always, the keys that hold other
 *   names never, any other key or call argument unless an event variable
 *   or function parameter has the name), and expressions that use it as
 *   an object ("Name.member", "Name(index).member") under every key, as
 *   the index scans them;
 * - an object type also by the "type" of layout instances (layers,
 *   sub-layers, non-world instances), the "type" of its own single-global
 *   instance, the "members" of families and of project.c3proj's containers
 *   (containers.ts), and the "objectType" of timeline tracks.
 * The editor compares object class names ignoring case (names.ts), and no
 * two object types or families have names that differ only in case, so a
 * name that matches ignoring case names this one.
 *
 * Possible references, listed and never changed: "Name(...)" with no
 * member after it and a bare "Name" inside a longer expression (an event
 * variable may share the name), a whole value that is the name where an
 * event variable or function parameter has it too, the name as a string
 * literal (System "Create object (by name)", which the runtime looks up
 * ignoring case), runtime.objects.Name in a script, the initial value of
 * an event variable or function parameter that is the name, the "c" value
 * of a flowchart node that is the name (what "c" holds is not known), and
 * the "objectClass" of an object-valued "instance-variable" parameter
 * ({ name, objectClass }) unless `instanceVariableObjects` is "rewrite"
 * (Construct 3 r506-2, Free edition, guest, rewrote it on a rename).
 */

import type { C3Event, EventSheet, Layout } from './types.js';
import { nameKey } from './names.js';
import { c3StringEnd } from './event-shapes.js';
import { expressionStringLiterals } from './layer-references.js';
import { walkEventStrings } from './event-strings.js';
import { forEachLayoutInstance } from './layers.js';
import { NON_OBJECT_PARAMETER_KEYS, collectVariableNames, isObjectParameterValue, scriptObjectTokens } from './analyzers/index-builder.js';

/** What kind of place names the object type or family. */
export type ObjectNameUseKind =
  | 'objectClass' | 'custom action owner' | 'custom action family' | 'object parameter' | 'instance-variable object'
  | 'expression' | 'instance type' | 'family member'
  | 'possible expression' | 'string literal' | 'script' | 'variable value' | 'flowchart node';

/** A place that names the object type or family being renamed. */
export interface ObjectNameUse {
  category: 'eventSheets' | 'layouts' | 'families' | 'scripts' | 'flowcharts';
  /** Name of the sheet, layout, family or flowchart the use is in, or the script file's path */
  file: string;
  kind: ObjectNameUseKind;
  /** JSON path of the event ("events[3].children[1]") */
  eventPath?: string;
  /** "condition 0", "action 2", "script" */
  ace?: string;
  /** Parameter key, argument index, variable name, or JSON path within a family or flowchart */
  parameter?: string;
  /** UID of a layout instance */
  uid?: number;
  /** The value as saved */
  value: string;
  /** A sure reference, rewritten by a rename; otherwise only reported */
  definite: boolean;
}

/** Whether the object-valued "instance-variable" parameter kind is rewritten (an editor save showed it) or only listed. */
export type InstanceVariableObjects = 'rewrite' | 'list';

/** The kinds of use a rename can rewrite; every other kind is only listed. */
export type RewritableObjectUseKind =
  'custom action owner' | 'objectClass' | 'custom action family' | 'instance-variable object' | 'object parameter' | 'expression';

/**
 * Which rewritable kinds a rename rewrites (true) or only lists (false), as
 * the editor's own rename showed them (Construct 3 r506-2, Free edition,
 * guest). One entry per kind decides both whether a use is definite and
 * whether it is changed. The functions that take an InstanceVariableObjects
 * set the "instance-variable object" entry from it.
 */
export const OBJECT_REWRITE_POLICY: Readonly<Record<RewritableObjectUseKind, boolean>> = {
  'custom action owner': true,
  objectClass: true,
  'custom action family': true,
  'instance-variable object': true,
  'object parameter': true,
  expression: true,
};
const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NAME_CHARACTER = /[\p{L}\p{N}_$]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Index of the parenthesis that closes the one at `open`, skipping string literals; -1 when there is none. */
function closingParenthesis(expression: string, open: number): number {
  let depth = 0;
  for (let k = open; k < expression.length; k++) {
    const ch = expression[k];
    if (ch === '"') {
      const end = c3StringEnd(expression, k);
      if (end === -1) return -1;
      k = end;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && --depth === 0) {
      return k;
    }
  }
  return -1;
}

/** The index of the next character after `from` that is not whitespace. */
function skipSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * Uses of `objectName` as an object in a C3 expression, and the text with
 * `newName` in their place: "Name.member" and "Name(...).member" outside
 * string literals, not after a "." and not inside a longer name, are
 * definite; "Name(...)" without a member after it and a bare "Name" are
 * counted as possible and kept.
 */
export function objectNameInExpression(expression: string, objectName: string, newName?: string): { text: string; definite: number; possible: number } {
  const key = nameKey(objectName);
  let out = '';
  let definite = 0;
  let possible = 0;
  let previous = '';
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (ch === '"') {
      const end = c3StringEnd(expression, i);
      if (end === -1) {
        out += expression.slice(i);
        break;
      }
      out += expression.slice(i, end + 1);
      i = end + 1;
      previous = '"';
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const word = IDENTIFIER.exec(expression);
    if (!word) {
      out += ch;
      if (!/\s/.test(ch)) previous = ch;
      i++;
      continue;
    }
    const start = i;
    i += word[0].length;
    const inLongerName = start > 0 && NAME_CHARACTER.test(expression[start - 1]);
    if (inLongerName || previous === '.' || nameKey(word[0]) !== key) {
      out += word[0];
      previous = 'a';
      continue;
    }
    let next = skipSpaces(expression, i);
    if (expression[next] === '(') {
      const close = closingParenthesis(expression, next);
      next = close === -1 ? expression.length : skipSpaces(expression, close + 1);
    }
    if (expression[next] === '.') {
      definite++;
      out += newName ?? word[0];
    } else {
      possible++;
      out += word[0];
    }
    previous = 'a';
  }
  return { text: out, definite, possible };
}

/** Whether a script line reads `objectName` through runtime.objects (the reference index's pattern, scriptObjectTokens), ignoring case. */
export function scriptReadsObject(line: string, objectName: string): boolean {
  const key = nameKey(objectName);
  return scriptObjectTokens(line).some(name => nameKey(name) === key);
}

/** What a walk of the sheets needs besides the name: the variable and parameter names of all sheets, and the policy. */
interface WalkContext {
  variableNames: ReadonlySet<string>;
  /** Which rewritable kinds are rewritten */
  policy: Readonly<Record<RewritableObjectUseKind, boolean>>;
}

/** The walk's policy: OBJECT_REWRITE_POLICY, with the instance-variable kind as the caller's setting says. */
function policyOf(instanceVariableObjects: InstanceVariableObjects): Readonly<Record<RewritableObjectUseKind, boolean>> {
  return { ...OBJECT_REWRITE_POLICY, 'instance-variable object': instanceVariableObjects === 'rewrite' };
}

/** The event variable and function parameter names of the sheets, as the reference index collects them. */
function variableNamesOf(sheets: Iterable<EventSheet>): Set<string> {
  const names = new Set<string>();
  for (const sheet of sheets) if (Array.isArray(sheet.events)) collectVariableNames(sheet.events as C3Event[], names);
  return names;
}

/**
 * Walk one sheet's uses of `objectName`; with `newName`, the definite ones
 * are rewritten in memory. Whether a use is definite and whether it is
 * rewritten are one decision, `context.policy[kind]`, so a kind the
 * editor's rename leaves is listed and never changed, in every sheet; the
 * kinds with no rewrite (variable values, possible expressions, string
 * literals, scripts) are not in the policy and are always listed.
 */
function walkSheet(sheet: EventSheet, file: string, objectName: string, context: WalkContext, newName?: string): ObjectNameUse[] {
  const uses: ObjectNameUse[] = [];
  const key = nameKey(objectName);
  const same = (value: unknown): value is string => typeof value === 'string' && nameKey(value) === key;
  const base = { category: 'eventSheets' as const, file };
  const rewrites = (kind: RewritableObjectUseKind): boolean => context.policy[kind];
  const change = (kind: RewritableObjectUseKind, apply: () => void) => { if (newName !== undefined && rewrites(kind)) apply(); };
  const variableValue = (variable: Record<string, unknown>, eventPath: string) => {
    if (!same(variable.initialValue)) return;
    const parameter = typeof variable.name === 'string' ? variable.name : undefined;
    uses.push({ ...base, kind: 'variable value', eventPath, ...(parameter !== undefined ? { parameter } : {}), value: variable.initialValue, definite: false });
  };
  walkEventStrings(sheet, {
    event(event, eventPath) {
      if (event.eventType === 'variable') variableValue(event, eventPath);
      if (Array.isArray(event.functionParameters)) {
        for (const p of event.functionParameters) if (isRecord(p)) variableValue(p, eventPath);
      }
      if (event.eventType === 'custom-ace-block' && same(event.objectClass)) {
        uses.push({ ...base, kind: 'custom action owner', eventPath, value: event.objectClass, definite: rewrites('custom action owner') });
        change('custom action owner', () => { event.objectClass = newName!; });
      }
    },
    ace(site, ace) {
      const { eventPath, ace: label } = site;
      if (same(ace.objectClass)) {
        uses.push({ ...base, kind: 'objectClass', eventPath, ace: label, value: ace.objectClass, definite: rewrites('objectClass') });
        change('objectClass', () => { ace.objectClass = newName!; });
      }
      if (same(ace.customActionObjectClass)) {
        uses.push({ ...base, kind: 'custom action family', eventPath, ace: label, value: ace.customActionObjectClass, definite: rewrites('custom action family') });
        change('custom action family', () => { ace.customActionObjectClass = newName!; });
      }
      const variable = isRecord(ace.parameters) ? ace.parameters['instance-variable'] : undefined;
      if (isRecord(variable) && same(variable.objectClass)) {
        uses.push({ ...base, kind: 'instance-variable object', eventPath, ace: label, parameter: 'instance-variable', value: variable.objectClass, definite: rewrites('instance-variable object') });
        change('instance-variable object', () => { variable.objectClass = newName!; });
      }
    },
    parameter({ eventPath, ace }, { key: parameter, value, named, set }) {
      const at = { ...base, eventPath, ace, parameter };
      const whole = value.trim();
      if (same(whole)) {
        // The index's rule for a whole value that is the name (isObjectParameterValue)
        if (named && NON_OBJECT_PARAMETER_KEYS.has(parameter)) return;
        if (isObjectParameterValue(named ? parameter : undefined, context.variableNames.has(whole))) {
          uses.push({ ...at, kind: 'object parameter', value, definite: rewrites('object parameter') });
          change('object parameter', () => set(newName!));
        } else {
          uses.push({ ...at, kind: 'possible expression', value, definite: false });
        }
        return;
      }
      const found = objectNameInExpression(value, objectName, newName);
      if (found.definite > 0) {
        uses.push({ ...at, kind: 'expression', value, definite: rewrites('expression') });
        change('expression', () => set(found.text));
      }
      if (found.possible > 0) uses.push({ ...at, kind: 'possible expression', value, definite: false });
      if (expressionStringLiterals(value).some(l => nameKey(l.text) === key)) uses.push({ ...at, kind: 'string literal', value, definite: false });
    },
    scriptLine(site, line) {
      if (scriptReadsObject(line, objectName)) uses.push({ ...base, eventPath: site.eventPath, ace: site.ace, kind: 'script', value: line, definite: false });
    },
  });
  return uses;
}

/**
 * Every place in the given sheets (all the sheets of the project, so the
 * variable names are the project's) that names `objectName` (see the
 * module comment).
 */
export function findObjectNameUsesInSheets(
  sheets: ReadonlyMap<string, EventSheet>, objectName: string, instanceVariableObjects: InstanceVariableObjects,
): ObjectNameUse[] {
  const context = { variableNames: variableNamesOf(sheets.values()), policy: policyOf(instanceVariableObjects) };
  const uses: ObjectNameUse[] = [];
  for (const [name, sheet] of sheets) uses.push(...walkSheet(sheet, name, objectName, context));
  return uses;
}

/**
 * Point the definite uses of one sheet (in memory) at `newName`, deciding
 * as findObjectNameUsesInSheets did with the same `variableNames` (the
 * project's, taken before any change). Returns how many places changed.
 */
export function renameObjectInSheet(
  sheet: EventSheet, objectName: string, newName: string, variableNames: ReadonlySet<string>, instanceVariableObjects: InstanceVariableObjects,
): number {
  return walkSheet(sheet, '', objectName, { variableNames, policy: policyOf(instanceVariableObjects) }, newName).filter(u => u.definite).length;
}

/** findObjectNameUsesInSheets with a whole policy (each rewritable kind's entry). */
export function findObjectNameUsesWithPolicy(
  sheets: ReadonlyMap<string, EventSheet>, objectName: string, policy: Readonly<Record<RewritableObjectUseKind, boolean>>,
): ObjectNameUse[] {
  const context = { variableNames: variableNamesOf(sheets.values()), policy };
  return [...sheets].flatMap(([name, sheet]) => walkSheet(sheet, name, objectName, context));
}

/** renameObjectInSheet with a whole policy. */
export function renameObjectInSheetWithPolicy(
  sheet: EventSheet, objectName: string, newName: string, variableNames: ReadonlySet<string>, policy: Readonly<Record<RewritableObjectUseKind, boolean>>,
): number {
  return walkSheet(sheet, '', objectName, { variableNames, policy }, newName).filter(u => u.definite).length;
}

/** The event variable and function parameter names of the project's sheets, for renameObjectInSheet. */
export function projectVariableNames(sheets: ReadonlyMap<string, EventSheet>): Set<string> {
  return variableNamesOf(sheets.values());
}

/** Visit the instances of a layout whose type is `objectName`; with `newName`, they get it. */
function walkInstances(layout: Layout, file: string, objectName: string, newName?: string): ObjectNameUse[] {
  const uses: ObjectNameUse[] = [];
  const key = nameKey(objectName);
  forEachLayoutInstance(layout, instance => {
    const record = instance as unknown as Record<string, unknown>;
    if (typeof record.type !== 'string' || nameKey(record.type) !== key) return;
    uses.push({ category: 'layouts', file, kind: 'instance type', ...(typeof record.uid === 'number' ? { uid: record.uid } : {}), value: record.type, definite: true });
    if (newName !== undefined) record.type = newName;
  });
  return uses;
}

/** The layout instances of `objectName` in the given layouts. */
export function findInstanceTypeUses(layouts: ReadonlyMap<string, Layout>, objectName: string): ObjectNameUse[] {
  const uses: ObjectNameUse[] = [];
  for (const [name, layout] of layouts) uses.push(...walkInstances(layout, name, objectName));
  return uses;
}

/** Give the instances of `objectName` in one layout (in memory) the type `newName`. Returns how many changed. */
export function renameInstanceTypes(layout: Layout, objectName: string, newName: string): number {
  return walkInstances(layout, '', objectName, newName).length;
}

/**
 * Give the "singleglobal-inst" of an object type file (a single-global
 * plugin's one instance, which names its own object type in "type") the type
 * `newName`, when it names `objectName`. Returns how many changed (0 or 1).
 */
export function renameSingleGlobalInstanceType(objectType: unknown, objectName: string, newName: string): number {
  if (!isRecord(objectType)) return 0;
  const instance = objectType['singleglobal-inst'];
  if (!isRecord(instance) || typeof instance.type !== 'string' || nameKey(instance.type) !== nameKey(objectName)) return 0;
  instance.type = newName;
  return 1;
}

/** Visit the members of a family that are `objectName`; with `newName`, they become it. */
function walkMembers(family: unknown, file: string, objectName: string, newName?: string): ObjectNameUse[] {
  if (!isRecord(family) || !Array.isArray(family.members)) return [];
  const key = nameKey(objectName);
  const uses: ObjectNameUse[] = [];
  family.members.forEach((member: unknown, i: number) => {
    if (typeof member !== 'string' || nameKey(member) !== key) return;
    uses.push({ category: 'families', file, kind: 'family member', parameter: `members[${i}]`, value: member, definite: true });
    if (newName !== undefined) (family.members as unknown[])[i] = newName;
  });
  return uses;
}

/** The families that list `objectName` as a member. */
export function findFamilyMemberUses(families: ReadonlyMap<string, unknown>, objectName: string): ObjectNameUse[] {
  const uses: ObjectNameUse[] = [];
  for (const [name, family] of families) uses.push(...walkMembers(family, name, objectName));
  return uses;
}

/** Rename the member `objectName` of one family (in memory) to `newName`. Returns how many entries changed. */
export function renameFamilyMember(family: unknown, objectName: string, newName: string): number {
  return walkMembers(family, '', objectName, newName).length;
}

/**
 * The flowchart nodes whose "c" value is `objectName`, as possible uses
 * only: what a node's "c" holds is not known, and no rename rewrites it.
 */
export function findFlowchartNodeUses(flowcharts: ReadonlyMap<string, unknown>, objectName: string): ObjectNameUse[] {
  const key = nameKey(objectName);
  const uses: ObjectNameUse[] = [];
  for (const [file, flowchart] of flowcharts) {
    if (!isRecord(flowchart) || !Array.isArray(flowchart.nodes)) continue;
    flowchart.nodes.forEach((node: unknown, i: number) => {
      if (!isRecord(node) || typeof node.c !== 'string' || nameKey(node.c) !== key) return;
      uses.push({ category: 'flowcharts', file, kind: 'flowchart node', parameter: `nodes[${i}].c`, value: node.c, definite: false });
    });
  }
  return uses;
}

/**
 * The key path at which a timeline track names its object: keys, with "[]"
 * for "every element of this array". Empty: no editor save has shown a
 * timeline track (Construct 3 r506-2, Free edition, guest, and the local
 * saves hold none), so no track is counted or changed.
 */
export const TIMELINE_TRACK_PATH: readonly string[] = [];

/**
 * The values at TIMELINE_TRACK_PATH (or `path`) of a timeline that name
 * `objectName`; with `newName`, they get it. Only that path is read: a key
 * of the same name elsewhere in the file is not a track's object. With an
 * empty path nothing is counted. `complete` is false when the timeline
 * does not have the path's shape (an array or record missing where the
 * path needs one), so the count may miss some.
 */
export function timelineTrackUses(
  timeline: unknown, objectName: string, newName?: string, path: readonly string[] = TIMELINE_TRACK_PATH,
): { count: number; complete: boolean } {
  const key = nameKey(objectName);
  let count = 0;
  let complete = true;
  if (path.length === 0) return { count, complete };
  let holders: unknown[] = [timeline];
  for (const [i, step] of path.entries()) {
    const last = i === path.length - 1;
    const next: unknown[] = [];
    for (const holder of holders) {
      if (step === '[]') {
        if (Array.isArray(holder)) next.push(...holder);
        else complete = false;
        continue;
      }
      if (!isRecord(holder)) {
        complete = false;
        continue;
      }
      if (!last) {
        if (step in holder) next.push(holder[step]);
        continue;
      }
      const value = holder[step];
      if (typeof value === 'string' && nameKey(value) === key) {
        count++;
        if (newName !== undefined) holder[step] = newName;
      }
    }
    holders = next;
  }
  return { count, complete };
}

/** Where a use is, for messages: '"Main" events[3] action 0 "x"', 'layout "L" instance UID 4', 'family "Fam"', 'script main.js'. */
export function objectNameUseLocation(use: ObjectNameUse): string {
  switch (use.category) {
    case 'layouts':
      return `layout "${use.file}" instance${use.uid !== undefined ? ` UID ${use.uid}` : ''}`;
    case 'families':
      return `family "${use.file}"`;
    case 'flowcharts':
      return `flowchart "${use.file}"${use.parameter !== undefined ? ` ${use.parameter}` : ''}`;
    case 'scripts':
      return `script ${use.file}`;
    default: {
      const parts = [`"${use.file}"`, use.eventPath ?? ''];
      if (use.ace !== undefined) parts.push(use.ace);
      if (use.parameter !== undefined) parts.push(`"${use.parameter}"`);
      return parts.filter(p => p !== '').join(' ');
    }
  }
}
