/**
 * An event whose last sub-event is taken out is written without a children key,
 * as the editor writes an event without sub-events. A group keeps its list.
 * update_script_event (remove) and delete_event_from_sheet follow the rule
 * move_event_block applies. Synthetic data.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;

const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });
const script = (lines: string[]): Ev => ({ eventType: 'script', language: 'javascript', script: lines });
const group = (title: string, sid: number, children: Ev[]): Ev =>
  ({ eventType: 'group', disabled: false, title, description: '', isActiveOnStart: true, children, sid });

/**
 * Block 300 holds one script event, block 400 holds block 410, group "G" holds one script event, block 500 stands
 * alone and group "H" holds block 230.
 */
function sheetEvents(): Ev[] {
  return [
    block(300, { children: [script(['a = 1;'])] }),
    block(400, { children: [block(410)] }),
    group('G', 200, [script(['b = 2;'])]),
    block(500),
    group('H', 220, [block(230)]),
  ];
}

function setup() {
  const server = new MockServer();
  const writer = new MockWriter();
  const reader = new MockReader({ eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 1, events: sheetEvents() }]]) });
  registerEventTools({ server, reader, writer, idGen: new MockIdGenerator() } as unknown as MutationToolDeps);
  return { server, writer };
}
const written = (writer: MockWriter): Ev[] => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as { events: Ev[] }).events;

/** The events of `sheetEvents()` after `edit` ran on them: what the written sheet must equal. */
function expectedEvents(edit: (events: Ev[]) => void): Ev[] {
  const events = sheetEvents();
  edit(events);
  return events;
}

describe('an emptied children list', () => {
  it('update_script_event remove drops the key of the event left without sub-events and keeps a group list', async () => {
    const { server, writer } = setup();
    const removed = await server.callTool('update_script_event', { sheetName: 'Sheet1', parentSid: 300, index: 0, remove: true, expectedText: 'a = 1;' });
    expect(removed.isError).toBeFalsy();
    expect(JSON.stringify(written(writer))).toBe(JSON.stringify(expectedEvents(events => { delete events[0].children; })));
    expect('children' in written(writer)[0]).toBe(false);

    const second = setup();
    const fromGroup = await second.server.callTool('update_script_event', { sheetName: 'Sheet1', groupPath: 'G', index: 0, remove: true, expectedText: 'b = 2;' });
    expect(fromGroup.isError).toBeFalsy();
    // The group keeps its key with an empty list
    expect(JSON.stringify(written(second.writer))).toBe(JSON.stringify(expectedEvents(events => { events[2].children = []; })));
  });

  it('delete_event_from_sheet drops the key of the event left without sub-events and keeps a group list', async () => {
    const { server, writer } = setup();
    const deleted = await server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 410 });
    expect(deleted.isError).toBeFalsy();
    expect(JSON.stringify(written(writer))).toBe(JSON.stringify(expectedEvents(events => { delete events[1].children; })));
    expect('children' in written(writer)[1]).toBe(false);

    const second = setup();
    const dryRun = await second.server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 410, dryRun: true });
    expect(dryRun.isError).toBeFalsy();
    expect(second.writer.callsFor('writeEntityFile')).toHaveLength(0);

    const third = setup();
    const fromGroup = await third.server.callTool('delete_event_from_sheet', { sheetName: 'Sheet1', sid: 230 });
    expect(fromGroup.isError).toBeFalsy();
    expect(JSON.stringify(written(third.writer))).toBe(JSON.stringify(expectedEvents(events => { events[4].children = []; })));
  });
});
