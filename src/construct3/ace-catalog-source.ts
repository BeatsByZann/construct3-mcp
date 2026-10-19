/**
 * Turn the ACE definitions a Construct release serves to its own editor into
 * the catalogue ACE validation uses.
 *
 * Three files of the editor are read, from editor.construct.net or from a local
 * copy, and stored as a per-user cache file:
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

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

/** The type of a parameter whose definition could not be read; the checks skip it. */
export const UNKNOWN_PARAM_TYPE = 'unknown';

/** Set an own, enumerable entry, also for a key such as __proto__ that plain assignment would take as the prototype. */
function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * One ACE reduced to its parameter list. A parameter that cannot be read (not
 * an object, no string id, no string type, or items that are not all strings)
 * keeps its position as an entry of unknown type, so the parameters after it
 * stay where they are.
 */
function params(ace: Record<string, unknown>): AceParam[] {
  const list: unknown[] = Array.isArray(ace.params) ? ace.params : [];
  return list.map((p): AceParam => {
    if (!isRecord(p)) return { id: '', type: UNKNOWN_PARAM_TYPE };
    const id = typeof p.id === 'string' ? p.id : '';
    if (typeof p.id !== 'string' || typeof p.type !== 'string') return { id, type: UNKNOWN_PARAM_TYPE };
    const param: AceParam = { id, type: p.type };
    if (p.items !== undefined) {
      if (!Array.isArray(p.items) || !p.items.every(item => typeof item === 'string')) return { id, type: UNKNOWN_PARAM_TYPE };
      param.items = p.items as string[];
    }
    return param;
  });
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
      const list: unknown[] = Array.isArray(category[kind]) ? category[kind] : [];
      for (const ace of list) if (isRecord(ace) && typeof ace.id === 'string') setOwn(result[kind], ace.id, params(ace));
    }
    const expressions: unknown[] = Array.isArray(category.expressions) ? category.expressions : [];
    for (const ace of expressions) if (isRecord(ace) && typeof ace.id === 'string') setOwn(result.expressions, ace.id, expression(ace));
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

/**
 * The names of the keys an object literal holds directly (depth one), found
 * without parsing: nested objects, arrays, calls and string values are
 * skipped, so a key of a nested object or a word inside a value is not
 * counted. `text` starts at the opening brace.
 */
function ownKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const word = /[A-Za-z_$][\w$]*/y;
  let depth = 0;
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === '\'' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && expectKey && c !== '`') {
        keys.add(text.slice(i + 1, j));
        expectKey = false;
      }
      i = j + 1;
    } else if (c === '{' || c === '[' || c === '(') {
      depth++;
      if (depth === 1) expectKey = true;
      i++;
    } else if (c === '}' || c === ']' || c === ')') {
      depth--;
      i++;
    } else if (c === ',' && depth === 1) {
      expectKey = true;
      i++;
    } else if (depth === 1 && expectKey && /[A-Za-z_$]/.test(c)) {
      word.lastIndex = i;
      const name = word.exec(text)?.[0] ?? c;
      keys.add(name);
      expectKey = false;
      i += name.length;
    } else i++;
  }
  return keys;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

/**
 * Rewrite a minified JavaScript object literal made only of data (strings in
 * either quote style, numbers such as .5, !0 and !1, bare keys, arrays and
 * objects) as JSON. Anything else, such as a call or a variable, throws.
 */
export function literalToJson(src: string): string {
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
    const keys = ownKeys(text);
    if (!keys.has('id') || !REGISTRATION_MARKERS.some(key => keys.has(key))) continue;
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
  const kindOf = new Map<string, keyof AceSet>([
    ['compare-instance-variable', 'conditions'],
    ['set-instvar-value', 'actions'],
    ['uid', 'expressions'],
  ]);
  const fnKind = new Map<string, keyof AceSet>();
  for (const { fn, ace } of found) {
    const kind = kindOf.get(ace.id as string);
    if (kind) fnKind.set(fn, kind);
  }
  if ([...fnKind.values()].sort().join() !== 'actions,conditions,expressions') {
    throw new Error(`Could not tell the condition, action and expression registrations apart: ${JSON.stringify(Object.fromEntries(fnKind))}`);
  }
  const result: AceSet = { conditions: {}, actions: {}, expressions: {} };
  for (const { fn, ace } of found) {
    const kind = fnKind.get(fn);
    if (kind === 'expressions') setOwn(result.expressions, ace.id as string, expression(ace));
    else if (kind) setOwn(result[kind], ace.id as string, params(ace));
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

/** The one host the catalogue sources are fetched from, always over HTTPS. */
export const ACE_SOURCE_HOST = 'editor.construct.net';
/** The three files, fetched in this order; the first decides whether a release is served. */
export const ACE_SOURCE_FILES = ['plugins/allAces.json', 'behaviors/allAces.json', 'main.js'] as const;
/** The release used when the project's own is not served or not recorded. */
export const FALLBACK_RELEASE = 'r495-2';
/** The most bytes read from one source file. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
/** The most bytes read from one cache file. */
export const MAX_CACHE_BYTES = 16 * 1024 * 1024;
/** How long one request may take, in milliseconds. */
export const FETCH_TIMEOUT_MS = 20_000;
/** How long the three requests of one attempt may take together, in milliseconds. */
export const FETCH_DEADLINE_MS = 60_000;
/** The most redirects followed for one file. */
export const MAX_REDIRECTS = 3;
/** The layout of a cache file; raised whenever the transform's output changes. */
export const CACHE_FORMAT = 2;

/** The part of fetch the catalogue needs; redirects are never followed by the platform. */
export type FetchLike = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;
/** The limits of one fetch, replaceable for tests. */
export interface SourceLimits { timeoutMs: number; deadlineMs: number; maxBytes: number }
/** Why no sources were obtained: the host could not be reached, answered unusably, or does not serve the release. */
export type SourceFailure = { ok: false; reason: 'offline' | 'refused' | 'not-served'; detail: string };
/** The three files of a release with each file's size in bytes, or why there are none. */
export type SourceResult = { ok: true; sources: CatalogSources; bytes: number[] } | SourceFailure;
/** What a cache file holds. */
export interface CacheEntry { format: typeof CACHE_FORMAT; sourceRelease: string; digest: string; catalog: AceCatalog }
/** Whether a cache file was written. */
export type CacheWriteOutcome = { written: true; path: string } | { written: false; reason: string };
/** A catalogue, or why none could be made. */
export type CatalogBuild = { ok: true; catalog: AceCatalog } | SourceFailure;

/** A failed result with a fixed detail. */
function failure(reason: SourceFailure['reason'], detail: string): SourceFailure {
  return { ok: false, reason, detail };
}

/** The URL of one source file of a release. Throws when the release is not a release name. */
export function sourceUrl(release: string, file: (typeof ACE_SOURCE_FILES)[number]): string {
  if (!RELEASE_PATTERN.test(release)) throw new Error('not a release name');
  return `https://${ACE_SOURCE_HOST}/${release}/${file}`;
}

/** The failure for an error thrown while requesting or reading: offline for a timeout or a network error, else refused. Only the error's code or name is kept. */
function failureFromError(error: unknown): SourceFailure {
  const name = error instanceof Error ? error.name : 'Error';
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const code = isRecord(cause) && typeof cause.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(cause.code) ? cause.code : name;
  if (error instanceof TypeError || name === 'AbortError' || name === 'TimeoutError') return failure('offline', code);
  return failure('refused', `unexpected error (${name})`);
}

/** Cancel a response body that will not be read. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is not wanted either way.
  }
}

/** Read a body through a counting reader, stopping once it is past `maxBytes`. */
async function readBody(response: Response, maxBytes: number): Promise<{ ok: true; text: string; size: number } | SourceFailure> {
  if (!response.body) return { ok: true, text: '', size: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return failure('refused', 'the file is too large');
      }
      chunks.push(value);
    }
  } catch (error) {
    return failureFromError(error);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8'), size };
}

/** Request one file, following redirects only to the same file of the same release on the one host. */
async function fetchOne(
  release: string,
  file: (typeof ACE_SOURCE_FILES)[number],
  first: boolean,
  fetchImpl: FetchLike,
  limits: SourceLimits,
  deadline: AbortSignal,
): Promise<{ ok: true; text: string; size: number } | SourceFailure> {
  const expectedPath = `/${release}/${file}`;
  let url = sourceUrl(release, file);
  for (let hops = 0; ; hops++) {
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(limits.timeoutMs), deadline]) });
    } catch (error) {
      return failureFromError(error);
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (location !== null) {
      await discard(response);
      if (hops >= MAX_REDIRECTS) return failure('refused', 'too many redirects');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return failure('refused', 'redirected to another host');
      }
      if (next.protocol !== 'https:' || next.host !== ACE_SOURCE_HOST || next.username !== '' || next.password !== '') {
        return failure('refused', 'redirected to another host');
      }
      if (next.pathname !== expectedPath) return failure('refused', 'redirected to another release or file');
      url = next.href;
      continue;
    }
    if (!response.ok) {
      await discard(response);
      if (response.status === 404 || response.status === 403) {
        return first ? failure('not-served', `${file} is not served`) : failure('refused', 'the release is only partly served');
      }
      return failure('refused', `HTTP ${response.status}`);
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > limits.maxBytes) {
      await discard(response);
      return failure('refused', 'the file is too large');
    }
    return readBody(response, limits.maxBytes);
  }
}

/** Parse the text of a source file that holds JSON. */
function parseSourceJson(text: string, file: string): { ok: true; value: unknown } | SourceFailure {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return failure('refused', `${file} is not valid JSON`);
  }
}

/**
 * Fetch the three files of a release one after another from the one host. The
 * first failure ends the attempt. `detail` of a failure is a fixed text plus a
 * file name, status or error code, never response text or a path.
 */
export async function fetchCatalogSources(release: string, fetchImpl: FetchLike, limits: Partial<SourceLimits> = {}): Promise<SourceResult> {
  if (!RELEASE_PATTERN.test(release)) return failure('refused', 'not a release name');
  const effective: SourceLimits = {
    timeoutMs: limits.timeoutMs ?? FETCH_TIMEOUT_MS,
    deadlineMs: limits.deadlineMs ?? FETCH_DEADLINE_MS,
    maxBytes: limits.maxBytes ?? MAX_SOURCE_BYTES,
  };
  const deadline = AbortSignal.timeout(effective.deadlineMs);
  const texts: string[] = [];
  const bytes: number[] = [];
  const parsed: unknown[] = [];
  for (const [index, file] of ACE_SOURCE_FILES.entries()) {
    const got = await fetchOne(release, file, index === 0, fetchImpl, effective, deadline);
    if (!got.ok) return got;
    texts.push(got.text);
    bytes.push(got.size);
    if (file !== 'main.js') {
      const json = parseSourceJson(got.text, file);
      if (!json.ok) return json;
      parsed.push(json.value);
    }
  }
  return { ok: true, sources: { release, plugins: parsed[0], behaviors: parsed[1], mainJs: texts[2] }, bytes };
}

/** Read the three files of a release from `<folder>/<release>/`. */
export async function readLocalSources(folder: string, release: string, maxBytes: number = MAX_SOURCE_BYTES): Promise<SourceResult> {
  if (!RELEASE_PATTERN.test(release)) return failure('refused', 'not a release name');
  const texts: string[] = [];
  const bytes: number[] = [];
  for (const [index, file] of ACE_SOURCE_FILES.entries()) {
    const where = path.join(folder, release, file);
    try {
      const size = (await stat(where)).size;
      if (size > maxBytes) return failure('refused', `${file} is too large`);
      texts.push(await readFile(where, 'utf8'));
      bytes.push(size);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return index === 0 ? failure('not-served', 'no local copy') : failure('refused', 'incomplete local copy');
      }
      return failure('refused', `${file} could not be read (${typeof code === 'string' ? code : 'error'})`);
    }
  }
  const plugins = parseSourceJson(texts[0], ACE_SOURCE_FILES[0]);
  if (!plugins.ok) return plugins;
  const behaviors = parseSourceJson(texts[1], ACE_SOURCE_FILES[1]);
  if (!behaviors.ok) return behaviors;
  return { ok: true, sources: { release, plugins: plugins.value, behaviors: behaviors.value, mainJs: texts[2] }, bytes };
}

/**
 * The one way a catalogue is made from source files, for fetched files, a
 * local folder and the build script alike: a failed result is returned as it
 * is, otherwise the sources are transformed and the result must have the shape
 * of a whole catalogue.
 */
export function catalogFromSources(result: SourceResult): CatalogBuild {
  if (!result.ok) return result;
  let catalog: AceCatalog;
  try {
    catalog = buildCatalog(result.sources);
  } catch (error) {
    console.error(`ACE catalogue: ${error instanceof Error ? error.message : String(error)}`);
    return failure('refused', 'the editor\'s files could not be read');
  }
  if (!isAceCatalog(catalog)) return failure('refused', 'the editor\'s files did not give a complete catalogue');
  return { ok: true, catalog };
}

/** The SHA-256 of a catalogue's JSON, in hex. It shows a cache file is what this server wrote; it does not resist a deliberate edit that recomputes it. */
export function catalogDigest(catalog: AceCatalog): string {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

/** The cache file of a release in `cacheDir`. Throws when the release is not a release name. */
export function cacheFilePath(cacheDir: string, release: string): string {
  if (!RELEASE_PATTERN.test(release)) throw new Error('not a release name');
  return path.join(cacheDir, `${release}.json`);
}

/**
 * The catalogue a cache file holds, or undefined when the file is absent or
 * cannot be trusted; a file that exists and fails a check is named on stderr
 * and is replaced by the next successful build. Nothing of it is partly used.
 */
export async function readCacheFile(cacheDir: string, release: string): Promise<AceCatalog | undefined> {
  const file = cacheFilePath(cacheDir, release);
  let text: string;
  try {
    const size = (await stat(file)).size;
    if (size > MAX_CACHE_BYTES) return rejectCache(file);
    text = await readFile(file, 'utf8');
  } catch (error) {
    return (error as { code?: unknown }).code === 'ENOENT' ? undefined : rejectCache(file);
  }
  let entry: unknown;
  try {
    entry = JSON.parse(text) as unknown;
  } catch {
    return rejectCache(file);
  }
  if (!isRecord(entry) || entry.format !== CACHE_FORMAT || entry.sourceRelease !== release) return rejectCache(file);
  const catalog = entry.catalog;
  if (!isAceCatalog(catalog) || catalog.release !== release) return rejectCache(file);
  if (entry.digest !== catalogDigest(catalog)) return rejectCache(file);
  return catalog;
}

/** Name an untrusted cache file on stderr; always undefined. */
function rejectCache(file: string): undefined {
  console.error(`${path.basename(file)} is not a valid ACE catalogue; rebuilding`);
  return undefined;
}

/** The failure detail for a cache folder that is not an absolute path. */
export const CACHE_DIR_NOT_ABSOLUTE = 'the cache folder is not an absolute path';

/** Remove the temporary cache files this process left in `cacheDir` for `release`. */
async function removeOwnTempFiles(cacheDir: string, release: string): Promise<void> {
  const own = new RegExp(`^${release}\\.json\\.${process.pid}-[0-9a-f]{8}\\.tmp$`);
  try {
    for (const name of await readdir(cacheDir)) if (own.test(name)) await rm(path.join(cacheDir, name), { force: true });
  } catch {
    // The folder may not exist; nothing was left behind.
  }
}

/**
 * Write a catalogue to its cache file through a temporary file in the same
 * folder and a rename, so another process sees the old file or the new one.
 * Never throws, also for a release that is not a release name: a failure
 * returns a reason made of a fixed text and the error code, after removing the
 * temporary files this process left in the folder. An entry over
 * MAX_CACHE_BYTES is not written, because the next read would reject it.
 */
export async function writeCacheFile(cacheDir: string, release: string, catalog: AceCatalog): Promise<CacheWriteOutcome> {
  try {
    const file = cacheFilePath(cacheDir, release);
    const temp = path.join(cacheDir, `${release}.json.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
    const entry: CacheEntry = { format: CACHE_FORMAT, sourceRelease: release, digest: catalogDigest(catalog), catalog };
    const text = JSON.stringify(entry);
    if (Buffer.byteLength(text) > MAX_CACHE_BYTES) return { written: false, reason: 'the catalogue is too large to cache' };
    await mkdir(cacheDir, { recursive: true });
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
    return { written: true, path: file };
  } catch (error) {
    await removeOwnTempFiles(cacheDir, release);
    const code = (error as { code?: unknown }).code;
    return { written: false, reason: `the cache file could not be written (${typeof code === 'string' ? code : 'error'})` };
  }
}

/**
 * The per-user folder of the cache files: C3_ACE_CACHE_DIR when it is set,
 * else the platform's cache folder (LOCALAPPDATA or <home>\AppData\Local,
 * <home>/Library/Caches, XDG_CACHE_HOME when absolute or <home>/.cache), then
 * construct3-mcp/ace-catalog. The result is not made absolute: when
 * C3_ACE_CACHE_DIR, LOCALAPPDATA or the home folder is relative, so is the
 * result, and the caller refuses it.
 */
export function defaultAceCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.C3_ACE_CACHE_DIR) return env.C3_ACE_CACHE_DIR;
  let base: string;
  if (platform === 'win32') base = env.LOCALAPPDATA ? env.LOCALAPPDATA : p.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = p.join(home, 'Library', 'Caches');
  else base = env.XDG_CACHE_HOME && p.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : p.join(home, '.cache');
  return p.join(base, 'construct3-mcp', 'ace-catalog');
}

/** What runBuildCatalog needs from its caller. */
export interface BuildCatalogDeps {
  fetch: FetchLike;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  out(line: string): void;
  err(line: string): void;
}

const BUILD_USAGE = 'Usage: build-ace-catalog <release> [--from <folder>] [--out <file>]';

/**
 * The build script: make the cache file of one release from the editor's
 * files (fetched, or read from `--from`). Returns 0 when the file was
 * written, 1 for a source failure or a failed write, 2 for a usage error.
 * It prints nothing taken from the files.
 */
export async function runBuildCatalog(args: readonly string[], deps: BuildCatalogDeps): Promise<0 | 1 | 2> {
  const [release, ...rest] = args;
  let from: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (rest[i] === '--from' && value !== undefined && from === undefined) from = value;
    else if (rest[i] === '--out' && value !== undefined && out === undefined) out = value;
    else {
      deps.err(BUILD_USAGE);
      return 2;
    }
  }
  if (release === undefined || !RELEASE_PATTERN.test(release)) {
    deps.err(`${release === undefined ? 'No release given' : 'Not a release name'}. ${BUILD_USAGE}`);
    return 2;
  }
  if (out !== undefined && path.basename(out) !== `${release}.json`) {
    deps.err(`--out must name a file called ${release}.json. ${BUILD_USAGE}`);
    return 2;
  }
  const defaultDir = defaultAceCacheDir(deps.env, deps.platform, deps.home);
  if (out === undefined && !(deps.platform === 'win32' ? path.win32 : path.posix).isAbsolute(defaultDir)) {
    deps.err(`${CACHE_DIR_NOT_ABSOLUTE}. Set C3_ACE_CACHE_DIR to an absolute path.`);
    return 1;
  }
  const started = Date.now();
  const result = from !== undefined ? await readLocalSources(from, release) : await fetchCatalogSources(release, deps.fetch);
  const built = catalogFromSources(result);
  if (!built.ok || !result.ok) {
    deps.err(built.ok ? 'No sources.' : `${built.reason}: ${built.detail}`);
    return 1;
  }
  const cacheDir = out !== undefined ? path.dirname(out) : defaultDir;
  const written = await writeCacheFile(cacheDir, release, built.catalog);
  if (!written.written) {
    deps.err(written.reason);
    return 1;
  }
  deps.out(`Wrote ${written.path}`);
  ACE_SOURCE_FILES.forEach((file, index) => deps.out(`${file}: ${result.bytes[index]} bytes`));
  for (const [name, count] of Object.entries(catalogCounts(built.catalog))) deps.out(`${name}: ${count}`);
  deps.out(`built in ${Date.now() - started} ms`);
  return 0;
}
