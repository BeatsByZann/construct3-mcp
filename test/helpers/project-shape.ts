import { expect } from 'vitest';

/** A parsed project.c3proj. */
export type ProjectJson = Record<string, unknown>;

/**
 * What a project saved by a release before 49502 looks like after the
 * writer updated it: the property order, the models3d folder, the same
 * addons plus `addonDelta`, and the release it was saved with.
 */
export function expectShaped(project: ProjectJson, before: ProjectJson, options: { addonDelta?: number } = {}): void {
  const keys = Object.keys(project.properties as Record<string, unknown>);
  expect(keys[keys.length - 1]).toBe('scriptsType');
  expect(keys.indexOf('uidAllocationMode')).toBe(keys.indexOf('preloadSounds') + 1);
  expect(project.models3d).toEqual({ items: [], subfolders: [] });
  const scripts = (project.rootFileFolders as { script: { items: Array<Record<string, unknown>> } }).script.items;
  for (const item of scripts) expect('file-info' in item).toBe(false);
  expect(project.usedAddons as unknown[]).toHaveLength((before.usedAddons as unknown[]).length + (options.addonDelta ?? 0));
  expect(project.savedWithRelease).toBe(before.savedWithRelease);
}

/**
 * A copy of the `c3-loadable-minimal` project.c3proj brought to the r495.2
 * save shape by hand, without the production module: `uidAllocationMode`
 * follows `preloadSounds`, `scriptsType` ends `properties`, script entries
 * carry `script-info`, and an empty `models3d` folder follows `flowcharts`.
 * An independent expectation for tests that need a project already in the
 * shape, so they also run on a branch that lacks `project-shape.ts`.
 */
export function shapeByHand(before: ProjectJson): ProjectJson {
  const project = structuredClone(before);
  const properties = project.properties as Record<string, unknown>;
  const ordered: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'uidAllocationMode' || key === 'scriptsType') continue;
    ordered.push([key, value]);
    if (key === 'preloadSounds') ordered.push(['uidAllocationMode', properties.uidAllocationMode]);
  }
  ordered.push(['scriptsType', properties.scriptsType]);
  project.properties = Object.fromEntries(ordered);

  const script = (project.rootFileFolders as { script: { items: Array<Record<string, unknown>> } }).script;
  script.items = script.items.map(item => Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key === 'file-info' ? 'script-info' : key, value]),
  ));

  const withModels: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(project)) {
    withModels.push([key, value]);
    if (key === 'flowcharts') withModels.push(['models3d', { items: [], subfolders: [] }]);
  }
  return Object.fromEntries(withModels);
}
