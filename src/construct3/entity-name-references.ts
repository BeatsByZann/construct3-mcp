/**
 * Where an event sheet or a layout is named, for renaming one.
 *
 * Both are named in project.c3proj's project-bar tree and in their own file
 * (its "name", and the file name), and besides:
 * - an event sheet by the include events of event sheets ("includeSheet")
 *   and by the event sheet binding of layouts ("eventSheet");
 * - a layout by the "layout" parameter of conditions and actions (System Go
 *   to layout), which the editor saves as the bare name, not as a string
 *   expression (`"layout": "Level 2"`), by project.c3proj's "firstLayout"
 *   (the startup layout, also kept in its "properties") and by the
 *   "startOnLayout" of timelines (readRegisteredTimelines in
 *   tools/timeline-tools.ts).
 * The editor compares these names ignoring case (names.ts), and no two event
 * sheets or layouts have names that differ only in case, so a name that
 * matches ignoring case names this one. These are sure references
 * (`definite`) and a rename rewrites them.
 *
 * A layout's name in a string literal (Go to layout (by name), a comparison
 * with LayoutName, a function call argument), in a script, or as the value
 * of a text variable (the initial value of an event variable or function
 * parameter, an instance variable value of a layout instance) may name the
 * layout or something else of that name, so it is only reported. A "layout"
 * parameter of a "...-by-name" action is such an expression, not a name.
 */

import type { EventSheet, Layout } from './types.js';
import { nameKey } from './names.js';
import { expressionStringLiterals } from './layer-references.js';
import { quotedNamePattern, walkEventStrings } from './event-strings.js';
import { forEachLayoutInstance } from './layers.js';

/** A place in an event sheet or layout that names the entity being renamed. */
export interface EntityNameUse {
  /** The kind of file the use is in */
  category: 'eventSheets' | 'layouts';
  /** Name of the event sheet or layout the use is in */
  file: string;
  kind: EntityNameUseKind;
  /** JSON path of the event ("events[3].children[1]"); absent for a layout's binding */
  eventPath?: string;
  /** "condition 0", "action 2", "script"; absent for includes, bindings and variable values */
  ace?: string;
  /** UID of the layout instance whose instance variable holds the name */
  uid?: number;
  /** Parameter key ("layout", "x", ...), the argument index of a function call, or "script" */
  parameter?: string;
  /** The value as saved */
  value: string;
  /** A sure reference, rewritten by a rename; otherwise only reported */
  definite: boolean;
}

export type EntityNameUseKind =
  | 'include' | 'eventSheet binding' | 'layout parameter' | 'string literal' | 'script' | 'variable value' | 'instance variable';

/** The kinds of use a rename can rewrite; every other kind is only listed. */
export type RewritableEntityUseKind = 'include' | 'eventSheet binding' | 'layout parameter';

/**
 * Which rewritable kinds a rename rewrites (true) or only lists (false), as
 * the editor's own rename showed them (Construct 3 r506-2, Free edition). One
 * entry per kind decides both whether a use is definite and whether it is
 * changed. Strings, scripts, variable values and instance variables have no
 * rewrite operation and are never promoted.
 */
export const ENTITY_REWRITE_POLICY: Readonly<Record<RewritableEntityUseKind, boolean>> = {
  include: true,
  'eventSheet binding': true,
  'layout parameter': true,
};

/** True when `value` is the name `name` (ignoring case, as the editor compares these names). */
export function isSameEntityName(value: unknown, name: string): value is string {
  return typeof value === 'string' && nameKey(value) === nameKey(name);
}

/**
 * The include events of `sheet` that include `sheetName`. With `newName`,
 * they are pointed at it (in memory).
 */
function walkIncludes(sheet: EventSheet, file: string, sheetName: string, newName?: string): EntityNameUse[] {
  const uses: EntityNameUse[] = [];
  walkEventStrings(sheet, {
    event(event, eventPath) {
      if (event.eventType !== 'include' || !isSameEntityName(event.includeSheet, sheetName)) return;
      uses.push({ category: 'eventSheets', file, kind: 'include', eventPath, value: event.includeSheet, definite: ENTITY_REWRITE_POLICY.include });
      if (newName !== undefined && ENTITY_REWRITE_POLICY.include) event.includeSheet = newName;
    },
  });
  return uses;
}

/** The include events in the given sheets that include `sheetName`. */
export function findSheetIncludes(sheets: ReadonlyMap<string, EventSheet>, sheetName: string): EntityNameUse[] {
  const uses: EntityNameUse[] = [];
  for (const [name, sheet] of sheets) uses.push(...walkIncludes(sheet, name, sheetName));
  return uses;
}

/** Point the include events of one sheet (in memory) that include `sheetName` at `newName`. Returns how many changed. */
export function renameSheetIncludes(sheet: EventSheet, sheetName: string, newName: string): number {
  return walkIncludes(sheet, '', sheetName, newName).length;
}

/** The layouts bound to the event sheet `sheetName`. */
export function findLayoutBindings(layouts: ReadonlyMap<string, Layout>, sheetName: string): EntityNameUse[] {
  const uses: EntityNameUse[] = [];
  for (const [name, layout] of layouts) {
    if (isSameEntityName(layout.eventSheet, sheetName)) {
      uses.push({ category: 'layouts', file: name, kind: 'eventSheet binding', value: layout.eventSheet, definite: ENTITY_REWRITE_POLICY['eventSheet binding'] });
    }
  }
  return uses;
}

/**
 * The conditions, actions, script lines and variables of `sheet` that name
 * the layout `layoutName`: "layout" parameters that are its bare name
 * (definite), and string literals, quoted script strings and initial values
 * of event variables and function parameters that name it (possible). With
 * `newName`, the definite ones are pointed at it (in memory).
 */
function walkLayoutNameUses(sheet: EventSheet, file: string, layoutName: string, newName?: string): EntityNameUse[] {
  const uses: EntityNameUse[] = [];
  const key = nameKey(layoutName);
  const scriptPattern = quotedNamePattern(layoutName);
  const variableValue = (variable: Record<string, unknown>, eventPath: string) => {
    if (isSameEntityName(variable.initialValue, layoutName)) {
      const parameter = typeof variable.name === 'string' ? variable.name : undefined;
      uses.push({ category: 'eventSheets', file, kind: 'variable value', eventPath, parameter, value: variable.initialValue, definite: false });
    }
  };
  walkEventStrings(sheet, {
    event(event, eventPath) {
      if (event.eventType === 'variable') variableValue(event, eventPath);
      if (Array.isArray(event.functionParameters)) {
        for (const p of event.functionParameters) {
          if (typeof p === 'object' && p !== null) variableValue(p as Record<string, unknown>, eventPath);
        }
      }
    },
    scriptLine(site, line) {
      if (scriptPattern.test(line)) {
        uses.push({ category: 'eventSheets', file, kind: 'script', ...site, parameter: 'script', value: line, definite: false });
      }
    },
    parameter({ id, ...site }, { key: parameter, value, set }) {
      // Go to layout (by name) takes an expression under the same key
      const byName = id !== undefined && id.endsWith('-by-name');
      if (parameter === 'layout' && !byName && isSameEntityName(value, layoutName)) {
        uses.push({ category: 'eventSheets', file, kind: 'layout parameter', ...site, parameter, value, definite: ENTITY_REWRITE_POLICY['layout parameter'] });
        if (newName !== undefined && ENTITY_REWRITE_POLICY['layout parameter']) set(newName);
      } else if (expressionStringLiterals(value).some(l => nameKey(l.text) === key)) {
        uses.push({ category: 'eventSheets', file, kind: 'string literal', ...site, parameter, value, definite: false });
      }
    },
  });
  return uses;
}

/** Every place in the given sheets that names the layout `layoutName` (see the module comment). */
export function findLayoutNameUses(sheets: ReadonlyMap<string, EventSheet>, layoutName: string): EntityNameUse[] {
  const uses: EntityNameUse[] = [];
  for (const [name, sheet] of sheets) uses.push(...walkLayoutNameUses(sheet, name, layoutName));
  return uses;
}

/**
 * Instance variable values of layout instances that are the name `layoutName`
 * (ignoring case): possibly a layout name an event passes to Go to layout
 * (by name), so they are only reported.
 */
export function findInstanceVariableValues(layouts: ReadonlyMap<string, Layout>, layoutName: string): EntityNameUse[] {
  const uses: EntityNameUse[] = [];
  for (const [file, layout] of layouts) {
    forEachLayoutInstance(layout, instance => {
      const values = (instance as { instanceVariables?: unknown }).instanceVariables;
      if (typeof values !== 'object' || values === null) return;
      for (const [parameter, value] of Object.entries(values)) {
        if (isSameEntityName(value, layoutName)) {
          const uid = typeof instance.uid === 'number' ? instance.uid : undefined;
          uses.push({ category: 'layouts', file, kind: 'instance variable', ...(uid !== undefined ? { uid } : {}), parameter, value, definite: false });
        }
      }
    });
  }
  return uses;
}

/** Point the "layout" parameters of one sheet (in memory) that name `layoutName` at `newName`. Returns how many changed. */
export function renameLayoutParameters(sheet: EventSheet, layoutName: string, newName: string): number {
  return walkLayoutNameUses(sheet, '', layoutName, newName).filter(u => u.definite).length;
}

/**
 * Where a use is, for messages: '"Sheet1" events[3] action 0 "layout"',
 * 'layout "Level 1"', 'layout "Level 1" instance UID 4 "target"'.
 */
export function entityNameUseLocation(use: EntityNameUse): string {
  if (use.category === 'layouts') {
    return use.kind === 'instance variable'
      ? `layout "${use.file}" instance${use.uid !== undefined ? ` UID ${use.uid}` : ''} "${use.parameter}"`
      : `layout "${use.file}"`;
  }
  const parts = [`"${use.file}"`, use.eventPath ?? ''];
  if (use.ace !== undefined) parts.push(use.ace);
  if (use.parameter !== undefined && use.parameter !== 'script') parts.push(`"${use.parameter}"`);
  return parts.filter(p => p !== '').join(' ');
}
