/**
 * Where the placement rules allow each kind of event, and the insert, the
 * only change. Synthetic events.
 */

import { describe, it, expect } from 'vitest';
import {
  insertIntoContainer,
  placedKindOf,
  placementError,
  resolveContainer,
  type ResolvedContainer,
} from '../../src/tools/event-helpers.js';

type Ev = Record<string, unknown>;
const block = (sid: number, children?: Ev[]): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...(children ? { children } : {}) });

/** Top level: block 1 (sub-event block 2), group "G" (block 3), function "F" (block 4), variable 5. */
function sheet(): Ev[] {
  return [
    block(1, [block(2)]),
    { eventType: 'group', disabled: false, title: 'G', description: '', isActiveOnStart: true, children: [block(3)], sid: 10 },
    { functionName: 'F', functionParameters: [], eventType: 'function-block', conditions: [], actions: [], children: [block(4)], sid: 11 },
    { eventType: 'variable', name: 'v', type: 'number', initialValue: '0', sid: 5 },
  ];
}
const container = (r: ReturnType<typeof resolveContainer>): ResolvedContainer => {
  if ('error' in r) throw new Error(r.error);
  return r.container;
};

describe('insertIntoContainer', () => {
  it('inserts before and after the sibling, at the start and at the end', () => {
    const events = sheet();
    const marks = ['b', 'a', 's', 'e'].map(m => ({ eventType: 'comment', text: m }));
    insertIntoContainer(container(resolveContainer(events, 'S', { siblingSid: 5, position: 'before' })), 'before', marks[0]);
    insertIntoContainer(container(resolveContainer(events, 'S', { siblingSid: 5, position: 'after' })), 'after', marks[1]);
    insertIntoContainer(container(resolveContainer(events, 'S', { position: 'start' })), 'start', marks[2]);
    insertIntoContainer(container(resolveContainer(events, 'S', { position: 'end' })), 'end', marks[3]);
    expect(events.map(e => (e.eventType === 'comment' ? e.text : e.sid))).toEqual(['s', 1, 10, 11, 'b', 5, 'a', 'e']);
  });

  it('gives an owner without sub-events its new list on insert', () => {
    const events = sheet();
    const c = container(resolveContainer(events, 'S', { parentSid: 2, position: 'end' }));
    const note = { eventType: 'comment', text: 'n' };
    insertIntoContainer(c, 'end', note);
    expect(((events[0].children as Ev[])[0]).children).toEqual([note]);
    // A group reached by its path, saved without a children list, gets it the same way
    const bare: Ev[] = [{ eventType: 'group', disabled: false, title: 'E', description: '', isActiveOnStart: true, sid: 20 }];
    insertIntoContainer(container(resolveContainer(bare, 'S', { groupPath: 'E', position: 'end' })), 'end', note);
    expect(bare[0].children).toEqual([note]);
  });

  it('throws when the sibling left its list before the insert', () => {
    const events = sheet();
    const c = container(resolveContainer(events, 'S', { siblingSid: 5, position: 'after' }));
    events.splice(3, 1);
    expect(() => insertIntoContainer(c, 'after', { eventType: 'comment', text: 'x' })).toThrow('is no longer in its list');
  });
});

describe('placement rules', () => {
  it('allows the table entries and names the allowed places otherwise', () => {
    const events = sheet();
    const inBlock = container(resolveContainer(events, 'S', { parentSid: 1, position: 'end' }));
    expect(placementError('block', inBlock)).toBeUndefined();
    expect(placementError('include', inBlock)).toBe('An include is not placed among the sub-events of a block: remove_event_from_sheet and the include path of delete_event_from_sheet find includes at the top level only. It can go at the top level of a sheet.');
    const inFunction = container(resolveContainer(events, 'S', { parentSid: 11, position: 'end' }));
    expect(placementError('custom-ace-block', inFunction)).toMatch(/^A custom action block is not placed among the sub-events of a function block: .+\. It can go /);
  });

  it('places each kind only where the table says, and refuses the places nothing backs', () => {
    const where = (parentSid: number | undefined) => {
      const c = container(resolveContainer(sheet(), 'S', parentSid === undefined ? { position: 'end' } : { parentSid, position: 'end' }));
      return (kind: Parameters<typeof placementError>[0]) => placementError(kind, c) === undefined;
    };
    const kinds = ['block', 'comment', 'script', 'variable', 'group', 'function-block', 'custom-ace-block', 'include'] as const;
    const allowed = (parentSid: number | undefined) => kinds.filter(where(parentSid));
    expect(allowed(undefined)).toEqual([...kinds]);
    expect(allowed(10)).toEqual(['block', 'comment', 'script', 'variable', 'group', 'function-block', 'custom-ace-block']);
    expect(allowed(1)).toEqual(['block', 'comment', 'script', 'variable', 'group', 'function-block']);
    // A function block holds blocks, scripts and variables, but no comment, group, function block or custom action
    expect(allowed(11)).toEqual(['block', 'script', 'variable']);
    // Nothing is placed among the sub-events of a custom action block
    const action: Ev = { eventType: 'custom-ace-block', aceType: 'action', aceName: 'A', objectClass: 'Hero', functionParameters: [], conditions: [], actions: [], sid: 12 };
    const inAction = container(resolveContainer([action], 'S', { parentSid: 12, position: 'end' }));
    expect(kinds.filter(k => placementError(k, inAction) === undefined)).toEqual([]);
  });

  it('knows the event types it covers', () => {
    expect(placedKindOf('function-block')).toBe('function-block');
    expect(placedKindOf('custom-ace-block')).toBe('custom-ace-block');
    expect(placedKindOf('animation')).toBeUndefined();
    expect(placedKindOf('toString')).toBeUndefined();
    expect(placedKindOf(undefined)).toBeUndefined();
  });
});
