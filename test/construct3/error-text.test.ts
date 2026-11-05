import { describe, expect, it } from 'vitest';
import { errorMessage, errorReason, withoutAbsolutePaths } from '../../src/construct3/error-text.js';

const PROJECT = 'C:\\Games\\My Game';

describe('withoutAbsolutePaths', () => {
  it.each([
    ['inside the project, backslashes', `open 'C:\\Games\\My Game\\layouts\\Level 1.json'`, `open 'layouts/Level 1.json'`],
    ['inside the project, forward slashes, other drive case', `at c:/Games/My Game/eventSheets/A.json`, 'at eventSheets/A.json'],
    ['the project folder alone', `in C:\\Games\\My Game`, 'in .'],
    ['outside, with a space in a user name, text after', `copy to C:\\Users\\First Last\\x.json failed`, 'copy to <a path outside the project> failed'],
    ['outside folder at the end of a sentence', `cannot open C:\\Users\\First Last. Check it.`, 'cannot open <a path outside the project>. Check it.'],
    ['two paths and a code', `rename C:\\a\\b.json -> C:\\a\\c.json: EPERM`, 'rename <a path outside the project> -> <a path outside the project>: EPERM'],
    ['outside, quoted', `stat 'D:\\Other Folder\\a.json': ENOENT`, `stat '<a path outside the project>': ENOENT`],
    ['UNC', `read \\\\server\\share\\a b\\c.json`, 'read <a path outside the project>'],
    ['POSIX root, quoted', `open '/home/first last/game/x.json'`, `open '<a path outside the project>'`],
    ['POSIX root, unquoted, at the end of a sentence', 'Cannot read /home/u/a.json.', 'Cannot read <a path outside the project>.'],
    ['8.3 short form outside the project', 'Cannot read C:\\FIRSTL~1\\Games\\a.json.', 'Cannot read <a path outside the project>.'],
    ['relative paths and slashes inside words are kept', 'Wrote ./layouts/a.json and tilemapBrushes/objectTypes/T.json, and/or 1/2.', 'Wrote ./layouts/a.json and tilemapBrushes/objectTypes/T.json, and/or 1/2.'],
    ['a division in an expression is not a path', 'Invalid expression: Self.X / 2', 'Invalid expression: Self.X / 2'],
    ['a division with no space before the divisor is not a path', 'Invalid expression: Self.X /Self.Y', 'Invalid expression: Self.X /Self.Y'],
    ['a URL is not a path', 'could not be reached (https://example.com/a b)', 'could not be reached (https://example.com/a b)'],
    ['a sibling folder that starts with the project name', `C:\\Games\\My Game 2\\x.json`, '<a path outside the project>'],
    ['no path', 'Name "A" is taken.', 'Name "A" is taken.'],
    ['outside, in parentheses, text after', 'Cannot open (C:\\a\\b.json) failed. Next', 'Cannot open (<a path outside the project>) failed. Next'],
    ['outside, in parentheses at the end', 'could not be read (D:\\Other Folder\\a.json)', 'could not be read (<a path outside the project>)'],
    ['a parenthesis pair inside a folder name stays in the path', 'open C:\\Games (old)\\a.json failed', 'open <a path outside the project> failed'],
  ])('%s', (_title, input, expected) => {
    expect(withoutAbsolutePaths(input, PROJECT)).toBe(expected);
  });
});

describe('errorReason', () => {
  it('names an fs error by its code and the file in the project', () => {
    const error = Object.assign(new Error(`EPERM: operation not permitted, open 'C:\\Games\\My Game\\a.json'`), { code: 'EPERM', path: 'C:\\Games\\My Game\\a.json' });
    expect(errorReason(error, { projectDir: PROJECT, relative: p => p.replace(`${PROJECT}\\`, '').replace(/\\/g, '/') })).toBe('EPERM on a.json');
  });
  it('keeps a relative path of an fs error as it is and shows an absolute one outside the project as a placeholder', () => {
    const relative = Object.assign(new Error('EACCES'), { code: 'EACCES', path: 'layouts/A.json' });
    expect(errorReason(relative, { projectDir: PROJECT })).toBe('EACCES on layouts/A.json');
    const outside = Object.assign(new Error('EACCES'), { code: 'EACCES', path: 'D:\\Other\\a.json' });
    expect(errorReason(outside, { projectDir: PROJECT })).toBe('EACCES on <a path outside the project>');
  });
  it('strips the path from an error that has a code and no path', () => {
    const error = Object.assign(new Error(`Failed to read layout "X": ENOENT: no such file, open 'C:\\Users\\First Last\\x.json'.`), { code: 'ENOENT' });
    expect(errorReason(error, { projectDir: PROJECT })).toBe(`Failed to read layout "X": ENOENT: no such file, open '<a path outside the project>'`);
  });
});

describe('withoutAbsolutePaths, other forms of the project folder', () => {
  it('words the project folder in both slash forms and keeps the ending', () => {
    const backslash = 'C:\\Users\\x\\Proj';
    const forward = 'C:/Users/x/Proj';
    const message = `Could not read ${backslash}\\layouts\\a.json and ${forward}/layouts/b.json under ${backslash}.`;
    expect(withoutAbsolutePaths(message, backslash)).toBe('Could not read layouts/a.json and layouts/b.json under ..');
    expect(withoutAbsolutePaths(message, forward)).not.toContain('Users');
    expect(withoutAbsolutePaths('The file is as before the call.', backslash)).toBe('The file is as before the call.');
    expect(withoutAbsolutePaths('Stopped. Nothing was changed.', backslash)).toBe('Stopped. Nothing was changed.');
  });

  it('takes a project folder with a trailing separator, and a drive letter in either case', () => {
    expect(withoutAbsolutePaths('In c:\\Users\\x\\Proj\\a.json', 'C:\\Users\\x\\Proj\\')).toBe('In a.json');
  });

  it('shows every path as outside when no project folder is given', () => {
    expect(withoutAbsolutePaths('In C:\\p\\a.json', undefined)).toBe('In <a path outside the project>');
    expect(withoutAbsolutePaths('a/b', '')).toBe('a/b');
  });
});

describe('errorReason, text of other errors', () => {
  it('drops only the final full stop and takes the paths out', () => {
    expect(errorReason(new Error('Bad. Worse.'), { projectDir: 'C:\\p' })).toBe('Bad. Worse');
    expect(errorReason(new Error('No full stop'), { projectDir: 'C:\\p' })).toBe('No full stop');
    expect(errorReason(new Error('In C:\\p\\a.json.'), { projectDir: 'C:\\p' })).toBe('In a.json');
    expect(errorReason('plain text', {})).toBe('plain text');
  });
});

describe('withoutAbsolutePaths, where a path ends', () => {
  it('ends the project folder before the words after it', () => {
    expect(withoutAbsolutePaths('Folder C:\\Games\\My Game is read-only', PROJECT)).toBe('Folder . is read-only');
    expect(withoutAbsolutePaths('boom at C:\\Games\\My Game and D:\\b\\y.json', PROJECT)).toBe('boom at . and <a path outside the project>');
  });

  it('ends an unquoted path before a drive path that follows it', () => {
    expect(withoutAbsolutePaths('copy C:\\a\\tmp D:\\b\\y.json', PROJECT)).toBe('copy <a path outside the project> <a path outside the project>');
  });

  it('ends an unquoted path at a semicolon, so a URL after it is kept', () => {
    expect(withoutAbsolutePaths('cannot read C:\\a b\\y.json; see https://example.com/help', PROJECT)).toBe('cannot read <a path outside the project>; see https://example.com/help');
  });

  it('ends an unquoted path before a comma and keeps what follows', () => {
    expect(withoutAbsolutePaths('cannot read C:\\a b\\y.json, then stop', PROJECT)).toBe('cannot read <a path outside the project>, then stop');
  });

  it('ends a path at the line end and keeps the next line', () => {
    expect(withoutAbsolutePaths('cannot read C:\\a\\y.json.\nNext line.', PROJECT)).toBe('cannot read <a path outside the project>.\nNext line.');
  });

  it('keeps the "." a project folder becomes at the end of the text, and drops only the full stop after it', () => {
    expect(errorReason(new Error(`Cannot read ${PROJECT}`), { projectDir: PROJECT })).toBe('Cannot read .');
    expect(errorReason(new Error(`Cannot read ${PROJECT}.`), { projectDir: PROJECT })).toBe('Cannot read .');
  });

  it('ends a quoted path at its closing quote, even when it holds a comma', () => {
    expect(withoutAbsolutePaths("open 'C:\\a, b\\y.json' failed", PROJECT)).toBe("open '<a path outside the project>' failed");
  });

  it('ends an unquoted POSIX path at a bracket', () => {
    expect(withoutAbsolutePaths('(see /home/u/a.json)', PROJECT)).toBe('(see <a path outside the project>)');
  });
});

describe('errorMessage', () => {
  it('is the message of an error or the text of any other value, with its final full stop and without absolute paths', () => {
    expect(errorMessage(new Error(`Cannot read ${PROJECT}\\a.json.`), PROJECT)).toBe('Cannot read a.json.');
    expect(errorMessage('plain text.', PROJECT)).toBe('plain text.');
    expect(errorMessage(new Error('Cannot read D:\\x\\a.json'))).toBe('Cannot read <a path outside the project>');
  });
});
