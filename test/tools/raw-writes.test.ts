/** The direct-write guard's scanner finds raw writes under aliases, on several lines, as properties, and in nested folders. */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listToolModules, rawWriteCalls } from '../helpers/raw-writes.js';

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('rawWriteCalls', () => {
  it('finds a call spread over several lines', () => {
    const calls = rawWriteCalls('a.ts', "import { writeFile } from 'fs/promises';\nawait writeFile(\n  path,\n  text,\n);\n");
    expect(calls.map(c => [c.name, c.line, c.text])).toEqual([['writeFile', 2, 'writeFile( path, text, )']]);
  });

  it('finds an aliased import and a destructured dynamic import', () => {
    const text = "import { unlink as remove } from 'fs/promises';\nawait remove(p);\n"
      + "const { writeFile } = await import('fs/promises');\nawait writeFile(p, t);\n";
    expect(rawWriteCalls('b.ts', text).map(c => c.name)).toEqual(['unlink', 'writeFile']);
  });

  it('finds a property call and ignores a local function of the same name that is not imported', () => {
    const text = "import * as fs from 'fs/promises';\nawait fs.rename(a, b);\nfunction copyFile() {}\ncopyFile();\n";
    expect(rawWriteCalls('c.ts', text).map(c => c.name)).toEqual(['rename']);
  });
});

describe('listToolModules', () => {
  it('walks nested folders', () => {
    dir = mkdtempSync(join(tmpdir(), 'c3-guard-'));
    mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(dir, 'top.ts'), '');
    writeFileSync(join(dir, 'nested', 'deeper', 'inner.ts'), '');
    writeFileSync(join(dir, 'nested', 'notes.md'), '');
    expect(listToolModules(dir).sort()).toEqual(['nested/deeper/inner.ts', 'top.ts']);
  });
});
