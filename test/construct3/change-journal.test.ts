/**
 * The change journal (change-journal.ts) on tool call scopes built by hand:
 * which changes a call made, the entries kept per project, the line a result
 * ends with, what list_changes shows, and the reasons it gives.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileKey, StaleFileError, type CallChange, type FileState, type ToolCallScope } from '../../src/construct3/disk-state.js';
import {
  MAX_JOURNAL_ENTRIES,
  callChanges,
  changedFilesLine,
  changedSinceCall,
  describeEntry,
  journalEntries,
  lastUnrevertedEntry,
  reasonOf,
  recordToolCall,
  revertEntry,
  withJournalLock,
  type RevertPort,
} from '../../src/construct3/change-journal.js';

const BEFORE: FileState = { mtimeMs: 1, size: 1, ino: 1 };
const AFTER: FileState = { mtimeMs: 2, size: 2, ino: 2 };
const path = (label: string) => join(tmpdir(), 'c3-journal-unit', ...label.split('/'));

function scope(): ToolCallScope {
  return { reads: new Map(), backups: new Map(), changes: new Map(), before: new Map(), steps: [], unowned: new Set(), checked: new Set() };
}

function change(s: ToolCallScope, label: string, opts: { existed?: boolean; before?: FileState; left?: FileState; journalOnly?: boolean } = {}): CallChange {
  const p = path(label);
  const key = fileKey(p);
  const existed = opts.existed ?? true;
  const c: CallChange = {
    path: p, label, backup: { path: p + '.bak', existed, state: BEFORE }, backupLabel: `${label}.bak`,
    isProjectFile: label === 'project.c3proj', journalOnly: opts.journalOnly ?? false,
  };
  s.changes.set(key, c);
  s.steps.push({ file: key });
  s.before.set(key, 'before' in opts ? opts.before as FileState : (existed ? BEFORE : null));
  s.reads.set(key, 'left' in opts ? opts.left as FileState : AFTER);
  return c;
}

function move(s: ToolCallScope, from: string, to: string): void {
  s.steps.push({ move: { from: path(from), to: path(to), fromLabel: from, toLabel: to } });
  s.reads.set(fileKey(path(from)), null);
  s.reads.set(fileKey(path(to)), BEFORE);
}

describe('callChanges', () => {
  it('names each kind of change in the order the call made it', () => {
    const s = scope();
    move(s, 'images/a-001.png', 'images/a-002.png');
    change(s, 'layouts/L.json');
    change(s, 'layouts/New.json', { existed: false });
    change(s, 'layouts/Gone.json', { left: null });
    change(s, 'timelines/T.json', { journalOnly: true });
    expect(callChanges(s).map(c => [c.kind, c.kind === 'move' ? c.move.toLabel : c.file.label])).toEqual([
      ['move', 'images/a-002.png'],
      ['write', 'layouts/L.json'],
      ['create', 'layouts/New.json'],
      ['delete', 'layouts/Gone.json'],
      ['write', 'timelines/T.json'],
    ]);
  });

  it('leaves out a file that ends in the state it had before the call', () => {
    const s = scope();
    change(s, 'images/p.png', { existed: false, before: null, left: null, journalOnly: true });
    change(s, 'images/a-000.png', { existed: false, before: BEFORE, left: BEFORE, journalOnly: true });
    expect(callChanges(s)).toEqual([]);
  });

  it('keeps an unowned file, whatever its states say', () => {
    const s = scope();
    change(s, 'timelines/T.json', { existed: false, before: null, left: null, journalOnly: true });
    s.unowned.add(fileKey(path('timelines/T.json')));
    expect(callChanges(s).map(c => c.kind)).toEqual(['create']);
  });

  it('leaves out a change the writer undid', () => {
    const s = scope();
    change(s, 'layouts/L.json');
    s.changes.delete(fileKey(path('layouts/L.json')));
    expect(callChanges(s)).toEqual([]);
  });
});

describe('the journal of a project', () => {
  it('keeps calls that changed something, newest first, separately per project, and an unowned file as unknown', () => {
    const project = {};
    const other = {};
    expect(recordToolCall(project, 'list_layouts', 1, scope())).toBeUndefined();
    const a = scope(); change(a, 'layouts/L.json');
    const b = scope(); change(b, 'project.c3proj'); b.unowned.add(fileKey(path('project.c3proj')));
    recordToolCall(project, 'add_layer', 2, a);
    const eb = recordToolCall(project, 'update_project_metadata', 3, b)!;
    expect(journalEntries(project).map(e => [e.id, e.tool])).toEqual([[2, 'update_project_metadata'], [1, 'add_layer']]);
    expect(journalEntries(project, 1)).toHaveLength(1);
    expect(journalEntries(other)).toEqual([]);
    expect(eb.expected.get(fileKey(path('project.c3proj')))).toBeUndefined();
    expect(eb.undone).toBe(0);
  });

  it(`keeps the last ${MAX_JOURNAL_ENTRIES} calls`, () => {
    const project = {};
    for (let i = 0; i < MAX_JOURNAL_ENTRIES + 5; i++) {
      const s = scope(); change(s, `layouts/L${i}.json`);
      recordToolCall(project, 'add_layer', i, s);
    }
    const entries = journalEntries(project, MAX_JOURNAL_ENTRIES);
    expect(entries).toHaveLength(MAX_JOURNAL_ENTRIES);
    expect(entries[0].id).toBe(MAX_JOURNAL_ENTRIES + 5);
    expect(entries[MAX_JOURNAL_ENTRIES - 1].id).toBe(6);
  });

  it('finds the last call not reverted', () => {
    const project = {};
    const a = scope(); change(a, 'layouts/L.json');
    const b = scope(); change(b, 'eventSheets/S.json');
    const ea = recordToolCall(project, 'a', 1, a)!;
    const eb = recordToolCall(project, 'b', 2, b)!;
    expect(lastUnrevertedEntry(project)).toBe(eb);
    eb.reverted = true;
    expect(lastUnrevertedEntry(project)).toBe(ea);
  });
});

describe('changedFilesLine', () => {
  it('names the files and the backups', () => {
    const s = scope(); change(s, 'layouts/Layout 1.json');
    expect(changedFilesLine(recordToolCall({}, 'add_layer', 1, s)!))
      .toBe('Changed 1 file(s): layouts/Layout 1.json (1 with a .bak backup; revert_last_change undoes this call).');
  });

  it('says nothing about backups when the call only created files', () => {
    const s = scope(); change(s, 'layouts/Temp.json', { existed: false });
    expect(changedFilesLine(recordToolCall({}, 'create_layout', 1, s)!)).toBe('Changed 1 file(s): layouts/Temp.json.');
  });

  it('lists 12 files and counts the rest', () => {
    const s = scope();
    for (let i = 0; i < 14; i++) change(s, `layouts/L${i}.json`, { existed: false });
    const line = changedFilesLine(recordToolCall({}, 'x', 1, s)!);
    expect(line.startsWith('Changed 14 file(s): layouts/L0.json, ')).toBe(true);
    expect(line.endsWith('layouts/L11.json, and 2 more.')).toBe(true);
  });
});

describe('describeEntry', () => {
  it('gives list_changes its shape, with the backup as it is named on disk', () => {
    const s = scope();
    const image = change(s, 'images/x.png');
    s.changes.set(fileKey(image.path), { ...image, backupLabel: 'images/x.png.1.bak' });
    change(s, 'layouts/New.json', { existed: false });
    move(s, 'images/a.png', 'images/b.png');
    expect(describeEntry(recordToolCall({}, 'mixed', Date.UTC(2026, 9, 17), s)!)).toEqual({
      id: 1,
      tool: 'mixed',
      at: '2026-10-17T00:00:00.000Z',
      reverted: false,
      changes: [
        { kind: 'write', file: 'images/x.png', backup: 'images/x.png.1.bak' },
        { kind: 'create', file: 'layouts/New.json' },
        { kind: 'move', file: 'images/b.png', from: 'images/a.png' },
      ],
    });
  });
});

describe('reasonOf', () => {
  it('gives an fs error\'s code, also from a wrapped cause, and never a path', () => {
    const fsError = Object.assign(new Error('EACCES: permission denied, open \'C:\\Users\\x\\project\\layouts\\L.json\''), { code: 'EACCES' });
    expect(reasonOf(fsError)).toBe('EACCES');
    expect(reasonOf(new Error('Restoring failed', { cause: fsError }))).toBe('EACCES');
    expect(reasonOf(new Error('Cannot open /home/me/project/layouts/L.json'))).toBe('an unexpected error (details are in the server log)');
    expect(reasonOf('C:\\Users\\x\\file')).toBe('an unexpected error (details are in the server log)');
  });

  it('gives a stale-file refusal\'s message, which names files by project-relative label', () => {
    const stale = new StaleFileError('layouts/L.json was changed on disk after this server read it.', 'layouts/L.json');
    expect(reasonOf(stale)).toBe('layouts/L.json was changed on disk after this server read it.');
  });
});

// Tests added beyond the plan's 13 (progress.md, Task 7 notes): proofs of protections the plan's tests leave unproved

describe('the journal of a project, kept in memory', () => {
  it('drops the calls beyond the last ones, however many are asked for', () => {
    const project = {};
    for (let i = 0; i < MAX_JOURNAL_ENTRIES + 5; i++) {
      const s = scope(); change(s, `layouts/L${i}.json`);
      recordToolCall(project, 'add_layer', i, s);
    }
    expect(journalEntries(project, 10 * MAX_JOURNAL_ENTRIES)).toHaveLength(MAX_JOURNAL_ENTRIES);
  });
});

describe('changedSinceCall on a file it cannot read', () => {
  it('lists a file it could not read as changed, as it does a file not known to be the call\'s', async () => {
    // A NUL in the path makes stat throw an error that is not ENOENT: "could not read", not "absent"
    const s = scope();
    const p = join(tmpdir(), 'c3-journal-unit', 'layouts', 'Unreadable\0.json');
    const key = fileKey(p);
    s.changes.set(key, {
      path: p, label: 'layouts/Unreadable.json', backup: { path: p + '.bak', existed: false, state: null }, backupLabel: 'layouts/Unreadable.json.bak',
      isProjectFile: false, journalOnly: false,
    });
    s.steps.push({ file: key });
    s.before.set(key, null);
    s.reads.set(key, AFTER);
    const entry = recordToolCall({}, 'create_layout', 1, s)!;
    expect(await changedSinceCall(entry)).toEqual({ files: ['layouts/Unreadable.json'], backups: [] });
  });

  it('lists a file the call left in no known state (an unowned file)', async () => {
    const s = scope();
    change(s, 'layouts/Unowned.json', { existed: false });
    s.unowned.add(fileKey(path('layouts/Unowned.json')));
    expect(await changedSinceCall(recordToolCall({}, 'x', 1, s)!)).toEqual({ files: ['layouts/Unowned.json'], backups: [] });
  });
});

describe('changedSinceCall on a backup it cannot read', () => {
  it('lists a backup it could not read as replaced', async () => {
    const s = scope();
    const c = change(s, 'layouts/L.json');
    s.changes.set(fileKey(c.path), { ...c, backup: { ...c.backup, path: join(tmpdir(), 'c3-journal-unit', 'layouts', 'L\0.json.bak') } });
    const entry = recordToolCall({}, 'add_layer', 1, s)!;
    expect((await changedSinceCall(entry)).backups).toEqual(['layouts/L.json.bak']);
  });
});

describe('revertEntry on a port written by hand', () => {
  function portLog(log: string[], overrides: Partial<RevertPort> = {}): RevertPort {
    return {
      putBackChange: async change => { log.push(`put back ${change.label}`); return true; },
      renameBack: async move => { log.push(`rename back ${move.toLabel}`); return true; },
      afterRevert: async projectPutBack => { log.push(`after revert (project put back: ${projectPutBack})`); },
      withAnimationLock: async fn => {
        log.push('lock taken');
        try {
          return await fn();
        } finally {
          log.push('lock released');
        }
      },
      ...overrides,
    };
  }

  it('does every step, and the work after it, while it holds the animation lock', async () => {
    const s = scope();
    change(s, 'layouts/L.json');
    change(s, 'project.c3proj');
    const log: string[] = [];
    const report = await revertEntry(recordToolCall({}, 'two', 1, s)!, portLog(log));
    expect(report.notRestored).toEqual([]);
    expect(log).toEqual([
      'lock taken', 'put back project.c3proj', 'put back layouts/L.json', 'after revert (project put back: true)', 'lock released',
    ]);
  });

  it('asks the port to put a file back only for the state the call left it in, and reads it when the port asks', async () => {
    const s = scope();
    change(s, 'layouts/L.json');
    const asked: Array<FileState | undefined> = [];
    const entry = recordToolCall({}, 'one', 1, s)!;
    await revertEntry(entry, portLog([], { putBackChange: async (_change, asLeft) => { asked.push(asLeft()); return true; } }));
    expect(asked).toEqual([AFTER]);
  });

  it('still lets the port finish (afterRevert) when the first step cannot be undone', async () => {
    const s = scope();
    change(s, 'layouts/L.json');
    change(s, 'layouts/M.json');
    const log: string[] = [];
    const entry = recordToolCall({}, 'two', 1, s)!;
    const report = await revertEntry(entry, portLog(log, { putBackChange: async () => false }));
    expect(report.restored).toEqual([]);
    expect(log).toEqual(['lock taken', 'after revert (project put back: false)', 'lock released']);
    expect(entry.undone).toBe(0);
  });
});

describe('withJournalLock', () => {
  it('runs one revert at a time, and goes on after one that threw', async () => {
    const project = {};
    const log: string[] = [];
    const first = withJournalLock(project, async () => {
      log.push('first starts');
      await new Promise(resolve => setTimeout(resolve, 20));
      log.push('first ends');
      throw new Error('first failed');
    });
    const second = withJournalLock(project, async () => {
      log.push('second runs');
      return 'second result';
    });
    await expect(first).rejects.toThrow('first failed');
    expect(await second).toBe('second result');
    expect(log).toEqual(['first starts', 'first ends', 'second runs']);
  });
});
