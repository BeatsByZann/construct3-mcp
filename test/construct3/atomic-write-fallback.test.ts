/**
 * Tests for atomicReplace when renaming the temp file onto an existing file
 * fails with EEXIST: the file is moved aside, never deleted, the new content
 * is linked into its place, and the file is linked back when that fails. No
 * step replaces or removes a file another write put at the name meanwhile.
 *
 * Failures are injected through a pass-through mock of rename, unlink, link
 * and lstat that fails only the calls a test names, and random tokens can be
 * forced. The files are synthetic, written to a temp directory; the writer
 * tests use a copy of the minimal fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { atomicReplace } from '../../src/construct3/atomic-write.js';
import { sameFileState, statFileState } from '../../src/construct3/disk-state.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';

const forced = vi.hoisted(() => ({ tokens: [] as string[] }));

// rename, unlink, link and lstat pass through unless a test queues a fault for the call
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    link: vi.fn(actual.link),
    lstat: vi.fn(actual.lstat),
  };
});

// randomBytes passes through unless a test queues tokens (16 hex digits each)
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => {
      const next = forced.tokens.shift();
      return next === undefined ? actual.randomBytes(size) : Buffer.from(next, 'hex');
    },
  };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

type Op = 'rename' | 'unlink' | 'link' | 'lstat';

/** One injected fault: the first call of `op` whose paths match runs `before`, then fails with `code`, or with `pass` runs for real and then `after`. */
interface Fault {
  op: Op;
  matches: (from: string, to?: string) => boolean;
  code?: string;
  /** The error message; default `<code>: injected failure, <op> '<from>' -> '<to>'`. */
  message?: string;
  /** Runs first (another write landing in between). */
  before?: () => Promise<void>;
  /** After `before`, run the real call instead of failing. */
  pass?: boolean;
  /** With `pass`, runs after the real call (another write landing just after it). */
  after?: () => Promise<void>;
}

let faults: Fault[] = [];

/** An error shaped like Node's for a failed file system call. */
function injected(fault: Fault, from: string, to?: string): NodeJS.ErrnoException {
  const code = fault.code ?? 'EIO';
  const where = to === undefined ? `'${from}'` : `'${from}' -> '${to}'`;
  const message = fault.message ?? `${code}: injected failure, ${fault.op} ${where}`;
  return Object.assign(new Error(message), { code, syscall: fault.op, path: from });
}

/** Removes and returns the first queued fault for this call, if any. */
function takeFault(op: Op, from: string, to?: string): Fault | undefined {
  const index = faults.findIndex(f => f.op === op && f.matches(from, to));
  return index < 0 ? undefined : faults.splice(index, 1)[0];
}

/** Whether `path` is one of atomicReplace's own files: .c3mcp-<16 hex digits>.<ext>. */
function isOwn(path: string, ext: 'tmp' | 'old' | 'link'): boolean {
  return new RegExp(`^\\.c3mcp-[0-9a-f]{16}\\.${ext}$`).test(basename(path));
}

/** Whether `path` is the temp file of a write to `file`: <file>.tmp, or a .c3mcp-*.tmp beside it. */
function isTempFor(path: string, file: string): boolean {
  return dirname(path) === dirname(file) && (path === `${file}.tmp` || isOwn(path, 'tmp'));
}

/** The [from, to] paths of every call of `fn` so far. */
function calls(fn: typeof rename | typeof link): Array<[string, string]> {
  return vi.mocked(fn).mock.calls.map(([from, to]) => [String(from), String(to)]);
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  faults = [];
  forced.tokens = [];
  const twoPath = (op: 'rename' | 'link', real: (a: string, b: string) => Promise<void>) =>
    async (from: unknown, to: unknown) => {
      const fault = takeFault(op, String(from), String(to));
      if (fault) {
        await fault.before?.();
        if (!fault.pass) throw injected(fault, String(from), String(to));
        await real(String(from), String(to));
        await fault.after?.();
        return;
      }
      return real(String(from), String(to));
    };
  vi.mocked(rename).mockClear();
  vi.mocked(rename).mockImplementation(twoPath('rename', actual.rename));
  vi.mocked(link).mockClear();
  vi.mocked(link).mockImplementation(twoPath('link', actual.link));
  vi.mocked(unlink).mockClear();
  vi.mocked(unlink).mockImplementation(async (path) => {
    const fault = takeFault('unlink', String(path));
    if (fault) throw injected(fault, String(path));
    return actual.unlink(path);
  });
  vi.mocked(lstat).mockClear();
  vi.mocked(lstat).mockImplementation((async (path: Parameters<typeof lstat>[0]) => {
    const fault = takeFault('lstat', String(path));
    if (fault) throw injected(fault, String(path));
    return actual.lstat(path);
  }) as typeof lstat);
});

describe('atomicReplace when the rename onto the file fails with EEXIST', () => {
  let dir: string;
  let file: string;
  const name = 'Layout1.json';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'c3-atomic-fallback-'));
    file = join(dir, name);
    await writeFile(file, '{"v":1}', 'utf-8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tempOntoFile = (from: string, to?: string) => isTempFor(from, file) && to === file;
  const asideOntoFile = (from: string, to?: string) => isOwn(from, 'old') && to === file;
  const fileOntoAside = (from: string, to?: string) => from === file && to !== undefined && isOwn(to, 'old');
  /** The first rename's temp file, and the name the file was moved aside to. */
  const temp = () => calls(rename)[0][0];
  const aside = () => calls(rename).find(([from]) => from === file)?.[1] ?? '';
  /** A failed install: EEXIST from the first rename, then `code` from the next call that installs the temp file, a rename or a link. */
  const installFails = (code: string, extra: Partial<Fault> = {}): Fault[] => [
    { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
    { op: 'rename', matches: tempOntoFile, code },
    { op: 'link', matches: tempOntoFile, code, ...extra },
  ];
  const leftWith = (lead: string, a: string, t: string, cause: string) =>
    `${lead}. ${name} was created again while this write had it moved aside (${cause}), and that file was left as it is. ` +
    `At that point what was at ${name} before this write was in ${basename(a)} and this write's content in ${basename(t)}, ` +
    'both in the same folder, and neither was removed.';

  it('keeps the file when linking the new content in fails, putting it back', async () => {
    const before = await statFileState(file);
    faults = installFails('EPERM');

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    expect(await readFile(file, 'utf-8')).toBe('{"v":1}');
    // Moved aside and linked back: the same file, so the stamp the server read still matches
    expect(sameFileState(await statFileState(file), before)).toBe(true);
    expect(isOwn(temp(), 'tmp')).toBe(true);
    expect(isOwn(aside(), 'old')).toBe(true);
    expect((error as Error).message).toBe(
      `Could not replace ${name}: EPERM: injected failure, link '${temp()}' -> '${file}'. ` +
      'It was put back, so this write did not change it.');
    expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
    expect((error as Error).cause).toMatchObject({ code: 'EPERM' });
    expect(await readdir(dir)).toEqual([name]);
  });

  it('replaces the file by moving it aside and linking the new content in when the first rename gives EEXIST', async () => {
    faults = [{ op: 'rename', matches: tempOntoFile, code: 'EEXIST' }];

    expect(await atomicReplace(file, '{"v":2}')).toBe(file);

    expect(isOwn(aside(), 'old')).toBe(true);
    expect(calls(link)).toContainEqual([temp(), file]);
    expect(await readFile(file, 'utf-8')).toBe('{"v":2}');
    expect(await readdir(dir)).toEqual([name]);
  });

  it('still reports the put back when the temp file cannot be removed afterwards', async () => {
    faults = [...installFails('EPERM'), { op: 'unlink', matches: (path) => isTempFor(path, file), code: 'EBUSY' }];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      `Could not replace ${name}: EPERM: injected failure, link '${temp()}' -> '${file}'. ` +
      'It was put back, so this write did not change it.');
    expect(await readFile(file, 'utf-8')).toBe('{"v":1}');
    expect((await readdir(dir)).sort()).toEqual([name, basename(temp())].sort());
  });

  it('names both files and removes neither when putting the file back fails too', async () => {
    faults = [...installFails('EPERM'), { op: 'link', matches: asideOntoFile, code: 'EBUSY' }];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    const t = temp();
    const a = aside();
    expect((error as Error).message).toBe(
      `Could not replace ${name}: EPERM: injected failure, link '${t}' -> '${file}'. ` +
      `Putting it back failed too (EBUSY: injected failure, link '${a}' -> '${file}'). ` +
      `At that point what was at ${name} before this write was in ${basename(a)} and this write's content in ${basename(t)}, ` +
      `both in the same folder, and neither was removed. If ${name} is missing, rename ${basename(a)} to ${name} to put it back.`);
    expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
    expect((await readdir(dir)).sort()).toEqual([basename(a), basename(t)].sort());
    expect(await readFile(a, 'utf-8')).toBe('{"v":1}');
    expect(await readFile(t, 'utf-8')).toBe('{"v":2}');
  });

  it('leaves the files of a failed put back in place when a later write draws the same token', async () => {
    faults = [...installFails('EPERM'), { op: 'link', matches: asideOntoFile, code: 'EBUSY' }];
    await atomicReplace(file, '{"v":2}').catch(() => undefined);
    const t = temp();
    const a = aside();
    faults = [];
    // The later write first draws the token of the temp file left above, then a fresh one
    forced.tokens = [basename(t).slice('.c3mcp-'.length, -'.tmp'.length)];

    // As a tool's restore from the .bak does: the file is missing, so this is a plain write
    expect(await atomicReplace(file, '{"v":3}')).toBe(file);

    expect(await readFile(file, 'utf-8')).toBe('{"v":3}');
    expect(await readFile(a, 'utf-8')).toBe('{"v":1}');
    expect(await readFile(t, 'utf-8')).toBe('{"v":2}');
    expect((await readdir(dir)).sort()).toEqual([name, basename(a), basename(t)].sort());
  });

  it('leaves a file another write put at the name before the put back, and removes nothing', async () => {
    faults = installFails('EPERM', { before: () => writeFile(file, '{"other":1}', 'utf-8') });

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    const t = temp();
    const a = aside();
    expect(await readFile(file, 'utf-8')).toBe('{"other":1}');
    expect(await readFile(a, 'utf-8')).toBe('{"v":1}');
    expect(await readFile(t, 'utf-8')).toBe('{"v":2}');
    expect((await readdir(dir)).sort()).toEqual([name, basename(a), basename(t)].sort());
    const message = (error as Error).message;
    const lead = `Could not replace ${name}: EPERM: injected failure, link '${t}' -> '${file}'`;
    expect(message.startsWith(`${lead}. ${name} was created again while this write had it moved aside (EEXIST`)).toBe(true);
    const realCause = message.slice(message.indexOf(' moved aside (') + ' moved aside ('.length, message.indexOf('), and that file'));
    expect(message).toBe(leftWith(lead, a, t, realCause));
    expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
  });

  it('leaves a file another write put at the name before the link-in, and removes nothing', async () => {
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'rename', matches: fileOntoAside, pass: true, after: () => writeFile(file, '{"other":1}', 'utf-8') },
    ];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    const t = temp();
    const a = aside();
    expect(await readFile(file, 'utf-8')).toBe('{"other":1}');
    expect(await readFile(a, 'utf-8')).toBe('{"v":1}');
    expect(await readFile(t, 'utf-8')).toBe('{"v":2}');
    const message = (error as Error).message;
    expect(message.startsWith(`Could not replace ${name}. ${name} was created again while this write had it moved aside (EEXIST`)).toBe(true);
    const realCause = message.slice(message.indexOf(' moved aside (') + ' moved aside ('.length, message.indexOf('), and that file'));
    expect(message).toBe(leftWith(`Could not replace ${name}`, a, t, realCause));
    expect((error as NodeJS.ErrnoException).code).toBe('EEXIST');
  });

  it('leaves the file as it was when moving it aside fails', async () => {
    const before = await statFileState(file);
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'rename', matches: fileOntoAside, code: 'EBUSY' },
    ];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      `Could not replace ${name}: EBUSY: injected failure, rename '${file}' -> '${aside()}'. This write did not change it.`);
    expect((error as NodeJS.ErrnoException).code).toBe('EBUSY');
    expect((error as Error).cause).toMatchObject({ code: 'EBUSY' });
    expect(await readFile(file, 'utf-8')).toBe('{"v":1}');
    expect(sameFileState(await statFileState(file), before)).toBe(true);
    expect(await readdir(dir)).toEqual([name]);
  });

  it('still reports the failed move aside when the temp file cannot be removed', async () => {
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'rename', matches: fileOntoAside, code: 'EBUSY' },
      { op: 'unlink', matches: (path) => isTempFor(path, file), code: 'EBUSY' },
    ];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      `Could not replace ${name}: EBUSY: injected failure, rename '${file}' -> '${aside()}'. This write did not change it.`);
    expect(await readFile(file, 'utf-8')).toBe('{"v":1}');
    expect((await readdir(dir)).sort()).toEqual([name, basename(temp())].sort());
  });

  it('keeps the replacement when the aside file cannot be removed afterwards', async () => {
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'unlink', matches: (path) => isOwn(path, 'old'), code: 'EBUSY' },
    ];

    expect(await atomicReplace(file, '{"v":2}')).toBe(file);

    expect(await readFile(file, 'utf-8')).toBe('{"v":2}');
    expect((await readdir(dir)).sort()).toEqual([name, basename(aside())].sort());
    expect(await readFile(aside(), 'utf-8')).toBe('{"v":1}');
  });

  it('rethrows a first rename failure other than EEXIST without touching the file', async () => {
    const before = await statFileState(file);
    faults = [{ op: 'rename', matches: tempOntoFile, code: 'EPERM' }];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    expect((error as Error).message).toBe(`EPERM: injected failure, rename '${temp()}' -> '${file}'`);
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(link)).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf-8')).toBe('{"v":1}');
    expect(sameFileState(await statFileState(file), before)).toBe(true);
    expect(await readdir(dir)).toEqual([name]);
  });

  it('rethrows EEXIST without the fallback when a directory has the file\'s name', async () => {
    const folder = join(dir, 'Folder.json');
    await mkdir(folder);
    await writeFile(join(folder, 'inside.txt'), 'x', 'utf-8');
    faults = [{ op: 'rename', matches: (from, to) => isTempFor(from, folder) && to === folder, code: 'EEXIST' }];

    const error = await atomicReplace(folder, '{"v":2}').catch((e: unknown) => e);

    expect((error as Error).message).toBe(`EEXIST: injected failure, rename '${temp()}' -> '${folder}'`);
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(link)).not.toHaveBeenCalled();
    expect((await stat(folder)).isDirectory()).toBe(true);
    expect(await readdir(folder)).toEqual(['inside.txt']);
    expect((await readdir(dir)).sort()).toEqual(['Folder.json', name].sort());
  });

  it('puts back a directory that took the file\'s place after the check, without installing over it', async () => {
    const swapInDirectory = async () => {
      await rm(file);
      await mkdir(file);
      await writeFile(join(file, 'inside.txt'), 'x', 'utf-8');
    };
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'rename', matches: fileOntoAside, pass: true, before: swapInDirectory },
    ];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      `Could not replace ${name}: EEXIST: injected failure, rename '${temp()}' -> '${file}', and ${name} is not a regular file. ` +
      'It was put back, so this write did not change it.');
    expect((error as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect(calls(link)).not.toContainEqual([temp(), file]);
    expect((await stat(file)).isDirectory()).toBe(true);
    expect(await readdir(file)).toEqual(['inside.txt']);
    expect(await readdir(dir)).toEqual([name]);
  });

  it('does not move the file when the folder cannot make hard links', async () => {
    const before = await statFileState(file);
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'link', matches: (from, to) => isTempFor(from, file) && to !== undefined && isOwn(to, 'link'), code: 'EPERM' },
    ];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    const probe = calls(link)[0][1];
    expect((error as Error).message).toBe(
      `Could not replace ${name}: EEXIST: injected failure, rename '${temp()}' -> '${file}', and the way around that error ` +
      `needs a hard link in this folder, which failed (EPERM: injected failure, link '${temp()}' -> '${probe}'). ` +
      'This write did not change it.');
    expect((error as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
    expect(sameFileState(await statFileState(file), before)).toBe(true);
    expect(await readdir(dir)).toEqual([name]);
  });

  it('gives one full stop when the cause message ends with one', async () => {
    faults = installFails('EPERM', { message: 'EPERM: operation not permitted.' });

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      `Could not replace ${name}: EPERM: operation not permitted. It was put back, so this write did not change it.`);
  });

  it('writes a file whose name is 250 characters long', async () => {
    const long = join(dir, `${'L'.repeat(245)}.json`);
    await writeFile(long, '{"v":1}', 'utf-8');

    expect(await atomicReplace(long, '{"v":2}')).toBe(long);

    expect(await readFile(long, 'utf-8')).toBe('{"v":2}');
  });

  it('never moves the file onto an own name that already exists', async () => {
    const taken = '1'.repeat(16);
    const takenPath = join(dir, `.c3mcp-${taken}.old`);
    await writeFile(takenPath, 'keep', 'utf-8');
    faults = [{ op: 'rename', matches: tempOntoFile, code: 'EEXIST' }];
    // Temp file, link test, then the taken aside name, then a free one
    forced.tokens = ['a'.repeat(16), 'b'.repeat(16), taken, 'c'.repeat(16)];

    expect(await atomicReplace(file, '{"v":2}')).toBe(file);

    expect(await readFile(file, 'utf-8')).toBe('{"v":2}');
    expect(await readFile(takenPath, 'utf-8')).toBe('keep');
    expect((await readdir(dir)).sort()).toEqual([basename(takenPath), name].sort());
  });

  it('still replaces the file when the link test cannot be removed', async () => {
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'unlink', matches: (path) => isOwn(path, 'link'), code: 'EBUSY' },
    ];

    expect(await atomicReplace(file, '{"v":2}')).toBe(file);

    const probe = calls(link)[0][1];
    expect(isOwn(probe, 'link')).toBe(true);
    expect(await readFile(file, 'utf-8')).toBe('{"v":2}');
    expect((await readdir(dir)).sort()).toEqual([name, basename(probe)].sort());
  });

  it('gives up with EEXIST after five taken temp names, leaving the file as it was', async () => {
    const before = await statFileState(file);
    const takenTmp = join(dir, `.c3mcp-${'a'.repeat(16)}.tmp`);
    await writeFile(takenTmp, 'keep', 'utf-8');
    forced.tokens = Array.from({ length: 5 }, () => 'a'.repeat(16));

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    expect((error as Error).message).toBe(`EEXIST: file already exists, open '${takenTmp}'`);
    expect((error as NodeJS.ErrnoException).code).toBe('EEXIST');
    // Exactly five names were drawn
    expect(forced.tokens).toEqual([]);
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(await readFile(takenTmp, 'utf-8')).toBe('keep');
    expect(await readFile(file, 'utf-8')).toBe('{"v":1}');
    expect(sameFileState(await statFileState(file), before)).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([basename(takenTmp), name].sort());
  });

  it('draws another aside name when moving the file aside gives EEXIST', async () => {
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'rename', matches: fileOntoAside, code: 'EEXIST' },
    ];

    expect(await atomicReplace(file, '{"v":2}')).toBe(file);

    const moves = calls(rename).filter(([from]) => from === file);
    expect(moves).toHaveLength(2);
    expect(moves.every(([, to]) => isOwn(to, 'old'))).toBe(true);
    expect(moves[0][1]).not.toBe(moves[1][1]);
    expect(await readFile(file, 'utf-8')).toBe('{"v":2}');
    expect(await readdir(dir)).toEqual([name]);
  });

  it('still reports the failed hard link when the temp file cannot be removed', async () => {
    const before = await statFileState(file);
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'link', matches: (from, to) => isTempFor(from, file) && to !== undefined && isOwn(to, 'link'), code: 'EPERM' },
      { op: 'unlink', matches: (path) => isTempFor(path, file), code: 'EBUSY' },
    ];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    const probe = calls(link)[0][1];
    expect((error as Error).message).toBe(
      `Could not replace ${name}: EEXIST: injected failure, rename '${temp()}' -> '${file}', and the way around that error ` +
      `needs a hard link in this folder, which failed (EPERM: injected failure, link '${temp()}' -> '${probe}'). ` +
      'This write did not change it.');
    expect((error as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect(sameFileState(await statFileState(file), before)).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([name, basename(temp())].sort());
    expect(await readFile(temp(), 'utf-8')).toBe('{"v":2}');
  });

  it('keeps the replacement when the temp file cannot be removed after the link in', async () => {
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'unlink', matches: (path) => isTempFor(path, file), code: 'EBUSY' },
    ];

    expect(await atomicReplace(file, '{"v":2}')).toBe(file);

    expect(await readFile(file, 'utf-8')).toBe('{"v":2}');
    // The temp file is a second name of the new file
    expect((await readdir(dir)).sort()).toEqual([name, basename(temp())].sort());
    expect(await readFile(temp(), 'utf-8')).toBe('{"v":2}');
  });

  it('still reports the put back when the aside file cannot be removed afterwards', async () => {
    const before = await statFileState(file);
    faults = [...installFails('EPERM'), { op: 'unlink', matches: (path) => isOwn(path, 'old'), code: 'EBUSY' }];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      `Could not replace ${name}: EPERM: injected failure, link '${temp()}' -> '${file}'. ` +
      'It was put back, so this write did not change it.');
    expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
    expect(await readFile(file, 'utf-8')).toBe('{"v":1}');
    expect(sameFileState(await statFileState(file), before)).toBe(true);
    // The aside file is a second name of the file that was put back
    expect((await readdir(dir)).sort()).toEqual([name, basename(aside())].sort());
    expect(await readFile(aside(), 'utf-8')).toBe('{"v":1}');
  });

  it('leaves the file as it was when the aside name cannot be checked', async () => {
    const before = await statFileState(file);
    faults = [
      { op: 'rename', matches: tempOntoFile, code: 'EEXIST' },
      { op: 'lstat', matches: (path) => isOwn(path, 'old'), code: 'EACCES' },
    ];

    const error = await atomicReplace(file, '{"v":2}').catch((e: unknown) => e);

    const checked = String(vi.mocked(lstat).mock.calls.map(([path]) => path).find(path => isOwn(String(path), 'old')));
    expect((error as Error).message).toBe(
      `Could not replace ${name}: EACCES: injected failure, lstat '${checked}'. This write did not change it.`);
    expect((error as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(calls(rename).filter(([from]) => from === file)).toEqual([]);
    expect(sameFileState(await statFileState(file), before)).toBe(true);
    expect(await readdir(dir)).toEqual([name]);
  });
});

describe('the writer when a replacement fails after EEXIST', () => {
  let dir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'c3-atomic-fallback-writer-'));
    await cp(FIXTURE_DIR, dir, { recursive: true });
    reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
    await reader.loadProject();
    writer = new Construct3ProjectWriter(reader, new IdGenerator());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A failed install of a temp file onto `target`: EEXIST from the first rename, then EPERM from the next call that installs it, a rename or a link. */
  const installFailsOnto = (target: string): Fault[] => {
    const tempOntoTarget = (from: string, to?: string) => isTempFor(from, target) && to === target;
    return [
      { op: 'rename', matches: tempOntoTarget, code: 'EEXIST' },
      { op: 'rename', matches: tempOntoTarget, code: 'EPERM' },
      { op: 'link', matches: tempOntoTarget, code: 'EPERM' },
    ];
  };

  it('updateProjectProperties leaves project.c3proj as it was, loadable and unchanged for the reader', async () => {
    const projectPath = join(dir, 'project.c3proj');
    const before = await readFile(projectPath);
    faults = installFailsOnto(projectPath);

    const error = await writer.updateProjectProperties({ description: 'fallback test' }).catch((e: unknown) => e);

    expect((await readFile(projectPath)).equals(before)).toBe(true);
    expect(await reader.projectFileChanged()).toBe(false);
    expect((error as Error).message).toBe(
      `Could not replace project.c3proj: EPERM: injected failure, link '${calls(rename)[0][0]}' -> '${projectPath}'. ` +
      'It was put back, so this write did not change it.');
    expect((await readdir(dir)).filter(n => n.startsWith('.c3mcp-') || n.endsWith('.tmp'))).toEqual([]);
    await new Construct3ProjectReader(projectPath).loadProject();
  });

  it('a later writeEntityFile of the file is not refused after a failed write put it back', async () => {
    const sheetPath = join(dir, 'eventSheets', 'Fallback.json');
    await writer.writeEntityFile('eventSheets', 'Fallback', { name: 'Fallback', events: [] });
    faults = installFailsOnto(sheetPath);

    const error = await writer.writeEntityFile('eventSheets', 'Fallback',
      { name: 'Fallback', events: [{ eventType: 'comment', text: 'first' }] }).catch((e: unknown) => e);

    // The second rename onto the file is the failed write's first
    const failedTemp = calls(rename).filter(([, to]) => to === sheetPath)[1][0];
    expect((error as Error).message).toBe(
      `Could not replace Fallback.json: EPERM: injected failure, link '${failedTemp}' -> '${sheetPath}'. ` +
      'It was put back, so this write did not change it.');

    // The file is the one the first write left, so the stale check lets this write through
    faults = [];
    await writer.writeEntityFile('eventSheets', 'Fallback',
      { name: 'Fallback', events: [{ eventType: 'comment', text: 'second' }] });
    expect(JSON.parse(await readFile(sheetPath, 'utf-8')).events[0].text).toBe('second');
  });
});
