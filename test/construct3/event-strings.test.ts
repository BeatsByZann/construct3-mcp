/** walkEventStrings and quotedNamePattern, on synthetic event sheets. */

import { describe, it, expect } from 'vitest';
import { quotedNamePattern, walkEventStrings, type EventStringSite } from '../../src/construct3/event-strings.js';
import type { EventSheet } from '../../src/construct3/types.js';

const sheet = (events: unknown[]): EventSheet => ({ name: 'S', events, sid: 1 } as unknown as EventSheet);

describe('walkEventStrings', () => {
  const events = [
    { eventType: 'include', includeSheet: 'Common' },
    { eventType: 'group', title: 'G', children: [
      { eventType: 'block', conditions: [{ id: 'compare', objectClass: 'Sprite', parameters: { x: 'Sprite.X', count: 3 } }],
        actions: [{ callFunction: 'F', parameters: ['"a"', 2] }, { type: 'script', script: ['one', 2, 'two'] }],
        children: [{ eventType: 'script', script: 'whole' }] },
    ] },
    null,
    { eventType: 'function-block', functionName: 'F', conditions: ['not a record'], actions: [] },
  ];

  it('visits every event with its JSON path, in groups, function blocks and sub-events, skipping entries that are not records', () => {
    const seen: string[] = [];
    walkEventStrings(sheet(events), { event: (_event, path) => seen.push(path) });
    expect(seen.sort()).toEqual(['events[0]', 'events[1]', 'events[1].children[0]', 'events[1].children[0].children[0]', 'events[3]'].sort());
  });

  it('hands each condition and action object to ace, with its site', () => {
    const seen: Array<[EventStringSite, unknown]> = [];
    walkEventStrings(sheet(events), { ace: (site, ace) => seen.push([site, ace]) });
    expect(seen.map(([site]) => `${site.eventPath} ${site.ace} ${site.id ?? '-'}`)).toEqual([
      'events[1].children[0] condition 0 compare',
      'events[1].children[0] action 0 -',
      'events[1].children[0] action 1 -',
    ]);
    expect(seen[0][1]).toBe((events[1] as { children: Array<{ conditions: unknown[] }> }).children[0].conditions[0]);
  });

  it('hands string parameters, named and positional, with a setter that changes the sheet', () => {
    const data = sheet(structuredClone(events));
    const keys: string[] = [];
    walkEventStrings(data, { parameter: (_site, p) => { keys.push(`${p.key}:${p.named}`); p.set(`<${p.value}>`); } });
    expect(keys).toEqual(['x:true', '0:false']);
    type Ace = { parameters: unknown };
    const block = (data.events as unknown as Array<{ children: Array<{ conditions: Ace[]; actions: Ace[] }> }>)[1].children[0];
    expect(block.conditions[0].parameters).toEqual({ x: '<Sprite.X>', count: 3 });
    expect(block.actions[0].parameters).toEqual(['<"a">', 2]);
  });

  it('hands the string lines of script actions and script events', () => {
    const lines: string[] = [];
    walkEventStrings(sheet(events), { scriptLine: (site, line) => lines.push(`${site.ace}:${line}`) });
    expect(lines.sort()).toEqual(['action 1:one', 'action 1:two', 'script:whole'].sort());
  });

  it('hands the line of a script action whose script is one string, as it does for a script event', () => {
    const lines: string[] = [];
    const oneString = [{ eventType: 'block', conditions: [], actions: [{ type: 'script', script: 'single' }, { type: 'script', script: 5 }, { type: 'script', script: ['a', 'b'] }] }];
    walkEventStrings(sheet(oneString), { scriptLine: (site, line) => lines.push(`${site.ace}:${line}`) });
    expect(lines).toEqual(['action 0:single', 'action 2:a', 'action 2:b']);
  });

  it('takes a sheet without events', () => {
    const seen: string[] = [];
    walkEventStrings(undefined, { event: (_e, p) => seen.push(p) });
    walkEventStrings(sheet(undefined as unknown as unknown[]), { event: (_e, p) => seen.push(p) });
    expect(seen).toEqual([]);
  });
});

describe('quotedNamePattern', () => {
  it('finds the name in double, single and back quotes, ignoring case, with regex characters escaped', () => {
    for (const unicode of [false, true]) {
      const pattern = quotedNamePattern('Level (2).x', { unicode });
      expect(pattern.test('go("level (2).X")')).toBe(true);
      expect(pattern.test("go('Level (2).x')")).toBe(true);
      expect(pattern.test('go(`Level (2).x`)')).toBe(true);
      expect(pattern.test('go("Level 2x")')).toBe(false);
      expect(pattern.test('go("Level (2).x\')')).toBe(false);
      expect(pattern.test('"Level (2).xy"')).toBe(false);
    }
  });

  it('folds letter case the Unicode way only when asked to', () => {
    // U+212A (the Kelvin sign) is the capital of "k" only under Unicode case folding
    expect(quotedNamePattern('k', { unicode: true }).test('"K"')).toBe(true);
    expect(quotedNamePattern('k', { unicode: false }).test('"K"')).toBe(false);
    expect(quotedNamePattern('K', { unicode: false }).test('"k"')).toBe(true);
    // A name with characters outside the Basic Multilingual Plane matches whole
    expect(quotedNamePattern('\u{10428}', { unicode: true }).test('"\u{10400}"')).toBe(true);
    expect(quotedNamePattern('\u{10428}', { unicode: true }).test('"\uD801"')).toBe(false);
  });
});
