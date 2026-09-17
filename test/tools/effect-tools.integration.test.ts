/**
 * Real-writer tests for the effect tools: the object-type entry and the
 * per-instance state must land in the files on disk, and removal must clean
 * both again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerEffectTools } from '../../src/tools/effect-tools.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('effect tools (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let server: MockServer;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-effect-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    // The fixture has no effect addon; register one the way the editor would.
    const projectPath = join(tmpDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    project.usedAddons.push({ type: 'effect', id: 'hsladjust', name: 'Adjust HSL', author: 'Scirra', bundled: false });
    await writeFile(projectPath, JSON.stringify(project, null, '\t'));

    reader = new Construct3ProjectReader(projectPath);
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerEffectTools({ server, reader, writer, idGen } as any);
    registerLayoutTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    resetProjectIndex();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  const readJson = async (rel: string) => JSON.parse(await readFile(join(tmpDir, rel), 'utf8'));

  it('adds, edits per instance, and removes an object-type effect on disk', async () => {
    const added = parse(await server.callTool('add_effect', {
      targetType: 'objectType', targetName: 'Sprite', effectId: 'hsladjust', name: 'Tint', parameters: { hue: 0, saturation: 0, luminosity: 0 },
    }));
    expect(added.success).toBe(true);

    expect((await readJson('objectTypes/Sprite.json')).effectTypes).toEqual([{ effectId: 'hsladjust', name: 'Tint' }]);
    let layout = await readJson('layouts/Layout 1.json');
    expect(layout.layers[0].instances[0].effects).toEqual({ Tint: { isEnabled: true, parameters: { hue: 0, saturation: 0, luminosity: 0 } } });

    const edited = parse(await server.callTool('update_instance', { layoutName: 'Layout 1', uid: 0, effects: { Tint: { parameters: { hue: 180 } } } }));
    expect(edited.success).toBe(true);
    layout = await readJson('layouts/Layout 1.json');
    expect(layout.layers[0].instances[0].effects.Tint.parameters).toEqual({ hue: 180, saturation: 0, luminosity: 0 });

    // The analyzer still sees a consistent project (no new errors from the effect).
    const before = await validateProjectIntegrity(reader);
    expect(before.errors).toEqual([]);

    const removed = parse(await server.callTool('remove_effect', { targetType: 'objectType', targetName: 'Sprite', name: 'Tint' }));
    expect(removed.success).toBe(true);
    expect((await readJson('objectTypes/Sprite.json')).effectTypes).toEqual([]);
    layout = await readJson('layouts/Layout 1.json');
    expect(layout.layers[0].instances[0].effects).toEqual({});
  });

  it('writes a layer effect with its inline instance block', async () => {
    parse(await server.callTool('add_effect', { targetType: 'layer', targetName: 'Main', layoutName: 'Layout 1', effectId: 'hsladjust' }));
    const layout = await readJson('layouts/Layout 1.json');
    expect(layout.layers[0].effectTypes).toEqual([{ effectId: 'hsladjust', name: 'hsladjust', instance: { isEnabled: true, parameters: {} } }]);
    parse(await server.callTool('update_effect', { targetType: 'layer', targetName: 'Main', layoutName: 'Layout 1', name: 'hsladjust', isEnabled: false }));
    expect((await readJson('layouts/Layout 1.json')).layers[0].effectTypes[0].instance.isEnabled).toBe(false);
  });
});
