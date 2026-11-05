import { describe, expect, it } from 'vitest';
import { nothingChanged, refuse, stoppedBeforeWrite } from '../../src/tools/refusals.js';

const PROJECT = 'C:\\G';

describe('stoppedBeforeWrite', () => {
  it('ends with one closing sentence when the error already says nothing was written', () => {
    expect(stoppedBeforeWrite(new Error('Layout "A" changed on disk. Nothing was written'), PROJECT))
      .toBe('The change was stopped before anything was written: Layout "A" changed on disk. Nothing was changed.');
    expect(stoppedBeforeWrite(new Error('Layout "A" changed on disk. Nothing was written.'), PROJECT))
      .toBe('The change was stopped before anything was written: Layout "A" changed on disk. Nothing was changed.');
  });

  it('puts the full stop after a closing quote and keeps the one a message has', () => {
    expect(stoppedBeforeWrite(new Error('Layout "A" is gone'), PROJECT))
      .toBe('The change was stopped before anything was written: Layout "A" is gone. Nothing was changed.');
    expect(stoppedBeforeWrite(new Error('Layout "A"'), PROJECT))
      .toBe('The change was stopped before anything was written: Layout "A". Nothing was changed.');
    expect(stoppedBeforeWrite(new Error('Layout is gone.'), PROJECT))
      .toBe('The change was stopped before anything was written: Layout is gone. Nothing was changed.');
  });

  it('adds no full stop after a question mark or an exclamation mark', () => {
    expect(stoppedBeforeWrite(new Error('Is layout "A" open in the editor?'), PROJECT))
      .toBe('The change was stopped before anything was written: Is layout "A" open in the editor? Nothing was changed.');
    expect(stoppedBeforeWrite(new Error('Stop!'), PROJECT))
      .toBe('The change was stopped before anything was written: Stop! Nothing was changed.');
  });

  it('shows no absolute path, and words an fs error from its code and path', () => {
    expect(stoppedBeforeWrite(new Error('Cannot read C:\\G\\layouts\\A.json and D:\\Other\\b.json'), PROJECT))
      .toBe('The change was stopped before anything was written: Cannot read layouts/A.json and <a path outside the project>. Nothing was changed.');
    const fsError = Object.assign(new Error("EACCES: permission denied, open 'C:\\G\\layouts\\A.json'"), { code: 'EACCES', path: 'C:\\G\\layouts\\A.json' });
    expect(stoppedBeforeWrite(fsError, PROJECT))
      .toBe('The change was stopped before anything was written: EACCES on layouts/A.json. Nothing was changed.');
  });

  it('keeps one full stop before the ending when the message has one after a path', () => {
    const message = stoppedBeforeWrite(new Error('Cannot read C:\\p\\a.json: EACCES.'), 'C:\\p');
    expect(message).toBe('The change was stopped before anything was written: Cannot read a.json: EACCES. Nothing was changed.');
    expect(message).not.toContain('..');
  });

  it('shows a path outside the project as a placeholder when no project folder is given', () => {
    expect(stoppedBeforeWrite(new Error('Cannot read C:\\G\\a.json'))).toBe(
      'The change was stopped before anything was written: Cannot read <a path outside the project>. Nothing was changed.');
  });
});

describe('nothingChanged and refuse', () => {
  it('ends a message with "Nothing was changed." exactly once', () => {
    expect(nothingChanged('Layout "A" not found')).toBe('Layout "A" not found. Nothing was changed.');
    expect(nothingChanged('Layout "A" not found?')).toBe('Layout "A" not found? Nothing was changed.');
    expect(nothingChanged('Is the layout there?')).toBe('Is the layout there? Nothing was changed.');
    expect(nothingChanged('Nothing was changed.')).toBe('Nothing was changed.');
    expect(nothingChanged('Layout "A" not found. Nothing was changed.')).toBe('Layout "A" not found. Nothing was changed.');
    expect(nothingChanged('Layout "A" not found. Nothing was changed.  ')).toBe('Layout "A" not found. Nothing was changed.');
    expect(nothingChanged('')).toBe('Nothing was changed.');
  });

  it('refuse ends the message once with "Nothing was changed."', () => {
    for (const text of ['No timeline.', 'No timeline. Nothing was changed.', 'No timeline']) {
      const result = refuse(text);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('No timeline. Nothing was changed.');
    }
  });

  it('returns the message as a tool error', () => {
    expect(refuse('Layout "A" not found')).toEqual({
      content: [{ type: 'text', text: 'Layout "A" not found. Nothing was changed.' }],
      isError: true,
    });
  });
});
