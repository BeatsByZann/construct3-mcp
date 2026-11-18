/** fileErrorText (#ISSUE): an fs error in a message as its code and a project-relative path. Synthetic errors. */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { fileErrorText } from '../../src/construct3/fs-errors.js';
import { EntityWriteError } from '../../src/construct3/project-writer.js';

const PROJECT = join('C:', 'games', 'My Game');
const relative = (path: string) => path.slice(PROJECT.length + 1).split('\\').join('/');
const fsError = (code: string, path: string) => Object.assign(new Error(`${code}: failed, open '${path}'`), { code, path });

describe('EntityWriteError', () => {
  const folder = 'C:\\games\\My Game';
  const path = `${folder}\\objectTypes\\Hero.json`;

  it('words its message without the absolute path and keeps the original error as the cause', () => {
    const cause = fsError('EPERM', path);
    const error = new EntityWriteError(cause, `${path}.bak`, '{}', folder);
    expect(error.message).toBe("EPERM: failed, open 'objectTypes/Hero.json'");
    expect(error.cause).toBe(cause);
  });

  it('shows a path as outside the project when it is given no project folder', () => {
    expect(new EntityWriteError(fsError('EPERM', path), `${path}.bak`).message).toBe("EPERM: failed, open '<a path outside the project>'");
  });
});

describe('fileErrorText', () => {
  it('gives an fs error\'s code and its path in the project, not its message', () => {
    const path = join(PROJECT, 'images', 'hero-walk-000.png');
    expect(fileErrorText(fsError('EACCES', path), relative)).toBe('EACCES on images/hero-walk-000.png');
  });

  it('takes the fs error behind an EntityWriteError', () => {
    const path = join(PROJECT, 'objectTypes', 'Hero.json');
    const error = new EntityWriteError(fsError('EPERM', path), `${path}.bak`, '{}');
    expect(fileErrorText(error, relative)).toBe('EPERM on objectTypes/Hero.json');
  });

  it('keeps any other error\'s message as it is', () => {
    expect(fileErrorText(new Error('Post-write verification failed for "Hero".'), relative)).toBe('Post-write verification failed for "Hero".');
  });
});
