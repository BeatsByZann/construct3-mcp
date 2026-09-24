/**
 * File stamps and the change journal (roadmap E1, E2): stamps notice an
 * outside change, entries group a call's changes, and a revert undoes each
 * kind of change from its backup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExternalChangeError,
  assertUnchanged,
  changedSinceSeen,
  clearJournal,
  clearStamps,
  currentEntry,
  forgetChange,
  journalEntries,
  lastEntry,
  noteSeen,
  recordChange,
  restamp,
  revertEntry,
  stampOf,
  supersededBy,
  withJournalEntry,
} from '../../src/construct3/change-journal.js';

let tmp: string;
beforeEach(async () => {
  clearStamps();
  clearJournal();
  tmp = await mkdtemp(join(tmpdir(), 'c3-journal-'));
});
afterEach(async () => {
  clearStamps();
  clearJournal();
  await rm(tmp, { recursive: true, force: true });
});

describe('file stamps', () => {
  it('passes an unchanged, unseen or missing file and refuses one that changed', async () => {
    const file = join(tmp, 'a.json');
    await writeFile(file, '{"a":1}');
    await assertUnchanged(file); // never seen
    noteSeen(file, await stat(file));
    await assertUnchanged(file); // unchanged
    expect(stampOf(file)).toEqual(expect.objectContaining({ size: 7 }));

    await writeFile(file, '{"a":12}');
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    await expect(assertUnchanged(file)).rejects.toThrow(ExternalChangeError);
    await expect(assertUnchanged(file)).rejects.toThrow('changed on disk after this server last read it');
    expect(await changedSinceSeen()).toEqual([{ path: file, state: 'changed' }]);

    await restamp(file);
    await assertUnchanged(file);
    await rm(file);
    await assertUnchanged(file); // gone: nothing to protect
    expect(await changedSinceSeen()).toEqual([{ path: file, state: 'missing' }]);
  });

  it('matches paths without case on Windows', async () => {
    const file = join(tmp, 'Layout.json');
    await writeFile(file, '{}');
    noteSeen(file, await stat(file));
    if (process.platform === 'win32') expect(stampOf(join(tmp, 'layout.JSON'))).toBeDefined();
  });
});

describe('journal entries', () => {
  it('groups the changes of one call and keeps only calls that changed something', async () => {
    const first = await withJournalEntry('read_only', async () => {
      expect(currentEntry()?.tool).toBe('read_only');
      return 1;
    });
    expect(first.result).toBe(1);
    expect(journalEntries()).toEqual([]);

    const second = await withJournalEntry('add_layer', async () => {
      recordChange({ kind: 'write', path: join(tmp, 'x.json'), backupPath: join(tmp, 'x.json.bak') });
      recordChange({ kind: 'create', path: join(tmp, 'y.json') });
      forgetChange(join(tmp, 'y.json'));
      return 'done';
    });
    expect(second.entry.changes).toHaveLength(1);
    expect(journalEntries().map(e => e.tool)).toEqual(['add_layer']);
    expect(lastEntry()?.id).toBe(second.entry.id);
    expect(currentEntry()).toBeUndefined();
    recordChange({ kind: 'create', path: join(tmp, 'outside.json') }); // no call in progress: dropped
    expect(journalEntries()[0].changes).toHaveLength(1);
  });

  it('keeps an entry when the call throws, and finds later calls that touched the same files', async () => {
    await expect(withJournalEntry('failing', async () => {
      recordChange({ kind: 'create', path: join(tmp, 'a.json') });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const a = lastEntry()!;
    const b = (await withJournalEntry('later', async () => { recordChange({ kind: 'write', path: join(tmp, 'a.json'), backupPath: join(tmp, 'a.json.bak') }); })).entry;
    const c = (await withJournalEntry('other', async () => { recordChange({ kind: 'write', path: join(tmp, 'z.json'), backupPath: join(tmp, 'z.json.bak') }); })).entry;
    expect(supersededBy(a).map(e => e.id)).toEqual([b.id]);
    expect(supersededBy(b)).toEqual([]);
    expect(supersededBy(c)).toEqual([]);
    b.reverted = true;
    // A reverted later call still spoils the earlier backup.
    expect(supersededBy(a).map(e => e.id)).toEqual([b.id]);
    expect(lastEntry()?.id).toBe(c.id);
  });
});

describe('revertEntry', () => {
  it('restores a write and a delete from their backups, removes a create and a copy, moves a move back', async () => {
    const written = join(tmp, 'written.json');
    const deleted = join(tmp, 'deleted.json');
    const created = join(tmp, 'created.json');
    const moved = join(tmp, 'moved.png');
    const copied = join(tmp, 'copied.png');
    const noBackup = join(tmp, 'placeholder.png');
    await writeFile(written + '.bak', 'before');
    await writeFile(written, 'after');
    await writeFile(deleted + '.bak', 'was here');
    await writeFile(created, 'new');
    await writeFile(moved, 'frame');
    await writeFile(copied, 'frame');
    await writeFile(noBackup, 'png');
    noteSeen(written, await stat(written));

    const { entry } = await withJournalEntry('mixed', async () => {
      recordChange({ kind: 'write', path: written, backupPath: written + '.bak' });
      recordChange({ kind: 'delete', path: deleted, backupPath: deleted + '.bak' });
      recordChange({ kind: 'create', path: created });
      recordChange({ kind: 'move', path: moved, from: join(tmp, 'origin.png') });
      recordChange({ kind: 'copy', path: copied });
      recordChange({ kind: 'overwrite-no-backup', path: noBackup });
    });
    const report = await revertEntry(entry);
    expect(report.failed).toEqual([{ path: noBackup, reason: 'the previous content was not backed up' }]);
    expect(report.restored.map(r => r.how)).toEqual([
      'removed (the call created it)',
      `moved back from ${moved}`,
      'removed (the call created it)',
      `restored from ${deleted}.bak`,
      `restored from ${written}.bak`,
    ]);
    expect(await readFile(written, 'utf8')).toBe('before');
    expect(await readFile(deleted, 'utf8')).toBe('was here');
    expect(existsSync(created)).toBe(false);
    expect(existsSync(copied)).toBe(false);
    expect(existsSync(moved)).toBe(false);
    expect(await readFile(join(tmp, 'origin.png'), 'utf8')).toBe('frame');
    expect(entry.reverted).toBe(true);
    expect(stampOf(written)).toEqual(expect.objectContaining({ size: 6 })); // restamped after the restore
    expect(lastEntry()).toBeUndefined();
  });
});
