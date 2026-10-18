/**
 * update_comment and update_script_event change a comment or script event in
 * place. These events have no SID, so each is addressed by its container (the
 * top level, a group, or the sub-events of an event) and its index. Refused,
 * changing nothing: no or several updates, an index past the end, an event of
 * another type, and a removal whose expected first line does not match. A
 * failed write is rolled back. Synthetic data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { withProjectSync } from '../../src/tools/project-sync.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;
type Result = { content: Array<{ text: string }>; isError?: boolean };

const comment = (text: string, extra: Ev = {}): Ev => ({ eventType: 'comment', text, ...extra });
const script = (lines: string[], extra: Ev = {}): Ev => ({ eventType: 'script', language: 'javascript', script: lines, ...extra });
const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });
const elseBlock = (sid: number): Ev => block(sid, { conditions: [{ id: 'else', objectClass: 'System', sid: sid + 1 }] });

/**
 * A top-level comment; group "G" (200) holding comment, block 210, script event,
 * else block 230; block 300 with a comment sub-event; group "E" (250) saved
 * without a children list.
 */
function sheetEvents(): Ev[] {
  return [
    comment('top'),
    { eventType: 'group', disabled: false, title: 'G', description: '', isActiveOnStart: true, children: [comment('in group'), block(210), script(['a = 1;', 'b = 2;']), elseBlock(230)], sid: 200 },
    block(300, { children: [comment('sub')] }),
    { eventType: 'group', disabled: false, title: 'E', description: '', isActiveOnStart: true, sid: 250 },
  ];
}

/** A writer whose write fails with an ordinary error. */
class FailingWriter extends MockWriter {
  override async writeEntityFile(): Promise<string> {
    throw new Error('disk full');
  }
}

function setup(writer: MockWriter = new MockWriter()) {
  const server = new MockServer();
  const reader = new MockReader({ eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 1, events: sheetEvents() }]]) });
  registerEventTools({ server, reader, writer, idGen: new MockIdGenerator() } as unknown as MutationToolDeps);
  return { server, reader, writer };
}
const parse = (r: Result) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const errorText = (r: Result) => (r.isError ? r.content[0].text : '');
const written = (writer: MockWriter): Ev[] => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as { events: Ev[] }).events;
const sheetOf = async (reader: MockReader) => (await reader.readEventSheet('Sheet1')).events as unknown as Ev[];
const groupG = (events: Ev[]) => (events[1].children as Ev[]);

/**
 * Adds a top-level block 500 whose conditions are read from `late` once group "G" has lost the
 * event at index 2 (a removal), and are none before. No real sheet gets a new load-time error
 * from losing a script event, since the rules look at an event's ancestors and, for else blocks,
 * at its predecessor (a warning), so this makes the input of the check change with the removal.
 */
function withLateConditions(events: Ev[], late: () => unknown[]): void {
  const lateBlock = block(500);
  Object.defineProperty(lateBlock, 'conditions', { enumerable: true, configurable: true, get: () => (groupG(events).length < 4 ? late() : []) });
  events.push(lateBlock);
}

const COMMENT_TOOL = 'update_comment';
const SCRIPT_TOOL = 'update_script_event';

describe('update_comment', () => {
  it('edits text and colours in place at the top level, in a group and among a block\'s sub-events', async () => {
    const { server, writer } = setup();
    // Top level: text, then a text colour, then a background colour, each where the editor writes it
    await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 0, text: 'new top' });
    expect(written(writer)[0]).toEqual({ eventType: 'comment', text: 'new top' });
    await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 0, textColor: [1, 0, 0, 1] });
    await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 0, backgroundColor: [0, 0, 1, 1] });
    expect(Object.keys(written(writer)[0])).toEqual(['eventType', 'text', 'text-color', 'background-color']);
    expect(written(writer)[0]).toMatchObject({ 'text-color': [1, 0, 0, 1], 'background-color': [0, 0, 1, 1] });
    // null removes a colour; the other keeps its place
    await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 0, textColor: null });
    expect(Object.keys(written(writer)[0])).toEqual(['eventType', 'text', 'background-color']);

    // A comment event saved without a text key: the colour goes after eventType
    const bare = setup();
    (await sheetOf(bare.reader))[0] = { eventType: 'comment' };
    await bare.server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 0, textColor: [0, 1, 0, 1] });
    expect(Object.keys(written(bare.writer)[0])).toEqual(['eventType', 'text-color']);

    // In a group: a background colour first, then a text colour, which goes before it
    await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 0, backgroundColor: [0, 1, 0, 1] });
    await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 0, textColor: [0, 0, 0, 1], text: 'new group text' });
    const inGroup = groupG(written(writer))[0];
    expect(Object.keys(inGroup)).toEqual(['eventType', 'text', 'text-color', 'background-color']);
    expect(inGroup.text).toBe('new group text');

    // Among a block's sub-events
    const data = parse(await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', parentSid: 300, index: 0, text: 'new sub' }));
    expect(data).toMatchObject({ success: true, action: 'updated', eventPath: 'events[2].children[0]' });
    expect((written(writer)[2].children as Ev[])[0].text).toBe('new sub');
  });

  it('refuses an index in a group saved without a children list and leaves the group without one', async () => {
    const { server, reader, writer } = setup();
    const result = await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', groupPath: 'E', index: 0, text: 'x' });
    expect(errorText(result)).toBe('Index 0 is out of range: group "E" holds 0 event(s), indexes 0-0. Nothing was changed.');
    expect('children' in (await sheetOf(reader))[3]).toBe(false);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses an index past the end and an event that is not a comment', async () => {
    const { server } = setup();
    expect(errorText(await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 4, text: 'x' })))
      .toBe('Index 4 is out of range: group "G" holds 4 event(s), indexes 0-3. Nothing was changed.');
    expect(errorText(await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 1, text: 'x' })))
      .toBe('The event at index 1 of group "G" is a "block", not a comment; indexes count every event of the container. Nothing was changed.');
    expect(errorText(await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', parentSid: 300, index: 3, text: 'x' })))
      .toBe('Index 3 is out of range: the sub-events of SID 300 holds 1 event(s), indexes 0-0. Nothing was changed.');
    expect(errorText(await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 1, text: 'x' })))
      .toBe('The event at index 1 of the top level is a "group", not a comment; indexes count every event of the container. Nothing was changed.');
  });

  it('refuses an argument it does not take', async () => {
    const { server } = setup();
    await expect(server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 0, text: 'x', bogus: 1 })).rejects.toThrow();
    await expect(server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 0, text: 'x', siblingSid: 210 }))
      .rejects.toThrow('update_comment takes sheetName, groupPath, parentSid, parentEventPath, index, text, textColor and backgroundColor. A comment is addressed by its container and index.');
  });

  it('reports an update to the values the comment has as unchanged and writes nothing', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 0, text: 'top', textColor: null }));
    expect(data).toMatchObject({ success: true, action: 'unchanged', eventPath: 'events[0]' });
    expect(data).not.toHaveProperty('editorNote');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('puts the sheet in memory back when a change stops partway, and when its write fails', async () => {
    const { server, reader, writer } = setup();
    const top = (await sheetOf(reader))[0];
    // The text is set first, then the background colour, whose key cannot be set
    Object.defineProperty(top, 'background-color', { enumerable: true, configurable: true, get: () => [0, 0, 0, 1], set: () => { throw new Error('the colour cannot be set'); } });
    const result = await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 0, text: 'x', backgroundColor: [1, 1, 1, 1] });
    expect(errorText(result)).toBe('The change was stopped before anything was written: the colour cannot be set. Nothing was changed.');
    expect((await sheetOf(reader))[0].text).toBe('top');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    const failing = setup(new FailingWriter());
    const failed = await failing.server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', index: 0, text: 'x' });
    expect(errorText(failed)).toContain('disk full');
    expect((await sheetOf(failing.reader))[0].text).toBe('top');
  });
});

describe('update_script_event', () => {
  it('replaces the lines and keeps the other keys', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, script: 'x = 1;\ny = 2;\nz = 3;' }));
    expect(data).toMatchObject({ success: true, action: 'updated', eventPath: 'events[1].children[2]' });
    expect(groupG(written(writer))[2]).toEqual({ eventType: 'script', language: 'javascript', script: ['x = 1;', 'y = 2;', 'z = 3;'] });
    await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, script: ['only line'] });
    expect(groupG(written(writer))[2].script).toEqual(['only line']);
  });

  it('toggles disabled', async () => {
    const { server, writer } = setup();
    await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, disabled: true });
    expect(Object.keys(groupG(written(writer))[2])).toEqual(['eventType', 'language', 'script', 'disabled']);
    expect(groupG(written(writer))[2].disabled).toBe(true);
    await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, disabled: false });
    expect(Object.keys(groupG(written(writer))[2])).toEqual(['eventType', 'language', 'script']);
  });

  it('removes the script event and returns the load-time gate\'s warnings', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, remove: true, expectedText: 'a = 1;' }));
    expect(data).toMatchObject({ success: true, action: 'deleted', eventPath: 'events[1].children[2]' });
    expect(data.warnings).toEqual(['The else block with SID 230 now follows the event with SID 210 instead of no event with a SID, so it runs when that event\'s conditions are false.']);
    expect(groupG(written(writer)).map(e => e.eventType)).toEqual(['comment', 'block', 'block']);
  });

  it('refuses to remove when the script at the index is not the expected one', async () => {
    const { server, reader, writer } = setup();
    groupG(await sheetOf(reader)).push(script(['second();']));
    const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
    expect(errorText(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 4, remove: true, expectedText: 'a = 1;' })))
      .toBe('The script event at index 4 of group "G" starts with "second();", not "a = 1;". Read the sheet again and give the index of the script event to remove. Nothing was changed.');
    expect(errorText(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 4, remove: true })))
      .toBe('remove needs expectedText, the first line of the script event to remove. Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
    // The right first line removes it
    const removed = parse(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 4, remove: true, expectedText: 'second();' }));
    expect(removed.action).toBe('deleted');
  });

  it('refuses a removal after which the load-time check finds a new error, and puts the sheet back', async () => {
    const { server, reader, writer } = setup();
    const trigger = (sid: number): Ev => ({ id: 'on-start-of-layout', objectClass: 'System', sid });
    withLateConditions(await sheetOf(reader), () => [trigger(501), trigger(502)]);
    const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
    const text = errorText(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, remove: true, expectedText: 'a = 1;' }));
    expect(text).toContain('Construct 3 load-time check failed; nothing was written.');
    expect(text).toContain('Event has 2 triggers');
    expect(text).toMatch(/Nothing was changed\.$/);
    expect(text.match(/Nothing was changed\./g)).toHaveLength(1);
    expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('compares the first line of a script saved as a list whose first entry holds a line break', async () => {
    const { server, reader } = setup();
    groupG(await sheetOf(reader))[2].script = ['first line\nsecond line', 'third'];
    expect(errorText(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, remove: true, expectedText: 'first line\nsecond line' })))
      .toContain('starts with "first line", not');
    const removed = parse(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, remove: true, expectedText: 'first line' }));
    expect(removed.action).toBe('deleted');
  });

  it('writes a script event that stores disabled: false without the key when disabled is false, and keeps the other keys', async () => {
    const { server, reader, writer } = setup();
    groupG(await sheetOf(reader))[2].disabled = false;
    const data = parse(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, disabled: false }));
    expect(data.action).toBe('updated');
    expect(groupG(written(writer))[2]).toEqual({ eventType: 'script', language: 'javascript', script: ['a = 1;', 'b = 2;'] });
  });

  it('refuses an event sheet that is not registered or cannot be read, saying Nothing was changed.', async () => {
    const { server, writer } = setup();
    for (const sheetName of ['Nope', 'sheet1']) {
      expect(errorText(await server.callTool(SCRIPT_TOOL, { sheetName, groupPath: 'G', index: 2, disabled: true })), sheetName).toMatch(/not found.*Nothing was changed\.$/s);
      expect(errorText(await server.callTool(COMMENT_TOOL, { sheetName, index: 0, text: 'x' })), sheetName).toMatch(/not found.*Nothing was changed\.$/s);
    }
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('names an event without an eventType as one, not as "undefined"', async () => {
    const { server, reader } = setup();
    groupG(await sheetOf(reader)).push({ sid: 240 });
    expect(errorText(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 4, disabled: true })))
      .toBe('The event at index 4 of group "G" has no eventType, so it is not a script event; indexes count every event of the container. Nothing was changed.');
    expect(errorText(await server.callTool(COMMENT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 4, text: 'x' })))
      .toBe('The event at index 4 of group "G" has no eventType, so it is not a comment; indexes count every event of the container. Nothing was changed.');
  });

  it('compares the first line of a script saved as one string', async () => {
    const { server, reader } = setup();
    groupG(await sheetOf(reader))[2].script = 'first line\nsecond line';
    expect(errorText(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, remove: true, expectedText: 'first line\nsecond line' })))
      .toContain('starts with "first line", not');
    const removed = parse(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, remove: true, expectedText: 'first line' }));
    expect(removed.action).toBe('deleted');
  });

  it('refuses none or more than one of script, disabled and remove, expectedText without remove, and an event that is not a script event', async () => {
    const { server } = setup();
    const base = { sheetName: 'Sheet1', groupPath: 'G', index: 2 };
    for (const extra of [{}, { remove: false }, { script: 'x', disabled: true }, { remove: true, expectedText: 'a = 1;', script: 'x' }, { disabled: true, remove: true, expectedText: 'a = 1;' }]) {
      expect(errorText(await server.callTool(SCRIPT_TOOL, { ...base, ...extra })), JSON.stringify(extra))
        .toBe('Give exactly one of script, disabled and remove. Nothing was changed.');
    }
    expect(errorText(await server.callTool(SCRIPT_TOOL, { ...base, script: 'x', expectedText: 'a = 1;' })))
      .toBe('expectedText is only used with remove. Nothing was changed.');
    expect(errorText(await server.callTool(SCRIPT_TOOL, { ...base, index: 1, disabled: true })))
      .toBe('The event at index 1 of group "G" is a "block", not a script event; indexes count every event of the container. Nothing was changed.');
    expect(errorText(await server.callTool(SCRIPT_TOOL, { ...base, index: 9, disabled: true })))
      .toBe('Index 9 is out of range: group "G" holds 4 event(s), indexes 0-3. Nothing was changed.');
  });

  it('refuses an argument it does not take', async () => {
    const { server } = setup();
    await expect(server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, disabled: true, bogus: 1 })).rejects.toThrow();
    await expect(server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, disabled: true, siblingSid: 210 }))
      .rejects.toThrow('update_script_event takes sheetName, groupPath, parentSid, parentEventPath, index, script, disabled, remove and expectedText. A script event is addressed by its container and index.');
  });

  it('reports an update to the values the event has as unchanged and writes nothing', async () => {
    const { server, writer } = setup();
    for (const extra of [{ script: ['a = 1;', 'b = 2;'] }, { script: 'a = 1;\nb = 2;' }, { disabled: false }]) {
      const data = parse(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, ...extra }));
      expect(data, JSON.stringify(extra)).toMatchObject({ success: true, action: 'unchanged', eventPath: 'events[1].children[2]' });
      expect(data).not.toHaveProperty('editorNote');
    }
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('puts the sheet in memory back when a change stops partway, when the gate stops, and when its write fails', async () => {
    const { server, reader, writer } = setup();
    const events = await sheetOf(reader);
    const lines = groupG(events)[2].script;
    Object.defineProperty(groupG(events)[2], 'script', { enumerable: true, configurable: true, get: () => lines, set: () => { throw new Error('the script cannot be set'); } });
    expect(errorText(await server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, script: 'x' })))
      .toBe('The change was stopped before anything was written: the script cannot be set. Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    // The load-time check cannot read an event once the script event is gone
    const stopping = setup();
    withLateConditions(await sheetOf(stopping.reader), () => { throw new Error('the check cannot read this event'); });
    const before = JSON.stringify(await stopping.reader.readEventSheet('Sheet1'));
    const stopped = await stopping.server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, remove: true, expectedText: 'a = 1;' });
    expect(errorText(stopped)).toBe('The change was stopped before anything was written: the check cannot read this event. Nothing was changed.');
    expect(JSON.stringify(await stopping.reader.readEventSheet('Sheet1'))).toBe(before);
    expect(stopping.writer.callsFor('writeEntityFile')).toHaveLength(0);

    const failing = setup(new FailingWriter());
    const failed = await failing.server.callTool(SCRIPT_TOOL, { sheetName: 'Sheet1', groupPath: 'G', index: 2, disabled: true });
    expect(errorText(failed)).toContain('disk full');
    expect('disabled' in groupG(await sheetOf(failing.reader))[2]).toBe(false);
  });
});

describe('update_comment and update_script_event', () => {
  it('every refusal ends with Nothing was changed. and leaves the sheet as it was', async () => {
    // Each also asks for a change that would be made if the call went through
    const calls: Array<{ tool: string; args: Ev; prepare?: (events: Ev[]) => void }> = [
      { tool: COMMENT_TOOL, args: { index: 0 } },
      { tool: COMMENT_TOOL, args: { index: 5, text: 'x' } },
      { tool: COMMENT_TOOL, args: { groupPath: 'G', index: 1, text: 'x' } },
      { tool: COMMENT_TOOL, args: { groupPath: 'Nope', index: 0, text: 'x' } },
      { tool: COMMENT_TOOL, args: { groupPath: 'G', parentSid: 300, index: 0, text: 'x' } },
      { tool: COMMENT_TOOL, args: { parentSid: 999, index: 0, text: 'x' } },
      { tool: COMMENT_TOOL, args: { parentEventPath: 'events[2]', index: 0, text: 'x' } },
      { tool: SCRIPT_TOOL, args: { groupPath: 'G', index: 2 } },
      { tool: SCRIPT_TOOL, args: { groupPath: 'G', index: 2, script: 'x', disabled: true } },
      { tool: SCRIPT_TOOL, args: { groupPath: 'G', index: 2, remove: true } },
      { tool: SCRIPT_TOOL, args: { groupPath: 'G', index: 2, remove: true, expectedText: 'other' } },
      { tool: SCRIPT_TOOL, args: { groupPath: 'G', index: 2, script: 'x', expectedText: 'a = 1;' } },
      { tool: SCRIPT_TOOL, args: { groupPath: 'G', index: 1, script: 'x' } },
      { tool: SCRIPT_TOOL, args: { groupPath: 'G', index: 7, disabled: true } },
      { tool: SCRIPT_TOOL, args: { groupPath: 'E', index: 0, disabled: true } },
      { tool: COMMENT_TOOL, args: { sheetName: 'Nope', index: 0, text: 'x' } },
      { tool: SCRIPT_TOOL, args: { sheetName: 'Nope', groupPath: 'G', index: 2, disabled: true } },
      // Refused after the script event was taken out in memory: the load-time check finds a new error
      {
        tool: SCRIPT_TOOL,
        args: { groupPath: 'G', index: 2, remove: true, expectedText: 'a = 1;' },
        prepare: events => withLateConditions(events, () => [{ id: 'on-start-of-layout', objectClass: 'System', sid: 501 }, { id: 'on-start-of-layout', objectClass: 'System', sid: 502 }]),
      },
    ];
    for (const { tool, args, prepare } of calls) {
      const { server, reader, writer } = setup();
      prepare?.(await sheetOf(reader));
      const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
      const result = await server.callTool(tool, { sheetName: 'Sheet1', ...args });
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(errorText(result), `${tool} ${JSON.stringify(args)}`).toMatch(/Nothing was changed\.$/);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
    }
  });
});

describe.each([
  { tool: COMMENT_TOOL, args: { index: 1, text: 'changed' } },
  { tool: SCRIPT_TOOL, args: { index: 2, script: 'changed();' } },
])('$tool on disk', ({ tool, args }) => {
  const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
  let tmpDir: string;
  let server: MockServer;
  let writer: Construct3ProjectWriter;
  const sheetPath = () => join(tmpDir, 'eventSheets', 'MainSheet.json');

  /** An editor save: other bytes, another length, and an mtime the writer's stamp check cannot miss within one Windows timestamp tick. */
  async function editorSave(path: string, text: string): Promise<void> {
    await writeFile(path, text);
    const { mtime } = await stat(path);
    const later = new Date(mtime.getTime() + 2000);
    await utimes(path, later, later);
  }

  /** The writer's read-back of the sheet fails once with an ordinary error; `before` runs first. */
  function failReadBack(before: () => Promise<void> = async () => {}): void {
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    let failed = false;
    internals.verifyWrittenFile = async (path, name, text) => {
      if (!failed && path.endsWith('MainSheet.json')) {
        failed = true;
        await before();
        throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
      }
      return verify(path, name, text);
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-update-comment-script-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as { events: Ev[] };
    sheet.events.push(comment('note'), script(['original();']));
    await writeFile(sheetPath(), JSON.stringify(sheet, null, '\t'));
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    writer = new Construct3ProjectWriter(reader, new IdGenerator());
    server = new MockServer();
    // Through withProjectSync, so each call runs in a tool call scope and the writer records its backups
    registerEventTools({ server: withProjectSync(server, reader), reader, writer, idGen: new IdGenerator() } as unknown as MutationToolDeps);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('changes the event on disk', async () => {
    const data = parse(await server.callTool(tool, { sheetName: 'MainSheet', ...args }));
    expect(data.action).toBe('updated');
    const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as { events: Ev[] };
    expect(JSON.stringify(sheet.events[args.index])).toContain('changed');
  });

  it('puts the sheet back when its write fails its read-back', async () => {
    const before = await readFile(sheetPath(), 'utf8');
    failReadBack();
    const result = await server.callTool(tool, { sheetName: 'MainSheet', ...args });
    expect(errorText(result)).toContain('The call was rolled back: eventSheets/MainSheet.json is as before the call.');
    expect(await readFile(sheetPath(), 'utf8')).toBe(before);
  });

  it('leaves a sheet the editor saved after the failed write as it is and names its .bak', async () => {
    const saved = `${await readFile(sheetPath(), 'utf8')}\n\n`;
    failReadBack(() => editorSave(sheetPath(), saved));
    const result = await server.callTool(tool, { sheetName: 'MainSheet', ...args });
    expect(errorText(result)).toContain('left as it is: eventSheets/MainSheet.json');
    expect(errorText(result)).toContain('eventSheets/MainSheet.json.bak');
    expect(errorText(result)).not.toContain('Nothing was changed');
    // The left-as-it-is reason is the editor's save, not a missing tool call scope
    expect(errorText(result)).not.toContain('is no longer the copy this call made');
    expect(await readFile(sheetPath(), 'utf8')).toBe(saved);
  });
});
