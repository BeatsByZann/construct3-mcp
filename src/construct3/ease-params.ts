/**
 * Custom eases inside event-sheet ACE parameters.
 *
 * A Tween action written with a bare custom ease name (`ease: "Bouncy"`) was
 * loaded by Construct r495.2 and saved back (W90 live round trip,
 * 2026-09-17) with the parameter as an object that embeds the ease, like a
 * timeline's `transitionsData` entry:
 *
 *   "ease": { "name": "Bouncy", "json": [ { "folders": [], "json": <ease file> } ] }
 *
 * Built-in ease names stay plain strings (63 `ease` parameters in the example
 * packages and C3-ACE, all built-in and all strings). No other ACE parameter
 * in those samples holds an object: the only non-string values are numbers
 * and booleans (`comparison`, `create-hierarchy`, `transform-*`, ...).
 */

import { readFile } from 'fs/promises';
import { resolveProjectPath } from './path-utils.js';
import { EASES_DIRECTORY, easesFolder, isBuiltinEaseName, type CustomEase } from './timeline-model.js';

/** Parameter key that names an ease in the sampled ACEs (Tween actions). */
export const EASE_PARAMETER_KEY = 'ease';

export interface EmbeddedEaseParameter {
  name: string;
  json: Array<{ folders: unknown[]; json: CustomEase }>;
}

/** Custom eases registered in a project, read from timelines/transitions/. */
export async function loadCustomEases(
  projectDir: string,
  timelinesContainer: { subfolders?: unknown[] } | undefined,
): Promise<Map<string, CustomEase>> {
  const eases = new Map<string, CustomEase>();
  for (const name of easesFolder(timelinesContainer)?.items ?? []) {
    try {
      const ease = JSON.parse(await readFile(resolveProjectPath(projectDir, 'timelines', EASES_DIRECTORY, `${name}.json`), 'utf-8')) as CustomEase;
      if (ease && typeof ease === 'object' && Array.isArray(ease.transitionKeyframes)) eases.set(name, ease);
    } catch { /* an unreadable ease file is reported by list_eases */ }
  }
  return eases;
}

/** The parameter value Construct stores for a custom ease. */
export function easeParameterValue(ease: CustomEase): EmbeddedEaseParameter {
  return { name: ease.name, json: [{ folders: [], json: structuredClone(ease) }] };
}

/** The ease a parameter value names: the string itself or the embedded object's name. */
export function easeParameterName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/** True when a parameters object names a non-built-in ease as a bare string, so eases must be read. */
export function needsEaseLookup(parameters: unknown): boolean {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
  const value = (parameters as Record<string, unknown>)[EASE_PARAMETER_KEY];
  return typeof value === 'string' && !isBuiltinEaseName(value);
}

/**
 * Replace a bare custom ease name in `parameters.ease` with the embedded
 * object, keeping the key's position. Returns the ease name when it did.
 */
export function embedCustomEase(parameters: unknown, eases: Map<string, CustomEase>): string | undefined {
  if (!needsEaseLookup(parameters)) return undefined;
  const record = parameters as Record<string, unknown>;
  const ease = eases.get(record[EASE_PARAMETER_KEY] as string);
  if (!ease) return undefined;
  record[EASE_PARAMETER_KEY] = easeParameterValue(ease);
  return ease.name;
}

/** Every ACE `parameters` object in a JSON tree that has an `ease` key. */
export function forEachEaseParameter(
  root: unknown,
  visit: (parameters: Record<string, unknown>) => void,
): void {
  const stack: unknown[] = [root];
  let guard = 0;
  while (stack.length > 0) {
    if (++guard > 2_000_000) throw new Error('Event sheet walk exceeded the node limit.');
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const params = record.parameters;
    if (params && typeof params === 'object' && !Array.isArray(params)
      && Object.prototype.hasOwnProperty.call(params, EASE_PARAMETER_KEY)) {
      visit(params as Record<string, unknown>);
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'parameters' && value && typeof value === 'object') stack.push(value);
    }
  }
}
