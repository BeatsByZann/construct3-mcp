/**
 * Third-party addon definitions for ACE validation.
 *
 * The built-in catalogue (ace-catalog-data.ts) knows Construct's own plugins
 * and behaviors. A third-party addon ships the same kind of definition in
 * its own `aces.json` beside `addon.json`, either unpacked in a folder or
 * packed as a `.c3addon` (a zip). This module reads those files and keeps
 * what validation needs in a process-wide registry, which `checkAce`
 * consults when an ACE's owner is not in the built-in catalogue.
 *
 * Sources are loaded at startup from the `C3_ADDON_DEFINITIONS` variable
 * (paths separated by the platform's path delimiter) and at any time by the
 * `load_addon_definitions` tool. A path may be an addon folder, a `.c3addon`
 * file, or a folder holding several of either.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { readZip } from '../runtime/zip-reader.js';
import type { AceParam, AceSet, ExpressionDef } from './ace-catalog.js';

export interface AddonDefinition {
  id: string;
  type: 'plugin' | 'behavior';
  name: string;
  version?: string;
  /** Where it was read from. */
  source: string;
  /** Conditions, actions and expressions, in the catalogue's shape. */
  aces: AceSet;
  counts: { conditions: number; actions: number; expressions: number };
}

export interface LoadReport {
  loaded: Array<Omit<AddonDefinition, 'aces'>>;
  skipped: Array<{ path: string; reason: string }>;
}

const registry = new Map<string, AddonDefinition>();

/** Definitions loaded so far, by "<type>:<id>". */
export function loadedAddonDefinitions(): AddonDefinition[] {
  return [...registry.values()];
}

export function addonDefinition(type: 'plugin' | 'behavior', id: string): AddonDefinition | undefined {
  return registry.get(`${type}:${id}`);
}

/** Forget every loaded definition (tests). */
export function clearAddonDefinitions(): void {
  registry.clear();
}

function parseJson(text: string, what: string): unknown {
  // Some addons save their JSON with a byte-order mark, which JSON.parse refuses.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(clean);
  } catch (error) {
    throw new Error(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function params(ace: Record<string, unknown>): AceParam[] {
  const list = Array.isArray(ace.params) ? ace.params as Array<Record<string, unknown>> : [];
  return list
    .filter(p => typeof p.id === 'string')
    .map(p => {
      const param: AceParam = { id: p.id as string, type: typeof p.type === 'string' ? p.type as string : 'any' };
      if (Array.isArray(p.items)) param.items = (p.items as unknown[]).filter((i): i is string => typeof i === 'string');
      return param;
    });
}

/** Build a definition from the two files' contents. */
export function parseAddonDefinition(addonJson: string, acesJson: string, source: string): AddonDefinition {
  const addon = parseJson(addonJson, 'addon.json') as Record<string, unknown>;
  if (!addon || typeof addon !== 'object') throw new Error('addon.json is not an object');
  const type = addon.type;
  if (type !== 'plugin' && type !== 'behavior') {
    throw new Error(`addon.json declares type ${JSON.stringify(type)}; only plugins and behaviors define conditions and actions`);
  }
  if (typeof addon.id !== 'string' || addon.id.length === 0) throw new Error('addon.json has no id');
  const aces = parseJson(acesJson, 'aces.json') as Record<string, unknown>;
  if (!aces || typeof aces !== 'object') throw new Error('aces.json is not an object');
  const set: AceSet = { conditions: {}, actions: {}, expressions: {} };
  for (const value of Object.values(aces)) {
    // A category is an object; the "$schema" entry is a string and falls out here.
    if (!value || typeof value !== 'object') continue;
    const group = value as Record<string, unknown>;
    for (const kind of ['conditions', 'actions'] as const) {
      for (const ace of Array.isArray(group[kind]) ? group[kind] as Array<Record<string, unknown>> : []) {
        if (typeof ace.id === 'string') set[kind][ace.id] = params(ace);
      }
    }
    for (const ace of Array.isArray(group.expressions) ? group.expressions as Array<Record<string, unknown>> : []) {
      if (typeof ace.id !== 'string') continue;
      const def: ExpressionDef = {
        name: typeof ace.expressionName === 'string' ? ace.expressionName : ace.id,
        params: params(ace).map(p => p.type),
      };
      if (ace.isVariadicParameters === true) def.variadic = true;
      if (typeof ace.returnType === 'string') def.returns = ace.returnType;
      set.expressions[ace.id] = def;
    }
  }
  return {
    id: addon.id,
    type,
    name: typeof addon.name === 'string' ? addon.name : addon.id,
    version: typeof addon.version === 'string' ? addon.version : undefined,
    source,
    aces: set,
    counts: {
      conditions: Object.keys(set.conditions).length,
      actions: Object.keys(set.actions).length,
      expressions: Object.keys(set.expressions).length,
    },
  };
}

function register(definition: AddonDefinition, report: LoadReport): void {
  registry.set(`${definition.type}:${definition.id}`, definition);
  const { aces: _aces, ...summary } = definition;
  report.loaded.push(summary);
}

async function loadFolder(folder: string, report: LoadReport): Promise<void> {
  const [addonJson, acesJson] = await Promise.all([
    readFile(join(folder, 'addon.json'), 'utf8'),
    readFile(join(folder, 'aces.json'), 'utf8'),
  ]);
  register(parseAddonDefinition(addonJson, acesJson, folder), report);
}

async function loadArchive(file: string, report: LoadReport): Promise<void> {
  const entries = readZip(await readFile(file));
  // The two files sit at the root of a .c3addon, or under one folder.
  const find = (name: string) => entries.find(e => e.path === name || e.path.endsWith('/' + name));
  const addon = find('addon.json');
  const aces = find('aces.json');
  if (!addon) throw new Error('no addon.json in the archive');
  if (!aces) throw new Error('no aces.json in the archive');
  register(parseAddonDefinition(addon.data.toString('utf8'), aces.data.toString('utf8'), file), report);
}

async function isAddonFolder(folder: string): Promise<boolean> {
  try {
    await stat(join(folder, 'addon.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the definitions at `path`: an addon folder, a `.c3addon`, or a folder
 * holding several of either (one level deep). Every failure is reported and
 * does not stop the others.
 */
export async function loadAddonDefinitions(path: string): Promise<LoadReport> {
  const report: LoadReport = { loaded: [], skipped: [] };
  const target = resolve(path);
  let info;
  try {
    info = await stat(target);
  } catch {
    report.skipped.push({ path: target, reason: 'not found' });
    return report;
  }
  const attempt = async (item: string, load: (p: string, r: LoadReport) => Promise<void>) => {
    try {
      await load(item, report);
    } catch (error) {
      report.skipped.push({ path: item, reason: error instanceof Error ? error.message : String(error) });
    }
  };
  if (info.isFile()) {
    if (extname(target).toLowerCase() === '.c3addon') await attempt(target, loadArchive);
    else report.skipped.push({ path: target, reason: 'not a .c3addon file or an addon folder' });
    return report;
  }
  if (await isAddonFolder(target)) {
    await attempt(target, loadFolder);
    return report;
  }
  let found = 0;
  for (const name of (await readdir(target)).sort()) {
    const item = join(target, name);
    let itemInfo;
    try {
      itemInfo = await stat(item);
    } catch {
      continue;
    }
    if (itemInfo.isFile() && extname(name).toLowerCase() === '.c3addon') {
      found++;
      await attempt(item, loadArchive);
    } else if (itemInfo.isDirectory() && await isAddonFolder(item)) {
      found++;
      await attempt(item, loadFolder);
    }
  }
  if (found === 0) {
    report.skipped.push({ path: target, reason: `no addon.json and no .c3addon under ${basename(target)}` });
  }
  return report;
}

/** Load every path in `C3_ADDON_DEFINITIONS` (path-delimiter separated); returns the combined report. */
export async function loadAddonDefinitionsFromEnv(value: string | undefined, delimiter: string): Promise<LoadReport> {
  const report: LoadReport = { loaded: [], skipped: [] };
  if (!value) return report;
  for (const path of value.split(delimiter).map(p => p.trim()).filter(Boolean)) {
    const part = await loadAddonDefinitions(path);
    report.loaded.push(...part.loaded);
    report.skipped.push(...part.skipped);
  }
  return report;
}
