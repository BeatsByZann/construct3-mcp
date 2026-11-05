/**
 * The one walk of a project's registered script files (rootFileFolders.script),
 * and the two callers that share it: the index's script member reads and the
 * runtime-trap check's Imports for events scan.
 */

import { describe, it, expect } from 'vitest';
import { registeredScriptFiles } from '../../src/construct3/script-files.js';
import { getProjectIndex, resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { findRuntimeTraps } from '../../src/construct3/analyzers/runtime-traps.js';
import { MockReader } from '../mocks/mock-reader.js';
import type { FileFolder, FileItem } from '../../src/construct3/types.js';

/** A folder as c3proj might hold it, malformed entries included (typed casts, no any). */
function folderOf(shape: { items?: unknown[]; subfolders?: unknown[] }): FileFolder {
  return shape as unknown as FileFolder;
}

/** A chain of `depth` nested folders d1/d2/..., each holding the file f<k>.js. */
function chainFolder(depth: number): FileFolder {
  type Sub = { name: string; items: FileItem[]; subfolders: Sub[] };
  const make = (k: number): Sub => ({
    name: `d${k}`,
    items: [{ name: `f${k}.js`, type: 'application/javascript', sid: k }],
    subfolders: k < depth ? [make(k + 1)] : [],
  });
  return { items: [], subfolders: depth > 0 ? [make(1)] : [] };
}

describe('registeredScriptFiles', () => {
  it('lists files with their paths inside scripts/ in file order, skipping malformed entries', () => {
    const a = { name: 'a.js' };
    const b = { name: 'b.js' };
    const folder = folderOf({
      items: [a, { name: 5 }, null, { name: '' }],
      subfolders: [{ name: 'lib', items: [b], subfolders: [] }, { name: 7, items: [{ name: 'x.js' }], subfolders: [] }, null],
    });
    const result = registeredScriptFiles(folder);
    expect(result.files.map(f => f.path)).toEqual(['a.js', 'lib/b.js']);
    expect(result.files[0].item).toBe(a);
    expect(result.files[1].item).toBe(b);
    expect(result.notWalked).toEqual([]);
  });

  it('gives nothing for an undefined folder', () => {
    expect(registeredScriptFiles(undefined)).toEqual({ files: [], notWalked: [] });
  });

  it('stops at depth 50 and names the first folder it did not enter', () => {
    const result = registeredScriptFiles(chainFolder(60));
    const paths = result.files.map(f => f.path);
    const dirs = (n: number) => Array.from({ length: n }, (_, i) => `d${i + 1}`).join('/');
    expect(paths).toHaveLength(50);
    expect(paths).toContain(`${dirs(50)}/f50.js`);
    expect(paths).not.toContain(`${dirs(51)}/f51.js`);
    expect(result.notWalked).toEqual([`scripts/${dirs(51)}/`]);
  });
});

const DEPTH_50_DIR = Array.from({ length: 50 }, (_, i) => `d${i + 1}`).join('/');
const DEPTH_51_DIR = `${DEPTH_50_DIR}/d51`;

describe('the index script member reads use the shared walk', () => {
  it('reads a script at depth 50 and not one at depth 51', async () => {
    const reader = new MockReader({
      scriptFiles: [
        { path: `${DEPTH_50_DIR}/near.js`, source: 'inst.instVars.nearVar;' },
        { path: `${DEPTH_51_DIR}/far.js`, source: 'inst.instVars.farVar;' },
        { path: 'top.js', source: 'inst.behaviors.Fade;' },
      ],
    }) as unknown as import('../../src/construct3/project-reader.js').Construct3ProjectReader;
    resetProjectIndex(reader);
    const { reads, unreadable } = await (await getProjectIndex(reader)).getScriptMemberReads(reader);
    expect(reads.map(r => `${r.path}:${r.name}`).sort()).toEqual([
      `scripts/${DEPTH_50_DIR}/near.js:nearVar`,
      'scripts/top.js:Fade',
    ]);
    expect(unreadable).toEqual([]);
  });

  it('lists a script that cannot be read as unreadable, by its path inside scripts/', async () => {
    const reader = new MockReader({
      scriptFiles: [
        { path: 'lib/ok.js', source: 'inst.instVars.hp;' },
        { path: 'lib/bad.js', source: '' },
      ],
    });
    const original = reader.readScriptFile.bind(reader);
    reader.readScriptFile = async (p: string) => {
      if (p === 'lib/bad.js') throw new Error('EACCES');
      return original(p);
    };
    const typed = reader as unknown as import('../../src/construct3/project-reader.js').Construct3ProjectReader;
    resetProjectIndex(typed);
    const { reads, unreadable } = await (await getProjectIndex(typed)).getScriptMemberReads(typed);
    expect(reads.map(r => r.name)).toEqual(['hp']);
    expect(unreadable).toEqual(['lib/bad.js']);
  });
});

describe('the runtime-trap Imports for events scan uses the shared walk', () => {
  const sheetUsing = (name: string) => new Map<string, Record<string, unknown>>([['Main', {
    name: 'Main',
    sid: 1,
    events: [{
      functionName: 'F',
      functionDescription: '',
      functionCategory: '',
      functionReturnType: 'none',
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [{ name, type: 'string', initialValue: '', comment: '', sid: 2 }],
      eventType: 'function-block',
      conditions: [],
      actions: [{ type: 'script', script: `${name}.go();` }],
      sid: 3,
    }],
  }]]);

  it('reads an Imports for events script at depth 50 and ignores one at depth 51', async () => {
    const near = new MockReader({
      eventSheets: sheetUsing('Near'),
      scriptFiles: [{ path: `${DEPTH_50_DIR}/imports.js`, purpose: 'imports-for-events', source: 'import * as Near from "./n.js";' }],
    });
    expect((await findRuntimeTraps(near as never)).issues).toEqual([]);

    const far = new MockReader({
      eventSheets: sheetUsing('Far'),
      scriptFiles: [{ path: `${DEPTH_51_DIR}/imports.js`, purpose: 'imports-for-events', source: 'import * as Far from "./f.js";' }],
    });
    const issues = (await findRuntimeTraps(far as never)).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('uses parameter "Far"');
  });

  it('notes an Imports for events script that cannot be read, by its path', async () => {
    const reader = new MockReader({
      eventSheets: sheetUsing('X'),
      scriptFiles: [{ path: 'lib/imports.js', purpose: 'imports-for-events', source: '' }],
    });
    reader.readScriptFile = async () => { throw new Error('ENOENT'); };
    const result = await findRuntimeTraps(reader as never);
    expect(result.notes.some(n => n.includes('"lib/imports.js" could not be read'))).toBe(true);
  });

  it('does not read scripts whose purpose is not imports-for-events', async () => {
    const reader = new MockReader({
      eventSheets: sheetUsing('Y'),
      scriptFiles: [{ path: 'other.js', purpose: 'none', source: 'import * as Y from "./y.js";' }],
    });
    const issues = (await findRuntimeTraps(reader as never)).issues;
    expect(issues).toHaveLength(1);
  });
});
