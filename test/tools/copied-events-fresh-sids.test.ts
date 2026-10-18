/**
 * move_events_between_sheets with deleteSource=false gives the copied events,
 * and everything inside them, new SIDs; a move keeps its SIDs. All data is
 * synthetic.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import * as eventHelpers from '../../src/tools/event-helpers.js';

const FIRST_DRAWN_SID = 100_000_000_000_001;

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerEventTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

const parseResult = (result: any) => JSON.parse(result.content[0].text);

/** The last event sheet data written under a name. */
function written(writer: MockWriter, name: string): any {
  const calls = writer.callsFor('writeEntityFile').filter(c => c.args[1] === name);
  return calls.at(-1)!.args[2];
}

const cond = (sid: number, value: string) => ({
  id: 'compare-instance-variable', objectClass: 'Player', sid,
  parameters: { 'instance-variable': 'health', comparison: 0, value },
});
const act = (sid: number, x: string) => ({ id: 'set-x', objectClass: 'Player', sid, parameters: { x } });

/** Every SID in a value, in traversal order of its keys. */
function allSids(value: unknown, found: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const item of value) allSids(item, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'sid' && typeof child === 'number') found.push(child);
      else allSids(child, found);
    }
  }
  return found;
}

/** A copy without SIDs, keys in their order. */
function withoutSids(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSids);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'sid').map(([k, v]) => [k, withoutSids(v)]));
}

/** Key order of a value and of everything inside it, as paths. */
function keyOrder(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => keyOrder(item, `${path}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [`${path}.${k}`, ...keyOrder(v, `${path}.${k}`)]);
}

function sourceSheet() {
  return {
    name: 'SourceSheet', sid: 1,
    events: [
      {
        eventType: 'block', sid: 500, conditions: [cond(501, '1'), cond(502, '2')], actions: [act(503, '10')],
        children: [
          { eventType: 'block', sid: 510, conditions: [cond(511, '3')], actions: [act(512, '20'), act(513, '30')] },
        ],
      },
      { eventType: 'block', sid: 520, conditions: [cond(521, '4')], actions: [] },
    ],
  };
}

function setupCopy() {
  const source = sourceSheet();
  const ctx = setup({
    eventSheets: new Map<string, any>([
      ['SourceSheet', source],
      ['TargetSheet', { name: 'TargetSheet', sid: 2, events: [] }],
    ]),
  });
  return { ...ctx, source, pristine: sourceSheet() };
}

describe('move_events_between_sheets copies get fresh SIDs', () => {
  it('gives a copied event, its sub-events, conditions, actions and parameters new SIDs that the project does not have', async () => {
    const { server, writer } = setupCopy();
    const data = parseResult(await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [500],
    }));
    expect(data.success).toBe(true);

    const copy = written(writer, 'TargetSheet').events[0];
    const original = allSids(sourceSheet());
    const copied = allSids(copy);
    // 500, 501, 502, 503, 510, 511, 512, 513
    expect(copied).toHaveLength(8);
    expect(new Set(copied).size).toBe(8);
    for (const sid of copied) expect(original).not.toContain(sid);
    // The event, a sub-event, a condition of the event, and an action of the sub-event
    expect(copy.sid).not.toBe(500);
    expect(copy.children[0].sid).not.toBe(510);
    expect(copy.conditions.map((c: any) => c.sid)).not.toContain(501);
    expect(copy.children[0].actions.map((a: any) => a.sid)).not.toContain(512);
  });

  it('gives the SIDs inside parameter lists new values too', async () => {
    const idGen = new MockIdGenerator();
    const value = {
      eventType: 'function-block', sid: 1,
      functionParameters: [{ name: 'n', type: 'number', sid: 2 }, { name: 'm', type: 'number', sid: 3 }],
      children: [{ eventType: 'block', sid: 4, conditions: [], actions: [] }],
    };
    const count = await eventHelpers.reassignSids({} as any, idGen as any, value);
    expect(count).toBe(4);
    expect(allSids(value).sort((a, b) => a - b)).toEqual([
      FIRST_DRAWN_SID, FIRST_DRAWN_SID + 1, FIRST_DRAWN_SID + 2, FIRST_DRAWN_SID + 3,
    ]);
  });

  it('stops with an error when the data is past the node limit', async () => {
    const idGen = new MockIdGenerator();
    const tooMany = Array.from({ length: eventHelpers.MAX_SEARCH_NODES + 1 }, () => ({}));
    await expect(eventHelpers.reassignSids({} as any, idGen as any, tooMany)).rejects.toThrow('SID reassignment exceeded');
  });

  it('keeps every other key of the copy as in the original, in order', async () => {
    const { server, writer } = setupCopy();
    await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [500, 520],
    });
    const copies = written(writer, 'TargetSheet').events;
    expect(withoutSids(copies)).toEqual(withoutSids(sourceSheet().events));
    expect(keyOrder(copies)).toEqual(keyOrder(sourceSheet().events));
  });

  it('keeps the SIDs of moved events', async () => {
    const { server, writer } = setupCopy();
    const data = parseResult(await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [500], deleteSource: true,
    }));
    expect(data.success).toBe(true);
    expect(data.reassignedSids).toBeUndefined();
    expect(allSids(written(writer, 'TargetSheet').events)).toEqual(allSids(sourceSheet().events[0]));
  });

  it('copies the same event twice without a shared-SID warning, each copy with its own SIDs', async () => {
    const { server, writer } = setupCopy();
    const copy = () => server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [500],
    });
    const first = parseResult(await copy());
    const second = parseResult(await copy());
    expect(first.warnings).toBeUndefined();
    expect(second.warnings).toBeUndefined();

    const events = written(writer, 'TargetSheet').events;
    expect(events).toHaveLength(2);
    const sids = allSids(events);
    expect(sids).toHaveLength(16);
    expect(new Set(sids).size).toBe(16);
  });

  it('still warns when a moved event\'s SID matches another event of the target', async () => {
    const source = sourceSheet();
    const { server, writer } = setup({
      eventSheets: new Map<string, any>([
        ['SourceSheet', source],
        ['TargetSheet', {
          name: 'TargetSheet', sid: 2,
          events: [{ eventType: 'block', sid: 500, conditions: [cond(601, '5')], actions: [] }],
        }],
      ]),
    });
    const data = parseResult(await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [500], deleteSource: true,
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toContain('because moved events keep their SIDs');
    expect(written(writer, 'TargetSheet').events.map((e: any) => e.sid)).toEqual([500, 500]);
  });

  it('reports how many SIDs a copy replaced', async () => {
    const { server } = setupCopy();
    const data = parseResult(await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [500, 520],
    }));
    // 8 in the first event with its sub-event, 2 in the second
    expect(data.reassignedSids).toBe(10);
  });

  it('a refused copy draws no SIDs from the ID generator', async () => {
    const variable = (sid: number) => ({
      eventType: 'variable', name: 'score', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid,
    });
    const { server, writer, idGen } = setup({
      eventSheets: new Map<string, any>([
        ['SourceSheet', { name: 'SourceSheet', sid: 1, events: [variable(700)] }],
        ['TargetSheet', { name: 'TargetSheet', sid: 2, events: [] }],
      ]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [700],
    });
    expect(result.isError).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await idGen.generateSid(null)).toBe(FIRST_DRAWN_SID);
  });
});
