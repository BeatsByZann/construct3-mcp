/**
 * Files near and over the size limit (#ISSUE): the writer checks the UTF-8
 * bytes of the text as written (CRLF, BOM, multibyte characters), against
 * the same limit the reader applies; C3MCP_MAX_FILE_MB sets it. Limits from
 * 1MB are always accepted; the test that raises the limit runs only when the
 * measured ceiling allows it. Synthetic layouts on a temp copy of the
 * minimal fixture, with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { DEFAULT_MAX_FILE_MB, describeFileSizeLimit, fileSizeLimit, MAX_FILE_MB_CEILING } from '../../src/construct3/file-size-limit.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const MB = 1024 * 1024;
const SLOW = 60_000;
const canRaise = MAX_FILE_MB_CEILING > DEFAULT_MAX_FILE_MB;

interface InstanceJson { tags?: string; uid?: number; [key: string]: unknown }
interface LayoutFile { name: string; layers: Array<{ name: string; instances: InstanceJson[] }>; [key: string]: unknown }
interface ToolData { isError?: boolean; text?: string; success?: boolean; [key: string]: unknown }

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const layoutPath = (name = 'Layout 1') => join(tmpDir, 'layouts', `${name}.json`);
const readLayoutFile = async (): Promise<LayoutFile> => JSON.parse(await readFile(layoutPath(), 'utf8')) as LayoutFile;
const call = async (tool: string, args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const rename = (newName: string) => call('update_layer', { layoutName: 'Layout 1', layerName: 'Main', newName });

/** "Layout 1" with `copies` copies of its first instance, its first instance's tags padded with spaces so the text is exactly `bytes`, in LF or CRLF. Returns its line breaks. */
async function writeLayoutOfSize(bytes: number, options: { copies?: number; crlf?: boolean; bom?: boolean } = {}): Promise<number> {
  const layout = await readLayoutFile();
  const [first] = layout.layers[0].instances;
  if (options.copies) layout.layers[0].instances = Array.from({ length: options.copies }, (_, i) => ({ ...structuredClone(first), uid: 1000 + i }));
  const bom = options.bom ? String.fromCharCode(0xfeff) : '';
  const render = (value: unknown) => {
    const lf = JSON.stringify(value, null, '\t');
    return bom + (options.crlf ? lf.replace(/\n/g, '\r\n') : lf);
  };
  layout.layers[0].instances[0].tags = '';
  const base = Buffer.byteLength(render(layout));
  layout.layers[0].instances[0].tags = ' '.repeat(bytes - base);
  const text = render(layout);
  expect(Buffer.byteLength(text)).toBe(bytes);
  await writeFile(layoutPath(), text);
  reader.invalidateCaches();
  return text.split('\n').length - 1;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-large-writes-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayoutTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('the size limit for reads and writes', () => {
  it('a layout between 5 and 10MB is changed at the default limit', async () => {
    await writeLayoutOfSize(7 * MB);
    const data = await rename('Game');
    expect(data.success).toBe(true);
    expect((await readLayoutFile()).layers[0].name).toBe('Game');
  }, SLOW);

  it('a layout over the limit is refused on read, naming the limit and the setting', async () => {
    await writeLayoutOfSize(12 * MB);
    // The outcome as text: a layout that was read must not reach the assertion's failure message, where printing 12MB hangs the reporter
    const outcome = await reader.readLayout('Layout 1').then(() => 'was read', (error: Error) => error.message);
    expect(outcome).toContain(`exceeds ${describeFileSizeLimit(fileSizeLimit())}`);
  }, SLOW);

  it.skipIf(!canRaise)('C3MCP_MAX_FILE_MB raises the limit for reads and writes', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '16');
    await writeLayoutOfSize(12 * MB);
    const data = await rename('Game');
    expect(data.success).toBe(true);
    const layout = await readLayoutFile();
    expect(layout.layers[0].name).toBe('Game');
    expect((layout.layers[0].instances[0].tags ?? '').length).toBeGreaterThan(11 * MB);
  }, SLOW);

  it('counts CRLF line endings: a new file is refused when its written text is over the limit, though its LF form is not', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    // project.c3proj in CRLF: a new layout takes that style
    const projectFile = join(tmpDir, 'project.c3proj');
    await writeFile(projectFile, (await readFile(projectFile, 'utf8')).replace(/\r?\n/g, '\r\n'));
    await reader.loadProject();
    const layout = await readLayoutFile();
    const [first] = layout.layers[0].instances;
    layout.name = 'Big';
    layout.layers[0].instances = Array.from({ length: 2000 }, (_, i) => ({ ...structuredClone(first), uid: 1000 + i }));
    layout.layers[0].instances[0].tags = '';
    const lines = JSON.stringify(layout, null, '\t').split('\n').length - 1;
    layout.layers[0].instances[0].tags = ' '.repeat(MB - 100 - Buffer.byteLength(JSON.stringify(layout, null, '\t')));
    const lfText = JSON.stringify(layout, null, '\t');
    expect(lfText.length).toBeLessThan(MB);
    expect(Buffer.byteLength(lfText) + lines).toBeGreaterThan(MB);

    await expect(writer.writeEntityFile('layouts', 'Big', layout)).rejects.toThrow(/is too large .* over the 1MB limit/);
    expect(existsSync(layoutPath('Big'))).toBe(false);
  }, SLOW);

  it('counts multibyte characters as UTF-8 bytes', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    const layout = await readLayoutFile();
    layout.name = 'Accents';
    layout.layers[0].instances[0].tags = String.fromCharCode(0xe9).repeat(Math.ceil(0.7 * MB));
    expect(JSON.stringify(layout, null, '\t').length).toBeLessThan(MB);
    await expect(writer.writeEntityFile('layouts', 'Accents', layout)).rejects.toThrow(/is too large/);
    expect(existsSync(layoutPath('Accents'))).toBe(false);
  }, SLOW);

  it('refuses an existing CRLF layout before backing anything up, though its LF JSON stays under the limit', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    // On disk 10 bytes under the limit; the rename adds 14, so the written text is 4 over it,
    // while its LF JSON is shorter by one byte per line break and passes the early check
    const lines = await writeLayoutOfSize(MB - 10, { copies: 200, crlf: true });
    expect(lines).toBeGreaterThan(100);
    const renamed = await readLayoutFile();
    renamed.layers[0].name = 'Main layer renamed';
    expect(JSON.stringify(renamed, null, '\t').length).toBeLessThan(MB);
    const before = await readFile(layoutPath());

    const data = await rename('Main layer renamed');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('is too large');
    expect(data.text).toContain('over the 1MB limit');
    expect(Buffer.compare(await readFile(layoutPath()), before)).toBe(0);
    expect(existsSync(`${layoutPath()}.bak`)).toBe(false);
  }, SLOW);

  it('counts the three bytes of a BOM', async () => {
    // The LF JSON after the rename is 2 bytes under 1MB; with the file's BOM the written text is 1 over it
    await writeLayoutOfSize(MB - 16 + 3, { bom: true });
    const text = await readFile(layoutPath());
    expect([...text.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.length).toBeLessThanOrEqual(MB);

    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    const data = await rename('Main layer renamed');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('is too large');
    expect(Buffer.compare(await readFile(layoutPath()), text)).toBe(0);
    expect(existsSync(`${layoutPath()}.bak`)).toBe(false);

    // Control: with room for the BOM the same rename is written, and the BOM stays
    vi.stubEnv('C3MCP_MAX_FILE_MB', '2');
    const done = await rename('Main layer renamed');
    expect(done.success).toBe(true);
    expect([...(await readFile(layoutPath())).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  }, SLOW);

  it('says the size of an early refusal is a lower bound', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    const layout = await readLayoutFile();
    layout.name = 'Plain';
    layout.layers[0].instances[0].tags = ' '.repeat(MB + 100);
    await expect(writer.writeEntityFile('layouts', 'Plain', layout)).rejects.toThrow(/is too large \(at least .*, over the 1MB limit/);
    expect(existsSync(layoutPath('Plain'))).toBe(false);
  }, SLOW);

  it('turns a value too large to stringify into the size refusal', async () => {
    const internals = writer as unknown as { validateJsonData: (data: unknown, name: string) => string };
    const huge = { toJSON: () => { throw new RangeError('Invalid string length'); } };
    expect(() => internals.validateJsonData(huge, 'Huge')).toThrow(/Generated JSON for "Huge" is too large to write/);
  });

  it('does not report a stack overflow as a size refusal', async () => {
    const internals = writer as unknown as { validateJsonData: (data: unknown, name: string) => string };
    const deep = { toJSON: () => { throw new RangeError('Maximum call stack size exceeded'); } };
    expect(() => internals.validateJsonData(deep, 'Deep')).toThrow('Maximum call stack size exceeded');
  });
});

describe('checkEntityWrite', () => {
  const messageOf = async (action: Promise<unknown>): Promise<string> =>
    action.then(() => 'resolved', (error: Error) => error.message);

  it('refuses what writeEntityFile refuses, and writes nothing', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    const layout = await readLayoutFile();
    // Multibyte characters only: the JSON is under the limit in characters, over it in bytes
    layout.layers[0].instances[0].tags = String.fromCharCode(0xe9).repeat(Math.ceil(0.7 * MB));
    expect(JSON.stringify(layout, null, '\t').length).toBeLessThan(MB);
    const before = await readFile(layoutPath());

    const checked = await messageOf(writer.checkEntityWrite('layouts', 'Layout 1', layout));
    expect(checked).toMatch(/is too large .* over the 1MB limit/);
    expect(checked).toBe(await messageOf(writer.writeEntityFile('layouts', 'Layout 1', layout)));
    expect(Buffer.compare(await readFile(layoutPath()), before)).toBe(0);
    expect(existsSync(`${layoutPath()}.bak`)).toBe(false);

    layout.layers[0].instances[0].tags = 'ok';
    await expect(writer.checkEntityWrite('layouts', 'Layout 1', layout)).resolves.toBeUndefined();
    expect(Buffer.compare(await readFile(layoutPath()), before)).toBe(0);
    expect(existsSync(`${layoutPath()}.bak`)).toBe(false);
  }, SLOW);

  it('measures a layout kept in a project folder with that file\'s own line endings', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    // The project is LF; the layout in the folder is CRLF and over the limit only with CRLF
    const projectFile = join(tmpDir, 'project.c3proj');
    await writeFile(projectFile, (await readFile(projectFile, 'utf8')).replace(/\r\n/g, '\n'));
    await reader.loadProject();
    const layout = await readLayoutFile();
    const [first] = layout.layers[0].instances;
    layout.name = 'Folded';
    layout.layers[0].instances = Array.from({ length: 2000 }, (_, i) => ({ ...structuredClone(first), uid: 1000 + i }));
    layout.layers[0].instances[0].tags = '';
    const lines = JSON.stringify(layout, null, '\t').split('\n').length - 1;
    layout.layers[0].instances[0].tags = ' '.repeat(MB - 100 - Buffer.byteLength(JSON.stringify(layout, null, '\t')));
    const lfText = JSON.stringify(layout, null, '\t');
    expect(Buffer.byteLength(lfText)).toBeLessThan(MB);
    expect(Buffer.byteLength(lfText) + lines).toBeGreaterThan(MB);
    const folded = join(tmpDir, 'layouts', 'Levels', 'Folded.json');
    await mkdir(join(tmpDir, 'layouts', 'Levels'), { recursive: true });
    await writeFile(folded, lfText.replace(/\n/g, '\r\n'));
    const before = await readFile(folded);

    const checked = await messageOf(writer.checkEntityWrite('layouts', 'Folded', layout, 'Levels'));
    expect(checked).toMatch(/is too large .* over the 1MB limit/);
    expect(checked).toBe(await messageOf(writer.writeEntityFile('layouts', 'Folded', layout, 'Levels')));
    expect(Buffer.compare(await readFile(folded), before)).toBe(0);
    expect(existsSync(`${folded}.bak`)).toBe(false);
  }, SLOW);
});
