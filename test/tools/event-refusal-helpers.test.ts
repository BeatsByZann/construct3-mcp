/**
 * resolveEventBySid names the argument that picks one of several events
 * sharing a SID, so a tool with two SID arguments (a parent and a sibling, a
 * source and a target) tells the caller which path to pass; nothingChanged
 * ends a refusal with "Nothing was changed." exactly once. Synthetic events.
 */

import { describe, it, expect } from 'vitest';
import { nothingChanged, resolveEventBySid } from '../../src/tools/event-helpers.js';

const twice = (): Record<string, unknown>[] => [
  { eventType: 'block', conditions: [], actions: [], sid: 7 },
  { eventType: 'group', title: 'G', children: [{ eventType: 'block', conditions: [], actions: [], sid: 7 }], sid: 8 },
];

describe('resolveEventBySid argument', () => {
  it('names eventPath when no argument is given', () => {
    const found = resolveEventBySid(twice(), 7, { sheetName: 'S', action: 'update' });
    expect('error' in found && found.error).toContain('Call again with eventPath set to the path of the event you mean');
  });

  it('names the given argument in the ambiguous-SID message', () => {
    const found = resolveEventBySid(twice(), 7, { sheetName: 'S', action: 'put the event into', argument: 'parentEventPath' });
    expect('error' in found && found.error).toContain('Call again with parentEventPath set to the path of the event you mean');
    expect('error' in found && found.error).not.toContain('with eventPath');
  });

  it('names the given argument when its path is not an event path or points elsewhere', () => {
    const bad = resolveEventBySid(twice(), 7, { sheetName: 'S', action: 'move', eventPath: 'events[0].actions[1]', argument: 'siblingEventPath' });
    expect('error' in bad && bad.error).toMatch(/^siblingEventPath "events\[0\]\.actions\[1\]" is not an event path\./);
    const elsewhere = resolveEventBySid(twice(), 7, { sheetName: 'S', action: 'move', eventPath: 'events[1]', argument: 'siblingEventPath' });
    expect('error' in elsewhere && elsewhere.error).toMatch(/^siblingEventPath "events\[1\]" does not point at an event with SID 7/);
  });

  it('picks the event at the given path', () => {
    const found = resolveEventBySid(twice(), 7, { sheetName: 'S', action: 'move', eventPath: 'events[1].children[0]', argument: 'parentEventPath' });
    expect('match' in found && found.match.path).toBe('events[1].children[0]');
  });
});

describe('nothingChanged', () => {
  it('adds the sentence once, after a full stop', () => {
    expect(nothingChanged('The sibling is gone.')).toBe('The sibling is gone. Nothing was changed.');
    expect(nothingChanged('The sibling is gone')).toBe('The sibling is gone. Nothing was changed.');
    expect(nothingChanged('Refused. Nothing was changed.')).toBe('Refused. Nothing was changed.');
    expect(nothingChanged('Refused.\n')).toBe('Refused. Nothing was changed.');
  });

  it('leaves a sentence that ends with a question or an exclamation mark as it is', () => {
    expect(nothingChanged('Did you mean "Alpha"?')).toBe('Did you mean "Alpha"? Nothing was changed.');
    expect(nothingChanged('Stop!')).toBe('Stop! Nothing was changed.');
  });
});
