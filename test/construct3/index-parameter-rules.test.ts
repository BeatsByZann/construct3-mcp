/**
 * The cross-reference index's rules that other tools share: which parameters
 * refer to an object, which paths the project script files have, and which
 * names event variables and function parameters declare. Synthetic data.
 */

import { describe, it, expect } from 'vitest';
import { collectVariableNames, isObjectParameterValue, scriptFilePaths } from '../../src/construct3/analyzers/index-builder.js';
import type { C3Event } from '../../src/construct3/types.js';

describe('isObjectParameterValue', () => {
  it.each(['object', 'object-to-create', 'pin-to', 'child'])('counts the value of the object parameter "%s" as an object, also when a variable has the name', key => {
    expect(isObjectParameterValue(key, false)).toBe(true);
    expect(isObjectParameterValue(key, true)).toBe(true);
  });

  it.each(['layout', 'audio-file', 'instance-variable', 'variable'])('never counts the value of "%s" as an object', key => {
    expect(isObjectParameterValue(key, false)).toBe(false);
    expect(isObjectParameterValue(key, true)).toBe(false);
  });

  it('counts the value of another key or a call argument as an object unless a variable has the name', () => {
    expect(isObjectParameterValue('x', false)).toBe(true);
    expect(isObjectParameterValue('x', true)).toBe(false);
    expect(isObjectParameterValue(undefined, false)).toBe(true);
    expect(isObjectParameterValue(undefined, true)).toBe(false);
  });
});

describe('scriptFilePaths', () => {
  it('lists the script files with their folders, skipping an item without a name', () => {
    const project = {
      rootFileFolders: {
        script: {
          items: [{ name: 'main.js' }, { name: '' }],
          subfolders: [{ name: 'lib', items: [{ name: 'util.js' }], subfolders: [] }],
        },
      },
    };
    expect(scriptFilePaths(project)).toEqual(['main.js', 'lib/util.js']);
  });

  it('lists nothing for a project without script files', () => {
    expect(scriptFilePaths({})).toEqual([]);
    expect(scriptFilePaths(undefined)).toEqual([]);
  });
});

describe('collectVariableNames', () => {
  it('collects event variables and function parameters at any depth', () => {
    const events = [
      { eventType: 'variable', name: 'score' },
      { eventType: 'group', title: 'G', children: [
        { eventType: 'variable', name: 'inGroup' },
        { eventType: 'function-block', functionName: 'F', functionParameters: [{ name: 'speed' }, { name: 'angle' }], children: [
          { eventType: 'block', conditions: [], actions: [], children: [{ eventType: 'variable', name: 'local' }] },
        ] },
      ] },
    ] as unknown as C3Event[];
    const names = new Set<string>();
    collectVariableNames(events, names);
    expect([...names].sort()).toEqual(['angle', 'inGroup', 'local', 'score', 'speed']);
  });
});
