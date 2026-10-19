import { describe, it, expect } from 'vitest';
import {
  applyMainScript,
  applyRegistration,
  entryPurpose,
  findEntryNameClash,
  findFileEntry,
  findSubfolderClash,
  getFileFolderDirectory,
  listFileEntries,
  removeFileEntry,
} from '../../src/construct3/file-registration.js';
import type { Construct3Project, FileItem } from '../../src/construct3/types.js';

/** An in-memory project holding only the given rootFileFolders. */
function projectWith(rootFileFolders: unknown): Construct3Project {
  return (rootFileFolders === undefined ? {} : { rootFileFolders }) as unknown as Construct3Project;
}

/** A folder with the editor's key order. */
function folder(items: unknown[] = [], subfolders: unknown[] = []): unknown {
  return { items, subfolders };
}

/** A script entry. */
function script(name: string, sid: number, purpose = 'none'): unknown {
  return { name, type: 'application/javascript', sid, 'script-info': { purpose } };
}

/** The entries of a family, as plain objects. */
function itemsOf(project: Construct3Project, family: string): FileItem[] {
  const roots = project.rootFileFolders as unknown as Record<string, { items: FileItem[] }>;
  return roots[family].items;
}

const SCRIPT = { name: 'host.js', type: 'application/javascript', infoKey: 'script-info' } as const;

describe('applyRegistration', () => {
  it('adds an entry in the editor key order', () => {
    const project = projectWith({ script: folder() });
    const outcome = applyRegistration(project, 'script', { ...SCRIPT, sid: 11 });
    expect(outcome).toEqual({ kind: 'added', sid: 11 });
    const entry = itemsOf(project, 'script')[0];
    expect(Object.keys(entry)).toEqual(['name', 'type', 'sid', 'script-info']);
    expect(entry['script-info']).toEqual({ purpose: 'none' });

    const withPurpose = projectWith({ script: folder() });
    applyRegistration(withPurpose, 'script', { ...SCRIPT, sid: 12, purpose: 'main' });
    expect(itemsOf(withPurpose, 'script')[0]['script-info']).toEqual({ purpose: 'main' });
  });

  it('creates the subfolders with the editor key order', () => {
    const project = projectWith({ script: folder() });
    const outcome = applyRegistration(project, 'script', { ...SCRIPT, sid: 13, subfolder: 'a/b' });
    expect(outcome).toEqual({ kind: 'added', sid: 13 });
    const roots = project.rootFileFolders as unknown as { script: { subfolders: Array<Record<string, unknown>> } };
    const a = roots.script.subfolders[0] as { subfolders: Array<Record<string, unknown>> };
    const b = a.subfolders[0] as { items: FileItem[] };
    expect(Object.keys(a)).toEqual(['items', 'subfolders', 'name']);
    expect(Object.keys(b)).toEqual(['items', 'subfolders', 'name']);
    expect(b.items[0].name).toBe('host.js');
  });

  it('needs a SID for a new entry and changes nothing without one', () => {
    const project = projectWith({ script: folder() });
    const before = JSON.stringify(project);
    expect(applyRegistration(project, 'script', { ...SCRIPT, subfolder: 'a/b' })).toEqual({ kind: 'needs-sid' });
    expect(JSON.stringify(project)).toBe(before);

    const bare = projectWith(undefined);
    expect(applyRegistration(bare, 'script', SCRIPT)).toEqual({ kind: 'needs-sid' });
    expect(JSON.stringify(bare)).toBe('{}');
  });

  it('leaves an exact registration alone', () => {
    const project = projectWith({ script: folder([script('host.js', 7)]) });
    const before = JSON.stringify(project);
    const outcome = applyRegistration(project, 'script', { ...SCRIPT, type: 'text/x-other', sid: 99 });
    expect(outcome).toEqual({ kind: 'unchanged', sid: 7 });
    expect(JSON.stringify(project)).toBe(before);
  });

  it('keeps an existing purpose unless one is given', () => {
    const project = projectWith({ script: folder([script('host.js', 7, 'main')]) });
    expect(applyRegistration(project, 'script', SCRIPT)).toEqual({ kind: 'unchanged', sid: 7 });
    expect(itemsOf(project, 'script')[0]['script-info']).toEqual({ purpose: 'main' });

    const outcome = applyRegistration(project, 'script', { ...SCRIPT, purpose: 'none' });
    expect(outcome.kind).toBe('repaired');
    if (outcome.kind !== 'repaired') throw new Error('expected repaired');
    expect(outcome.repairs).toHaveLength(1);
    expect(outcome.repairs[0]).toContain('from "main" to "none"');
    expect(itemsOf(project, 'script')[0]['script-info']).toEqual({ purpose: 'none' });
  });

  it('replaces the other metadata key and keeps the SID', () => {
    const legacy = projectWith({ script: folder([{ name: 'host.js', type: 'application/javascript', sid: 5, 'file-info': { purpose: 'none' } }]) });
    const outcome = applyRegistration(legacy, 'script', SCRIPT);
    expect(outcome.kind).toBe('repaired');
    if (outcome.kind !== 'repaired') throw new Error('expected repaired');
    expect(outcome.sid).toBe(5);
    expect(outcome.repairs.join(' ')).toContain('file-info');
    const entry = itemsOf(legacy, 'script')[0];
    expect(Object.keys(entry)).toEqual(['name', 'type', 'sid', 'script-info']);

    const general = projectWith({ general: folder([{ name: 'data.json', type: 'application/json', sid: 6, 'script-info': { purpose: 'none' } }]) });
    const generalOutcome = applyRegistration(general, 'general', { name: 'data.json', type: 'application/json', infoKey: 'file-info' });
    expect(generalOutcome.kind).toBe('repaired');
    const generalEntry = itemsOf(general, 'general')[0];
    expect(Object.keys(generalEntry)).toEqual(['name', 'type', 'sid', 'file-info']);

    const both = projectWith({
      script: folder([{ name: 'host.js', type: 'application/javascript', sid: 8, 'script-info': { purpose: 'main' }, 'file-info': { purpose: 'none' } }]),
    });
    const bothOutcome = applyRegistration(both, 'script', SCRIPT);
    expect(bothOutcome.kind).toBe('repaired');
    const bothEntry = itemsOf(both, 'script')[0];
    expect(bothEntry['file-info']).toBeUndefined();
    expect(bothEntry['script-info']).toEqual({ purpose: 'main' });

    const withPurpose = projectWith({ script: folder([{ name: 'host.js', type: 'application/javascript', sid: 9, 'file-info': { purpose: 'main' } }]) });
    const changed = applyRegistration(withPurpose, 'script', { ...SCRIPT, purpose: 'none' });
    if (changed.kind !== 'repaired') throw new Error('expected repaired');
    const text = changed.repairs.join(' ');
    expect(text).toContain('file-info');
    expect(text).toContain('from "main" to "none"');
    expect(itemsOf(withPurpose, 'script')[0]['script-info']).toEqual({ purpose: 'none' });
  });

  it('removes duplicate registrations of one name and keeps the first', () => {
    const project = projectWith({
      script: folder([script('host.js', 1), script('other.js', 2), script('host.js', 3)]),
      general: folder([{ name: 'host.js', type: 'application/javascript', sid: 4, 'file-info': { purpose: 'none' } }]),
    });
    const outcome = applyRegistration(project, 'script', SCRIPT);
    if (outcome.kind !== 'repaired') throw new Error('expected repaired');
    expect(outcome.sid).toBe(1);
    expect(outcome.repairs.join(' ')).toContain('1 duplicate registration removed');
    expect(itemsOf(project, 'script').map(item => [item.name, item.sid])).toEqual([['host.js', 1], ['other.js', 2]]);
    expect(itemsOf(project, 'general')).toHaveLength(1);
  });

  it('keeps the entries of a malformed family root', () => {
    const project = projectWith({ script: { items: [script('host.js', 1)] } });
    const outcome = applyRegistration(project, 'script', { ...SCRIPT, name: 'other.js', sid: 2 });
    expect(outcome).toEqual({ kind: 'added', sid: 2 });
    const root = (project.rootFileFolders as unknown as { script: { items: FileItem[]; subfolders: unknown[] } }).script;
    expect(root.items.map(item => item.name)).toEqual(['host.js', 'other.js']);
    expect(root.subfolders).toEqual([]);
  });

  it('creates rootFileFolders.script in a project without rootFileFolders', () => {
    const project = projectWith(undefined);
    expect(findFileEntry(project, 'script', 'host.js')).toBeUndefined();
    expect(listFileEntries(project, 'script')).toEqual([]);
    expect(applyRegistration(project, 'script', { ...SCRIPT, sid: 3 })).toEqual({ kind: 'added', sid: 3 });
    expect(itemsOf(project, 'script').map(item => item.name)).toEqual(['host.js']);
  });
});

describe('removeFileEntry', () => {
  it('removes every entry of the name in that folder only', () => {
    const project = projectWith({
      script: folder([script('host.js', 1), script('other.js', 2), script('host.js', 3)]),
      general: folder([script('host.js', 4)]),
    });
    expect(removeFileEntry(project, 'script', 'host.js')).toBe(true);
    expect(itemsOf(project, 'script').map(item => item.name)).toEqual(['other.js']);
    expect(itemsOf(project, 'general')).toHaveLength(1);
  });

  it('returns false when there is none', () => {
    const project = projectWith({ script: folder([script('host.js', 1)]) });
    expect(removeFileEntry(project, 'script', 'missing.js')).toBe(false);
    expect(removeFileEntry(project, 'sound', 'host.js')).toBe(false);
    expect(itemsOf(project, 'script')).toHaveLength(1);
  });

  it('removes from a nested subfolder only', () => {
    const project = projectWith({
      script: {
        items: [script('host.js', 1)],
        subfolders: [{ items: [], subfolders: [{ items: [script('host.js', 2)], subfolders: [], name: 'b' }], name: 'a' }],
      },
    });
    expect(removeFileEntry(project, 'script', 'host.js', 'a/b')).toBe(true);
    expect(removeFileEntry(project, 'script', 'host.js', 'a/b')).toBe(false);
    expect(itemsOf(project, 'script')).toHaveLength(1);
  });
});

describe('name clash helpers', () => {
  it('findEntryNameClash returns the registered spelling of a name differing only in case', () => {
    const project = projectWith({ script: folder([script('host.js', 1)]), general: folder() });
    expect(findEntryNameClash(project, 'script', 'HOST.js')).toBe('host.js');
    expect(findEntryNameClash(project, 'script', 'host.js')).toBeUndefined();
    expect(findEntryNameClash(project, 'general', 'HOST.js')).toBeUndefined();
    expect(findEntryNameClash(project, 'script', 'new.js')).toBeUndefined();
    expect(findEntryNameClash(project, 'script', 'HOST.js', 'missing')).toBeUndefined();
  });

  it('findSubfolderClash returns the existing spelling, from the first folder only', () => {
    const project = projectWith({
      script: {
        items: [],
        subfolders: [{ items: [], subfolders: [{ items: [], subfolders: [], name: 'sounds' }], name: 'assets' }],
      },
    });
    expect(findSubfolderClash(project, 'script', 'Assets/Sounds')).toBe('assets/sounds');
    expect(findSubfolderClash(project, 'script', 'assets/sounds')).toBeUndefined();
    expect(findSubfolderClash(project, 'script', 'fresh/path')).toBeUndefined();
    expect(findSubfolderClash(project, 'sound', 'Assets/Sounds')).toBeUndefined();
  });

  it('findSubfolderClash catches a clash in the second folder only', () => {
    const project = projectWith({
      script: { items: [], subfolders: [{ items: [], subfolders: [{ items: [], subfolders: [], name: 'sounds' }], name: 'assets' }] },
    });
    expect(findSubfolderClash(project, 'script', 'assets/Sounds')).toBe('assets/sounds');
  });
});

describe('applyMainScript', () => {
  it('makes the target main and every other main none, leaving other purposes', () => {
    const project = projectWith({
      script: {
        items: [script('host.js', 1, 'none'), script('old.js', 2, 'main'), script('imports.js', 3, 'imports-for-events')],
        subfolders: [{ items: [script('host.js', 4, 'main')], subfolders: [], name: 'lib' }],
      },
    });
    const outcome = applyMainScript(project, 'host.js');
    expect(outcome).toEqual({ changed: ['host.js -> main', 'old.js -> none', 'lib/host.js -> none'] });
    const entries = listFileEntries(project, 'script');
    expect(entries.map(located => [located.subfolder, located.entry.name, entryPurpose(located.entry)])).toEqual([
      [undefined, 'host.js', 'main'],
      [undefined, 'old.js', 'none'],
      [undefined, 'imports.js', 'imports-for-events'],
      ['lib', 'host.js', 'none'],
    ]);
  });

  it('reports no change when the target is already the only main', () => {
    const project = projectWith({ script: folder([script('host.js', 1, 'main'), script('other.js', 2, 'none')]) });
    expect(applyMainScript(project, 'host.js')).toEqual({ changed: [] });
  });

  it('reports a script that is not in the folder and changes nothing', () => {
    const project = projectWith({ script: folder([script('host.js', 1, 'main')]) });
    const before = JSON.stringify(project);
    expect(applyMainScript(project, 'missing.js')).toEqual({ missing: true });
    expect(applyMainScript(project, 'host.js', 'lib')).toEqual({ missing: true });
    expect(JSON.stringify(project)).toBe(before);
  });

  it('reads a purpose held only in file-info and rewrites it as script-info', () => {
    const project = projectWith({
      script: folder([
        { name: 'old.js', type: 'application/javascript', sid: 1, 'file-info': { purpose: 'main' } },
        { name: 'host.js', type: 'application/javascript', sid: 2, 'file-info': { purpose: 'none' } },
      ]),
    });
    expect(entryPurpose(itemsOf(project, 'script')[0])).toBe('main');
    const outcome = applyMainScript(project, 'host.js');
    expect(outcome).toEqual({ changed: ['old.js -> none', 'host.js -> main'] });
    const [old, host] = itemsOf(project, 'script');
    expect(old['script-info']).toEqual({ purpose: 'none' });
    expect(old['file-info']).toBeUndefined();
    expect(host['script-info']).toEqual({ purpose: 'main' });
    expect(host['file-info']).toBeUndefined();
  });

  it('addresses the target by folder as well as by name', () => {
    const project = projectWith({
      script: {
        items: [script('host.js', 1, 'main')],
        subfolders: [{ items: [script('host.js', 2, 'none')], subfolders: [], name: 'lib' }],
      },
    });
    expect(applyMainScript(project, 'host.js', 'lib')).toEqual({ changed: ['host.js -> none', 'lib/host.js -> main'] });
  });
});

describe('listFileEntries', () => {
  it('lists every entry with its slash path', () => {
    const project = projectWith({
      script: {
        items: [script('a.js', 1)],
        subfolders: [{ items: [script('b.js', 2)], subfolders: [{ items: [script('c.js', 3)], subfolders: [], name: 'y' }], name: 'x' }],
      },
    });
    expect(listFileEntries(project, 'script').map(located => [located.entry.name, located.subfolder])).toEqual([
      ['a.js', undefined],
      ['b.js', 'x'],
      ['c.js', 'x/y'],
    ]);
  });

  it('returns [] for a family the project lacks', () => {
    expect(listFileEntries(projectWith({ script: folder() }), 'sound')).toEqual([]);
  });
});

describe('a malformed family root', () => {
  it('does not throw in lookups on a root without subfolders or a folder without items', () => {
    const project = projectWith({
      script: {
        items: [script('host.js', 1, 'main')],
        subfolders: [{ subfolders: [], name: 'noitems' }],
      },
    });
    expect(findFileEntry(project, 'script', 'host.js')?.entry.sid).toBe(1);
    expect(findFileEntry(project, 'script', 'host.js', 'noitems')).toBeUndefined();
    expect(findEntryNameClash(project, 'script', 'HOST.js')).toBe('host.js');
    expect(findEntryNameClash(project, 'script', 'x.js', 'noitems')).toBeUndefined();
    expect(listFileEntries(project, 'script').map(located => located.entry.name)).toEqual(['host.js']);
    expect(applyMainScript(project, 'host.js')).toEqual({ changed: [] });

    const rootOnly = projectWith({ script: { items: [script('host.js', 1)] } });
    expect(findFileEntry(rootOnly, 'script', 'host.js')?.entry.sid).toBe(1);
    expect(findEntryNameClash(rootOnly, 'script', 'HOST.js')).toBe('host.js');
    expect(listFileEntries(rootOnly, 'script')).toHaveLength(1);
    expect(applyMainScript(rootOnly, 'host.js')).toEqual({ changed: ['host.js -> main'] });
    expect(findSubfolderClash(rootOnly, 'script', 'a/b')).toBeUndefined();
  });
});

describe('getFileFolderDirectory', () => {
  it('maps each family to the directory of an editor-saved project', () => {
    expect(getFileFolderDirectory('script')).toBe('scripts');
    expect(getFileFolderDirectory('general')).toBe('files');
    expect(getFileFolderDirectory('sound')).toBe('sounds');
  });
});
