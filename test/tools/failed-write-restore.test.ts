/**
 * The rollback of an entity write that failed after it replaced the file
 * puts the backup back only while the file holds that write's own bytes;
 * a save that landed after the failure is left as it is and named with
 * its .bak. Through update_layer, whose event sheet write fails its
 * read-back. Synthetic data on a temp copy of the minimal fixture, with
 * the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface ActionJson { sid?: number; id?: string; objectClass?: string; parameters?: Record<string, string>; [key: string]: unknown }
interface SheetFile { events: Array<{ actions: ActionJson[]; [key: string]: unknown }>; [key: string]: unknown }

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const sheetPath = () => join(tmpDir, 'eventSheets', 'MainSheet.json');
const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');

/** The writer's read-back of `fileName` fails once with an ordinary error; `before` runs first (an editor save, say). */
function failReadBackOf(fileName: string, before: () => Promise<void> = async () => {}): void {
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  let failed = false;
  internals.verifyWrittenFile = async (path, name, text) => {
    if (!failed && path.endsWith(fileName)) {
      failed = true;
      await before();
      throw new Error(`Post-write verification failed for "${name}": the file could not be read back`);
    }
    return verify(path, name, text);
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-failed-write-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as SheetFile;
  sheet.events[0].actions.push({ sid: 400000000000100, id: 'set-layer-visible', objectClass: 'System', parameters: { layer: '"Main"', visibility: 'visible' } });
  await writeFile(sheetPath(), JSON.stringify(sheet, null, '\t'));
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayoutTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('rolling back a failed entity write', () => {
  it('puts the backup back when the file holds the failed write', async () => {
    const sheetBefore = await readFile(sheetPath(), 'utf8');
    const layoutBefore = await readFile(layoutPath(), 'utf8');
    failReadBackOf('MainSheet.json');
    const result = await server.callTool('update_layer', { layoutName: 'Layout 1', layerName: 'Main', newName: 'Game' });
    expect(result.isError).toBe(true);
    expect(await readFile(sheetPath(), 'utf8')).toBe(sheetBefore);
    expect(await readFile(layoutPath(), 'utf8')).toBe(layoutBefore);
  });

  it('leaves a file an editor saved after the failed write as it is, and names it with its .bak', async () => {
    const saved = JSON.stringify({ ...(JSON.parse(await readFile(sheetPath(), 'utf8')) as SheetFile), savedInEditor: true }, null, '\t');
    failReadBackOf('MainSheet.json', () => writeFile(sheetPath(), saved));
    const result = await server.callTool('update_layer', { layoutName: 'Layout 1', layerName: 'Main', newName: 'Game' });
    expect(result.isError).toBe(true);
    expect(await readFile(sheetPath(), 'utf8')).toBe(saved);
    expect(result.content[0].text).toContain('eventSheets/MainSheet.json (another write changed it after this call\'s write failed; '
      + 'its state from before the call is in eventSheets/MainSheet.json.bak)');
  });

  it('leaves a file that cannot be read after the failed write as it is, and says it could not be read', async () => {
    // A directory where the sheet was: it exists, and reading it fails with EISDIR, not ENOENT
    failReadBackOf('MainSheet.json', async () => {
      await rm(sheetPath());
      await mkdir(sheetPath());
    });
    const result = await server.callTool('update_layer', { layoutName: 'Layout 1', layerName: 'Main', newName: 'Game' });
    expect(result.isError).toBe(true);
    expect((await stat(sheetPath())).isDirectory()).toBe(true);
    expect(result.content[0].text).toContain('eventSheets/MainSheet.json (it could not be read; '
      + 'its state from before the call is in eventSheets/MainSheet.json.bak)');
    expect(result.content[0].text).not.toContain('another write changed it');
  });
});
