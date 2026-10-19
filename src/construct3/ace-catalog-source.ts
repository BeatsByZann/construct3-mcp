/**
 * Turn the ACE definitions a Construct release serves to its own editor into
 * the catalogue ACE validation uses.
 *
 * Three files of the editor are read (this module only parses them; it
 * fetches nothing):
 *   plugins/allAces.json    every built-in plugin's own conditions and actions
 *   behaviors/allAces.json  every built-in behavior's conditions and actions
 *   main.js                 the common ACEs the editor adds to plugins by
 *                           capability (instance variables, position, size,
 *                           angle, appearance, Z order, hierarchy, effects,
 *                           picking, destroy), which allAces.json leaves out
 *
 * Only what validation needs is kept: each condition and action ID with its
 * parameter IDs, types and combo items, and each expression's name (the form
 * written inside parameter strings), parameter types and whether it takes a
 * variable number of arguments.
 */

import type { AceCatalog, AceParam, AceSet, ExpressionDef } from './ace-types.js';

/** The three files of one release, already read. */
export interface CatalogSources {
  /** Release name as it appears in a URL, e.g. r495-2. */
  release: string;
  /** Parsed plugins/allAces.json. */
  plugins: unknown;
  /** Parsed behaviors/allAces.json. */
  behaviors: unknown;
  /** The text of main.js. */
  mainJs: string;
}

/** Counts of what a catalogue holds. */
export interface CatalogCounts {
  plugins: number;
  behaviors: number;
  /** Conditions and actions of the plugins and behaviors, common ones excluded. */
  aces: number;
  /** Expressions of the plugins and behaviors, common ones excluded. */
  expressions: number;
  commonAces: number;
  commonExpressions: number;
}

/** A release name: r495, or r495-2 for a patch release. Nothing that could alter a URL or a path matches. */
export const RELEASE_PATTERN = /^r[1-9]\d{0,3}(?:-[1-9]\d?)?$/;

const REGISTRATION_MARKERS = ['c2id', 'scriptName', 'expressionName'];

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One ACE reduced to its parameter list. */
function params(ace: Record<string, unknown>): AceParam[] {
  const list = Array.isArray(ace.params) ? ace.params as unknown[] : [];
  const result: AceParam[] = [];
  for (const p of list) {
    if (!isRecord(p) || typeof p.id !== 'string') continue;
    const param: AceParam = { id: p.id, type: typeof p.type === 'string' ? p.type : 'any' };
    if (Array.isArray(p.items)) param.items = p.items as string[];
    result.push(param);
  }
  return result;
}

/** One expression reduced to what an expression string reveals: its name, parameter types, variadic flag. */
function expression(ace: Record<string, unknown>): ExpressionDef {
  const name = typeof ace.expressionName === 'string' ? ace.expressionName : String(ace.id);
  const entry: ExpressionDef = { name, params: params(ace).map(p => p.type) };
  if (ace.isVariadicParameters) entry.variadic = true;
  if (typeof ace.returnType === 'string') entry.returns = ace.returnType;
  return entry;
}

/** An addon's categories flattened to the catalogue's shape. */
function flatten(addon: unknown): AceSet {
  const result: AceSet = { conditions: {}, actions: {}, expressions: {} };
  if (!isRecord(addon)) return result;
  for (const category of Object.values(addon)) {
    if (!isRecord(category)) continue;
    for (const kind of ['conditions', 'actions'] as const) {
      const list = Array.isArray(category[kind]) ? category[kind] as unknown[] : [];
      for (const ace of list) if (isRecord(ace) && typeof ace.id === 'string') result[kind][ace.id] = params(ace);
    }
    const expressions = Array.isArray(category.expressions) ? category.expressions as unknown[] : [];
    for (const ace of expressions) if (isRecord(ace) && typeof ace.id === 'string') result.expressions[ace.id] = expression(ace);
  }
  return result;
}

/** The addons of one allAces.json, sorted by id. */
function flattenAddons(file: unknown, name: string): Record<string, AceSet> {
  if (!isRecord(file)) throw new Error(`${name} is not an object of addons`);
  return Object.fromEntries(
    Object.entries(file).sort(([a], [b]) => a.localeCompare(b)).map(([id, addon]) => [id, flatten(addon)]),
  );
}

/** End index of the bracket or brace that opens at `start`, skipping string literals; -1 when it never closes. */
function matchBracket(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === '\'' || c === '`') quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

/**
 * Rewrite a minified JavaScript object literal made only of data (strings in
 * either quote style, numbers such as .5, !0 and !1, bare keys, arrays and
 * objects) as JSON. Anything else, such as a call or a variable, throws.
 */
function literalToJson(src: string): string {
  let out = '';
  let i = 0;
  const expectKey: boolean[] = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === '\'') {
      let j = i + 1;
      let value = '';
      while (src[j] !== c) {
        if (j >= src.length) throw new Error('unterminated string');
        if (src[j] === '\\') {
          const e = src[j + 1] ?? '';
          value += ESCAPES[e] ?? e;
          j += 2;
        } else value += src[j++];
      }
      out += JSON.stringify(value);
      i = j + 1;
    } else if (c === '{' || c === '[') {
      expectKey.push(c === '{');
      out += c;
      i++;
    } else if (c === '}' || c === ']') {
      expectKey.pop();
      out += c;
      i++;
    } else if (c === ',' || c === ':') {
      out += c;
      i++;
    } else if (c === '!' && (src[i + 1] === '0' || src[i + 1] === '1')) {
      out += src[i + 1] === '0' ? 'true' : 'false';
      i += 2;
    } else if (/[-\d.]/.test(c)) {
      const num = /^-?\d*\.?\d+(?:e[-+]?\d+)?/i.exec(src.slice(i));
      if (!num) throw new Error(`unexpected "${c}" at "${src.slice(i, i + 30)}"`);
      out += String(Number(num[0]));
      i += num[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))?.[0] ?? c;
      const inObject = expectKey[expectKey.length - 1];
      if (inObject && src[i + word.length] === ':') out += JSON.stringify(word);
      else if (word === 'true' || word === 'false' || word === 'null') out += word;
      else throw new Error(`not a data literal at "${src.slice(i, i + 30)}"`);
      i += word.length;
    } else {
      throw new Error(`unexpected "${c}" at "${src.slice(i, i + 30)}"`);
    }
  }
  return out;
}

/**
 * The common ACEs: object literals of the form fn({id:"...",...}) in main.js,
 * written with their keys in any order. Every `<name>({` call is a candidate
 * when its text holds `id:` and a marker key; a candidate that is not a data
 * literal makes the catalogue unavailable rather than incomplete. It is a
 * registration when its own top-level keys hold a string `id` and a marker
 * (a marker only in a nested object does not count). The registering
 * function's minified name tells condition, action and expression apart; it
 * is identified from IDs whose kind is certain rather than hard-coded,
 * because it changes between releases.
 */
function commonAces(mainJs: string): AceSet {
  const found: Array<{ fn: string; ace: Record<string, unknown> }> = [];
  const call = /([A-Za-z_$][\w$]*)\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(mainJs))) {
    const start = m.index + m[1].length + 1;
    const end = matchBracket(mainJs, start);
    if (end < 0) continue;
    const text = mainJs.slice(start, end + 1);
    if (!text.includes('id:') || !REGISTRATION_MARKERS.some(key => text.includes(`${key}:`))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(literalToJson(text));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not read a common ACE registration near "${text.slice(0, 30)}": ${reason}`);
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string') continue;
    const ace = parsed;
    if (!REGISTRATION_MARKERS.some(key => key in ace)) continue;
    found.push({ fn: m[1], ace });
  }
  const kindOf: Record<string, keyof AceSet> = {
    'compare-instance-variable': 'conditions',
    'set-instvar-value': 'actions',
    'uid': 'expressions',
  };
  const fnKind: Record<string, keyof AceSet> = {};
  for (const { fn, ace } of found) {
    const kind = kindOf[ace.id as string];
    if (kind) fnKind[fn] = kind;
  }
  if (Object.values(fnKind).sort().join() !== 'actions,conditions,expressions') {
    throw new Error(`Could not tell the condition, action and expression registrations apart: ${JSON.stringify(fnKind)}`);
  }
  const result: AceSet = { conditions: {}, actions: {}, expressions: {} };
  for (const { fn, ace } of found) {
    const kind = fnKind[fn];
    if (kind === 'expressions') result.expressions[ace.id as string] = expression(ace);
    else if (kind) result[kind][ace.id as string] = params(ace);
  }
  return result;
}

/** Build the catalogue from the three files of one release. */
export function buildCatalog(sources: CatalogSources): AceCatalog {
  return {
    release: sources.release,
    plugins: flattenAddons(sources.plugins, 'plugins/allAces.json'),
    behaviors: flattenAddons(sources.behaviors, 'behaviors/allAces.json'),
    common: commonAces(sources.mainJs),
  };
}

/** How many addons, conditions, actions and expressions a catalogue holds. */
export function catalogCounts(catalog: AceCatalog): CatalogCounts {
  const groups = [catalog.plugins, catalog.behaviors];
  let aces = 0;
  let expressions = 0;
  for (const group of groups) {
    for (const set of Object.values(group)) {
      aces += Object.keys(set.conditions).length + Object.keys(set.actions).length;
      expressions += Object.keys(set.expressions).length;
    }
  }
  return {
    plugins: Object.keys(catalog.plugins).length,
    behaviors: Object.keys(catalog.behaviors).length,
    aces,
    expressions,
    commonAces: Object.keys(catalog.common.conditions).length + Object.keys(catalog.common.actions).length,
    commonExpressions: Object.keys(catalog.common.expressions).length,
  };
}

/**
 * The release a project was saved with, as the name used in the editor's
 * URLs: 49502 gives r495-2, 44000 gives r440. Anything that is not an
 * integer saved-with number of a plausible release gives undefined.
 */
export function releaseFromSaved(saved: unknown): string | undefined {
  if (typeof saved !== 'number' || !Number.isInteger(saved) || saved < 100 || saved >= 1000000) return undefined;
  const major = Math.floor(saved / 100);
  const minor = saved % 100;
  const release = minor === 0 ? `r${major}` : `r${major}-${minor}`;
  return RELEASE_PATTERN.test(release) ? release : undefined;
}

/** A release name as a number that orders releases: r495-2 and r495.2 give 49502, r440 gives 44000, anything else NaN. */
export function releaseNumber(release: string): number {
  const m = /^r([1-9]\d{0,3})(?:[-.]([1-9]\d?))?$/.exec(release);
  if (!m) return NaN;
  return Number(m[1]) * 100 + (m[2] ? Number(m[2]) : 0);
}

/** The release name as Construct shows it: r495-2 becomes r495.2. */
export function releaseLabel(release: string): string {
  return release.replace('-', '.');
}

/** True when `value` is a record whose every entry is an AceParam list. */
function isParamListRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(list => Array.isArray(list) && list.every(p =>
    isRecord(p) && typeof p.id === 'string' && typeof p.type === 'string'
    && (p.items === undefined || (Array.isArray(p.items) && p.items.every(item => typeof item === 'string')))));
}

/** True when `value` is a record whose every entry is an ExpressionDef. */
function isExpressionRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(e =>
    isRecord(e) && typeof e.name === 'string'
    && Array.isArray(e.params) && e.params.every(p => typeof p === 'string')
    && (e.variadic === undefined || typeof e.variadic === 'boolean')
    && (e.returns === undefined || typeof e.returns === 'string'));
}

/** True when `value` has the shape of an AceSet. */
function isAceSet(value: unknown): value is AceSet {
  return isRecord(value)
    && isParamListRecord(value.conditions)
    && isParamListRecord(value.actions)
    && isExpressionRecord(value.expressions);
}

/** True when `value` is a record whose every entry is an AceSet. */
function isAceSetRecord(value: unknown): value is Record<string, AceSet> {
  return isRecord(value) && Object.values(value).every(isAceSet);
}

/**
 * Whether `value` is a whole catalogue: a valid release name, every addon
 * well formed, and a System plugin with at least one condition, action and
 * expression, so a truncated or partial catalogue is not accepted.
 */
export function isAceCatalog(value: unknown): value is AceCatalog {
  if (!isRecord(value)) return false;
  if (typeof value.release !== 'string' || !RELEASE_PATTERN.test(value.release)) return false;
  if (!isAceSetRecord(value.plugins) || !isAceSetRecord(value.behaviors) || !isAceSet(value.common)) return false;
  const system = value.plugins.system;
  return system !== undefined
    && Object.keys(system.conditions).length > 0
    && Object.keys(system.actions).length > 0
    && Object.keys(system.expressions).length > 0;
}
