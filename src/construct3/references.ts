/**
 * Reference scanning and rewriting for rename operations.
 *
 * One scanner serves both `dryRun` (report only) and the real rename: every
 * function takes an `apply` flag, mutates the parsed JSON it is handed only
 * when `apply` is true, and returns one `RefSite` per reference it found.
 * The rename tools therefore cannot report one set of references and rewrite
 * a different one.
 *
 * Every key handled below was confirmed against the C3-ACE project (Construct
 * 3 r495 format). The header comment on each helper names the observed key.
 */

import type { EventSheet, Layout, C3Event, Subfolder } from './types.js';
import { collectLayers } from './layout-walk.js';

/** Guard against cyclic or pathological event nesting. */
const MAX_DEPTH = 60;

// ─── Reference kinds ───────────────────────────────────────

/**
 * What kind of reference a site is. Reported per-kind so a caller can see
 * exactly which key was rewritten where.
 */
export type RefKind =
  // ── object type / family ──
  /** `objectClass` on a condition or action. */
  | 'objectClass'
  /** `objectClass` on a `custom-ace-block` event (the ACE's owner). */
  | 'customAceObjectClass'
  /** A parameter whose whole value is a bare object/family name (`object`, `object-to-create`, `parent`, `child`, `instance`). */
  | 'parameterObjectName'
  /** An identifier token inside expression text in a parameter value. */
  | 'expression'
  /** `type` on a layout instance. */
  | 'instanceType'
  /** An entry in a family file's `members` array. */
  | 'familyMember'
  /** An entry in `containers[].members` in project.c3proj. */
  | 'containerMember'
  // ── shared ──
  /** The entity's name in its own JSON file (`name`). */
  | 'entityName'
  /** The item in the project.c3proj `objectTypes`/`families`/`layouts`/`eventSheets` tree. */
  | 'projectTree'
  /** The entity's own JSON file, renamed on disk. */
  | 'entityFile'
  /** An `images/<lowercase name>-...png` file, renamed on disk. */
  | 'imageFile'
  /** A `tilemapBrushes/objectTypes/<subfolder>/<name>.brush.json` file, renamed on disk. */
  | 'tilemapBrushFile'
  /** `objectType` on a timeline track in a `timelines/` JSON file. */
  | 'timelineTrackObjectType'
  // ── layout ──
  /** `firstLayout` in project.c3proj. */
  | 'firstLayout'
  /** `startOnLayout` in a timelines/<name>.json file. */
  | 'timelineStartOnLayout'
  /** A `layout`-keyed action/condition parameter. */
  | 'layoutParameter'
  // ── event sheet ──
  /** `eventSheet` on a layout. */
  | 'layoutEventSheet'
  /** `includeSheet` on an `include` event. */
  | 'includeSheet'
  // ── layer ──
  /** A layer's `name` in its layout. */
  | 'layerName'
  /** A `layer`-keyed parameter whose whole value is the bare layer name. */
  | 'layerParameter'
  /** A `"<name>"` string literal inside expression text (layer names reach expressions this way). */
  | 'layerLiteral'
  // ── event variable ──
  /** The `variable` event declaration's `name`. */
  | 'variableDeclaration'
  /** A `variable`-keyed action/condition parameter. */
  | 'variableParameter';

/** One reference found by the scanner. */
export interface RefSite {
  /** Project-relative file, e.g. `eventSheets/MainSheet.json`. */
  file: string;
  /** Path inside that file, e.g. `events[0].actions[1].objectClass`. */
  path: string;
  kind: RefKind;
}

/**
 * Parameter keys whose whole value is a bare object type or family name (not
 * an expression). Confirmed in C3-ACE: `parameters.object` (pick-by-evaluate,
 * pick-by-comparison), `parameters.object-to-create` (create-object),
 * `parameters.parent` / `parameters.child` (scene-graph actions),
 * `parameters.instance`. `object-name` is NOT in this set: its observed values
 * are expressions (`"item"&diInventory.CurrentKey`).
 */
export const OBJECT_NAME_PARAM_KEYS = new Set([
  'object',
  'object-to-create',
  'parent',
  'child',
  'instance',
]);

// ─── Expression text rewriting ─────────────────────────────

/**
 * Characters that terminate an identifier run in a Construct expression.
 * Everything else — including non-ASCII letters and emoji, which real C3
 * object names use (`fTreeNodes` plus an emoji in C3-ACE) — is an identifier
 * character. A space is a delimiter, so a name containing a space can never
 * match an identifier run; that matches Construct, which cannot reference
 * such a name from an expression either.
 */
const EXPR_DELIMITERS = new Set<string>([
  ' ', '\t', '\r', '\n',
  '+', '-', '*', '/', '(', ')', '[', ']', '{', '}',
  ',', '.', '&', '|', '<', '>', '=', '!', '%', '?', ':', ';',
  '"', "'", '^', '~', '\\', '#', '@', '$',
]);

/** True when `name` can appear as a single identifier token in an expression. */
export function isExpressionIdentifier(name: string): boolean {
  for (const ch of name) {
    if (EXPR_DELIMITERS.has(ch)) return false;
  }
  return name.length > 0;
}

/**
 * Rewrite `oldName` to `newName` where it appears as a whole identifier token
 * in Construct expression text.
 *
 * Token-aware, not textual:
 * - Only maximal identifier runs are compared, so `PlayerShip.X` is untouched
 *   when renaming `Player`.
 * - A run immediately preceded by `.` is a member name (`Sprite.Player`), not
 *   an object reference, and is left alone.
 * - Text inside a `"..."` string literal is never touched, so
 *   `"Player wins" & Player.X` rewrites only the second occurrence.
 * - `Name.`, `Name(` and a bare `Name` all rewrite, because `.` and `(` are
 *   delimiters and the run therefore ends before them.
 */
export function rewriteExpressionIdentifier(
  text: string,
  oldName: string,
  newName: string,
): { text: string; count: number } {
  if (!isExpressionIdentifier(oldName) || !text.includes(oldName)) {
    return { text, count: 0 };
  }

  let out = '';
  let count = 0;
  let run = '';
  let runPrev = '';
  let inString = false;

  const flushRun = () => {
    if (run === oldName && runPrev !== '.') {
      out += newName;
      count++;
    } else {
      out += run;
    }
    run = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '"') inString = false;
      continue;
    }
    if (EXPR_DELIMITERS.has(ch)) {
      if (run.length > 0) flushRun();
      out += ch;
      runPrev = ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (run.length === 0) runPrev = i === 0 ? '' : text[i - 1];
    run += ch;
  }
  if (run.length > 0) flushRun();

  return { text: out, count };
}

/**
 * Rewrite `"oldName"` to `"newName"` where a whole double-quoted string
 * literal equals the name. Layer names reach expressions only this way:
 * C3-ACE has `"layer": "\"l_BehaviorTrees\""` and
 * `"scale": "LayerScale(\"l_BehaviorTrees\")+..."`. Partial matches inside a
 * longer literal are never rewritten.
 */
export function rewriteWholeStringLiteral(
  text: string,
  oldName: string,
  newName: string,
): { text: string; count: number } {
  const needle = `"${oldName}"`;
  if (!text.includes(needle)) return { text, count: 0 };

  let out = '';
  let count = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      out += text[i];
      i++;
      continue;
    }
    const end = text.indexOf('"', i + 1);
    if (end === -1) {
      out += text.slice(i);
      break;
    }
    const body = text.slice(i + 1, end);
    if (body === oldName) {
      out += `"${newName}"`;
      count++;
    } else {
      out += `"${body}"`;
    }
    i = end + 1;
  }
  return { text: out, count };
}

// ─── Event walking ─────────────────────────────────────────

interface AceVisit {
  /** The condition or action object. */
  ace: Record<string, unknown>;
  /** Path to the ACE, e.g. `events[0].actions[1]`. */
  path: string;
}

interface EventVisit {
  event: Record<string, unknown>;
  path: string;
}

/**
 * Visit every event (depth-first, in order) and every condition/action on it.
 * `children` nesting is followed for all event types that carry it.
 */
function walkEvents(
  events: unknown,
  onEvent: (visit: EventVisit) => void,
  onAce: (visit: AceVisit) => void,
): void {
  const walk = (list: unknown, prefix: string, depth: number) => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return;
    for (let i = 0; i < list.length; i++) {
      const event = list[i] as Record<string, unknown> | null;
      if (!event || typeof event !== 'object') continue;
      const path = `${prefix}[${i}]`;
      onEvent({ event, path });
      for (const key of ['conditions', 'actions'] as const) {
        const aces = event[key];
        if (!Array.isArray(aces)) continue;
        for (let j = 0; j < aces.length; j++) {
          const ace = aces[j] as Record<string, unknown> | null;
          if (!ace || typeof ace !== 'object') continue;
          onAce({ ace, path: `${path}.${key}[${j}]` });
        }
      }
      walk(event.children, `${path}.children`, depth + 1);
    }
  };
  walk(events, 'events', 0);
}

/**
 * Apply `rewrite` to every string parameter value on an ACE.
 * `parameters` is normally a key/value object, but a `custom-ace-block` call
 * action serializes its arguments as a plain array of expression strings
 * (observed in C3-ACE), so both shapes are handled.
 */
function forEachParameter(
  ace: Record<string, unknown>,
  acePath: string,
  visit: (key: string | number, value: string, path: string, set: (v: string) => void) => void,
): void {
  const params = ace.parameters;
  if (Array.isArray(params)) {
    for (let i = 0; i < params.length; i++) {
      const value = params[i];
      if (typeof value !== 'string') continue;
      visit(i, value, `${acePath}.parameters[${i}]`, v => { params[i] = v; });
    }
    return;
  }
  if (!params || typeof params !== 'object') return;
  const record = params as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    visit(key, value, `${acePath}.parameters.${key}`, v => { record[key] = v; });
  }
}

// ─── Object type / family references in an event sheet ─────

/**
 * Find (and optionally rewrite) every reference to an object type or family
 * name in one event sheet.
 *
 * Handled keys: `conditions[].objectClass`, `actions[].objectClass`,
 * `objectClass` on a `custom-ace-block` event, the bare-name parameter keys in
 * `OBJECT_NAME_PARAM_KEYS`, and identifier tokens inside every other string
 * parameter value (`value`, `expression`, `unique-id`, `first-value`, ... and
 * array-form custom-action arguments).
 *
 * Deliberately NOT rewritten (reported by the caller as a warning instead):
 * `script` action/event bodies (JavaScript), `comment` text, and a variable's
 * `initialValue` (a literal, which in C3-ACE contains object names as prose).
 */
export function collectObjectNameRefsInSheet(
  file: string,
  sheet: EventSheet,
  oldName: string,
  newName: string,
  apply: boolean,
): RefSite[] {
  const sites: RefSite[] = [];

  walkEvents(
    sheet.events as unknown as C3Event[],
    ({ event, path }) => {
      if (event.eventType === 'custom-ace-block' && event.objectClass === oldName) {
        sites.push({ file, path: `${path}.objectClass`, kind: 'customAceObjectClass' });
        if (apply) event.objectClass = newName;
      }
    },
    ({ ace, path }) => {
      if (ace.objectClass === oldName) {
        sites.push({ file, path: `${path}.objectClass`, kind: 'objectClass' });
        if (apply) ace.objectClass = newName;
      }
      forEachParameter(ace, path, (key, value, paramPath, set) => {
        if (typeof key === 'string' && OBJECT_NAME_PARAM_KEYS.has(key) && value === oldName) {
          sites.push({ file, path: paramPath, kind: 'parameterObjectName' });
          if (apply) set(newName);
          return;
        }
        const rewritten = rewriteExpressionIdentifier(value, oldName, newName);
        for (let n = 0; n < rewritten.count; n++) {
          sites.push({ file, path: paramPath, kind: 'expression' });
        }
        if (apply && rewritten.count > 0) set(rewritten.text);
      });
    },
  );

  return sites;
}

/**
 * Count the object-name occurrences this server deliberately leaves alone, so
 * a rename can warn about them: `script` bodies, `comment` text and variable
 * `initialValue`.
 */
export function countUnrewrittenObjectMentions(sheet: EventSheet, name: string): number {
  let count = 0;
  const countIn = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.includes(name)) count++;
    } else if (Array.isArray(value)) {
      for (const line of value) countIn(line);
    }
  };
  walkEvents(
    sheet.events as unknown as C3Event[],
    ({ event }) => {
      if (event.eventType === 'script') countIn(event.script);
      if (event.eventType === 'comment') countIn(event.text);
      if (event.eventType === 'variable') countIn(event.initialValue);
    },
    ({ ace }) => {
      if (ace.type === 'script') countIn(ace.script);
      if (ace.type === 'comment') countIn(ace.text);
    },
  );
  return count;
}

// ─── Object type references in a layout ────────────────────

/**
 * Find (and optionally rewrite) `type` on every instance of an object type in
 * one layout, including nested sub-layers and `nonworld-instances`.
 *
 * Checked and found to hold no type names in C3-ACE: an instance's
 * `sceneGraphData` (UIDs and flags only) and its `template` block
 * (`templateName`/`sourceTemplateName` are template names, and the
 * `components[].component[].key` values are `plugin`, `instance-variable`,
 * behavior names, effect names and `world-instance`).
 */
export function collectInstanceTypeRefsInLayout(
  file: string,
  layout: Layout,
  oldName: string,
  newName: string,
  apply: boolean,
): RefSite[] {
  const sites: RefSite[] = [];

  const layers = collectLayers(layout);
  for (let li = 0; li < layers.length; li++) {
    const instances = layers[li].instances;
    if (!Array.isArray(instances)) continue;
    for (let ii = 0; ii < instances.length; ii++) {
      const instance = instances[ii] as unknown as Record<string, unknown>;
      if (instance?.type !== oldName) continue;
      sites.push({
        file,
        path: `layers[${li}:${layers[li].name}].instances[${ii}].type`,
        kind: 'instanceType',
      });
      if (apply) instance.type = newName;
    }
  }

  const nonworld = layout['nonworld-instances'];
  if (Array.isArray(nonworld)) {
    for (let i = 0; i < nonworld.length; i++) {
      const instance = nonworld[i] as Record<string, unknown>;
      if (instance?.type !== oldName) continue;
      sites.push({ file, path: `nonworld-instances[${i}].type`, kind: 'instanceType' });
      if (apply) instance.type = newName;
    }
  }

  return sites;
}

// ─── Object type references in a timeline ─────────

/** Cap the timeline walk so a hand-edited or cyclic file cannot hang it. */
const MAX_TIMELINE_NODES = 200_000;

/**
 * Find (and optionally rewrite) every `objectType` naming an object type in
 * one timeline file.
 *
 * An instance track stores the object type by name:
 *
 *   "tracks": [ { "type": "instance-track", "worldInstance": 2,
 *                 "objectType": "Box", "project": "2wt2ovw8c2u", ... } ]
 *
 * Construct refuses to open a project whose track names an object type that
 * no longer exists, so this has to be rewritten with the rest of a rename.
 *
 * The walk covers the whole document, not only `tracks[]`: `tracksRoot` and
 * `nestedTimelinesRoot` are folder structures (`items`/`subfolders`) that are
 * empty in every observed sample even when a track exists, so whether a track
 * can nest inside them is not knowable from the data - walking everything
 * makes the answer not matter. `objectType` has no other meaning in a
 * timeline file.
 *
 * Left alone on purpose: `tracks[].worldInstance` and a property track's
 * `source: { type: "world-instance", uid }` address an instance by UID, which
 * a rename does not change, and `tracks[].project` holds the project's
 * `uniqueId`, not a name.
 */
export function collectTimelineObjectTypeRefs(
  file: string,
  timeline: unknown,
  oldName: string,
  newName: string,
  apply: boolean,
): RefSite[] {
  const sites: RefSite[] = [];
  let nodes = 0;

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || nodes++ > MAX_TIMELINE_NODES) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      const childPath = path ? `${path}.${key}` : key;
      if (key === 'objectType' && value === oldName) {
        sites.push({ file, path: childPath, kind: 'timelineTrackObjectType' });
        if (apply) record[key] = newName;
        continue;
      }
      walk(value, childPath, depth + 1);
    }
  };

  walk(timeline, '', 0);
  return sites;
}

// ─── Family members ────────────────────────────────────────

/** Find (and optionally rewrite) an object type name in a family's `members`. */
export function collectFamilyMemberRefs(
  file: string,
  family: Record<string, unknown>,
  oldName: string,
  newName: string,
  apply: boolean,
): RefSite[] {
  const sites: RefSite[] = [];
  const members = family.members;
  if (!Array.isArray(members)) return sites;
  for (let i = 0; i < members.length; i++) {
    if (members[i] !== oldName) continue;
    sites.push({ file, path: `members[${i}]`, kind: 'familyMember' });
    if (apply) members[i] = newName;
  }
  return sites;
}

// ─── Event sheet references ────────────────────────────────

/** Find (and optionally rewrite) `includeSheet` on `include` events. */
export function collectIncludeSheetRefs(
  file: string,
  sheet: EventSheet,
  oldName: string,
  newName: string,
  apply: boolean,
): RefSite[] {
  const sites: RefSite[] = [];
  walkEvents(
    sheet.events as unknown as C3Event[],
    ({ event, path }) => {
      if (event.eventType === 'include' && event.includeSheet === oldName) {
        sites.push({ file, path: `${path}.includeSheet`, kind: 'includeSheet' });
        if (apply) event.includeSheet = newName;
      }
    },
    () => { /* includes carry no ACEs */ },
  );
  return sites;
}

/** Find (and optionally rewrite) a layout's `eventSheet` binding. */
export function collectLayoutEventSheetRef(
  file: string,
  layout: Layout,
  oldName: string,
  newName: string,
  apply: boolean,
): RefSite[] {
  if (layout.eventSheet !== oldName) return [];
  if (apply) layout.eventSheet = newName;
  return [{ file, path: 'eventSheet', kind: 'layoutEventSheet' }];
}

// ─── Layout references ─────────────────────────────────────

/**
 * Find (and optionally rewrite) `layout`-keyed parameters naming a layout.
 *
 * No `layout`-keyed parameter exists anywhere in C3-ACE (it uses no
 * go-to-layout action), so both serializations Construct can produce for a
 * layout-valued parameter are accepted: the bare name (`"layout": "Level 2"`,
 * the combo form) and an expression that is exactly the quoted name
 * (`"layout": "\"Level 2\""`, the by-name form). Any other expression is left
 * alone.
 */
export function collectLayoutParameterRefs(
  file: string,
  sheet: EventSheet,
  oldName: string,
  newName: string,
  apply: boolean,
): RefSite[] {
  const sites: RefSite[] = [];
  walkEvents(
    sheet.events as unknown as C3Event[],
    () => { /* no layout names on events themselves */ },
    ({ ace, path }) => {
      forEachParameter(ace, path, (key, value, paramPath, set) => {
        if (key !== 'layout') return;
        if (value === oldName) {
          sites.push({ file, path: paramPath, kind: 'layoutParameter' });
          if (apply) set(newName);
          return;
        }
        const rewritten = rewriteWholeStringLiteral(value, oldName, newName);
        if (rewritten.count > 0) {
          sites.push({ file, path: paramPath, kind: 'layoutParameter' });
          if (apply) set(rewritten.text);
        }
      });
    },
  );
  return sites;
}

// ─── Layer references ──────────────────────────────────────

/**
 * Find (and optionally rewrite) layer-name references in one event sheet.
 *
 * Two forms, both observed in C3-ACE:
 * - a `layer`-keyed parameter whose whole value is the bare name;
 * - a `"<name>"` string literal anywhere in expression text, which is how the
 *   editor writes both `"layer": "\"l_BehaviorTrees\""` and
 *   `"scale": "LayerScale(\"l_BehaviorTrees\")+..."`.
 *
 * Unquoted expressions (`cBtConstants.cBEHAVIORTREE_LAYER`, `Self.LayerName`,
 * `0`) are expressions, not names, and are never touched.
 */
export function collectLayerRefsInSheet(
  file: string,
  sheet: EventSheet,
  oldName: string,
  newName: string,
  apply: boolean,
): RefSite[] {
  const sites: RefSite[] = [];
  walkEvents(
    sheet.events as unknown as C3Event[],
    () => { /* no layer names on events themselves */ },
    ({ ace, path }) => {
      forEachParameter(ace, path, (key, value, paramPath, set) => {
        if (key === 'layer' && value === oldName) {
          sites.push({ file, path: paramPath, kind: 'layerParameter' });
          if (apply) set(newName);
          return;
        }
        const kind: RefKind = key === 'layer' ? 'layerParameter' : 'layerLiteral';
        const rewritten = rewriteWholeStringLiteral(value, oldName, newName);
        for (let n = 0; n < rewritten.count; n++) {
          sites.push({ file, path: paramPath, kind });
        }
        if (apply && rewritten.count > 0) set(rewritten.text);
      });
    },
  );
  return sites;
}

/**
 * The walk path of an event in a sheet (`events[2].children[1]`), or
 * undefined when the event is not in the sheet. Matched by object identity.
 */
export function findEventPath(sheet: EventSheet, target: Record<string, unknown>): string | undefined {
  let found: string | undefined;
  walkEvents(
    sheet.events as unknown as C3Event[],
    ({ event, path }) => { if (found === undefined && event === target) found = path; },
    () => { /* ACEs are not needed */ },
  );
  return found;
}

// ─── Event variable references ─────────────────────────────

/**
 * Find (and optionally rewrite) references to an event variable in one sheet.
 *
 * Handled: `parameters.variable` (the key used by `set-eventvar-value`,
 * `add-to-eventvar`, `subtract-from-eventvar`, `reset-eventvar` and
 * `compare-eventvar`, confirmed in C3-ACE) and bare identifier tokens in every
 * other string parameter value. `parameters.instance-variable` names an
 * instance variable, a different namespace, and is never touched.
 */
export function collectVariableRefsInSheet(
  file: string,
  sheet: EventSheet,
  oldName: string,
  newName: string,
  apply: boolean,
  scopePath?: string,
): RefSite[] {
  const sites: RefSite[] = [];
  walkEvents(
    sheet.events as unknown as C3Event[],
    () => { /* the declaration is renamed by the caller */ },
    ({ ace, path }) => {
      // A local variable is visible only inside the container that declares
      // it, so references outside that container's children belong to some
      // other declaration and are left alone.
      if (scopePath !== undefined && !path.startsWith(scopePath)) return;
      forEachParameter(ace, path, (key, value, paramPath, set) => {
        if (key === 'instance-variable') return;
        if (key === 'variable') {
          if (value === oldName) {
            sites.push({ file, path: paramPath, kind: 'variableParameter' });
            if (apply) set(newName);
          }
          return;
        }
        const rewritten = rewriteExpressionIdentifier(value, oldName, newName);
        for (let n = 0; n < rewritten.count; n++) {
          sites.push({ file, path: paramPath, kind: 'expression' });
        }
        if (apply && rewritten.count > 0) set(rewritten.text);
      });
    },
  );
  return sites;
}

// ─── project.c3proj ────────────────────────────────────────

/**
 * Rename an item in a project.c3proj entity tree in place, preserving its
 * position and its subfolder. Returns the subfolder path holding it
 * (`''` for the container root) or null when the name is not registered.
 */
export function renameTreeItem(
  container: { items?: unknown; subfolders?: unknown } | undefined,
  oldName: string,
  newName: string,
  apply: boolean,
): string | null {
  if (!container) return null;

  const items = container.items;
  if (Array.isArray(items)) {
    const index = items.indexOf(oldName);
    if (index !== -1) {
      if (apply) items[index] = newName;
      return '';
    }
  }

  const walk = (subfolders: unknown, prefix: string): string | null => {
    if (!Array.isArray(subfolders)) return null;
    for (const raw of subfolders) {
      const folder = raw as Subfolder | undefined;
      if (!folder || typeof folder !== 'object') continue;
      const path = prefix ? `${prefix}/${folder.name}` : String(folder.name);
      if (Array.isArray(folder.items)) {
        const index = folder.items.indexOf(oldName);
        if (index !== -1) {
          if (apply) folder.items[index] = newName;
          return path;
        }
      }
      const found = walk(folder.subfolders, path);
      if (found !== null) return found;
    }
    return null;
  };

  return walk(container.subfolders, '');
}

/**
 * Find (and optionally rewrite) an object type name in the root `containers`
 * array of project.c3proj (`containers[].members`). Containers hold object
 * types only, so this is not used for families.
 */
export function collectContainerMemberRefs(
  project: Record<string, unknown>,
  oldName: string,
  newName: string,
  apply: boolean,
): RefSite[] {
  const sites: RefSite[] = [];
  const containers = project.containers;
  if (!Array.isArray(containers)) return sites;
  for (let i = 0; i < containers.length; i++) {
    const members = (containers[i] as { members?: unknown } | undefined)?.members;
    if (!Array.isArray(members)) continue;
    for (let j = 0; j < members.length; j++) {
      if (members[j] !== oldName) continue;
      sites.push({ file: 'project.c3proj', path: `containers[${i}].members[${j}]`, kind: 'containerMember' });
      if (apply) members[j] = newName;
    }
  }
  return sites;
}

// ─── Reporting ─────────────────────────────────────────────

/** Group reference sites into `{ <kind>: count }`, in the order kinds appear. */
export function countByKind(sites: RefSite[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of sites) {
    counts[site.kind] = (counts[site.kind] ?? 0) + 1;
  }
  return counts;
}

/** Group reference sites by file, preserving discovery order within a file. */
export function groupByFile(sites: RefSite[]): Array<{ file: string; count: number; kinds: Record<string, number> }> {
  const order: string[] = [];
  const byFile = new Map<string, RefSite[]>();
  for (const site of sites) {
    let list = byFile.get(site.file);
    if (!list) {
      list = [];
      byFile.set(site.file, list);
      order.push(site.file);
    }
    list.push(site);
  }
  return order.map(file => {
    const list = byFile.get(file)!;
    return { file, count: list.length, kinds: countByKind(list) };
  });
}
