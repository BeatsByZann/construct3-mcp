/** The bare names of C3 expressions and their rename, on synthetic expressions. */

import { describe, it, expect } from 'vitest';
import { expressionIdentifierSpans, findExpressionIdentifiers, renameExpressionIdentifier } from '../../src/construct3/event-shapes.js';
import { isEventVariableNameCharacter } from '../../src/construct3/event-variable-names.js';

describe('expressionIdentifierSpans', () => {
  it.each([
    ['Score * 2', [[0, 5]]],
    ['max(Score, 1) + Sprite.Score + Score.x + "Score" & score', [[4, 9], [51, 56]]],
    ['a"b""c"d', [[0, 1], [7, 8]]],
    ['x1 + 2y + _z', [[0, 2], [10, 12]]],
    ['"open', []],
  ] as const)('gives the positions of the bare names of %s', (expr, spans) => {
    expect(expressionIdentifierSpans(expr).map(({ start, end }) => [start, end])).toEqual(spans);
  });

  it.each([
    ['Größe * 2', [[0, 5]]],
    ['scoreé + score', [[0, 6], [9, 14]]],
    ['a。b', [[0, 1], [2, 3]]],
  ] as const)('reads names with the characters an event variable name may hold: %s', (expr, spans) => {
    expect(expressionIdentifierSpans(expr).map(({ start, end }) => [start, end])).toEqual(spans);
  });

  it('findExpressionIdentifiers returns the names of those positions, lower-cased', () => {
    expect(findExpressionIdentifiers('max(Score, 1) + Größe & scoreé')).toEqual(['score', 'größe', 'scoreé']);
  });
});

describe('isEventVariableNameCharacter', () => {
  it('accepts the characters a name may hold and refuses whitespace, punctuation and control characters', () => {
    expect(['a', 'Z', '0', '_', 'ö', 'ß', '．'].every(isEventVariableNameCharacter)).toBe(true);
    expect([' ', ' ', '.', '-', '`', '$', '{', '。', '（', '“', '\u0001', '\u007F'].some(isEventVariableNameCharacter)).toBe(false);
  });
});

describe('renameExpressionIdentifier', () => {
  it.each([
    ['Score * 2', 'Points * 2', 1],
    ['score + SCORE', 'Points + Points', 2],
    ['max(Score, 1)', 'max(Points, 1)', 1],
    ['Sprite.Score + Score.X + Score(1)', 'Sprite.Score + Score.X + Score(1)', 0],
    ['"Score" & Score', '"Score" & Points', 1],
    ['Scores + aScore + Score2', 'Scores + aScore + Score2', 0],
    ['Score . X', 'Score . X', 0],
    ['scoreé + score', 'scoreé + Points', 1],
    ['Sprite. Score + Score', 'Sprite. Score + Points', 1],
    ['Score .X + Score', 'Score .X + Points', 1],
  ])('%s', (expr, renamed, count) => {
    expect(renameExpressionIdentifier(expr, 'Score', 'Points')).toEqual({ text: renamed, count });
  });
});
