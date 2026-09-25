/**
 * Roadmap C5 (HANDOFF W94): project.c3proj written by an older release is
 * brought to the shape the r495.2 editor saves, without pruning usedAddons,
 * without touching zAxisScale, and without reordering a newer release's file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { upgradeProjectShape, SHAPE_BASELINE_RELEASE, Z_AXIS_SCALE_MIGRATED_RELEASE } from '../../src/construct3/project-shape.js';

type Json = Record<string, any>;

const fixture = (name: string): Json =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', name, 'project.c3proj'), 'utf-8').replace(/^﻿/, ''));

/**
 * `properties` key order in the r495.2 editor's save of c3-loadable-minimal
 * (W90 round trip, reports/2026-09-17-w90-construct3-mcp-parity-tiers-evidence/w90-roundtrip3.txt),
 * for the keys the fixture and the save share.
 */
const R495_PROPERTY_ORDER = [
  'description', 'version', 'autoIncrementVersion', 'author', 'authorEmail', 'authorWebsite', 'appId',
  'pixelRounding', 'zAxisScale', 'fov', 'useLoaderLayout', 'fullscreenMode', 'fullscreenQuality',
  'viewportFit', 'backgroundColor', 'splashColor', 'useThemeColor', 'themeColor', 'orientations', 'webgpu',
  'multitexturing', 'gpuPreference', 'framerateMode', 'sampling', 'downscaling', 'renderingMode',
  'anisotropicFiltering', 'zNear', 'zFar', 'maxSpriteSheetSize', 'loaderStyle', 'preloadSounds',
  'uidAllocationMode', 'cordovaiOSScheme', 'cordovaAndroidScheme', 'exportFileStructure', 'scriptsType',
];

/** JSON with every object's keys sorted, to compare content regardless of order. */
const sorted = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value as Json).sort().map(k => [k, sorted((value as Json)[k])]))
      : value;

describe('upgradeProjectShape on a project an older release saved', () => {
  it('brings the release-44903 fixture to the r495.2 save shape and changes nothing else', () => {
    const project = fixture('c3-loadable-minimal');
    const before = structuredClone(project);
    expect(project.savedWithRelease).toBeLessThan(SHAPE_BASELINE_RELEASE);

    const changes = upgradeProjectShape(project);

    expect(Object.keys(project.properties).filter(k => R495_PROPERTY_ORDER.includes(k))).toEqual(R495_PROPERTY_ORDER);
    const script = project.rootFileFolders.script.items[0];
    expect(Object.keys(script)).toEqual(['name', 'type', 'sid', 'script-info']);
    expect(script['script-info']).toEqual({ purpose: 'none' });
    const top = Object.keys(project);
    expect(top.indexOf('models3d')).toBe(top.indexOf('flowcharts') + 1);
    expect(project.models3d).toEqual({ items: [], subfolders: [] });

    // r495.2 reads this release's "normalized" as "regular" (W90 round trip, C5 load check).
    expect(before.properties.zAxisScale).toBe('normalized');
    expect(project.properties.zAxisScale).toBe('regular');

    // Content is otherwise identical: no pruning, no other setting changed, no release claimed.
    expect(project.usedAddons).toHaveLength(23);
    expect(project.savedWithRelease).toBe(before.savedWithRelease);
    const expected = structuredClone(before);
    const expectedScript = expected.rootFileFolders.script.items[0];
    expectedScript['script-info'] = expectedScript['file-info'];
    delete expectedScript['file-info'];
    expected.models3d = { items: [], subfolders: [] };
    expected.properties.zAxisScale = 'regular';
    expect(sorted(project)).toEqual(sorted(expected));

    expect(changes).toEqual([
      'scripts: script "c3-runtime-bridge.js" file-info renamed to script-info',
      'models3d folder added',
      'properties.uidAllocationMode moved after preloadSounds',
      'properties.scriptsType moved to the end',
      'properties.zAxisScale "normalized" read as "regular", as r495.2 does for this release',
    ]);
  });

  it('changes zAxisScale only at or before the release the editor was seen to migrate', () => {
    const later = fixture('c3-loadable-minimal');
    later.savedWithRelease = Z_AXIS_SCALE_MIGRATED_RELEASE + 1;
    upgradeProjectShape(later);
    expect(later.properties.zAxisScale).toBe('normalized');

    const regular = fixture('c3-loadable-minimal');
    regular.properties.zAxisScale = 'regular';
    expect(upgradeProjectShape(regular).some(c => c.includes('zAxisScale'))).toBe(false);
    expect(regular.properties.zAxisScale).toBe('regular');
  });

  it('is a no-op the second time', () => {
    const project = fixture('c3-loadable-minimal');
    upgradeProjectShape(project);
    const once = JSON.stringify(project);
    expect(upgradeProjectShape(project)).toEqual([]);
    expect(JSON.stringify(project)).toBe(once);
  });

  it('adds models3d before properties when the file has no flowcharts key', () => {
    const project = fixture('minimal-project');
    expect('flowcharts' in project).toBe(false);
    upgradeProjectShape(project);
    const top = Object.keys(project);
    expect(top.indexOf('models3d')).toBe(top.indexOf('properties') - 1);
  });

  it('renames file-info on scripts in nested subfolders, and leaves an entry that has both keys alone', () => {
    const both = { name: 'both.js', type: 'application/javascript', sid: 2, 'file-info': { purpose: 'main' }, 'script-info': { purpose: 'none' } };
    const nested = { name: 'deep.js', type: 'application/javascript', sid: 3, 'file-info': { purpose: 'main' } };
    const project: Json = {
      savedWithRelease: 44000,
      rootFileFolders: { script: { items: [both], subfolders: [{ name: 'A', items: [], subfolders: [{ name: 'B', items: [nested], subfolders: [] }] }] } },
      models3d: { items: [], subfolders: [] },
    };
    const changes = upgradeProjectShape(project);
    expect(Object.keys(nested)).toEqual(['name', 'type', 'sid', 'script-info']);
    expect((nested as Json)['script-info']).toEqual({ purpose: 'main' });
    expect(both).toEqual({ name: 'both.js', type: 'application/javascript', sid: 2, 'file-info': { purpose: 'main' }, 'script-info': { purpose: 'none' } });
    expect(changes).toEqual(['scripts/A/B: script "deep.js" file-info renamed to script-info']);
  });

  it('leaves Project File entries (sounds, general files) on file-info', () => {
    const project: Json = {
      savedWithRelease: 44000,
      rootFileFolders: { general: { items: [{ name: 'a.txt', 'file-info': { purpose: 'none' } }], subfolders: [] } },
      models3d: { items: [], subfolders: [] },
    };
    upgradeProjectShape(project);
    expect(Object.keys(project.rootFileFolders.general.items[0])).toEqual(['name', 'file-info']);
  });
});

describe('upgradeProjectShape on a project r495.2 or a later release saved', () => {
  it.each(['timeline-sample', 'timeline-properties'])('leaves the r495.2-saved %s fixture byte-identical', (name) => {
    const project = fixture(name);
    expect(project.savedWithRelease).toBe(SHAPE_BASELINE_RELEASE);
    const before = JSON.stringify(project);
    expect(upgradeProjectShape(project)).toEqual([]);
    expect(JSON.stringify(project)).toBe(before);
  });

  it('keeps a newer release its own property order', () => {
    const project = fixture('timeline-sample');
    project.savedWithRelease = 49700;
    // A release that wrote uidAllocationMode last would be reordered if the release gate were ignored.
    const { uidAllocationMode, ...rest } = project.properties;
    project.properties = { ...rest, uidAllocationMode };
    const before = JSON.stringify(project);
    expect(upgradeProjectShape(project)).toEqual([]);
    expect(JSON.stringify(project)).toBe(before);
  });
});
