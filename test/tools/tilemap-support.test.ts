import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import {
  refusal,
  unregisteredName,
  messageWithoutPaths,
  causeWithoutPaths,
  stoppedBeforeWrite,
  syncedTools,
} from '../../src/tools/tilemap-support.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';
import { currentToolCall } from '../../src/construct3/disk-state.js';
import { decodeTileData, cellsToRows } from '../../src/construct3/tilemap-data.js';
import { makeTilemapProject, PAINTED_DATA, PAINTED_ROWS, PAINTED_UID, BARE_UID } from '../helpers/tilemap-project.js';

const text = (result: { content: Array<{ text: string }> }) => result.content[0].text;

describe('refusal', () => {
  it('ends once with Nothing was changed.', () => {
    expect(text(refusal('Layout is missing.'))).toBe('Layout is missing. Nothing was changed.');
    expect(text(refusal('Layout is missing. Nothing was changed.'))).toBe('Layout is missing. Nothing was changed.');
    expect(text(refusal('Is the layout there?'))).toBe('Is the layout there? Nothing was changed.');
    expect(text(refusal('Layout is missing'))).toBe('Layout is missing. Nothing was changed.');
    expect(refusal('x').isError).toBe(true);
  });

  it('a message that is only the ending stays that ending', () => {
    expect(text(refusal('Nothing was changed.'))).toBe('Nothing was changed.');
    expect(text(refusal(''))).toBe('Nothing was changed.');
  });
});

describe('unregisteredName', () => {
  it('accepts the registered spelling, names the registered spelling for another case, and suggests otherwise', () => {
    expect(unregisteredName('Layout', 'Layout 1', ['Layout 1'], [], 'list_layouts')).toBeUndefined();
    const caseMessage = unregisteredName('Layout', 'layout 1', ['Layout 1'], [], 'list_layouts');
    expect(caseMessage).toContain('Did you mean "Layout 1"?');
    expect(caseMessage).toContain('letter case');
    expect(unregisteredName('Layout', 'Nope', ['Layout 1'], ['Layout 1'], 'list_layouts')).toContain('Did you mean: Layout 1?');
    expect(unregisteredName('Layout', 'Nope', ['Layout 1'], [], 'list_layouts')).toContain('Use list_layouts');
  });
});

describe('messageWithoutPaths', () => {
  it('removes the project folder in both slash forms and keeps the ending', () => {
    const backslash = 'C:\\Users\\x\\Proj';
    const forward = 'C:/Users/x/Proj';
    const message = `Could not read ${backslash}\\layouts\\a.json and ${forward}/layouts/b.json under ${backslash}.`;
    const result = messageWithoutPaths(new Error(message), backslash);
    expect(result).toBe('Could not read .\\layouts\\a.json and ./layouts/b.json under ..');
    expect(result).not.toContain('Users');
    expect(messageWithoutPaths(new Error(message), forward)).not.toContain('Users');
    expect(messageWithoutPaths(new Error('The file is as before the call.'), backslash)).toBe('The file is as before the call.');
    expect(messageWithoutPaths(new Error('Stopped. Nothing was changed.'), backslash)).toBe('Stopped. Nothing was changed.');
    expect(messageWithoutPaths('plain text', backslash)).toBe('plain text');
  });
});

describe('messageWithoutPaths edge cases', () => {
  it('leaves the message alone for an empty folder', () => {
    expect(messageWithoutPaths(new Error('a/b'), '')).toBe('a/b');
  });

  it('leaves a sibling folder that starts with the project folder alone', () => {
    expect(messageWithoutPaths(new Error('In C:\\Proj2\\x and C:\\Proj\\y.'), 'C:\\Proj')).toBe('In C:\\Proj2\\x and .\\y.');
  });

  it('replaces the folder whatever the letter case of the drive, and with a trailing separator', () => {
    expect(messageWithoutPaths(new Error('In c:\\users\\x\\Proj\\a.json'), 'C:\\Users\\x\\Proj\\')).toBe('In .\\a.json');
  });
});

describe('causeWithoutPaths', () => {
  it('drops only the final full stop', () => {
    expect(causeWithoutPaths(new Error('Bad. Worse.'), 'C:\\p')).toBe('Bad. Worse');
    expect(causeWithoutPaths(new Error('No full stop'), 'C:\\p')).toBe('No full stop');
    expect(causeWithoutPaths(new Error('In C:\\p\\a.json.'), 'C:\\p')).toBe('In .\\a.json');
  });
});

describe('stoppedBeforeWrite', () => {
  it('refuses without a path, with one full stop before the ending', () => {
    const message = text(stoppedBeforeWrite(new Error('Cannot read C:\\p\\a.json: EACCES.'), 'C:\\p'));
    expect(message).toBe('The change was stopped before anything was written: Cannot read .\\a.json: EACCES. Nothing was changed.');
    expect(message).not.toContain('..');
  });
});

describe('syncedTools', () => {
  interface Recorded { handler: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }

  function stubs(check: () => Promise<boolean>, projectDir: string) {
    const registered = new Map<string, Recorded['handler']>();
    const server = {
      tool: (name: string, _description: string, _shape: unknown, handler: Recorded['handler']) => { registered.set(name, handler); },
    } as unknown as MutationToolDeps['server'];
    const reader = { checkProjectFile: check, getProjectDir: () => projectDir } as unknown as MutationToolDeps['reader'];
    return { registered, tools: syncedTools(server, reader) };
  }

  const projectDir = 'C:\\Users\\x\\Proj';
  const failing = () => Promise.reject(new Error(`Cannot read ${projectDir}\\project.c3proj and C:/Users/x/Proj/project.c3proj.`));

  it('a failing project check is worded by the tool kind', async () => {
    const { registered, tools } = stubs(failing, projectDir);
    let called = 0;
    tools.writeTool('w', 'd', { a: z.string() }, () => { called++; return { content: [{ type: 'text', text: 'done' }] }; });
    tools.readTool('r', 'd', { a: z.string() }, () => { called++; return { content: [{ type: 'text', text: 'done' }] }; });

    const written = await registered.get('w')!({ a: 'x' });
    expect(written.isError).toBe(true);
    expect(written.content[0].text).not.toContain('Users');
    expect(written.content[0].text.startsWith('The change was stopped before anything was written:')).toBe(true);
    expect(written.content[0].text.endsWith('Nothing was changed.')).toBe(true);

    const read = await registered.get('r')!({ a: 'x' });
    expect(read.isError).toBe(true);
    expect(read.content[0].text).not.toContain('Users');
    expect(read.content[0].text).not.toContain('Nothing was changed.');
    expect(read.content[0].text.startsWith('Error reading the project:')).toBe(true);
    expect(called).toBe(0);
  });

  it('a passing project check runs the handler once, inside a tool call scope', async () => {
    const { registered, tools } = stubs(() => Promise.resolve(true), projectDir);
    const seen: Array<{ args: unknown; scoped: boolean }> = [];
    for (const kind of ['writeTool', 'readTool'] as const) {
      tools[kind](kind, 'd', { a: z.string() }, args => {
        seen.push({ args, scoped: currentToolCall() !== undefined });
        return { content: [{ type: 'text', text: 'done' }] };
      });
      const result = await registered.get(kind)!({ a: 'x' });
      expect(result.content[0].text).toBe('done');
    }
    expect(seen).toEqual([{ args: { a: 'x' }, scoped: true }, { args: { a: 'x' }, scoped: true }]);
  });
});

describe('the project helper', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

  it('writes the painted grid', async () => {
    dir = await mkdtemp(join(tmpdir(), 'c3-tilemap-support-'));
    await makeTilemapProject(dir);
    const layout = JSON.parse(await readFile(join(dir, 'layouts', 'Layout 1.json'), 'utf-8'));
    const instances = layout.layers[0].instances as Array<{ uid: number; ownData?: { tilemapData: { data: string } } }>;
    const painted = instances.find(i => i.uid === PAINTED_UID)!;
    expect(painted.ownData!.tilemapData.data).toBe(PAINTED_DATA);
    expect(cellsToRows(decodeTileData(painted.ownData!.tilemapData.data, 4, 2), 4, 2)).toEqual(PAINTED_ROWS);
    expect(instances.find(i => i.uid === BARE_UID)!.ownData).toBeUndefined();
  });
});
