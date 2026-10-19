/** Where an object type or a family is named: object-name-references.ts on synthetic sheets, layouts, families, flowcharts and timelines. */

import { describe, it, expect } from 'vitest';
import {
  findFamilyMemberUses, findFlowchartNodeUses, findInstanceTypeUses, findObjectNameUsesInSheets, findObjectNameUsesWithPolicy,
  OBJECT_REWRITE_POLICY, objectNameInExpression, objectNameUseLocation, projectVariableNames, renameFamilyMember, renameInstanceTypes,
  renameObjectInSheet, renameObjectInSheetWithPolicy, renameSingleGlobalInstanceType, scriptReadsObject, TIMELINE_TRACK_PATH,
  timelineTrackUses,
} from '../../src/construct3/object-name-references.js';
import type { EventSheet, Layout } from '../../src/construct3/types.js';

const sheet = (events: unknown[]): EventSheet => ({ name: 'S', events, sid: 1 } as unknown as EventSheet);

describe('objectNameInExpression', () => {
  it.each([
    ['Alpha.X + 1', 'Gamma.X + 1', 1, 0],
    ['alpha.X + ALPHA(0).Y', 'Gamma.X + Gamma(0).Y', 2, 0],
    ['Alpha (Alpha.Count - 1) . X', 'Gamma (Gamma.Count - 1) . X', 2, 0],
    ['"Alpha" & Alpha.X', '"Alpha" & Gamma.X', 1, 0],
    ['Sprite.Alpha + AlphaBeta.X + Alpha2.X', 'Sprite.Alpha + AlphaBeta.X + Alpha2.X', 0, 0],
    ['max(Alpha, 1) + Alpha(1)', 'max(Alpha, 1) + Alpha(1)', 0, 2],
    ['2Alpha.X', '2Alpha.X', 0, 0],
    ['"unterminated Alpha.X', '"unterminated Alpha.X', 0, 0],
  ])('%s', (expression, renamed, definite, possible) => {
    expect(objectNameInExpression(expression, 'Alpha', 'Gamma')).toEqual({ text: renamed, definite, possible });
    expect(objectNameInExpression(expression, 'Alpha').text).toBe(expression);
  });
});

describe('event sheet uses', () => {
  const events = () => [
    { eventType: 'variable', name: 'Who', type: 'string', initialValue: 'alpha' },
    { eventType: 'custom-ace-block', aceName: 'Hit', objectClass: 'Alpha', functionParameters: [{ name: 'p', initialValue: 'Alpha' }], conditions: [], actions: [] },
    { eventType: 'block', conditions: [{ id: 'is-visible', objectClass: 'ALPHA' }], actions: [
      { id: 'set-x', objectClass: 'Beta', parameters: { x: 'Alpha.X' } },
      { id: 'create-object', objectClass: 'System', parameters: { 'object-to-create': 'Alpha', layer: '"Alpha"', x: '0', y: '0' } },
      { id: 'sort-z', objectClass: 'System', parameters: { object: 'Beta', 'instance-variable': { name: 'hp', objectClass: 'Alpha' } } },
      { customAction: 'Hit', objectClass: 'Beta', customActionObjectClass: 'Alpha', parameters: ['Alpha'] },
      { id: 'set-text', objectClass: 'Txt', parameters: { text: '"Alpha"', 'audio-file': 'Alpha' } },
      { id: 'go-to-layout-by-name', objectClass: 'System', parameters: { layout: 'Alpha.NextLevel' } },
      { id: 'go-to-layout', objectClass: 'System', parameters: { layout: 'Alpha' } },
      { type: 'script', script: ['runtime.objects.Alpha.getFirstInstance();', 'runtime.objects["alpha"];', 'runtime.objects.AlphaBeta;'] },
    ] },
  ];
  const names = (events: unknown[]) => projectVariableNames(new Map([['Main', sheet(events)]]));

  it('marks objects, owners, families of calls, whole-value object parameters and member expressions definite, under every key', () => {
    const uses = findObjectNameUsesInSheets(new Map([['Main', sheet(events())]]), 'Alpha', 'list');
    const definite = uses.filter(u => u.definite).map(u => `${u.kind}:${u.parameter ?? '-'}`).sort();
    expect(definite).toEqual([
      'custom action family:-', 'custom action owner:-', 'expression:x',
      'object parameter:0', 'object parameter:object-to-create', 'objectClass:-',
    ].sort());
    const possible = uses.filter(u => !u.definite).map(u => u.kind).sort();
    expect(possible).toEqual(['instance-variable object', 'possible expression', 'script', 'script', 'string literal', 'string literal', 'variable value', 'variable value'].sort());
    // A whole value under a key that holds another kind of name is no use of the object
    expect(uses.some(u => u.parameter === 'audio-file' || (u.parameter === 'layout' && u.value === 'Alpha'))).toBe(false);
  });

  it('keeps a whole value an event variable shares the name with as possible, as the reference index does', () => {
    const withVariable = [{ eventType: 'variable', name: 'Alpha', type: 'number', initialValue: '0' }, ...events()];
    const uses = findObjectNameUsesInSheets(new Map([['Main', sheet(withVariable)]]), 'Alpha', 'list');
    expect(uses.filter(u => u.parameter === '0').map(u => [u.kind, u.definite])).toEqual([['possible expression', false]]);
    expect(uses.filter(u => u.parameter === 'object-to-create').map(u => u.definite)).toEqual([true]);
  });

  it('rewrites only the definite uses of one sheet, with the new name as given', () => {
    const data = sheet(events());
    expect(renameObjectInSheet(data, 'Alpha', 'Gamma', names(events()), 'list')).toBe(6);
    const text = JSON.stringify(data);
    expect(text).toContain('"objectClass":"Gamma","functionParameters"');
    expect(text).toContain('{"id":"is-visible","objectClass":"Gamma"}');
    expect(text).toContain('"x":"Gamma.X"');
    expect(text).toContain('"object-to-create":"Gamma"');
    expect(text).toContain('"instance-variable":{"name":"hp","objectClass":"Alpha"}');
    expect(text).toContain('"customActionObjectClass":"Gamma","parameters":["Gamma"]');
    expect(text).toContain('"layout":"Alpha.NextLevel"');
    expect(text).toContain('"layout":"Alpha"');
    expect(text).toContain('"layer":"\\"Alpha\\""');
    expect(text).toContain('"audio-file":"Alpha"');
    expect(text).toContain('runtime.objects.Alpha.getFirstInstance();');
    expect(text).toContain('"initialValue":"alpha"');
  });

  it('rewrites an object-valued instance-variable parameter only under "rewrite"', () => {
    const data = sheet(events());
    renameObjectInSheet(data, 'Alpha', 'Gamma', names(events()), 'rewrite');
    expect(JSON.stringify(data)).toContain('"instance-variable":{"name":"hp","objectClass":"Gamma"}');
    const ofKind = (setting: 'rewrite' | 'list') => findObjectNameUsesInSheets(new Map([['Main', sheet(events())]]), 'Alpha', setting)
      .filter(u => u.kind === 'instance-variable object').map(u => u.definite);
    expect(ofKind('rewrite')).toEqual([true]);
    expect(ofKind('list')).toEqual([false]);
  });

  it('lists a parameter whose key is the name as a possible use and never renames the key', () => {
    const keyed = () => [{ eventType: 'block', conditions: [], actions: [{ id: 'set-text', objectClass: 'Beta', parameters: { alpha: 'a value', text: '"x"' } }] }];
    const uses = findObjectNameUsesInSheets(new Map([['Main', sheet(keyed())]]), 'Alpha', 'list');
    expect(uses.map(u => `${u.kind}:${u.parameter}:${u.value}:${u.definite}`)).toEqual(['possible expression:alpha:alpha:false']);
    const data = sheet(keyed());
    expect(renameObjectInSheet(data, 'Alpha', 'Gamma', names(keyed()), 'list')).toBe(0);
    expect(JSON.stringify(data)).toContain('"parameters":{"alpha":"a value","text":"\\"x\\""}');
  });

  it('says where a use is', () => {
    const [use] = findObjectNameUsesInSheets(new Map([['Main', sheet(events())]]), 'Alpha', 'list').filter(u => u.kind === 'expression' && u.parameter === 'x');
    expect(objectNameUseLocation(use)).toBe('"Main" events[2] action 0 "x"');
  });

  it('rewrites the object-valued parameters an editor save holds under parent, child, obstacle and array, unless a variable has the name', () => {
    const savedParameters = () => [{ eventType: 'block', conditions: [], actions: [
      { id: 'pin', objectClass: 'Beta', parameters: { child: 'Alpha', parent: 'Alpha', obstacle: 'Alpha', array: 'Alpha' } },
    ] }];
    const kinds = (events: unknown[]) => findObjectNameUsesInSheets(new Map([['Main', sheet(events)]]), 'Alpha', 'list')
      .map(u => `${u.parameter}:${u.kind}:${u.definite}`).sort();
    expect(kinds(savedParameters())).toEqual([
      'array:object parameter:true', 'child:object parameter:true', 'obstacle:object parameter:true', 'parent:object parameter:true',
    ]);
    const data = sheet(savedParameters());
    expect(renameObjectInSheet(data, 'Alpha', 'Gamma', names(savedParameters()), 'list')).toBe(4);
    expect((data.events[0] as unknown as { actions: Array<{ parameters: unknown }> }).actions[0].parameters)
      .toEqual({ child: 'Gamma', parent: 'Gamma', obstacle: 'Gamma', array: 'Gamma' });
    // An event variable with the name: the keys the reference index does not know as object keys are only possible uses
    const shared = [{ eventType: 'variable', name: 'Alpha', type: 'number', initialValue: '0' }, ...savedParameters()];
    expect(kinds(shared)).toEqual([
      'array:possible expression:false', 'child:object parameter:true', 'obstacle:possible expression:false', 'parent:possible expression:false',
    ]);
  });

  it('lists a whole value that differs from the name only in letter case, and never changes it', () => {
    const mouse = () => [{ eventType: 'block', conditions: [
      { id: 'on-click', objectClass: 'Mouse', parameters: { 'mouse-button': 'left', 'click-type': 'clicked' } },
    ], actions: [{ id: 'pin', objectClass: 'Beta', parameters: { child: 'Left' } }] }];
    const data = sheet(mouse());
    const uses = findObjectNameUsesInSheets(new Map([['Main', data]]), 'Left', 'rewrite');
    expect(uses.map(u => `${u.parameter}:${u.kind}:${u.definite}`).sort()).toEqual(['child:object parameter:true', 'mouse-button:possible expression:false']);
    expect(renameObjectInSheet(data, 'Left', 'LeftButton', names(mouse()), 'rewrite')).toBe(1);
    expect(JSON.stringify(data)).toContain('"mouse-button":"left"');
    expect(JSON.stringify(data)).toContain('"child":"LeftButton"');
  });

  it('lets an event variable that has the name in another letter case shadow a whole value', () => {
    const events = [{ eventType: 'variable', name: 'alpha', type: 'number', initialValue: '0' },
      { eventType: 'block', conditions: [], actions: [{ id: 'set', objectClass: 'Beta', parameters: { value: 'Alpha' } }] }];
    const uses = findObjectNameUsesInSheets(new Map([['Main', sheet(events)]]), 'Alpha', 'list');
    expect(uses.filter(u => u.parameter === 'value').map(u => [u.kind, u.definite])).toEqual([['possible expression', false]]);
  });

  it('finds an object whose name starts with a digit in expressions, as the editor writes it', () => {
    expect(objectNameInExpression('2Alpha.X + 12Alpha.Y + Sprite.2Alpha + 2AlphaB.X', '2Alpha', 'Alpha2'))
      .toEqual({ text: 'Alpha2.X + 12Alpha.Y + Sprite.2Alpha + 2AlphaB.X', definite: 1, possible: 0 });
    const data = sheet([{ eventType: 'block', conditions: [], actions: [{ id: 'set-x', objectClass: '2Alpha', parameters: { x: '2Alpha.X + 1' } }] }]);
    expect(renameObjectInSheet(data, '2Alpha', 'Alpha2', new Set(), 'list')).toBe(2);
    expect(JSON.stringify(data)).toContain('"x":"Alpha2.X + 1"');
  });

  it('lists Name.member under a key that holds a layout or sound name, and never changes it', () => {
    const data = sheet([{ eventType: 'block', conditions: [], actions: [
      { id: 'go-to-layout-by-name', objectClass: 'System', parameters: { layout: 'Alpha.NextLevel' } },
      { id: 'play', objectClass: 'Audio', parameters: { 'audio-file': 'Alpha.Boom' } },
    ] }]);
    const uses = findObjectNameUsesInSheets(new Map([['Main', data]]), 'Alpha', 'rewrite');
    expect(uses.map(u => `${u.parameter}:${u.kind}:${u.definite}`).sort()).toEqual(['audio-file:possible expression:false', 'layout:possible expression:false']);
    expect(renameObjectInSheet(data, 'Alpha', 'Gamma', new Set(), 'rewrite')).toBe(0);
    expect(JSON.stringify(data)).toContain('"layout":"Alpha.NextLevel"');
    expect(JSON.stringify(data)).toContain('"audio-file":"Alpha.Boom"');
  });

  it('leaves a parameter whose key holds another kind of name alone, on any object', () => {
    const data = sheet([{ eventType: 'block', conditions: [], actions: [
      { id: 'set-value', objectClass: 'Beta', parameters: { variable: 'Alpha', 'instance-variable': 'Alpha', 'audio-file': 'Alpha', layout: 'Alpha' } },
    ] }]);
    const before = JSON.stringify(data);
    expect(findObjectNameUsesInSheets(new Map([['Main', data]]), 'Alpha', 'rewrite')).toEqual([]);
    expect(renameObjectInSheet(data, 'Alpha', 'Gamma', new Set(), 'rewrite')).toBe(0);
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe('layouts, families, scripts and timelines', () => {
  it('finds and renames instance types on layers, sub-layers and non-world instances', () => {
    const layout = {
      name: 'L', layers: [{ name: 'A', instances: [{ type: 'alpha', uid: 1 }], subLayers: [{ name: 'B', instances: [{ type: 'Alpha', uid: 2 }, { type: 'Beta', uid: 3 }] }] }],
      'nonworld-instances': [{ type: 'Alpha', uid: 4 }],
    } as unknown as Layout;
    expect(findInstanceTypeUses(new Map([['L', layout]]), 'Alpha').map(u => u.uid)).toEqual([1, 2, 4]);
    expect(renameInstanceTypes(layout, 'Alpha', 'Gamma')).toBe(3);
    expect(JSON.stringify(layout).match(/"type":"Gamma"/g)).toHaveLength(3);
  });

  it('finds and renames family members, matched ignoring case', () => {
    const family = { name: 'Fam', members: ['Beta', 'ALPHA', 7] };
    expect(findFamilyMemberUses(new Map<string, unknown>([['Fam', family], ['Other', { members: 'none' }]]), 'Alpha').map(u => u.file)).toEqual(['Fam']);
    expect(renameFamilyMember(family, 'Alpha', 'Gamma')).toBe(1);
    expect(family.members).toEqual(['Beta', 'Gamma', 7]);
  });

  it('renames the instance type of an object type\'s own single-global instance and no other type', () => {
    const own = { name: 'Alpha', 'singleglobal-inst': { type: 'Alpha', properties: {}, tags: '', uid: 5 } };
    expect(renameSingleGlobalInstanceType(own, 'Alpha', 'Gamma')).toBe(1);
    expect(own['singleglobal-inst'].type).toBe('Gamma');
    const other = { name: 'Beta', 'singleglobal-inst': { type: 'Beta' } };
    expect(renameSingleGlobalInstanceType(other, 'Alpha', 'Gamma')).toBe(0);
    expect(other['singleglobal-inst'].type).toBe('Beta');
    expect(renameSingleGlobalInstanceType({ name: 'Alpha' }, 'Alpha', 'Gamma')).toBe(0);
    expect(renameSingleGlobalInstanceType(null, 'Alpha', 'Gamma')).toBe(0);
  });

  it('lists flowchart nodes whose "c" value is the name as possible uses, and never reads another key', () => {
    const flowcharts = new Map<string, unknown>([
      ['Flow', { name: 'Flow', nodes: [{ c: 'alpha', t: 'x' }, { c: 'Beta' }, { c: 7 }, 'odd', { other: 'Alpha' }], c: 'Alpha' }],
      ['Odd', { nodes: 'none' }],
    ]);
    const uses = findFlowchartNodeUses(flowcharts, 'Alpha');
    expect(uses).toEqual([{ category: 'flowcharts', file: 'Flow', kind: 'flowchart node', parameter: 'nodes[0].c', value: 'alpha', definite: false }]);
    expect(objectNameUseLocation(uses[0])).toBe('flowchart "Flow" nodes[0].c');
  });

  it('tells script lines that read the object through runtime.objects, with the reference index pattern', () => {
    expect(['const a = runtime.objects.alpha;', 'const b = runtime.objects?.["Alpha"];', 'const c = runtime.objects.AlphaBeta;', 'const d = "Alpha";']
      .map(line => scriptReadsObject(line, 'Alpha'))).toEqual([true, true, false, false]);
  });

  it('finds and renames the object name of timeline tracks at the given key path only, and says when a timeline lacks its shape', () => {
    const path = ['tracks', '[]', 'objectType'];
    const timeline = { tracks: [{ type: 'instance-track', objectType: 'Alpha' }, { objectType: 'alpha' }, { objectType: 'Beta' }], nested: { objectType: 'Alpha' } };
    expect(timelineTrackUses(timeline, 'Alpha', undefined, path)).toEqual({ count: 2, complete: true });
    expect(timelineTrackUses(timeline, 'Alpha', 'Gamma', path).count).toBe(2);
    expect(timeline.tracks.map(t => t.objectType)).toEqual(['Gamma', 'Gamma', 'Beta']);
    // A key of that name off the path is not a track's object
    expect(timeline.nested.objectType).toBe('Alpha');
    expect(timelineTrackUses({ tracks: 'none' }, 'Alpha', undefined, path)).toEqual({ count: 0, complete: false });
    // Without a recorded path nothing is counted
    expect(timelineTrackUses(timeline, 'Gamma')).toEqual({ count: 0, complete: true });
  });

  it('rewrites every kind of event sheet use by default, as the editor did on a rename', () => {
    expect(OBJECT_REWRITE_POLICY).toEqual({
      'custom action owner': true, objectClass: true, 'custom action family': true, 'instance-variable object': true, 'object parameter': true, expression: true,
    });
  });

  it('has no recorded key path for a timeline track, since no editor save has shown one', () => {
    expect(TIMELINE_TRACK_PATH).toEqual([]);
  });

  it('rewrites and lists by one policy: a kind set to list is listed in every sheet and never changed, beside a kind that is rewritten', () => {
    // A policy that only lists expressions, as for an editor that leaves them on a rename
    const listed = { ...OBJECT_REWRITE_POLICY, expression: false };
    const data = { name: 'Main', events: [{ eventType: 'block', conditions: [], actions: [{ id: 'set-x', objectClass: 'Alpha', parameters: { x: 'Alpha.X + 1' } }] }] } as unknown as EventSheet;
    const before = JSON.stringify(data);
    const uses = findObjectNameUsesWithPolicy(new Map([['Main', data]]), 'Alpha', listed);
    expect(uses.map(u => `${u.kind}:${u.definite}`).sort()).toEqual(['expression:false', 'objectClass:true']);
    expect(renameObjectInSheetWithPolicy(data, 'Alpha', 'Gamma', new Set(), listed)).toBe(1);
    const after = JSON.parse(JSON.stringify(data));
    expect(after.events[0].actions[0]).toEqual({ id: 'set-x', objectClass: 'Gamma', parameters: { x: 'Alpha.X + 1' } });
    expect(JSON.stringify(data)).not.toBe(before);
  });
});
