/** The uses of one event variable on synthetic event sheets: which find it, what a rename may change, and script lines. */

import { describe, it, expect } from 'vitest';
import { findVariableUses, parameterSlots, variableScriptReads } from '../../src/construct3/analyzers/variable-renames.js';
import { variableNamesUsedBy } from '../../src/construct3/analyzers/delete-references.js';
import { findExpressionIdentifiers } from '../../src/construct3/event-shapes.js';

const v = (name: string, sid: number) => ({ eventType: 'variable', name, type: 'number', initialValue: '0', sid });
/** The synthetic sheets' shape, as the assertions read it. */
type Ace = { parameters: Record<string, unknown> | unknown[]; script?: string[] | string };
type Ev = { name?: string; actions: Ace[]; children: Ev[] };
const setVar = (variable: string, value = '1') => ({ id: 'set-eventvar-value', objectClass: 'System', parameters: { variable, value } });
const text = (expr: string) => ({ id: 'set-text', objectClass: 'Txt', parameters: { text: expr } });
const callF = (...args: string[]) => ({ callFunction: 'F', parameters: args });
const script = (lines: string[] | string) => ({ type: 'script', script: lines });
const block = (actions: unknown[], children?: unknown[]) => ({ eventType: 'block', conditions: [], actions, ...(children ? { children } : {}) });

/** Main: globals Score and Bonus, a group A with local Count, a group B with local Count, a group Shadow with a local Score, a function F(score). Other: uses of the global. */
function project() {
  const global = v('Score', 1);
  const countA = v('Count', 2);
  const countB = v('Count', 3);
  const shadow = v('Score', 4);
  const bonus = v('Bonus', 5);
  const activated = v('activated', 8);
  const main = [
    global,
    bonus,
    block([
      setVar('Score', 'Score + 1'),
      text('"S=" & score & Score * 2'),
      callF('Score * 2'),
      { id: 'x', objectClass: 'Sprite', parameters: { 'instance-variable': 'Score', object: 'Score', layout: 'Score', 'audio-file': 'Score' } },
      { id: 'set-group-active', objectClass: 'System', parameters: { 'group-name': 'Bonus', state: 'activated' } },
    ]),
    { eventType: 'group', title: 'A', children: [countA, block([setVar('Count')], [block([callF('Count + 1'), script(['localVars.Count = 2;'])])])] },
    { eventType: 'group', title: 'B', children: [countB, block([callF('count'), script('localVars.Count = 7;')])] },
    { eventType: 'group', title: 'Shadow', children: [shadow, block([setVar('Score'), script(['runtime.globalVars.Score = 0;'])])] },
    { eventType: 'function-block', functionName: 'F', functionParameters: [{ name: 'score' }], conditions: [], actions: [callF('score')] },
    block([script(['runtime.globalVars.Score += 1;', 'localVars.Count = 3;', 'myglobalVars.Score = 1;'])]),
    activated,
  ];
  const other = [block([callF('Score'), setVar('Points'), callF('`T=${Score}`')])];
  return { sheets: new Map<string, unknown>([['Main', main], ['Other', other]]), global, countA, countB, shadow, bonus, activated };
}

describe('parameterSlots', () => {
  it('classifies the variable parameter, call arguments, name keys and every other string parameter', () => {
    const kinds = (ace: Record<string, unknown>, kind: 'condition' | 'action' = 'action') =>
      parameterSlots(ace, kind).map(s => `${String(s.parameter)}:${s.kind}`);
    expect(kinds(setVar('Score', 'Score + 1'))).toEqual(['variable:variable-name', 'value:unclassified']);
    expect(kinds(callF('Score', 'x'))).toEqual(['0:call-argument', '1:call-argument']);
    expect(kinds({ customAction: 'Go', parameters: ['Score'] })).toEqual(['0:call-argument']);
    expect(kinds({ id: 'x', objectClass: 'Sprite', parameters: { object: 'Score', text: 'Score' } })).toEqual(['object:name', 'text:unclassified']);
    expect(kinds({ id: 'x', objectClass: 'Sprite', parameters: ['Score'] })).toEqual(['0:unclassified']);
    expect(kinds({ id: 'set-variable', objectClass: 'Sprite', parameters: { variable: 'Score' } })).toEqual(['variable:unclassified']);
    // The two System ACEs that keep an expression under a name key
    expect(kinds({ id: 'go-to-layout-by-name', objectClass: 'System', parameters: { layout: 'Score' } })).toEqual(['layout:unclassified']);
    expect(kinds({ id: 'load-layout-images-by-name', objectClass: 'System', parameters: { layout: 'Score' } })).toEqual(['layout:unclassified']);
    expect(kinds({ id: 'go-to-layout', objectClass: 'System', parameters: { layout: 'Score' } })).toEqual(['layout:name']);
  });

  it.each([
    [setVar('Score', 'Score + 1'), 'action'],
    [{ id: 'compare-eventvar', objectClass: 'System', parameters: { variable: 'Count', comparison: 0, value: 'Count * 2' } }, 'condition'],
    [callF('Score * 2', 'max(Score, 1)'), 'action'],
    [{ customAction: 'Go', parameters: ['Score', 3, true] }, 'action'],
    [{ id: 'x', objectClass: 'Sprite', parameters: { 'instance-variable': 'Score', object: 'Score', text: '"a" & Score', n: 3 } }, 'action'],
    [{ id: 'set-group-active', objectClass: 'System', parameters: { 'group-name': 'Bonus', state: 'activated' } }, 'action'],
    [{ id: 'set-variable', objectClass: 'Sprite', parameters: { variable: 'Score' } }, 'action'],
    [{ type: 'script', script: ['runtime.globalVars.Score = 1;'] }, 'action'],
  ] as const)('agrees with the checks on the names each parameter holds (%#)', (ace, kind) => {
    const checks = variableNamesUsedBy(ace as Record<string, unknown>, kind, () => true).map(u => u.name.toLowerCase()).sort();
    const slots = parameterSlots(ace as Record<string, unknown>, kind)
      .filter(s => s.kind !== 'name')
      .flatMap(s => (s.kind === 'variable-name' ? [s.value.toLowerCase()] : findExpressionIdentifiers(s.value)))
      .sort();
    expect(slots).toEqual(checks);
  });
});

describe('findVariableUses', () => {
  it('finds the uses of a global outside the scopes that hide it, in every sheet, ignoring case, and changes nothing', () => {
    const { sheets, global } = project();
    const before = JSON.stringify([...sheets]);
    const found = findVariableUses(sheets, global, 'Points');
    expect(found.uses.map(u => `${u.sheet} ${u.kind} ${u.path} ${String(u.parameter)}`)).toEqual([
      'Main event-variable block > action:0 variable',
      'Main variable-expression block > action:2 0',
      'Other variable-expression block > action:0 0',
    ]);
    expect(found.notUpdated.map(u => `${u.sheet} ${u.path} ${String(u.parameter)} ${u.reason}`)).toEqual([
      'Main block > action:0 value parameter-type-unknown',
      'Main block > action:1 text parameter-type-unknown',
      // A plugin's name keys: names in the built-in ACEs, but not verified for an addon's
      'Main block > action:3 instance-variable name-parameter',
      'Main block > action:3 object name-parameter',
      'Main block > action:3 layout name-parameter',
      'Main block > action:3 audio-file name-parameter',
      'Other block > action:2 0 template-text',
    ]);
    expect(found.captured.map(c => `${c.sheet} ${c.kind} ${c.path}`)).toEqual(['Other event-variable block > action:1']);
    expect(found.complete).toBe(true);
    expect(JSON.stringify([...sheets])).toBe(before);
  });

  it('applies a rename only to the uses it can update', () => {
    const { sheets, global } = project();
    for (const use of findVariableUses(sheets, global, 'Points').uses) use.apply('Points');
    const main = sheets.get('Main') as unknown as Ev[];
    expect(main[2].actions[0].parameters).toEqual({ variable: 'Points', value: 'Score + 1' });
    expect(main[2].actions[1].parameters).toEqual({ text: '"S=" & score & Score * 2' });
    expect(main[2].actions[2].parameters).toEqual(['Points * 2']);
    expect(main[2].actions[3].parameters).toEqual({ 'instance-variable': 'Score', object: 'Score', layout: 'Score', 'audio-file': 'Score' });
    expect(main[5].children[1].actions[0].parameters).toEqual({ variable: 'Score', value: '1' });
    expect(main[6].actions[0].parameters).toEqual(['score']);
    expect(main[0].name).toBe('Score'); // the declaration is the caller's to rename
    const other = sheets.get('Other') as unknown as Ev[];
    expect(other[0].actions.map(a => a.parameters)).toEqual([['Points'], { variable: 'Points', value: '1' }, ['`T=${Score}`']]);
  });

  it('never writes a parameter it cannot classify: a group name and a combo choice spelled like variables', () => {
    const { sheets, bonus } = project();
    const found = findVariableUses(sheets, bonus, 'Prize');
    expect(found.uses).toEqual([]);
    expect(found.notUpdated.map(u => `${u.path} ${String(u.parameter)} ${u.reason}`)).toEqual(['block > action:4 group-name parameter-type-unknown']);
    for (const use of found.uses) use.apply('Prize');
    const main = sheets.get('Main') as unknown as Ev[];
    expect(main[2].actions[4].parameters).toEqual({ 'group-name': 'Bonus', state: 'activated' });
  });

  it.each([
    ['countA', ['group:A > block > action:0 variable', 'group:A > block > block > action:0 0']],
    ['countB', ['group:B > block > action:0 0']],
    ['shadow', ['group:Shadow > block > action:0 variable']],
  ] as const)('finds only the uses of %s in its own scope', (which, paths) => {
    const built = project();
    const found = findVariableUses(built.sheets, built[which], 'Tally');
    expect(found.uses.map(u => `${u.path} ${String(u.parameter)}`)).toEqual(paths);
  });

  it('reports a captured use only where the renamed local will be in scope', () => {
    const built = project();
    expect(findVariableUses(built.sheets, built.countA, 'Points').captured).toEqual([]);
  });

  it('lists an argument naming a variable whose name starts with a digit, and does not rewrite it', () => {
    const digit = v('2x', 7);
    const sheets = new Map<string, unknown>([['Main', [digit, block([setVar('2x'), callF('2x + 1')])]]]);
    const found = findVariableUses(sheets, digit, 'Two');
    expect(found.uses.map(u => String(u.parameter))).toEqual(['variable']);
    expect(found.notUpdated.map(u => u.reason)).toEqual(['number-like-name']);
  });

  it('lists a plugin name parameter whose expression names a variable that starts with a digit', () => {
    const digit = v('2x', 7);
    const addon = { id: 'x', objectClass: 'Sprite', parameters: { object: '2x & 1' } };
    const sheets = new Map<string, unknown>([['Main', [digit, block([addon])]]]);
    const found = findVariableUses(sheets, digit, 'Two');
    expect(found.uses).toEqual([]);
    expect(found.notUpdated.map(u => `${String(u.parameter)} ${u.reason}`)).toEqual(['object name-parameter']);
  });

  it('lists the call arguments when the new name starts with a digit, and does not rewrite them', () => {
    const { sheets, global } = project();
    const found = findVariableUses(sheets, global, '2x');
    expect(found.uses.map(u => `${u.sheet} ${String(u.parameter)}`)).toEqual(['Main variable']);
    expect(found.notUpdated.filter(u => u.reason === 'number-like-new-name').map(u => `${u.sheet} ${u.path} ${String(u.parameter)}`)).toEqual([
      'Main block > action:2 0',
      'Other block > action:0 0',
    ]);
    for (const use of found.uses) use.apply('2x');
    const main = sheets.get('Main') as unknown as Ev[];
    expect(main[2].actions[2].parameters).toEqual(['Score * 2']);
  });

  it('rewrites an argument whose string literal is not closed, and treats it as code up to there', () => {
    const global = v('Score', 1);
    const sheets = new Map<string, unknown>([['Main', [global, block([callF('Score & "open `')])]]]);
    const found = findVariableUses(sheets, global, 'Points');
    expect(found.notUpdated).toEqual([]);
    for (const use of found.uses) use.apply('Points');
    expect((sheets.get('Main') as unknown as Ev[])[1].actions[0].parameters).toEqual(['Points & "open `']);
  });

  it('lists a System layout-by-name parameter that names the variable, and leaves a layout name', () => {
    const global = v('Score', 1);
    const sheets = new Map<string, unknown>([['Main', [global, block([
      { id: 'go-to-layout-by-name', objectClass: 'System', parameters: { layout: 'Score' } },
      { id: 'go-to-layout', objectClass: 'System', parameters: { layout: 'Score' } },
    ])]]]);
    const found = findVariableUses(sheets, global, 'Points');
    expect(found.uses).toEqual([]);
    expect(found.notUpdated.map(u => `${u.path} ${String(u.parameter)} ${u.reason}`)).toEqual(['block > action:0 layout parameter-type-unknown']);
    expect(found.complete).toBe(true);
  });

  it('lists a combo choice spelled like the variable it renames, and never writes it', () => {
    const { sheets, activated } = project();
    const found = findVariableUses(sheets, activated, 'on1');
    expect(found.uses).toEqual([]);
    expect(found.notUpdated.map(u => `${u.path} ${String(u.parameter)} ${u.reason}`)).toEqual(['block > action:4 state parameter-type-unknown']);
    for (const use of found.uses) use.apply('on1');
    const main = sheets.get('Main') as unknown as Ev[];
    expect(main[2].actions[4].parameters).toEqual({ 'group-name': 'Bonus', state: 'activated' });
  });

  it('says when a traversal limit stopped it', () => {
    let events: unknown[] = [block([setVar('Score')])];
    for (let i = 0; i < 60; i++) events = [block([], events)];
    const global = v('Score', 9);
    const found = findVariableUses(new Map([['Deep', [global, ...events]]]), global, 'Points');
    expect(found.complete).toBe(false);
    expect(found.limit).toBe('depth');
  });
});

describe('variableScriptReads', () => {
  it('lists globalVars reads of a global in every scope and every script shape, ignoring case', () => {
    const { sheets, global } = project();
    expect(variableScriptReads(sheets, global, true).reads.map(r => `${r.path}: ${r.line}`)).toEqual([
      'block: runtime.globalVars.Score += 1;',
      'group:Shadow > block: runtime.globalVars.Score = 0;',
    ]);
  });

  it('scopes script lines like the uses: localVars reads where the local is the one found, one-string scripts included', () => {
    const { sheets, countA, countB } = project();
    expect(variableScriptReads(sheets, countA, false).reads.map(r => `${r.path}: ${r.line}`)).toEqual(['group:A > block > block: localVars.Count = 2;']);
    expect(variableScriptReads(sheets, countB, false).reads.map(r => `${r.path}: ${r.line}`)).toEqual(['group:B > block: localVars.Count = 7;']);
  });

  it('finds an access split over lines, in script actions, script events and one-string scripts', () => {
    const global = v('Score', 1);
    const local = v('Count', 2);
    const sheets = new Map<string, unknown>([['Main', [
      global,
      block([script(['runtime.globalVars', '.Score += 1;'])]),
      { eventType: 'script', script: ['const g = runtime.globalVars[', '  "Score"', '];'] },
      block([script('runtime.globalVars[\n"Score"\n] += 1;')]),
      block([script(['runtime.globalVars', '.Scores = 1;'])]),
      { eventType: 'group', title: 'G', children: [local, block([script(['localVars', '  .Count = 1;'])])] },
      block([script(['localVars', '.Count = 1;'])]),
    ]]]);
    expect(variableScriptReads(sheets, global, true).reads.map(r => `${r.path}: ${r.line}`)).toEqual([
      'block: runtime.globalVars\n.Score += 1;',
      'block: const g = runtime.globalVars[\n  "Score"\n];',
      'block: runtime.globalVars[\n"Score"\n] += 1;',
    ]);
    expect(variableScriptReads(sheets, global, true).complete).toBe(true);
    expect(variableScriptReads(sheets, local, false).reads.map(r => `${r.path}: ${r.line}`)).toEqual(['group:G > block: localVars\n  .Count = 1;']);
  });

  it('skips what is not an event, an action or a script', () => {
    const global = v('Score', 1);
    const sheets = new Map<string, unknown>([
      ['Bad', 5],
      ['Main', [global, null, 7, block([null, { type: 'script', script: 5 }, { type: 'script', script: ['runtime.globalVars.Score = 1;'] }])]],
    ]);
    expect(variableScriptReads(sheets, global, true).reads.map(r => r.line)).toEqual(['runtime.globalVars.Score = 1;']);
    expect(findVariableUses(sheets, global, 'Points').uses).toEqual([]);
  });

  it('lists a line that reads the variable twice once', () => {
    const local = v('Count', 2);
    const sheets = new Map<string, unknown>([['Main', [{ eventType: 'group', title: 'G', children: [local, block([script(['localVars.Count = localVars.Count + 1;'])])] }]]]);
    expect(variableScriptReads(sheets, local, false).reads.map(r => r.line)).toEqual(['localVars.Count = localVars.Count + 1;']);
  });

  it('says when the event limit stopped it, and lists nothing past the limit', () => {
    const global = v('Score', 9);
    const wide = Array.from({ length: 100_000 }, () => block([]));
    const found = variableScriptReads(new Map([['Wide', [global, ...wide, block([script(['runtime.globalVars.Score = 1;'])])]]]), global, true);
    expect(found.complete).toBe(false);
    expect(found.limit).toBe('events');
    expect(found.reads).toEqual([]);
  });

  it('says when a traversal limit stopped it', () => {
    let events: unknown[] = [block([script(['runtime.globalVars.Score = 1;'])])];
    for (let i = 0; i < 60; i++) events = [block([], events)];
    const global = v('Score', 9);
    const found = variableScriptReads(new Map([['Deep', [global, ...events]]]), global, true);
    expect(found.complete).toBe(false);
    expect(found.limit).toBe('depth');
  });
});
