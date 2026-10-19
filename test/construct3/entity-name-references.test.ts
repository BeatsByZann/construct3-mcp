/** Where an event sheet or a layout is named: entity-name-references.ts on synthetic sheets and layouts. */

import { describe, it, expect } from 'vitest';
import {
  entityNameUseLocation, findInstanceVariableValues, findLayoutBindings, findLayoutNameUses, findSheetIncludes,
  isSameEntityName, renameLayoutParameters, renameSheetIncludes,
} from '../../src/construct3/entity-name-references.js';
import type { EventSheet, Layout } from '../../src/construct3/types.js';

const sheet = (events: unknown[]): EventSheet => ({ name: 'S', events, sid: 1 } as unknown as EventSheet);
const layout = (data: Record<string, unknown>): Layout => ({ name: 'L', layers: [], ...data } as unknown as Layout);
const goTo = (layoutName: string, id = 'go-to-layout') => ({ id, objectClass: 'System', parameters: { layout: layoutName } });

describe('event sheet references', () => {
  const sheets = new Map([
    ['Main', sheet([
      { eventType: 'include', includeSheet: 'Common' },
      { eventType: 'group', title: 'G', children: [{ eventType: 'include', includeSheet: 'COMMON' }] },
      { eventType: 'include', includeSheet: 'Other' },
    ])],
  ]);

  it('finds includes at any depth, ignoring case, as definite', () => {
    const uses = findSheetIncludes(sheets, 'Common');
    expect(uses.map(u => [u.eventPath, u.value, u.definite])).toEqual([
      ['events[0]', 'Common', true], ['events[1].children[0]', 'COMMON', true],
    ]);
  });

  it('points the includes of one sheet at a new name and counts them', () => {
    const data = structuredClone(sheets.get('Main')!);
    expect(renameSheetIncludes(data, 'Common', 'Shared')).toBe(2);
    expect(JSON.stringify(data)).not.toMatch(/"includeSheet":"(Common|COMMON)"/);
    expect(JSON.stringify(data)).toContain('"includeSheet":"Other"');
  });

  it('finds layout bindings ignoring case', () => {
    const layouts = new Map([['A', layout({ eventSheet: 'common' })], ['B', layout({ eventSheet: 'Main' })], ['C', layout({})]]);
    expect(findLayoutBindings(layouts, 'Common').map(u => [u.file, u.kind])).toEqual([['A', 'eventSheet binding']]);
  });
});

describe('layout references', () => {
  const main = sheet([
    { eventType: 'variable', name: 'Next', type: 'string', initialValue: 'Level 1' },
    { eventType: 'function-block', functionName: 'Go', functionParameters: [{ name: 'where', initialValue: 'level 1' }], conditions: [], actions: [] },
    { eventType: 'block', conditions: [{ id: 'compare', objectClass: 'System', parameters: { layout: 'Level 1' } }], actions: [
      goTo('Level 1'),
      goTo('"Level 1"', 'go-to-layout-by-name'),
      goTo('Level 1', 'go-to-layout-by-name'),
      { id: 'set-text', objectClass: 'Txt', parameters: { text: 'LayoutName = "Level 1"' } },
      { type: 'script', script: ['runtime.goToLayout("Level 1");'] },
    ], children: [{ eventType: 'block', conditions: [], actions: [goTo('LEVEL 1')] }] },
  ]);

  it('marks bare "layout" parameters definite, by-name expressions, strings, scripts and variable values possible', () => {
    const uses = findLayoutNameUses(new Map([['Main', main]]), 'Level 1');
    const summary = uses.map(u => `${u.kind}:${u.definite}`).sort();
    expect(summary).toEqual([
      'layout parameter:true', 'layout parameter:true', 'layout parameter:true',
      'script:false', 'string literal:false', 'string literal:false', 'variable value:false', 'variable value:false',
    ].sort());
    expect(uses.find(u => u.ace === 'action 2')).toBeUndefined();
  });

  it('rewrites only the definite uses of one sheet', () => {
    const data = structuredClone(main);
    expect(renameLayoutParameters(data, 'Level 1', 'Stage')).toBe(3);
    const text = JSON.stringify(data);
    expect(text).toContain('"layout":"\\"Level 1\\""');
    expect(text).toContain('"initialValue":"Level 1"');
    expect(text.match(/"layout":"Stage"/g)).toHaveLength(3);
  });

  it('lists a "layout" parameter of another object\'s action as possible and leaves it, while a System go-to-layout is rewritten', () => {
    const custom = sheet([
      { eventType: 'block', conditions: [], actions: [
        { id: 'open-level', objectClass: 'Hero', parameters: { layout: 'Level' } },
        { id: 'call-function', callFunction: 'Show', objectClass: 'Functions', parameters: { layout: 'level' } },
        goTo('Level'),
      ] },
    ]);
    const uses = findLayoutNameUses(new Map([['Main', custom]]), 'Level');
    expect(uses.map(u => [u.ace, u.kind, u.definite])).toEqual([
      ['action 0', 'layout parameter', false], ['action 1', 'layout parameter', false], ['action 2', 'layout parameter', true],
    ]);
    const data = structuredClone(custom);
    expect(renameLayoutParameters(data, 'Level', 'Stage')).toBe(1);
    const actions = (data.events[0] as unknown as { actions: Array<{ parameters: { layout: string } }> }).actions;
    expect(actions.map(a => a.parameters.layout)).toEqual(['Level', 'level', 'Stage']);
  });

  it('gives a script use only its place, without the id of the action', () => {
    const scripted = sheet([{ eventType: 'block', conditions: [], actions: [{ id: 'run-script', objectClass: 'System', type: 'script', script: ['runtime.goToLayout("Level");'] }] }]);
    const [use] = findLayoutNameUses(new Map([['Main', scripted]]), 'Level');
    expect(use).toEqual({ category: 'eventSheets', file: 'Main', kind: 'script', eventPath: 'events[0]', ace: 'action 0', parameter: 'script', value: 'runtime.goToLayout("Level");', definite: false });
  });

  it('lists instance variable values of layout instances that are the name', () => {
    const layouts = new Map([['A', layout({ layers: [{ name: 'L0', instances: [{ type: 'Door', uid: 7, instanceVariables: { target: 'Level 1', n: 3 } }] }] })]]);
    const uses = findInstanceVariableValues(layouts, 'level 1');
    expect(uses).toEqual([{ category: 'layouts', file: 'A', kind: 'instance variable', uid: 7, parameter: 'target', value: 'Level 1', definite: false }]);
    expect(entityNameUseLocation(uses[0])).toBe('layout "A" instance UID 7 "target"');
  });

  it('says where a use is', () => {
    const [use] = findLayoutNameUses(new Map([['Main', main]]), 'Level 1').filter(u => u.ace === 'action 0');
    expect(entityNameUseLocation(use)).toBe('"Main" events[2] action 0 "layout"');
    expect(isSameEntityName('LEVEL 1', 'Level 1')).toBe(true);
    expect(isSameEntityName(3, 'Level 1')).toBe(false);
  });
});
