/**
 * update_function changes a function block (name, return type, options,
 * parameters) and, with updateCallers, the calls and function map
 * registrations that name it. All data is synthetic.
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
import { Construct3ProjectReader, type ReadFailure } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { searchText, type RawTextTerm } from '../../src/construct3/raw-text-search.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;
type Result = { content: Array<{ text: string }>; isError?: boolean };
const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });
const useOf = (name: string, sid: number): Ev => ({ id: 'compare-eventvar', objectClass: 'System', sid, parameters: { variable: name, comparison: 0, value: '1' } });
const call = (name: string, sid: number, args: unknown[]): Ev => ({ callFunction: name, sid, parameters: args });
const damage = (sid: number, paramSid: number, bodySid: number, useSid: number): Ev => ({
  functionName: 'Damage', functionDescription: '', functionCategory: '', functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false,
  functionParameters: [{ name: 'amount', type: 'number', initialValue: '0', comment: '', sid: paramSid }], eventType: 'function-block',
  conditions: [], actions: [], sid, children: [block(bodySid, { conditions: [useOf('amount', useSid)] })],
});
const heal = (sid: number): Ev => ({
  functionName: 'Heal', functionDescription: '', functionCategory: '', functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false,
  functionParameters: [], eventType: 'function-block', conditions: [], actions: [], sid,
});
const globalVariable = (name: string, sid: number): Ev => ({ eventType: 'variable', name, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid });

/** A reader that also registers event sheets it cannot parse (name to text), as the real reader reports them: absent from the bulk read, searchable as text. */
class UnparsableSheetsReader extends MockReader {
  constructor(data: ConstructorParameters<typeof MockReader>[0], private readonly unparsable: Record<string, string>) {
    super(data);
  }
  override async listEventSheets(): Promise<string[]> {
    return [...await super.listEventSheets(), ...Object.keys(this.unparsable)];
  }
  override getReadFailures(category: string): Map<string, ReadFailure> {
    if (category !== 'eventSheets') return super.getReadFailures(category);
    return new Map(Object.keys(this.unparsable).map(name => [name, { code: 'E_INVALID_JSON', message: 'not valid JSON' } as ReadFailure]));
  }
  override async searchEntityTextRaw(category: Parameters<MockReader['searchEntityTextRaw']>[0], name: string, terms: readonly RawTextTerm[]): Promise<Set<string>> {
    const text = this.unparsable[name];
    return category === 'eventSheets' && typeof text === 'string' ? searchText(text, terms) : super.searchEntityTextRaw(category, name, terms);
  }
}

/**
 * Sheet1: function Damage(amount) 100 whose body (110) uses amount, a call in block 200, a function map in 210, and (unless
 * left out) Functions.Damage(1) in 300. Other: a call in block 400. Third (when asked for): a call in block 500.
 * `unparsable`: event sheets registered but not parsed (name to text).
 */
function setup(options: { expression?: boolean; other?: Ev[]; calls?: boolean; third?: boolean; unparsable?: Record<string, string> } = {}) {
  const withCalls = options.calls ?? true;
  const sheet1: Ev[] = [
    damage(100, 101, 110, 111),
    ...(withCalls ? [block(200, { actions: [call('damage', 201, ['5'])] })] : []),
    block(210, { actions: [{ id: 'map-function', objectClass: 'Functions', sid: 211, parameters: { map: '"m"', string: '"k"', function: 'Damage' } }] }),
    ...(options.expression ?? true ? [block(300, { actions: [{ id: 'set-x', objectClass: 'Sprite', sid: 301, parameters: { x: 'Functions.Damage(1)' } }] })] : []),
  ];
  const other = options.other ?? (withCalls ? [block(400, { actions: [call('Damage', 401, ['1'])] })] : []);
  const server = new MockServer();
  const reader = new UnparsableSheetsReader({
    eventSheets: new Map([
      ['Sheet1', { name: 'Sheet1', sid: 1, events: sheet1 }],
      ['Other', { name: 'Other', sid: 2, events: other }],
      ...(options.third ? [['Third', { name: 'Third', sid: 3, events: [block(500, { actions: [call('Damage', 501, ['2'])] })] }] as const] : []),
    ]),
  }, options.unparsable ?? {});
  const writer = new MockWriter();
  registerEventTools({ server, reader, writer, idGen: new MockIdGenerator() } as unknown as MutationToolDeps);
  return { server, reader, writer };
}
const parse = (r: Result) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const errorText = (r: Result) => (r.isError ? r.content[0].text : '');
const writtenSheet = (writer: MockWriter, name: string): Ev[] | undefined =>
  (writer.callsFor('writeEntityFile').filter(c => c.args[1] === name).at(-1)?.args[2] as { events: Ev[] } | undefined)?.events;
const actionIn = (events: Ev[], blockSid: number): Ev => ((events.find(e => e.sid === blockSid)!.actions as Ev[])[0]);
/** The stored events of a sheet (the mock reader hands out the object it holds). */
const storedEvents = async (reader: MockReader, name: string): Promise<Ev[]> => (await reader.readEventSheet(name)).events as unknown as Ev[];
/** Every sheet the mock reader holds, as text, to compare before and after a call. */
const allSheets = async (reader: MockReader): Promise<string> =>
  JSON.stringify(await Promise.all((await MockReader.prototype.listEventSheets.call(reader)).map(n => reader.readEventSheet(n))));
/** 100,000 comments: a walk of every sheet stops at its traversal limit after them. */
const comments = (): Ev[] => Array.from({ length: 100_000 }, () => ({ eventType: 'comment', text: '' }));

describe('update_function', () => {
  it('changes description, category, isAsync and copyPicked in place', async () => {
    const { server, writer } = setup({ expression: false });
    const data = parse(await server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, description: 'Hurts', category: 'Combat', isAsync: true, copyPicked: true,
    }));
    expect(data).toMatchObject({ success: true, action: 'updated', updatedSid: 100, kind: 'function', name: 'Damage', previousName: 'Damage', updatedSheets: ['Sheet1'], rewrittenCalls: 0, rewrittenMaps: 0 });
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    const func = writtenSheet(writer, 'Sheet1')![0];
    expect(func).toMatchObject({ functionDescription: 'Hurts', functionCategory: 'Combat', functionIsAsync: true, functionCopyPicked: true, functionName: 'Damage' });
    // The keys stay where the block had them
    expect(Object.keys(func)).toEqual(Object.keys(damage(100, 101, 110, 111)));
    expect(actionIn(writtenSheet(writer, 'Sheet1')!, 200).callFunction).toBe('damage');
  });

  it('renames a function and its calls and function map registrations with updateCallers', async () => {
    const { server, writer } = setup({ expression: false });
    const data = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', updateCallers: true }));
    expect(data).toMatchObject({ success: true, action: 'updated', name: 'Hurt', previousName: 'Damage', updatedSheets: ['Other', 'Sheet1'], rewrittenCalls: 2, rewrittenMaps: 1 });
    const sheet1 = writtenSheet(writer, 'Sheet1')!;
    expect(sheet1[0].functionName).toBe('Hurt');
    expect(actionIn(sheet1, 200).callFunction).toBe('Hurt');
    expect((actionIn(sheet1, 210).parameters as Ev).function).toBe('Hurt');
    expect(actionIn(writtenSheet(writer, 'Other')!, 400).callFunction).toBe('Hurt');
  });

  it('refuses a rename with calls without updateCallers, listing them', async () => {
    const { server, reader, writer } = setup({ expression: false });
    const before = await allSheets(reader);
    const data = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt' }));
    expect(data).toMatchObject({ success: false, action: 'update_blocked' });
    expect(String(data.message)).toContain('3 call(s) or function map registration(s) use "Damage": Sheet1 block > action:0 (SID 200); Other block > action:0 (SID 400); Sheet1 block > action:0 (SID 210). Set updateCallers=true');
    expect(String(data.message)).toMatch(/Nothing was changed\.$/);
    expect(data.references).toEqual([
      { sheet: 'Sheet1', path: 'block > action:0', sid: 200, kind: 'callFunction' },
      { sheet: 'Other', path: 'block > action:0', sid: 400, kind: 'callFunction' },
      { sheet: 'Sheet1', path: 'block > action:0', sid: 210, kind: 'function-map' },
    ]);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await allSheets(reader)).toBe(before);
  });

  it('refuses a rename that Functions.Damage(...) expressions use without force, and renames with force, listing them', async () => {
    const { server, writer } = setup();
    const args = { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', updateCallers: true };
    const blocked = parse(await server.callTool('update_function', args));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect(String(blocked.message)).toContain('1 expression(s) call Functions.Damage(...): Sheet1 block > action:0 (SID 300).');
    expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
    expect(blocked.references).toEqual([{ sheet: 'Sheet1', path: 'block > action:0', sid: 300, kind: 'expression' }]);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('update_function', { ...args, force: true }));
    expect(forced).toMatchObject({ success: true, name: 'Hurt', rewrittenCalls: 2 });
    expect(String(forced.warnings)).toContain('Updated with force=true: 1 Functions.Damage(...) expression call(s) were left as they are: Sheet1 block > action:0 (SID 300).');
    // The expression is left as it is
    expect((actionIn(writtenSheet(writer, 'Sheet1')!, 300).parameters as Ev).x).toBe('Functions.Damage(1)');
  });

  it('refuses a name the editor refuses', async () => {
    const { server, reader, writer } = setup({ expression: false, other: [block(400, { actions: [call('Damage', 401, ['1'])] }), heal(410)] });
    const before = await allSheets(reader);
    const taken = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'heal', updateCallers: true }));
    expect(taken).toBe('The function "Heal", which differs from "heal" only in case, already exists in sheet "Other" (events[1], SID 410). '
      + 'Construct 3 requires a function name to differ, ignoring case, from every other function in the project (it looks '
      + 'functions up ignoring case, so a call could not tell them apart). Choose a different name. Nothing was changed.');
    const reserved = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'abs', updateCallers: true }));
    expect(reserved).toBe('"abs" is the name of the System expression "abs". Construct 3 reserves the names of its built-in System functions for functions; choose a different name. Nothing was changed.');
    const spaced = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Big hit', returnType: 'number', updateCallers: true }));
    expect(spaced).toMatch(/^"Big hit" is not a valid name for a function with return type "number": it contains whitespace\. .* Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await allSheets(reader)).toBe(before);
  });

  it('allows a case-only rename of its own name', async () => {
    const { server, writer } = setup({ expression: false });
    const data = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'DAMAGE', updateCallers: true }));
    expect(data).toMatchObject({ success: true, name: 'DAMAGE', rewrittenCalls: 2, rewrittenMaps: 1 });
    expect(writtenSheet(writer, 'Sheet1')![0].functionName).toBe('DAMAGE');
    expect(actionIn(writtenSheet(writer, 'Other')!, 400).callFunction).toBe('DAMAGE');
  });

  it('refuses return type "none" while expressions call the function, without force', async () => {
    const { server, reader, writer } = setup();
    (await storedEvents(reader, 'Sheet1'))[0].functionReturnType = 'number';
    const blocked = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, returnType: 'none' }));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect(String(blocked.message)).toContain('1 expression(s) call Functions.Damage(...)');
    expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, returnType: 'none', force: true }));
    expect(forced.success).toBe(true);
    expect(writtenSheet(writer, 'Sheet1')![0].functionReturnType).toBe('none');
  });

  it('refuses a return type that the current name cannot have', async () => {
    const { server, reader, writer } = setup({ expression: false });
    (await storedEvents(reader, 'Sheet1'))[0].functionName = 'Do it';
    const text = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, returnType: 'number' }));
    expect(text).toMatch(/^"Do it" is not a valid name for a function with return type "number": it contains whitespace\. /);
    expect(text).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('removes a parameter and the argument at its position from calls with updateCallers', async () => {
    const { server, reader, writer } = setup({ expression: false, other: [block(400, { actions: [call('Damage', 401, ['1', '2'])] })] });
    const sheet1 = await storedEvents(reader, 'Sheet1');
    (sheet1[0].functionParameters as Ev[]).push({ name: 'bonus', type: 'number', initialValue: '0', comment: '', sid: 102 });
    (actionIn(sheet1, 200).parameters as unknown[]).push('6');
    const data = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, removeParameters: ['bonus'], updateCallers: true }));
    expect(data).toMatchObject({ success: true, rewrittenCalls: 2, parameters: [{ name: 'amount', type: 'number', sid: 101 }] });
    expect(actionIn(writtenSheet(writer, 'Sheet1')!, 200).parameters).toEqual(['5']);
    expect(actionIn(writtenSheet(writer, 'Other')!, 400).parameters).toEqual(['1']);
    expect((writtenSheet(writer, 'Sheet1')![0].functionParameters as Ev[]).map(p => p.name)).toEqual(['amount']);
  });

  it('adds a parameter and its initial value to calls with updateCallers', async () => {
    const { server, writer } = setup({ expression: false });
    const data = parse(await server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'crit', type: 'boolean' }, { name: 'times', type: 'number', initialValue: '2.5', comment: 'how often' }], updateCallers: true,
    }));
    expect(data).toMatchObject({ success: true, rewrittenCalls: 2 });
    expect(actionIn(writtenSheet(writer, 'Sheet1')!, 200).parameters).toEqual(['5', false, '2.5']);
    expect(actionIn(writtenSheet(writer, 'Other')!, 400).parameters).toEqual(['1', false, '2.5']);
    const params = writtenSheet(writer, 'Sheet1')![0].functionParameters as Ev[];
    expect(params.slice(1)).toEqual([
      { name: 'crit', type: 'boolean', initialValue: 'false', comment: '', sid: 100_000_000_000_001 },
      { name: 'times', type: 'number', initialValue: '2.5', comment: 'how often', sid: 100_000_000_000_002 },
    ]);
  });

  it('refuses parameter changes with calls without updateCallers, and with expression calls without force', async () => {
    const { server, reader, writer } = setup();
    const before = await allSheets(reader);
    const noCallers = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'crit', type: 'boolean' }] }));
    expect(noCallers).toMatchObject({ success: false, action: 'update_blocked' });
    expect(String(noCallers.message)).toContain('2 call(s) or function map registration(s) use "Damage"');
    expect(String(noCallers.message)).toMatch(/Nothing was changed\.$/);
    const expressions = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'crit', type: 'boolean' }], updateCallers: true }));
    expect(expressions).toMatchObject({ success: false, action: 'update_blocked' });
    expect(String(expressions.message)).toContain('1 expression(s) call Functions.Damage(...)');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await allSheets(reader)).toBe(before);
  });

  it('leaves a call whose argument count is not the function\'s parameter count, and lists it', async () => {
    const { server, writer } = setup({ expression: false, other: [block(400, { actions: [call('Damage', 401, ['1', '2'])] })] });
    const data = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'crit', type: 'boolean' }], updateCallers: true }));
    expect(data).toMatchObject({ success: true, action: 'updated', rewrittenCalls: 1, updatedSheets: ['Sheet1'] });
    expect(actionIn(writtenSheet(writer, 'Sheet1')!, 200).parameters).toEqual(['5', false]);
    expect(writtenSheet(writer, 'Other')).toBeUndefined();
    expect(String(data.warnings)).toContain('1 call(s) pass a number of arguments other than the 1 parameter(s) "Damage" had');
    expect(String(data.warnings)).toContain('Other block > action:0 (SID 400)');
  });

  it('does not drop or add an argument twice when the same call runs again after a stop', async () => {
    // As the first run left it: Other already rewritten, Sheet1 (written last) not yet
    const { server, writer } = setup({ expression: false, other: [block(400, { actions: [call('Damage', 401, ['1', false])] })] });
    const data = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'crit', type: 'boolean' }], updateCallers: true }));
    expect(data.success).toBe(true);
    expect(writtenSheet(writer, 'Other')).toBeUndefined();
    const sheet1 = writtenSheet(writer, 'Sheet1')!;
    expect(actionIn(sheet1, 200).parameters).toEqual(['5', false]);
    expect((sheet1[0].functionParameters as Ev[]).map(p => p.name)).toEqual(['amount', 'crit']);
  });

  it('refuses removing and adding parameters together while calls exist, which a repeated run could not tell apart', async () => {
    const { server, reader, writer } = setup({ expression: false });
    const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
    const result = await server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, removeParameters: ['amount'], addParameters: [{ name: 'hits', type: 'number' }], updateCallers: true, force: true,
    });
    expect(errorText(result)).toContain('Make two calls: one that removes the parameters, then one that adds them.');
    expect(errorText(result)).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
    // With no call to rewrite, the same update is made
    const lone = setup({ expression: false, calls: false });
    const data = parse(await lone.server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, removeParameters: ['amount'], addParameters: [{ name: 'hits', type: 'number' }], force: true,
    }));
    expect(data.success).toBe(true);
  });

  it('renames a parameter in place and refuses it without force while the body uses the old name', async () => {
    const { server, writer } = setup({ expression: false });
    const args = { sheetName: 'Sheet1', sid: 100, renameParameters: [{ from: 'amount', to: 'dmg' }] };
    const blocked = parse(await server.callTool('update_function', args));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect(String(blocked.message)).toContain('Event variable "amount" is still used 1 time(s) where the parameter no longer exists after the update');
    expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('update_function', { ...args, force: true }));
    expect(forced).toMatchObject({ success: true, rewrittenCalls: 0, parameters: [{ name: 'dmg', type: 'number', sid: 101 }] });
    expect(JSON.stringify(forced.references)).toContain('"variable":"amount"');
    const func = writtenSheet(writer, 'Sheet1')![0];
    // Renamed in place: the record keeps its SID, its keys and its place
    expect(func.functionParameters).toEqual([{ name: 'dmg', type: 'number', initialValue: '0', comment: '', sid: 101 }]);
    // The use in the body is not rewritten, and no call changes
    expect((((func.children as Ev[])[0].conditions as Ev[])[0].parameters as Ev).variable).toBe('amount');
    expect(writtenSheet(writer, 'Other')).toBeUndefined();
  });

  it('refuses removing a parameter the body uses without force, and removes it with force, listing the uses', async () => {
    const { server, writer } = setup({ expression: false });
    const args = { sheetName: 'Sheet1', sid: 100, removeParameters: ['amount'], updateCallers: true };
    const blocked = parse(await server.callTool('update_function', args));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect(String(blocked.message)).toContain('"amount"');
    expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
    expect(JSON.stringify(blocked.references)).toContain('"sheet":"Sheet1"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('update_function', { ...args, force: true }));
    expect(forced).toMatchObject({ success: true, action: 'updated', rewrittenCalls: 2 });
    expect(String(forced.warnings)).toContain('Updated with force=true');
    expect(JSON.stringify(forced.references)).toContain('"sheet":"Sheet1"');
    // rewriteFunctionCallInPlace writes a call without arguments without the key
    expect('parameters' in actionIn(writtenSheet(writer, 'Other')!, 400)).toBe(false);
  });

  it('refuses an argument it does not take', async () => {
    const { server } = setup({ expression: false });
    await expect(server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', bogus: 1 })).rejects.toThrow();
    await expect(server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'a', type: 'number', bogus: 1 }],
    })).rejects.toThrow();
    await expect(server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, renameParameters: [{ from: 'amount', to: 'a', bogus: 1 }],
    })).rejects.toThrow();
  });

  it('refuses parameter names the editor refuses', async () => {
    const { server, reader, writer } = setup({ expression: false, other: [block(400, { actions: [call('Damage', 401, ['1'])] }), globalVariable('Score', 420)] });
    const before = await allSheets(reader);
    const global = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'score', type: 'number' }], updateCallers: true }));
    expect(global).toContain('Sheet "Other":');
    expect(global).toContain('Construct 3 requires a function parameter name to differ, ignoring case, from every global variable');
    expect(global).toMatch(/Nothing was changed\.$/);
    const twice = errorText(await server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'a', type: 'number' }, { name: 'A', type: 'number' }], updateCallers: true,
    }));
    expect(twice).toContain('"A"');
    expect(twice).toContain('"a"');
    expect(twice).toMatch(/Nothing was changed\.$/);
    const renamedToGlobal = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, renameParameters: [{ from: 'amount', to: 'SCORE' }] }));
    expect(renamedToGlobal).toContain('Construct 3 requires a function parameter name to differ');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await allSheets(reader)).toBe(before);
  });

  it('refuses to remove or rename a parameter the function does not have', async () => {
    const { server } = setup({ expression: false });
    const remove = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, removeParameters: ['nope'] }));
    expect(remove).toBe('The function "Damage" has no parameter "nope" to remove. Its parameters are "amount". Nothing was changed.');
    const rename = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, renameParameters: [{ from: 'nope', to: 'x' }] }));
    expect(rename).toBe('The function "Damage" has no parameter "nope" to rename. Nothing was changed.');
    const both = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, removeParameters: ['amount'], renameParameters: [{ from: 'amount', to: 'x' }] }));
    expect(both).toBe('The function "Damage" has no parameter "amount" to rename: this update also removes it. Nothing was changed.');
  });

  it('says a sheet that is not registered is not found, a registered sheet that cannot be read could not be read, and an event that is no function block is refused', async () => {
    const { server } = setup({ expression: false, unparsable: { Bad: '{"events"' } });
    const missing = errorText(await server.callTool('update_function', { sheetName: 'sheet1', sid: 100, functionName: 'Hurt' }));
    expect(missing).toBe('Event sheet "sheet1" not found: names are matched with their letter case. Did you mean "Sheet1"? Nothing was changed.');
    const unreadable = errorText(await server.callTool('update_function', { sheetName: 'Bad', sid: 100, functionName: 'Hurt' }));
    expect(unreadable).toBe('Event sheet "Bad" is registered in the project but could not be read. Nothing was changed.');
    const notFunction = errorText(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 200, functionName: 'Hurt' }));
    expect(notFunction).toBe('The event with SID 200 is a "block", not a function block or custom action block. Nothing was changed.');
  });

  it('skips a registered sheet that holds no event list', async () => {
    const { server, reader, writer } = setup({ expression: false });
    reader.addEventSheet('Odd', { name: 'Odd', sid: 9 });
    const data = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', updateCallers: true }));
    expect(data).toMatchObject({ success: true, updatedSheets: ['Other', 'Sheet1'] });
    expect(writtenSheet(writer, 'Odd')).toBeUndefined();
  });

  it('refuses a change while an event sheet it could not parse may name the function, without force', async () => {
    const { server, reader, writer } = setup({ expression: false, unparsable: { Bad: '{"events":[{"callFunction":"Damage"' } });
    const before = await allSheets(reader);
    const blocked = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', updateCallers: true }));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect(JSON.stringify(blocked.unscannedFiles)).toContain('Bad');
    expect(String(blocked.message)).toMatch(/Use force=true to update anyway\. Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await allSheets(reader)).toBe(before);
    const forced = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', updateCallers: true, force: true }));
    expect(forced.success).toBe(true);
    expect(String(forced.warnings)).toContain('Updated with force=true:');
  });

  it('refuses a change while the check for uses of the function stopped at its traversal limit, and updates with force', async () => {
    const { server, writer } = setup({ expression: false, other: [...comments(), block(400, { actions: [call('Damage', 401, ['1'])] })] });
    const limit = 'stopped at its traversal limit (100,000 events across all event sheets), so uses further on are unknown.';
    const blocked = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', updateCallers: true }));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect(String(blocked.message)).toBe(`The check for uses of the function "Damage" ${limit} Use force=true to update anyway. Nothing was changed.`);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', renameParameters: [{ from: 'amount', to: 'dmg' }], updateCallers: true, force: true,
    }));
    expect(forced.success).toBe(true);
    expect(forced.warnings).toContain(`Updated with force=true: The check for uses of the function "Damage" ${limit}`);
    expect(forced.warnings).toContain(`Updated with force=true: The check for uses of the parameters of "Damage" ${limit}`);
  });

  it('dryRun reports the plan and writes nothing', async () => {
    const { server, reader, writer } = setup({ expression: false });
    const before = await allSheets(reader);
    const data = parse(await server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', addParameters: [{ name: 'crit', type: 'boolean' }], updateCallers: true, dryRun: true,
    }));
    expect(data).toMatchObject({ dryRun: true, kind: 'function', name: 'Damage', newName: 'Hurt', returnType: 'none' });
    expect((data.parameters as Ev[]).map(p => p.name)).toEqual(['amount', 'crit']);
    expect(data.calls).toHaveLength(2);
    expect(data.maps).toHaveLength(1);
    expect(data.expressions).toEqual([]);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await allSheets(reader)).toBe(before);
  });

  it('reports an update to the values the function has as unchanged and writes nothing', async () => {
    const { server, reader, writer } = setup({ expression: false });
    const before = await allSheets(reader);
    const data = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Damage', description: '', isAsync: false, returnType: 'none' }));
    expect(data).toMatchObject({ success: true, action: 'unchanged', updatedSheets: [], rewrittenCalls: 0, rewrittenMaps: 0 });
    expect('editorNote' in data).toBe(false);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await allSheets(reader)).toBe(before);
  });

  it('puts every sheet in memory back when a step after the parameter change throws, and says nothing was changed', async () => {
    const { server, reader, writer } = setup({ expression: false });
    const before = await allSheets(reader);
    // The search of unparsed sheets runs after the parameter list was changed in memory
    reader.readAllEventSheets = async () => { throw new Error('EIO: i/o error, scandir'); };
    const result = await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'crit', type: 'boolean' }], updateCallers: true });
    expect(errorText(result)).toBe('The change was stopped before anything was written: EIO: i/o error, scandir. Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await allSheets(reader)).toBe(before);
  });

  it('puts every sheet in memory back when a write fails, and keeps the write error', async () => {
    const { server, reader, writer } = setup({ expression: false });
    const before = await allSheets(reader);
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = (async (...a: Parameters<typeof write>) => {
      if (a[1] === 'Sheet1') throw new Error('disk full');
      return write(...a);
    }) as typeof writer.writeEntityFile;
    const result = await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', updateCallers: true });
    expect(errorText(result)).toContain('disk full');
    expect(errorText(result)).not.toContain('stopped before anything was written');
    expect(await allSheets(reader)).toBe(before);
  });

  it('every refusal ends with Nothing was changed. and leaves every sheet as it was', async () => {
    type Case = { args: Record<string, unknown>; options?: Parameters<typeof setup>[0]; prepare?: (reader: MockReader) => Promise<void> };
    const noExpression = { expression: false };
    const cases: Case[] = [
      { args: {} },
      { args: { sheetName: 'sheet1', functionName: 'Hurt' } },
      { args: { sheetName: 'Bad', functionName: 'Hurt' }, options: { unparsable: { Bad: '{"events"' } } },
      { args: { sid: 999, functionName: 'Hurt' } },
      { args: { sid: 200, functionName: 'Hurt' } },
      { args: { functionName: 'heal', updateCallers: true }, options: { expression: false, other: [heal(410)] } },
      { args: { functionName: 'abs', updateCallers: true }, options: noExpression },
      { args: { functionName: 'Big hit', returnType: 'number', updateCallers: true }, options: noExpression },
      { args: { removeParameters: ['nope'], updateCallers: true }, options: noExpression },
      { args: { renameParameters: [{ from: 'nope', to: 'x' }] }, options: noExpression },
      // Combined with an earlier change in memory: the removal is made before the rename is refused
      { args: { removeParameters: ['amount'], renameParameters: [{ from: 'amount', to: 'x' }], updateCallers: true }, options: noExpression },
      { args: { addParameters: [{ name: 'n', type: 'number', initialValue: '1 + x' }], updateCallers: true }, options: noExpression },
      { args: { addParameters: [{ name: 'b', type: 'boolean', initialValue: 'yes' }], updateCallers: true }, options: noExpression },
      { args: { addParameters: [{ name: 'score', type: 'number' }], updateCallers: true }, options: { expression: false, other: [globalVariable('Score', 420)] } },
      { args: { renameParameters: [{ from: 'amount', to: 'dmg' }], addParameters: [{ name: 'a', type: 'number' }, { name: 'A', type: 'number' }], updateCallers: true }, options: noExpression },
      { args: { renameParameters: [{ from: 'amount', to: 'score' }] }, options: { expression: false, other: [globalVariable('Score', 420)] } },
      // Refused after the parameter list was changed in memory
      { args: { functionName: 'Hurt', renameParameters: [{ from: 'amount', to: 'dmg' }], force: true }, options: noExpression },
      { args: { removeParameters: ['amount'], addParameters: [{ name: 'hits', type: 'number' }], updateCallers: true, force: true }, options: noExpression },
      { args: { functionName: 'Hurt', addParameters: [{ name: 'crit', type: 'boolean' }], updateCallers: true } },
      { args: { functionName: 'Hurt', updateCallers: true }, options: { expression: false, unparsable: { Bad: '{"callFunction":"Damage"' } } },
      { args: { addParameters: [{ name: 'crit', type: 'boolean' }], updateCallers: true }, options: { expression: false, other: [...comments(), block(400)] } },
      { args: { removeParameters: ['amount'], updateCallers: true }, options: noExpression },
      { args: { renameParameters: [{ from: 'amount', to: 'dmg' }] }, options: noExpression },
      {
        args: { renameParameters: [{ from: 'amount', to: 'base' }, { from: 'bonus', to: 'amount' }] },
        options: { expression: false, calls: false },
        prepare: async reader => {
          ((await storedEvents(reader, 'Sheet1'))[0].functionParameters as Ev[]).push({ name: 'bonus', type: 'number', initialValue: '0', comment: '', sid: 102 });
        },
      },
      { args: { returnType: 'none' }, prepare: async reader => { (await storedEvents(reader, 'Sheet1'))[0].functionReturnType = 'number'; } },
      { args: { returnType: 'number' }, options: noExpression, prepare: async reader => { (await storedEvents(reader, 'Sheet1'))[0].functionName = 'Do it'; } },
    ];
    for (const { args, options, prepare } of cases) {
      const { server, reader, writer } = setup(options);
      await prepare?.(reader);
      const before = await allSheets(reader);
      const result = await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, ...args });
      const text = result.isError ? result.content[0].text : String(parse(result).message);
      expect(text, JSON.stringify(args)).toMatch(/Nothing was changed\.$/);
      expect(text.match(/Nothing was changed\./g), JSON.stringify(args)).toHaveLength(1);
      expect(await allSheets(reader), JSON.stringify(args)).toBe(before);
      expect(writer.callsFor('writeEntityFile'), JSON.stringify(args)).toHaveLength(0);
    }
  });

  it('writes the caller sheets before the definition\'s sheet', async () => {
    const { server, writer } = setup({ expression: false });
    await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', updateCallers: true });
    expect(writer.callsFor('writeEntityFile').map(c => c.args[1])).toEqual(['Other', 'Sheet1']);
  });

  it('reads every sheet before the first write, so a sheet read that would fail after a write cannot leave a caller sheet rewritten', async () => {
    const { server, reader, writer } = setup({ expression: false, third: true });
    const log: string[] = [];
    const read = reader.readEventSheet.bind(reader);
    reader.readEventSheet = (async (name: string) => {
      log.push(`read ${name}`);
      // A read of Third after a write fails, as an unreadable file would
      if (name === 'Third' && log.some(e => e.startsWith('write'))) throw new Error('EIO: i/o error, read');
      return read(name);
    }) as typeof reader.readEventSheet;
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = (async (...a: Parameters<typeof write>) => {
      log.push(`write ${String(a[1])}`);
      return write(...a);
    }) as typeof writer.writeEntityFile;
    const data = parse(await server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, functionName: 'Hurt', updateCallers: true }));
    expect(data).toMatchObject({ success: true, updatedSheets: ['Other', 'Third', 'Sheet1'], rewrittenCalls: 3 });
    const firstWrite = log.findIndex(e => e.startsWith('write'));
    expect(log.slice(firstWrite).filter(e => e.startsWith('read'))).toEqual([]);
  });

  it('refuses parameter renames that make a use in the body find another parameter, and renames with force', async () => {
    const { server, reader, writer } = setup({ expression: false, calls: false });
    const sheet = await reader.readEventSheet('Sheet1');
    // F(amount, bonus) whose body uses amount only
    ((sheet.events as unknown as Ev[])[0].functionParameters as Ev[]).push({ name: 'bonus', type: 'number', initialValue: '0', comment: '', sid: 102 });
    const args = { sheetName: 'Sheet1', sid: 100, renameParameters: [{ from: 'amount', to: 'base' }, { from: 'bonus', to: 'amount' }] };
    const blocked = parse(await server.callTool('update_function', args));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect(String(blocked.message)).toContain('where the name now finds another parameter after the update');
    expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('update_function', { ...args, force: true }));
    expect(forced.success).toBe(true);
    expect(String(forced.warnings)).toContain('reads or sets that one instead');
  });

  it('writes a string initial value with a quote as a Construct string literal in each call', async () => {
    const { server, writer } = setup({ expression: false });
    await server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'label', type: 'string', initialValue: 'say "hi"' }], updateCallers: true,
    });
    expect(actionIn(writtenSheet(writer, 'Other')!, 400).parameters).toEqual(['1', '"say ""hi"""']);
    const empty = setup({ expression: false });
    await empty.server.callTool('update_function', { sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'label', type: 'string' }], updateCallers: true });
    expect(actionIn(writtenSheet(empty.writer, 'Other')!, 400).parameters).toEqual(['1', '""']);
  });

  it('refuses an initial value the calls cannot take as an argument, before anything is written', async () => {
    const { server, writer } = setup({ expression: false });
    const result = await server.callTool('update_function', {
      sheetName: 'Sheet1', sid: 100, addParameters: [{ name: 'n', type: 'number', initialValue: '1 + x' }], updateCallers: true,
    });
    expect(errorText(result)).toContain('The initial value of a number parameter is a number');
    expect(errorText(result)).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

describe('update_function on disk', () => {
  const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
  let tmpDir: string;
  let server: MockServer;
  let writer: Construct3ProjectWriter;
  const sheetPath = (name: string) => join(tmpDir, 'eventSheets', `${name}.json`);

  /** An editor save: other bytes, another length, and an mtime the writer's stamp check cannot miss within one Windows timestamp tick. */
  async function editorSave(path: string, text: string): Promise<void> {
    await writeFile(path, text);
    const { mtime } = await stat(path);
    const later = new Date(mtime.getTime() + 2000);
    await utimes(path, later, later);
  }

  /** The writer's read-back of `file` fails once with an ordinary error; `before` runs first. */
  function failReadBack(file: string, before: () => Promise<void> = async () => {}): void {
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    let failed = false;
    internals.verifyWrittenFile = async (path, name, text) => {
      if (!failed && path.endsWith(file)) {
        failed = true;
        await before();
        throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
      }
      return verify(path, name, text);
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-update-function-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const main = JSON.parse(await readFile(sheetPath('MainSheet'), 'utf8')) as { events: Ev[] };
    main.events.push(damage(410000000000010, 410000000000011, 410000000000012, 410000000000013));
    await writeFile(sheetPath('MainSheet'), JSON.stringify(main, null, '\t'));
    const other = { name: 'Other', events: [block(410000000000020, { actions: [call('Damage', 410000000000021, ['1'])] })], sid: 410000000000022 };
    await writeFile(sheetPath('Other'), JSON.stringify(other, null, '\t'));
    const third = { name: 'Third', events: [block(410000000000030, { actions: [call('Damage', 410000000000031, ['2'])] })], sid: 410000000000032 };
    await writeFile(sheetPath('Third'), JSON.stringify(third, null, '\t'));
    // A sheet that is not valid JSON (cut off) and holds Functions.Damage(1) as text, as unscanned-uses.test.ts writes one
    const broken = JSON.stringify({ name: 'Broken', events: [block(410000000000040, { actions: [{ id: 'set-x', objectClass: 'Sprite', sid: 410000000000041, parameters: { x: 'Functions.Damage(1)' } }] })], sid: 410000000000042 }, null, '\t');
    await writeFile(sheetPath('Broken'), broken.slice(0, broken.length - 3));
    const projectPath = join(tmpDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as { eventSheets: { items: string[] } };
    project.eventSheets.items.push('Other', 'Third', 'Broken');
    await writeFile(projectPath, JSON.stringify(project, null, '\t'));
    const reader = new Construct3ProjectReader(projectPath);
    await reader.loadProject();
    writer = new Construct3ProjectWriter(reader, new IdGenerator());
    server = new MockServer();
    // Through withProjectSync, so each call runs in a tool call scope and the writer records its backups
    registerEventTools({ server: withProjectSync(server, reader), reader, writer, idGen: new IdGenerator() } as unknown as MutationToolDeps);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rolls back the caller sheets written before when the definition\'s sheet fails its read-back', async () => {
    const mainBefore = await readFile(sheetPath('MainSheet'), 'utf8');
    const otherBefore = await readFile(sheetPath('Other'), 'utf8');
    failReadBack('MainSheet.json');
    const result = await server.callTool('update_function', { sheetName: 'MainSheet', sid: 410000000000010, functionName: 'Hurt', updateCallers: true, force: true });
    expect(errorText(result)).toContain('The call was rolled back');
    expect(errorText(result)).toContain('eventSheets/Other.json');
    expect(errorText(result)).toContain('eventSheets/MainSheet.json');
    expect(await readFile(sheetPath('MainSheet'), 'utf8')).toBe(mainBefore);
    expect(await readFile(sheetPath('Other'), 'utf8')).toBe(otherBefore);
  });

  it('leaves a caller sheet the editor saved after the call wrote it, and names its .bak', async () => {
    const mainBefore = await readFile(sheetPath('MainSheet'), 'utf8');
    let saved = '';
    failReadBack('MainSheet.json', async () => {
      saved = `${await readFile(sheetPath('Other'), 'utf8')}\n\n`;
      await editorSave(sheetPath('Other'), saved);
    });
    const result = await server.callTool('update_function', { sheetName: 'MainSheet', sid: 410000000000010, functionName: 'Hurt', updateCallers: true, force: true });
    // undoToolCall's wording for a file changed on disk again after the call wrote it
    expect(errorText(result)).toContain('left as they are (changed on disk again after this call wrote them, or their backup was replaced): eventSheets/Other.json');
    expect(errorText(result)).toContain('eventSheets/Other.json.bak');
    expect(errorText(result)).not.toContain('Nothing was changed');
    // The left-as-it-is reason is the editor's save, not a missing tool call scope
    expect(errorText(result)).not.toContain('is no longer the copy this call made');
    expect(await readFile(sheetPath('Other'), 'utf8')).toBe(saved);
    expect(await readFile(sheetPath('MainSheet'), 'utf8')).toBe(mainBefore);
  });

  it('rolls back the first caller sheet when the second caller sheet fails its read-back, and leaves the definition as it was', async () => {
    const before = await Promise.all(['MainSheet', 'Other', 'Third'].map(n => readFile(sheetPath(n), 'utf8')));
    failReadBack('Third.json');
    const result = await server.callTool('update_function', { sheetName: 'MainSheet', sid: 410000000000010, functionName: 'Hurt', updateCallers: true, force: true });
    expect(errorText(result)).toContain('The call was rolled back');
    expect(errorText(result)).toContain('eventSheets/Other.json');
    expect(errorText(result)).toContain('eventSheets/Third.json');
    expect(await Promise.all(['MainSheet', 'Other', 'Third'].map(n => readFile(sheetPath(n), 'utf8')))).toEqual(before);
  });

  it('refuses removing the return type while an event sheet it could not parse may call it in an expression, without force', async () => {
    const main = JSON.parse(await readFile(sheetPath('MainSheet'), 'utf8')) as { events: Ev[] };
    expect(main.events.at(-1)!.functionReturnType).toBe('none');
    // Give Damage a return type first (no caller or expression in a parsed sheet depends on that change)
    const typed = parse(await server.callTool('update_function', { sheetName: 'MainSheet', sid: 410000000000010, returnType: 'number' }));
    expect(typed.success).toBe(true);
    const blocked = parse(await server.callTool('update_function', { sheetName: 'MainSheet', sid: 410000000000010, returnType: 'none' }));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect(JSON.stringify(blocked.unscannedFiles)).toContain('eventSheets/Broken');
    expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
    const forced = parse(await server.callTool('update_function', { sheetName: 'MainSheet', sid: 410000000000010, returnType: 'none', force: true }));
    expect(forced.success).toBe(true);
    expect(String(forced.warnings)).toContain('Updated with force=true');
  });
});
