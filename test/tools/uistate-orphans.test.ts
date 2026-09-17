import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

describe('orphan scan ignores Construct editor UI state files', () => {
  let dir: string;
  let reader: Construct3ProjectReader;
  beforeEach(async () => {
    resetProjectIndex();
    dir = await mkdtemp(join(tmpdir(), 'c3-uistate-'));
    await cp(join(__dirname, '..', 'fixtures', 'minimal-project'), dir, { recursive: true });
    reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
    await reader.loadProject();
  });
  afterEach(async () => {
    resetProjectIndex();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('skips uistate sidecars and layouts/uistate instance bars but still reports real orphans', async () => {
    await mkdir(join(dir, 'layouts', 'uistate', 'Deep Folder'), { recursive: true });
    await mkdir(join(dir, 'eventSheets', 'Deep Folder'), { recursive: true });
    await writeFile(join(dir, 'eventSheets', 'Deep Folder', 'Sheet.uistate.json'), '{}');
    await writeFile(join(dir, 'layouts', 'Level.uistate.json'), '{}');
    await writeFile(join(dir, 'layouts', 'uistate', 'Level.instancesBar.json'), '{}');
    await writeFile(join(dir, 'layouts', 'uistate', 'Deep Folder', 'Level.instancesBar.json'), '{}');
    await writeFile(join(dir, 'layouts', 'uistate', 'Deep Folder', 'Orphan.json'), '{}');
    await writeFile(join(dir, 'layouts', 'Stray.instancesBar.json'), '{}');
    await writeFile(join(dir, 'eventSheets', 'Deep Folder', 'Orphan.json'), '{}');
    const result = await validateProjectIntegrity(reader);
    const paths = result.info.filter(i => i.check === 'orphaned-file').map(i => i.entity).sort();
    expect(paths).toEqual([
      'eventSheets/Deep Folder/Orphan.json',
      'layouts/Stray.instancesBar.json',
      'layouts/uistate/Deep Folder/Orphan.json',
    ]);
  });
});
