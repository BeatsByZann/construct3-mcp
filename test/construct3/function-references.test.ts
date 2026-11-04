/**
 * findFunctionReferences: the uses of a function by name. Every sheet in
 * these tests is synthetic, built here.
 */
import { describe, it, expect } from 'vitest';
import { findFunctionReferences, REFERENCE_CHECK_MAX_EVENTS } from '../../src/construct3/analyzers/delete-references.js';

type Ev = Record<string, unknown>;
const fn = (name: string, sid: number): Ev => ({
  functionName: name, functionReturnType: 'none', functionParameters: [],
  eventType: 'function-block', conditions: [], actions: [], sid,
});
const block = (sid: number, actions: unknown[], extra: Ev = {}): Ev => ({ eventType: 'block', sid, conditions: [], actions, ...extra });
const sheetsOf = (sheets: Record<string, unknown[]>) => new Map<string, unknown>(Object.entries(sheets));

describe('findFunctionReferences', () => {
  it('finds Call function actions, function map registrations and expression calls in every sheet, ignoring case', () => {
    const { references, complete } = findFunctionReferences(sheetsOf({
      A: [fn('Damage', 10), block(20, [{ callFunction: 'damage', sid: 21, parameters: ['5'] }])],
      B: [block(30, [
        { id: 'map-function', objectClass: 'Functions', sid: 31, parameters: { map: '"m"', string: '"k"', function: 'DAMAGE' } },
        // One reference per condition or action, however many of its parameters call the function
        { id: 'set-position', objectClass: 'Sprite', sid: 32, parameters: { x: 'functions.damage(1) + Functions.Damage(2)', y: 'Functions.Damage(4)' } },
        // A boolean argument is no expression
        { callFunction: 'Other', sid: 33, parameters: [false, 'Functions.DAMAGE(3)'] },
        { callFunction: 'Damaged', sid: 34 },
      ])],
    }), 'Damage', 'Functions');
    expect(complete).toBe(true);
    expect(references.map(r => [r.sheet, r.kind, r.path, r.sid])).toEqual([
      ['A', 'callFunction', 'block > action:0', 20],
      ['B', 'function-map', 'block > action:0', 30],
      ['B', 'expression', 'block > action:1', 30],
      ['B', 'expression', 'block > action:2', 30],
    ]);
  });

  it('skips script and comment rows', () => {
    const { references } = findFunctionReferences(sheetsOf({
      A: [block(20, [
        { type: 'script', language: 'javascript', script: ['Functions.Damage(1)'], callFunction: 'Damage' },
        { type: 'comment', text: 'Functions.Damage(1)', callFunction: 'Damage', parameters: ['Functions.Damage(1)'] },
        { callFunction: 'Damage', sid: 21 },
      ])],
    }), 'Damage', 'Functions');
    expect(references.map(r => r.path)).toEqual(['block > action:2']);
  });

  it('gives each reference the stored condition or action object', () => {
    const callAce = { callFunction: 'Damage', sid: 21, parameters: ['5'] };
    const mapAce = { id: 'map-function', objectClass: 'Functions', sid: 22, parameters: { map: '"m"', string: '"k"', function: 'Damage' } };
    const condition = { id: 'compare-two-values', objectClass: 'System', sid: 23, parameters: { 'first-value': 'Functions.Damage(1)', comparison: 0, 'second-value': '0' } };
    const { references } = findFunctionReferences(sheetsOf({
      A: [block(20, [callAce, mapAce], { conditions: [condition] })],
    }), 'Damage', 'Functions');
    expect(references.map(r => r.ace)).toEqual([condition, callAce, mapAce]);
    expect(references[0].ace).toBe(condition);
    expect(references[1].ace).toBe(callAce);
    expect(references[2].ace).toBe(mapAce);
  });

  it('says when it stopped at its traversal limit', () => {
    const wide = Array.from({ length: REFERENCE_CHECK_MAX_EVENTS }, () => ({ eventType: 'comment', text: '' }));
    const { references, complete, limit } = findFunctionReferences(sheetsOf({
      A: [...wide, block(20, [{ callFunction: 'Damage', sid: 21 }])],
    }), 'Damage', 'Functions');
    expect(references).toEqual([]);
    expect([complete, limit]).toEqual([false, 'events']);
  });

  it('says when it stopped at its depth limit', () => {
    let inner: Ev = block(2, [{ callFunction: 'Damage', sid: 3 }]);
    for (let i = 0; i < 52; i++) inner = block(i + 4, [], { children: [inner] });
    const { references, complete, limit } = findFunctionReferences(sheetsOf({ A: [inner] }), 'Damage', 'Functions');
    expect(references).toEqual([]);
    expect([complete, limit]).toEqual([false, 'depth']);
  });
});
