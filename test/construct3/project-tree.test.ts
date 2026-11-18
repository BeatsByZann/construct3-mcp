/**
 * Project Bar tree helpers on synthetic trees: where a name is registered,
 * folder lookup and creation, the names Windows can store, the names of a
 * tree, and registering a name beside another.
 */

import { describe, it, expect } from 'vitest';
import {
  allTreeNames, describeFolder, ensureTreeFolder, fileNameProblem, findTreeFolder,
  folderSegmentsProblem, locateInTree, registerAfterInTree, type TreeFolder,
} from '../../src/construct3/project-tree.js';

function sampleTree(): TreeFolder {
  return {
    items: ['Root A'],
    subfolders: [
      { items: ['Actor', 'Other'], subfolders: [{ items: ['Deep', 'Actor'], subfolders: [], name: 'Inner' }], name: 'Actors' },
      { items: ['Ease'], subfolders: [] } as TreeFolder,
    ],
  };
}

describe('locateInTree', () => {
  it('finds every place a name is registered with its folder path and skips unnamed subfolders', () => {
    const root = sampleTree();
    const found = locateInTree(root, 'Actor');
    expect(found.map(l => [l.path, l.index])).toEqual([['Actors', 0], ['Actors/Inner', 1]]);
    expect(found[0].folder).toBe(root.subfolders[0]);
    expect(locateInTree(root, 'Ease')).toEqual([]);
    expect(locateInTree(root, 'Root A').map(l => l.path)).toEqual(['']);
  });

  it('finds the name of a file item', () => {
    const root: TreeFolder = { items: [{ name: 'data.json' }], subfolders: [] };
    expect(locateInTree(root, 'data.json')).toHaveLength(1);
  });
});

describe('findTreeFolder', () => {
  it('matches segments exactly: a case variant is not found', () => {
    const root = sampleTree();
    expect(findTreeFolder(root, 'Actors/Inner')).toBe(root.subfolders[0].subfolders[0]);
    expect(findTreeFolder(root, 'actors')).toBeUndefined();
    expect(findTreeFolder(root, 'Actors/inner')).toBeUndefined();
    expect(findTreeFolder(root, '')).toBe(root);
  });

  it('does not take an entry that is not a folder for one, and ensureTreeFolder creates the folder beside it', () => {
    const wanted: TreeFolder = { items: [], subfolders: [], name: 'A' };
    const malformed: TreeFolder = {
      items: [],
      subfolders: [null as unknown as TreeFolder, { name: 'B' } as unknown as TreeFolder, wanted],
    };
    expect(findTreeFolder(malformed, 'A')).toBe(wanted);
    expect(findTreeFolder(malformed, 'B')).toBeUndefined();
    const ensured = ensureTreeFolder(malformed, 'B');
    expect(ensured.created).toEqual(['B']);
    expect(ensured.folder.name).toBe('B');
  });
});

/** A tree nested `levels` folders deep; the folder at depth i holds the item `item<i>`. */
function nestedTree(levels: number): TreeFolder {
  const root: TreeFolder = { items: ['item0'], subfolders: [] };
  let current = root;
  for (let i = 1; i <= levels; i++) {
    const next: TreeFolder = { items: [`item${i}`], subfolders: [], name: `f${i}` };
    current.subfolders.push(next);
    current = next;
  }
  return root;
}

describe('tree depth', () => {
  it('locateInTree reads 64 levels of folders and stops there', () => {
    const root = nestedTree(70);
    expect(locateInTree(root, 'item64')).toHaveLength(1);
    expect(locateInTree(root, 'item65')).toEqual([]);
  });

  it('allTreeNames reads 64 levels of folders and stops there', () => {
    const names = allTreeNames(nestedTree(70), false);
    expect(names).toContain('item64');
    expect(names).not.toContain('item65');
  });
});

describe('ensureTreeFolder', () => {
  it('creates missing folders with the key order of Construct and appends them after their siblings, reporting the created paths', () => {
    const root = sampleTree();
    const { folder, created } = ensureTreeFolder(root, 'Actors/New/Deeper');
    expect(created).toEqual(['Actors/New', 'Actors/New/Deeper']);
    expect(Object.keys(folder)).toEqual(['items', 'subfolders', 'name']);
    const actors = root.subfolders[0];
    expect(actors.subfolders.map(f => f.name)).toEqual(['Inner', 'New']);
    expect(ensureTreeFolder(root, 'Actors/New/Deeper').created).toEqual([]);
    expect(ensureTreeFolder(root, '').folder).toBe(root);
  });
});

describe('folderSegmentsProblem', () => {
  it('accepts an ordinary path', () => {
    expect(folderSegmentsProblem('Actors/Inner folder')).toBeUndefined();
  });

  it.each([
    ['Windows-forbidden characters', 'Bad:name', 'contains a character Windows does not allow'],
    ['a control character', 'Bad\u0001name', 'contains a character Windows does not allow'],
    ['a trailing space', 'Name ', 'must not start with a space or end with a space or a dot'],
    ['a trailing dot', 'Name.', 'must not start with a space or end with a space or a dot'],
    ['a leading space', ' Name', 'must not start with a space or end with a space or a dot'],
    ['a reserved name', 'CON', 'is reserved on Windows'],
    ['a reserved name with an extension', 'lpt1.txt', 'is reserved on Windows'],
    ['an over-long segment', 'a'.repeat(256), 'is too long'],
    ['dot-dot', 'A/../B', 'invalid characters'],
    ['a backslash', 'A\\B', 'invalid characters'],
    ['a leading slash', '/A', 'invalid characters'],
    ['an empty segment', 'A//B', 'invalid segments'],
    ['a dot segment', 'A/./B', 'invalid segments'],
  ])('names the problem of %s', (_label, path, text) => {
    expect(folderSegmentsProblem(path)).toContain(text);
  });
});

describe('fileNameProblem', () => {
  it('accepts an ordinary name', () => {
    expect(fileNameProblem('data.json')).toBeUndefined();
  });

  it.each([
    ['empty', '', 'cannot be empty'],
    ['over-long', 'a'.repeat(256), 'too long'],
    ['a dot', '.', 'single path segment'],
    ['dot-dot', '..', 'single path segment'],
    ['a forward slash', 'a/b', 'single path segment'],
    ['a backslash', 'a\\b', 'single path segment'],
  ])('refuses a name that is %s', (_label, name, text) => {
    expect(fileNameProblem(name)).toContain(text);
  });
});

describe('allTreeNames', () => {
  it('lists item names, file items by their name, and skips unnamed folders unless asked', () => {
    expect(allTreeNames(sampleTree(), false)).toEqual(['Root A', 'Actor', 'Other', 'Deep', 'Actor']);
    expect(allTreeNames(sampleTree(), true)).toEqual(['Root A', 'Actor', 'Other', 'Deep', 'Actor', 'Ease']);
    const files: TreeFolder = { items: [{ name: 'a.txt' }, { name: 'b.txt' }], subfolders: [] };
    expect(allTreeNames(files, false)).toEqual(['a.txt', 'b.txt']);
  });

  it('skips a subfolder entry that is not a folder', () => {
    const malformed: TreeFolder = { items: ['A'], subfolders: [null as unknown as TreeFolder, { name: 'B' } as unknown as TreeFolder] };
    expect(allTreeNames(malformed, true)).toEqual(['A']);
    expect(locateInTree(malformed, 'A')).toHaveLength(1);
  });
});

describe('registerAfterInTree', () => {
  it('puts the new name directly after the source in the source folder', () => {
    const root = sampleTree();
    registerAfterInTree(root, 'Other', 'Copy');
    expect(root.subfolders[0].items).toEqual(['Actor', 'Other', 'Copy']);
    registerAfterInTree(root, 'Actor', 'Mid');
    expect(root.subfolders[0].items).toEqual(['Actor', 'Mid', 'Other', 'Copy']);
  });

  it('throws when the source is not registered', () => {
    expect(() => registerAfterInTree(sampleTree(), 'Gone', 'Copy')).toThrow('"Gone" is no longer registered in project.c3proj');
  });
});

describe('describeFolder', () => {
  it('quotes a path and names the root', () => {
    expect(describeFolder('A/B')).toBe('"A/B"');
    expect(describeFolder('')).toBe('the root');
  });
});
