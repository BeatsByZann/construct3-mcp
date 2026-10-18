/**
 * The container resolver of the tools that place and move events: a
 * destination given as a group path, a parent SID or a sibling SID; resolving
 * changes nothing in the sheet. Synthetic events.
 */

import { describe, it, expect } from 'vitest';
import {
  containerInFunction,
  containerParents,
  elsePredecessors,
  elsePredecessorWarnings,
  eventAtEventPath,
  eventPathOf,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_NODES,
  resolveContainer,
  validateLocator,
  type ResolvedContainer,
} from '../../src/tools/event-helpers.js';
import type { C3Event } from '../../src/construct3/types.js';

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
const errorOf = (r: ReturnType<typeof resolveContainer>): string => ('error' in r ? r.error : '');

describe('resolveContainer', () => {
  it('resolves the top level when no locator is given', () => {
    const events = sheet();
    const c = container(resolveContainer(events, 'S', { position: 'end' }));
    expect(c.kind).toBe('root');
    expect(c.targetEvents).toBe(events);
    expect(c.owner).toBeUndefined();
  });

  it('resolves a group path to the group and its sub-events', () => {
    const events = sheet();
    const c = container(resolveContainer(events, 'S', { groupPath: 'G', position: 'start' }));
    expect(c.kind).toBe('group');
    expect(c.owner).toBe(events[1]);
    expect(c.targetEvents).toBe(events[1].children);
  });

  it('resolves parentSid to the event and its sub-events, without giving an event that has none a children list', () => {
    const events = sheet();
    const before = JSON.stringify(events);
    const c = container(resolveContainer(events, 'S', { parentSid: 2, position: 'end' }));
    expect(c.kind).toBe('block');
    expect(c.targetEvents).toEqual([]);
    expect(JSON.stringify(events)).toBe(before);
  });

  it('resolves a group path to a group without a children list without adding one', () => {
    const events: Ev[] = [{ eventType: 'group', disabled: false, title: 'E', description: '', isActiveOnStart: true, sid: 20 }];
    const before = JSON.stringify(events);
    const c = container(resolveContainer(events, 'S', { groupPath: 'E', position: 'end' }));
    expect(c.owner).toBe(events[0]);
    expect(c.targetEvents).toEqual([]);
    expect(JSON.stringify(events)).toBe(before);
  });

  it('treats an empty groupPath as not given', () => {
    const events = sheet();
    expect(container(resolveContainer(events, 'S', { groupPath: '', position: 'end' })).kind).toBe('root');
    expect(validateLocator({ groupPath: '', parentSid: 1, position: 'end' })).toBeUndefined();
  });

  it('refuses a parentSid whose event has no sub-events', () => {
    expect(errorOf(resolveContainer(sheet(), 'S', { parentSid: 5, position: 'end' })))
      .toBe('The event with SID 5 is a "variable", which has no sub-events. A parent must be a group, block or function block.');
  });

  it('refuses a locator whose arguments do not fit together, before looking at the sheet', () => {
    expect(errorOf(resolveContainer(sheet(), 'S', { groupPath: 'G', parentSid: 1, position: 'end' })))
      .toBe('Give at most one of groupPath, parentSid and siblingSid.');
  });

  it('refuses a group path that names no group, naming the groups there', () => {
    const message = errorOf(resolveContainer(sheet(), 'S', { groupPath: 'Nope', position: 'end' }));
    expect(message).toContain('Group path "Nope" not found in "S"');
    expect(message).toContain('"G"');
  });

  it('refuses a siblingSid that no event has, or that several events share, naming siblingEventPath', () => {
    expect(errorOf(resolveContainer(sheet(), 'S', { siblingSid: 99, position: 'after' })))
      .toContain('Event with SID 99 not found in sheet "S"');
    const events = [block(7), { eventType: 'group', title: 'H', children: [block(7)], sid: 9 }];
    expect(errorOf(resolveContainer(events, 'S', { siblingSid: 7, position: 'after' })))
      .toContain('Call again with siblingEventPath set to the path of the event you mean');
  });

  it('refuses a parentSid several events share and names parentEventPath', () => {
    const events = [block(7), { eventType: 'group', title: 'H', children: [block(7)], sid: 9 }];
    expect(errorOf(resolveContainer(events, 'S', { parentSid: 7, position: 'end' })))
      .toContain('Call again with parentEventPath set to the path of the event you mean');
  });

  it('picks one of several parents with parentEventPath', () => {
    const events = [block(7), { eventType: 'group', title: 'H', children: [block(7)], sid: 9 }];
    const c = container(resolveContainer(events, 'S', { parentSid: 7, parentEventPath: 'events[1].children[0]', position: 'end' }));
    expect(c.owner).toBe((events[1].children as Ev[])[0]);
  });

  it('resolves siblingSid to the list holding it and the kind of its parent', () => {
    const events = sheet();
    const inFunction = container(resolveContainer(events, 'S', { siblingSid: 4, position: 'after' }));
    expect(inFunction.kind).toBe('function-block');
    expect(inFunction.targetEvents).toBe(events[2].children);
    expect(inFunction.siblingEvent).toBe((events[2].children as Ev[])[0]);
    expect(container(resolveContainer(events, 'S', { siblingSid: 5, position: 'before' })).kind).toBe('root');
  });

  it('refuses a sibling inside an event that cannot hold sub-events', () => {
    const events: Ev[] = [{ eventType: 'include', includeSheet: 'X', children: [block(6)] }];
    expect(errorOf(resolveContainer(events, 'S', { siblingSid: 6, position: 'after' })))
      .toBe('The event with SID 6 stands among the sub-events of a "include", which cannot hold sub-events, so nothing can be placed beside it.');
  });
});

describe('validateLocator', () => {
  it('refuses two locators, a path without its SID, and positions that do not fit', () => {
    expect(validateLocator({ groupPath: 'G', parentSid: 1, position: 'end' })).toBe('Give at most one of groupPath, parentSid and siblingSid.');
    expect(validateLocator({ parentEventPath: 'events[0]', position: 'end' })).toBe('parentEventPath picks one of several events that share parentSid; pass it together with parentSid.');
    expect(validateLocator({ siblingEventPath: 'events[0]', position: 'after' })).toBe('siblingEventPath picks one of several events that share siblingSid; pass it together with siblingSid.');
    expect(validateLocator({ siblingSid: 1, position: 'end' })).toBe('siblingSid needs position "before" or "after".');
    expect(validateLocator({ position: 'before' })).toBe('position "before" needs siblingSid.');
    expect(validateLocator({ parentSid: 1, position: 'after' })).toBe('position "after" needs siblingSid.');
    expect(validateLocator({ siblingSid: 1, position: 'before' })).toBeUndefined();
  });
});

describe('scope helpers', () => {
  it('containerParents lists the enclosing events outermost first, ending with the owner', () => {
    const events = sheet();
    const c = container(resolveContainer(events, 'S', { parentSid: 2, position: 'end' }));
    expect(containerParents(events as unknown as C3Event[], c)).toEqual([events[0], (events[0].children as Ev[])[0]]);
    expect(containerParents(events as unknown as C3Event[], container(resolveContainer(events, 'S', { position: 'end' })))).toEqual([]);
  });

  it('containerInFunction is true in and below a function block and false elsewhere', () => {
    const events = sheet();
    expect(containerInFunction(events, container(resolveContainer(events, 'S', { parentSid: 11, position: 'end' })))).toBe(true);
    expect(containerInFunction(events, container(resolveContainer(events, 'S', { parentSid: 4, position: 'end' })))).toBe(true);
    expect(containerInFunction(events, container(resolveContainer(events, 'S', { siblingSid: 4, position: 'after' })))).toBe(true);
    expect(containerInFunction(events, container(resolveContainer(events, 'S', { parentSid: 1, position: 'end' })))).toBe(false);
    expect(containerInFunction(events, container(resolveContainer(events, 'S', { position: 'end' })))).toBe(false);
  });

  it('eventPathOf and eventAtEventPath find an event by identity and by path', () => {
    const events = sheet();
    const inner = (events[0].children as Ev[])[0];
    expect(eventPathOf(events, inner)).toBe('events[0].children[0]');
    expect(eventPathOf(events, { eventType: 'block' })).toBeUndefined();
    expect(eventAtEventPath(events, 'events[2].children[0]')).toBe((events[2].children as Ev[])[0]);
    expect(eventAtEventPath(events, 'events[9]')).toBeUndefined();
    expect(eventAtEventPath(events, 'events[0].actions[0]')).toBeUndefined();
  });

  it('warns when an else block continues another event after a change, where both arrangements are valid', () => {
    const elseBlock = (sid: number): Ev => ({ eventType: 'block', conditions: [{ id: 'else', objectClass: 'System', sid: sid + 1 }], actions: [], sid });
    const before: Ev[] = [block(30), block(31), elseBlock(32)];
    // Block 31 moved away: else 32 now continues 30
    const moved: Ev[] = [block(30), elseBlock(32)];
    expect(elsePredecessorWarnings(before, moved)).toEqual([
      'The else block with SID 32 now follows the event with SID 30 instead of the event with SID 31, so it runs when that event\'s conditions are false.',
    ]);
    // A block placed right before it
    expect(elsePredecessorWarnings(before, [block(30), block(31), block(33), elseBlock(32)])).toHaveLength(1);
    // A comment placed between them changes nothing
    expect(elsePredecessorWarnings(before, [block(30), block(31), { eventType: 'comment', text: 'c' }, elseBlock(32)])).toEqual([]);
  });

  it('stops scanning for else blocks in a sheet nested deeper or larger than the search limits', () => {
    let nested: Ev[] = [block(1)];
    for (let i = 0; i <= MAX_SEARCH_DEPTH; i++) nested = [block(i + 2, nested)];
    expect(() => elsePredecessors(nested)).toThrow(`Sub-event scan exceeded depth ${MAX_SEARCH_DEPTH}`);
    const wide = Array.from({ length: MAX_SEARCH_NODES + 1 }, (_, i) => block(i + 1));
    expect(() => elsePredecessors(wide)).toThrow(`Sub-event scan exceeded ${MAX_SEARCH_NODES} nodes`);
  });
});
