/**
 * Tests for project-shape.ts: bringing a parsed project.c3proj saved by an
 * older Construct release to the shape the r495.2 editor saves.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripBom } from '../../src/construct3/json-format.js';
import { SHAPE_BASELINE_RELEASE, upgradeProjectShape } from '../../src/construct3/project-shape.js';
import { shapeByHand, type ProjectJson } from '../helpers/project-shape.js';

const FIXTURES = join(__dirname, '..', 'fixtures');

/** A fresh parse of a fixture's project.c3proj, BOM stripped. */
function loadFixture(name: string): ProjectJson {
  return JSON.parse(stripBom(readFileSync(join(FIXTURES, name, 'project.c3proj'), 'utf8'))) as ProjectJson;
}

/** The same value with every object's keys sorted, so key order does not matter. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

/** The properties of a project as an object. */
function propsOf(project: ProjectJson): Record<string, unknown> {
  return project.properties as Record<string, unknown>;
}

/** The script items of a project's root script folder. */
function scriptItems(project: ProjectJson): Array<Record<string, unknown>> {
  return (project.rootFileFolders as { script: { items: Array<Record<string, unknown>> } }).script.items;
}

/** `properties` with `key` moved to the end. */
function withKeyLast(project: ProjectJson, key: string): void {
  const properties = propsOf(project);
  const value = properties[key];
  delete properties[key];
  properties[key] = value;
}

describe('upgradeProjectShape', () => {
  it('B1: brings the release-44903 fixture to the shape and changes nothing else', () => {
    const fixture = loadFixture('c3-loadable-minimal');
    expect(fixture.savedWithRelease).toBeLessThan(SHAPE_BASELINE_RELEASE);
    const project = structuredClone(fixture);

    const changes = upgradeProjectShape(project);

    const keys = Object.keys(propsOf(project));
    expect(keys.indexOf('uidAllocationMode')).toBe(keys.indexOf('preloadSounds') + 1);
    expect(keys[keys.length - 1]).toBe('scriptsType');
    expect(Object.keys(scriptItems(project)[0]!)).toEqual(['name', 'type', 'sid', 'script-info']);
    expect(scriptItems(project)[0]!['script-info']).toEqual({ purpose: 'none' });
    expect(project.models3d).toEqual({ items: [], subfolders: [] });
    const top = Object.keys(project);
    expect(top.indexOf('models3d')).toBe(top.indexOf('flowcharts') + 1);
    expect(propsOf(project).zAxisScale).toBe('normalized');
    expect((project.usedAddons as unknown[]).length).toBe(23);
    expect(project.savedWithRelease).toBe(fixture.savedWithRelease);

    const expected = structuredClone(fixture);
    expected.models3d = { items: [], subfolders: [] };
    const item = scriptItems(expected)[0]!;
    item['script-info'] = item['file-info'];
    delete item['file-info'];
    expect(sortKeys(project)).toEqual(sortKeys(expected));

    expect(changes).toEqual([
      'scripts: script "c3-runtime-bridge.js" file-info renamed to script-info',
      'models3d folder added',
      'properties.uidAllocationMode moved after preloadSounds',
      'properties.scriptsType moved to the end',
    ]);
    expect(JSON.stringify(project)).toBe(JSON.stringify(shapeByHand(fixture)));
  });

  it('B2: leaves zAxisScale as saved, whatever the release', () => {
    const base = loadFixture('c3-loadable-minimal');
    const cases: Array<{ release: number; zAxisScale: string }> = [
      { release: 44903, zAxisScale: 'normalized' },
      { release: 44000, zAxisScale: 'normalized' },
      { release: 44903, zAxisScale: 'regular' },
    ];
    for (const { release, zAxisScale } of cases) {
      const project = structuredClone(base);
      project.savedWithRelease = release;
      propsOf(project).zAxisScale = zAxisScale;
      const changes = upgradeProjectShape(project);
      expect(propsOf(project).zAxisScale).toBe(zAxisScale);
      expect(changes.filter(line => line.includes('zAxisScale'))).toEqual([]);
    }
  });

  it('B3: a second run changes nothing', () => {
    const project = loadFixture('c3-loadable-minimal');
    upgradeProjectShape(project);
    const once = JSON.stringify(project);
    expect(upgradeProjectShape(project)).toEqual([]);
    expect(JSON.stringify(project)).toBe(once);
  });

  it('B4: places models3d after flowcharts, else before properties, else at the end, and leaves an existing one', () => {
    const withFlowcharts = loadFixture('c3-loadable-minimal');
    upgradeProjectShape(withFlowcharts);
    const keys = Object.keys(withFlowcharts);
    expect(keys[keys.indexOf('flowcharts') + 1]).toBe('models3d');

    const noFlowcharts = loadFixture('minimal-project');
    expect('flowcharts' in noFlowcharts).toBe(false);
    upgradeProjectShape(noFlowcharts);
    const noFlowKeys = Object.keys(noFlowcharts);
    expect(noFlowKeys[noFlowKeys.indexOf('properties') - 1]).toBe('models3d');

    const neither: ProjectJson = { name: 'x', savedWithRelease: 49502 };
    expect(upgradeProjectShape(neither)).toEqual(['models3d folder added']);
    expect(Object.keys(neither)).toEqual(['name', 'savedWithRelease', 'models3d']);

    const existing: ProjectJson = {
      models3d: { items: ['m.glb'], subfolders: [] },
      flowcharts: { items: [], subfolders: [] },
      name: 'x',
    };
    expect(upgradeProjectShape(existing)).toEqual([]);
    expect(Object.keys(existing)).toEqual(['models3d', 'flowcharts', 'name']);
    expect(existing.models3d).toEqual({ items: ['m.glb'], subfolders: [] });
  });

  it('B5: renames file-info to script-info at every depth, with the path in the line', () => {
    const project = loadFixture('minimal-project');
    const script = (project.rootFileFolders as Record<string, { items: unknown[]; subfolders: unknown[] }>).script!;
    script.items = [{ name: 'top.js', type: 'application/javascript', sid: 1, 'file-info': { purpose: 'none' } }];
    script.subfolders = [{
      name: 'Sub',
      items: [{ name: 'mid.js', type: 'application/javascript', sid: 2, 'file-info': { purpose: 'none' } }],
      subfolders: [{
        name: 'Deep',
        items: [
          { name: 'deep.js', type: 'application/javascript', sid: 3, 'file-info': { purpose: 'none' } },
          { name: 'both.js', type: 'application/javascript', sid: 4, 'file-info': { purpose: 'a' }, 'script-info': { purpose: 'b' } },
        ],
        subfolders: [],
      }],
    }];
    const general = (project.rootFileFolders as Record<string, { items: unknown[] }>).general!;
    general.items = [{ name: 'data.json', type: 'application/json', sid: 5, 'file-info': { purpose: 'none' } }];

    const changes = upgradeProjectShape(project);

    expect(changes.filter(line => line.includes('renamed'))).toEqual([
      'scripts: script "top.js" file-info renamed to script-info',
      'scripts/Sub: script "mid.js" file-info renamed to script-info',
      'scripts/Sub/Deep: script "deep.js" file-info renamed to script-info',
    ]);
    expect(Object.keys(scriptItems(project)[0]!)).toEqual(['name', 'type', 'sid', 'script-info']);
    const deep = (script.subfolders[0] as { subfolders: Array<{ items: Array<Record<string, unknown>> }> }).subfolders[0]!;
    expect(Object.keys(deep.items[0]!)).toEqual(['name', 'type', 'sid', 'script-info']);
    expect(deep.items[1]).toEqual({
      name: 'both.js', type: 'application/javascript', sid: 4, 'file-info': { purpose: 'a' }, 'script-info': { purpose: 'b' },
    });
    expect(Object.keys(general.items[0] as Record<string, unknown>)).toEqual(['name', 'type', 'sid', 'file-info']);
  });

  it('B6: leaves a project already in the shape alone, and gates property order at the baseline release', () => {
    const fixture = loadFixture('c3-loadable-minimal');
    const shaped = shapeByHand(fixture);
    shaped.savedWithRelease = SHAPE_BASELINE_RELEASE;
    const before = JSON.stringify(shaped);
    expect(upgradeProjectShape(shaped)).toEqual([]);
    expect(JSON.stringify(shaped)).toBe(before);

    const newer = shapeByHand(fixture);
    newer.savedWithRelease = 49700;
    withKeyLast(newer, 'uidAllocationMode');
    const newerBefore = JSON.stringify(newer);
    expect(upgradeProjectShape(newer)).toEqual([]);
    expect(JSON.stringify(newer)).toBe(newerBefore);

    const below = shapeByHand(fixture);
    below.savedWithRelease = SHAPE_BASELINE_RELEASE - 1;
    withKeyLast(below, 'uidAllocationMode');
    expect(upgradeProjectShape(below)).toEqual(['properties.uidAllocationMode moved after preloadSounds']);
    expect(Object.keys(propsOf(below)).at(-1)).toBe('scriptsType');

    const at = shapeByHand(fixture);
    at.savedWithRelease = SHAPE_BASELINE_RELEASE;
    withKeyLast(at, 'uidAllocationMode');
    const atBefore = JSON.stringify(at);
    expect(upgradeProjectShape(at)).toEqual([]);
    expect(JSON.stringify(at)).toBe(atBefore);
  });

  it('B8: does not invent a property that is missing or move one whose anchor is missing', () => {
    const noUid: ProjectJson = {
      savedWithRelease: 44000,
      models3d: { items: [], subfolders: [] },
      properties: { a: 1, scriptsType: 'module', b: 2 },
    };
    expect(upgradeProjectShape(noUid)).toEqual(['properties.scriptsType moved to the end']);
    expect(JSON.stringify(noUid.properties)).toBe('{"a":1,"b":2,"scriptsType":"module"}');

    const noAnchor: ProjectJson = {
      savedWithRelease: 44000,
      models3d: { items: [], subfolders: [] },
      properties: { a: 1, uidAllocationMode: 'increment', b: 2 },
    };
    expect(upgradeProjectShape(noAnchor)).toEqual([]);
    expect(JSON.stringify(noAnchor.properties)).toBe('{"a":1,"uidAllocationMode":"increment","b":2}');
  });

  it('B7: does not throw on a malformed project', () => {
    const cases: ProjectJson[] = [
      {},
      { savedWithRelease: 44000 },
      { properties: 'text' },
      { rootFileFolders: { script: 'x' } },
      { savedWithRelease: 44000, properties: 'text', rootFileFolders: { script: 'x' } },
      { rootFileFolders: 'text', models3d: 'text' },
    ];
    for (const project of cases) {
      let changes: string[] = [];
      expect(() => { changes = upgradeProjectShape(project); }).not.toThrow();
      expect(changes.every(line => line === 'models3d folder added')).toBe(true);
    }
  });
});
