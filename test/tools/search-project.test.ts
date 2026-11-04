/**
 * search_project and its matchers, on a temp copy of the minimal fixture with
 * the real reader. The clock and the limits are the ones SEARCH_LIMITS holds;
 * tests that change them restore them after.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import {
  registerUsageTools,
  SEARCH_LIMITS,
  SearchTimeout,
  newBudget,
  literalMatcher,
  regexMatcher,
  type Matcher,
} from '../../src/tools/usage-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const ORIGINAL_LIMITS = { ...SEARCH_LIMITS };

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;
let nextSid = 900000000000000;

/** The folder of a project's script registry, as the tests edit it. */
interface ScriptFolder { items: unknown[]; subfolders: Array<ScriptFolder & { name: string }> }

/** The parts of project.c3proj the tests edit. */
interface ProjectEdit {
  eventSheets: { items: string[] };
  layouts: { items: string[] };
  rootFileFolders: { script: ScriptFolder };
}

/** The result of search_project, as the tests read it. */
interface SearchResult {
  query: string;
  totalHits: number;
  returned: number;
  truncated: boolean;
  totalHitsIsLowerBound?: boolean;
  hits: Array<{ where: string; file: string; eventSid?: number; path: string; field: string; text: string }>;
  complete: boolean;
  unscannedFiles?: Array<{ file: string; reason: string; textSearch: string; names?: string[] }>;
  unreadableScripts?: string[];
  scriptsNotWalked?: string[];
}

async function editProject(change: (project: ProjectEdit) => void): Promise<void> {
  const path = join(tmpDir, 'project.c3proj');
  const project = JSON.parse(await readFile(path, 'utf-8')) as ProjectEdit;
  change(project);
  await writeFile(path, JSON.stringify(project, null, '\t'));
}

async function addSheet(name: string, events: unknown[]): Promise<void> {
  await editProject(project => { project.eventSheets.items.push(name); });
  await writeFile(join(tmpDir, 'eventSheets', `${name}.json`), JSON.stringify({ name, events, sid: nextSid++ }, null, '\t'));
}

const comment = (text: string) => ({ eventType: 'comment', text });

async function addScript(path: string, content: string | undefined): Promise<void> {
  const parts = path.split('/');
  await editProject(project => {
    let folder = project.rootFileFolders.script;
    for (const part of parts.slice(0, -1)) {
      let sub = folder.subfolders.find(s => s.name === part);
      if (!sub) {
        sub = { name: part, items: [], subfolders: [] };
        folder.subfolders.push(sub);
      }
      folder = sub;
    }
    folder.items.push({ name: parts[parts.length - 1], type: 'external-script-module', sid: nextSid++ });
  });
  if (content !== undefined) {
    const file = join(tmpDir, 'scripts', ...parts);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

const instance = (uid: number, type: string, extra: Record<string, unknown>) => ({
  type, uid, sid: nextSid++, properties: {}, instanceVariables: {}, behaviors: {},
  world: { x: 0, y: 0, width: 64, height: 64 }, ...extra,
});

async function addLayout(name: string, instances: unknown[]): Promise<void> {
  await editProject(project => { project.layouts.items.push(name); });
  await writeFile(join(tmpDir, 'layouts', `${name}.json`), JSON.stringify({
    name,
    layers: [{ name: 'Main', sid: nextSid++, instances, subLayers: [], isInitiallyVisible: true }],
    'nonworld-instances': [],
    sid: nextSid++,
    eventSheet: '',
    width: 1920,
    height: 1080,
  }, null, '\t'));
}

async function startServer(): Promise<void> {
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  server = new MockServer();
  registerUsageTools(server as never, reader);
  resetProjectIndex(reader);
}

async function raw(args: Record<string, unknown>) {
  return server.callTool('search_project', args);
}

async function search(args: Record<string, unknown>): Promise<SearchResult> {
  const result = await raw(args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text) as SearchResult;
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-search-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  Object.assign(SEARCH_LIMITS, ORIGINAL_LIMITS);
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('search_project', () => {
  it('finds text in event sheets, scripts and layout instances, with the place of each hit', async () => {
    await addSheet('Needles', [
      comment('a needle in a comment'),
      { eventType: 'group', title: 'needle group', description: '', isActiveOnStart: true, children: [], sid: nextSid++ },
      { eventType: 'variable', name: 'needleVar', type: 'number', initialValue: '0', isStatic: false, isConstant: false, sid: nextSid++ },
      { eventType: 'script', language: 'javascript', script: ['let a = 1;', 'let needle = 2;'], sid: nextSid++ },
      {
        eventType: 'block',
        conditions: [],
        actions: [{ id: 'set-text', objectClass: 'Sprite', sid: nextSid++, parameters: { text: '"needle text"' } }],
        sid: nextSid++,
      },
    ]);
    await addScript('lib/util.js', 'one\ntwo needle\r\nthree');
    await addLayout('Layout 2', [
      instance(41, 'Sprite', { properties: { 'initial-text': 'needle prop' }, instanceVariables: { score: 'needle var' }, tags: 'needle tag' }),
    ]);
    await startServer();

    const events = await search({ query: 'needle' });
    const byField = events.hits.map((h: { file: string; field: string; path: string; where: string }) => `${h.where}|${h.file}|${h.field}|${h.path}`);
    expect(byField).toContain('event-sheet|eventSheets/Needles.json|text|events[0].text');
    expect(byField).toContain('event-sheet|eventSheets/Needles.json|title|events[1].title');
    expect(byField).toContain('event-sheet|eventSheets/Needles.json|name|events[2].name');
    expect(byField).toContain('event-sheet|eventSheets/Needles.json|script|events[3].script[1]');
    expect(byField).toContain('event-sheet|eventSheets/Needles.json|text|events[4].actions[0].parameters.text');
    expect(byField).toContain('script|scripts/lib/util.js|code|line 2');
    expect(events.hits.every((h: { where: string }) => h.where !== 'layout')).toBe(true);
    const comment0 = events.hits.find((h: { path: string }) => h.path === 'events[0].text');
    expect(comment0?.text).toBe('a needle in a comment');
    expect(typeof events.hits.find((h: { path: string }) => h.path === 'events[4].actions[0].parameters.text')?.eventSid).toBe('number');
    expect(events.totalHits).toBe(events.hits.length);
    expect(events.returned).toBe(events.hits.length);
    expect(events.truncated).toBe(false);
    expect(events.complete).toBe(true);
    expect(events).not.toHaveProperty('success');
    expect(events).not.toHaveProperty('editorNote');

    const layouts = await search({ query: 'needle', scopes: ['layouts'] });
    expect(layouts.hits.map((h: { file: string; path: string; field: string }) => `${h.file}|${h.field}|${h.path}`).sort()).toEqual([
      'layouts/Layout 2.json|initial-text|instance uid 41 (Sprite) properties.initial-text',
      'layouts/Layout 2.json|score|instance uid 41 (Sprite) instanceVariables.score',
      'layouts/Layout 2.json|tags|instance uid 41 (Sprite) tags',
    ]);
  });

  it('honours caseSensitive, wholeWord, regex, sheets and maxResults', async () => {
    await addSheet('One', [comment('Needle needles NEEDLE'), comment('needle')]);
    await addSheet('Two', [comment('needle two')]);
    await startServer();

    const insensitive = await search({ query: 'needle', scopes: ['events'] });
    expect(insensitive.totalHits).toBe(5);
    expect((await search({ query: 'needle', caseSensitive: true, scopes: ['events'] })).totalHits).toBe(3);
    expect((await search({ query: 'needle', wholeWord: true, scopes: ['events'] })).totalHits).toBe(4);
    expect((await search({ query: 'n[e]+dle', regex: true, scopes: ['events'] })).totalHits).toBe(5);
    const onlyTwo = await search({ query: 'needle', sheets: ['two'], scopes: ['events'] });
    expect(onlyTwo.hits.map((h: { file: string }) => h.file)).toEqual(['eventSheets/Two.json']);

    const limited = await search({ query: 'needle', maxResults: 2, scopes: ['events'] });
    expect(limited).toMatchObject({ totalHits: 5, returned: 2, truncated: true });
    expect(limited.hits).toHaveLength(2);
    expect(limited).not.toHaveProperty('totalHitsIsLowerBound');

    const refused = await raw({ query: 'needle', sheets: ['Nope'] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Event sheet "Nope" not found.');
    expect(refused.content[0].text.endsWith(' Nothing was returned.')).toBe(true);
  });

  it('shows a hit with up to 60 characters on each side, marking the cut with "..."', async () => {
    await addSheet('Long', [comment(`${'x'.repeat(100)}needle${'y'.repeat(100)}`)]);
    await startServer();
    const result = await search({ query: 'needle', scopes: ['events'], sheets: ['Long'] });
    expect(result.hits.map(h => h.text)).toEqual([`...${'x'.repeat(60)}needle${'y'.repeat(60)}...`]);
  });

  it('accepts maxResults from 1 to 1000 and refuses others', async () => {
    await startServer();
    await expect(raw({ query: 'a', maxResults: 0 })).rejects.toThrow();
    await expect(raw({ query: 'a', maxResults: 1001 })).rejects.toThrow();
    expect((await raw({ query: 'a', maxResults: 1000 })).isError).toBeUndefined();
    expect((await raw({ query: 'a', maxResults: 1 })).isError).toBeUndefined();
  });

  it('matches a literal query with regular expression characters literally', async () => {
    await addSheet('Chars', [comment('call a.b( now'), comment('axb(')]);
    await startServer();
    const result = await search({ query: 'a.b(', scopes: ['events'] });
    expect(result.hits.map((h: { text: string }) => h.text)).toEqual(['call a.b( now']);
  });

  it('refuses an invalid regular expression', async () => {
    await startServer();
    const result = await raw({ query: '(', regex: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid regular expression');
    expect(result.content[0].text.startsWith('Invalid regular expression: ')).toBe(true);
    expect(result.content[0].text).not.toContain('Invalid regular expression: Invalid regular expression');
    expect(result.content[0].text.endsWith(' Nothing was returned.')).toBe(true);
  });

  it('ends a catastrophic regular expression in time and says which file it was in', async () => {
    await addSheet('Slow', [comment(`${'a'.repeat(28)}b`)]);
    await startServer();
    SEARCH_LIMITS.perCallMs = 50;
    const started = performance.now();
    const result = await raw({ query: '(a+)+$', regex: true, scopes: ['events'] });
    const elapsed = performance.now() - started;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('The regular expression took too long to run in eventSheets/');
    expect(result.content[0].text.endsWith(' Nothing was returned.')).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it('names the time budget, not the expression, when the whole search runs out', async () => {
    await addSheet('Plain', [comment('a')]);
    await startServer();
    SEARCH_LIMITS.now = () => 0;
    SEARCH_LIMITS.budgetMs = 0;
    const result = await raw({ query: 'a', regex: true, scopes: ['events'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('The search ran past its time budget');
    expect(result.content[0].text).not.toContain('regular expression');
    expect(result.content[0].text.endsWith(' Nothing was returned.')).toBe(true);
  });

  it('searches a literal query without vm', async () => {
    await addSheet('Big', Array.from({ length: 20_000 }, (_, i) => comment(`line ${i} needle`)));
    await startServer();
    SEARCH_LIMITS.perCallMs = 1;
    SEARCH_LIMITS.budgetMs = 60_000;
    const result = await search({ query: 'needle', scopes: ['events'], maxResults: 5 });
    expect(result.totalHits).toBe(20_000);
    expect(result.returned).toBe(5);
  });

  it('returns a reader failure as an error that ends "Nothing was returned."', async () => {
    await startServer();
    vi.spyOn(reader, 'readAllEventSheets').mockRejectedValue(new Error('sheets gone'));
    const result = await raw({ query: 'a' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error searching the project: sheets gone. Nothing was returned.');
  });

  it('counts every value of a file once against the node limit', async () => {
    await addSheet('One', [comment('needle')]);
    await startServer();
    // The events array, the comment, and its two strings: four values.
    SEARCH_LIMITS.maxNodes = 4;
    expect((await search({ query: 'needle', scopes: ['events'], sheets: ['One'] })).totalHits).toBe(1);
    SEARCH_LIMITS.maxNodes = 3;
    const refused = await raw({ query: 'needle', scopes: ['events'], sheets: ['One'] });
    expect(refused.content[0].text).toBe('The search exceeded the node limit. Nothing was returned.');
  });

  it('refuses a sheet with more nodes than the limit', async () => {
    await addSheet('Many', [comment('a'), comment('b'), comment('c')]);
    await startServer();
    SEARCH_LIMITS.maxNodes = 5;
    const result = await raw({ query: 'a', scopes: ['events'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('The search exceeded the node limit. Nothing was returned.');
  });

  describe('files that could not be read', () => {
    it('reports an unparsable sheet with the outcome of the text search, and still returns other hits', async () => {
      await addSheet('Good', [comment('needle here')]);
      await addSheet('Holds', [comment('x')]);
      await addSheet('Empty', [comment('x')]);
      await writeFile(join(tmpDir, 'eventSheets', 'Holds.json'), '{ broken needle');
      await writeFile(join(tmpDir, 'eventSheets', 'Empty.json'), '{ broken');
      await startServer();

      const whole = await search({ query: 'needle', wholeWord: true, scopes: ['events'] });
      expect(whole.complete).toBe(false);
      expect(whole.hits.map((h: { file: string }) => h.file)).toEqual(['eventSheets/Good.json']);
      expect(whole.unscannedFiles).toEqual([
        expect.objectContaining({ file: 'eventSheets/Holds', reason: 'not valid JSON', textSearch: 'possible-use' }),
        expect.objectContaining({ file: 'eventSheets/Empty', reason: 'not valid JSON', textSearch: 'no-match' }),
      ]);

      for (const args of [{ query: 'needle' }, { query: 'needle', regex: true, wholeWord: true }, { query: '(needle', wholeWord: true }, { query: 'needle)', wholeWord: true }, { query: 'a needle', wholeWord: true, regex: false }]) {
        const result = await search({ ...args, scopes: ['events'] });
        const outcomes = (result.unscannedFiles ?? []).map(u => `${u.file}|${u.textSearch}`);
        const expected = args.query === 'a needle' ? ['eventSheets/Holds|no-match', 'eventSheets/Empty|no-match'] : ['eventSheets/Holds|not-searched', 'eventSheets/Empty|not-searched'];
        expect(outcomes, JSON.stringify(args)).toEqual(expected);
      }

      const named = await search({ query: 'needle', sheets: ['holds'], wholeWord: true, scopes: ['events'] });
      expect(named.complete).toBe(false);
      expect(named.hits).toEqual([]);
      expect(named.unscannedFiles).toEqual([expect.objectContaining({ file: 'eventSheets/Holds', textSearch: 'possible-use' })]);
    });

    it('searches an unparsable sheet as text for a whole-word query that starts and ends with a non-ASCII letter', async () => {
      await addSheet('Umlaut', [comment('x')]);
      await writeFile(join(tmpDir, 'eventSheets', 'Umlaut.json'), '{ broken Ärger');
      await startServer();
      const result = await search({ query: 'Ärger', wholeWord: true, scopes: ['events'] });
      expect(result.unscannedFiles).toEqual([expect.objectContaining({ file: 'eventSheets/Umlaut', textSearch: 'possible-use' })]);
      const none = await search({ query: 'Ärgerx', wholeWord: true, scopes: ['events'] });
      expect(none.unscannedFiles).toEqual([expect.objectContaining({ file: 'eventSheets/Umlaut', textSearch: 'no-match' })]);
    });

    it('finds a whole word that starts or ends with a non-ASCII letter in parsed files', async () => {
      await addSheet('Words', [comment('kein Ärger hier'), comment('le café noir'), comment('der Ärgerliche'), comment('cafés open'), comment('naïve')]);
      await startServer();
      const start = await search({ query: 'Ärger', wholeWord: true, scopes: ['events'] });
      expect(start.totalHits).toBe(1);
      expect(start.hits.map(h => h.text)).toEqual([expect.stringContaining('kein')]);
      const end = await search({ query: 'café', wholeWord: true, scopes: ['events'] });
      expect(end.totalHits).toBe(1);
      expect(end.hits.map(h => h.text)).toEqual([expect.stringContaining('noir')]);
      const inside = await search({ query: 'naïve', wholeWord: true, scopes: ['events'] });
      expect(inside.totalHits).toBe(1);
      const caseless = await search({ query: 'äRGER', wholeWord: true, scopes: ['events'] });
      expect(caseless.totalHits).toBe(1);
    });

    it('keeps ASCII word boundaries for a regular expression with wholeWord', async () => {
      await addSheet('Plain', [comment('a needle here'), comment('needles')]);
      await startServer();
      const result = await search({ query: 'needle', regex: true, wholeWord: true, scopes: ['events'] });
      expect(result.totalHits).toBe(1);
    });

    it('reports an unparsable layout, still returns the other layouts\' hits and is not complete', async () => {
      await addLayout('Good', [instance(51, 'Sprite', { tags: 'needle tag' })]);
      await addLayout('Bad', [instance(52, 'Sprite', { tags: 'needle tag' })]);
      await writeFile(join(tmpDir, 'layouts', 'Bad.json'), '{ broken');
      await startServer();
      const result = await search({ query: 'needle', scopes: ['layouts'] });
      expect(result.complete).toBe(false);
      expect(result.hits.map(h => h.file)).toEqual(['layouts/Good.json']);
      expect(result.unscannedFiles).toEqual([expect.objectContaining({ file: 'layouts/Bad', reason: 'not valid JSON', textSearch: 'not-searched' })]);
      const eventsOnly = await search({ query: 'needle', scopes: ['events'] });
      expect(eventsOnly.complete).toBe(true);
    });

    it('names an unreadable registered script and a script below the walk depth, and is not complete', async () => {
      await addScript('gone.js', undefined);
      await addScript('here.js', 'a needle');
      const deep = `${'d/'.repeat(52)}deep.js`;
      await addScript(deep, 'a needle too');
      await startServer();

      const result = await search({ query: 'needle', scopes: ['scripts'] });
      expect(result.complete).toBe(false);
      expect(result.unreadableScripts).toEqual(['scripts/gone.js']);
      expect(result.scriptsNotWalked).toEqual([`scripts/${'d/'.repeat(51)}`]);
      expect(result.hits.map((h: { file: string }) => h.file)).toEqual(['scripts/here.js']);
    });
  });

  it('reports capped strings and does not hide them', async () => {
    await addSheet('Many', [comment('needle '.repeat(150))]);
    await startServer();
    const capped = await search({ query: 'needle', scopes: ['events'], maxResults: 200 });
    expect(capped).toMatchObject({ returned: 100, totalHits: 100, totalHitsIsLowerBound: true, truncated: true });

    await writeFile(join(tmpDir, 'eventSheets', 'Many.json'), JSON.stringify({ name: 'Many', events: [comment('needle needle needle')], sid: 1 }));
    await reader.loadProject();
    resetProjectIndex(reader);
    const plain = await search({ query: 'needle', scopes: ['events'], maxResults: 200 });
    expect(plain).toMatchObject({ returned: 3, totalHits: 3, truncated: false });
    expect(plain).not.toHaveProperty('totalHitsIsLowerBound');
  });

  it('counts every sheet and says truncated when the hits returned are fewer', async () => {
    await addSheet('A', [comment('needle '.repeat(80))]);
    await addSheet('B', [comment('needle '.repeat(80))]);
    await startServer();
    const result = await search({ query: 'needle', scopes: ['events'], maxResults: 100 });
    expect(result).toMatchObject({ returned: 100, totalHits: 160, truncated: true });
    expect(result).not.toHaveProperty('totalHitsIsLowerBound');
  });

  describe('budget', () => {
    it('refuses a search whose last file ran past the budget (the check after the last file)', async () => {
      await addSheet('Last', [comment('needle')]);
      await startServer();
      let calls = 0;
      SEARCH_LIMITS.now = () => (calls++ < 2 ? 0 : 100);
      SEARCH_LIMITS.budgetMs = 50;
      const result = await raw({ query: 'needle', scopes: ['events'], sheets: ['Last'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('The search ran past its time budget of 0.05 seconds.');
      expect(result.content[0].text.endsWith(' Nothing was returned.')).toBe(true);
    });

    it('checks the budget while it walks a large sheet, before the matcher runs', async () => {
      await addSheet('Walk', Array.from({ length: 11_000 }, () => comment('zqxneedle')));
      await startServer();
      let calls = 0;
      // The budget starts at call 1 and the walk's first look (node 10,000) is call 2, both inside it.
      // Only the second look (node 20,000) passes it, before the matcher has made any call.
      SEARCH_LIMITS.now = () => (calls++ < 2 ? 0 : 100);
      SEARCH_LIMITS.budgetMs = 50;
      const exec = vi.spyOn(RegExp.prototype, 'exec');
      const result = await raw({ query: 'zqxneedle', scopes: ['events'], sheets: ['Walk'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('The search ran past its time budget');
      const onPattern = exec.mock.contexts.filter(context => (context as RegExp).source === 'zqxneedle');
      expect(onPattern).toHaveLength(0);
    });
  });
});

const MATCHERS: Array<[string, (pattern: RegExp, budget?: ReturnType<typeof newBudget>) => Matcher]> = [
  ['literalMatcher', literalMatcher],
  ['regexMatcher', regexMatcher],
];

describe.each(MATCHERS)('%s', (name, make) => {
  it('runs more than once and finds the right matches each time', () => {
    const match = make(/a/g);
    expect(match(['xax', 'aa'], 10)).toEqual({ hits: [{ text: 0, index: 1, length: 1 }, { text: 1, index: 0, length: 1 }, { text: 1, index: 1, length: 1 }], count: 3, capped: false });
    expect(match(['b', 'ba'], 10)).toEqual({ hits: [{ text: 1, index: 1, length: 1 }], count: 1, capped: false });
  });

  it('stops a text at the match cap and says so', () => {
    const result = make(/x/g)(['x'.repeat(10_000)], 1000);
    expect(result.count).toBe(100);
    expect(result.capped).toBe(true);
    expect(result.hits).toHaveLength(100);
  });

  it('does not flag a text that holds exactly the cap', () => {
    const result = make(/x/g)(['x'.repeat(100)], 1000);
    expect(result).toMatchObject({ count: 100, capped: false });
  });

  it('refuses a pattern without the g flag', () => {
    expect(() => make(/a/)).toThrow('needs the g flag');
  });

  it('ends on a pattern that matches the empty string', () => {
    expect(make(/(?:)/g)(['abc'], 100)).toMatchObject({ count: 4, capped: false });
  });

  it('holds at most keep hits whatever the texts hold, and counts them all', () => {
    const texts = Array.from({ length: 50 }, () => 'x'.repeat(100));
    const five = make(/x/g)(texts, 5);
    expect(five.hits).toHaveLength(5);
    expect(five.count).toBe(5000);
    const none = make(/x/g)(texts, 0);
    expect(none.hits).toHaveLength(0);
    expect(none.count).toBe(5000);
  });

  it('refuses at once with a budget of 0, and when the budget runs out after a file', () => {
    SEARCH_LIMITS.budgetMs = 0;
    SEARCH_LIMITS.now = () => 0;
    expect(() => make(/a/g)(['a'], 1)).toThrow(SearchTimeout);

    SEARCH_LIMITS.budgetMs = 50;
    // Reads before the call's last look at the budget: the budget's start and the look before
    // the call, plus for regexMatcher the read of what is left of the budget (the vm limit stays 50 ms).
    const readsInside = name === 'regexMatcher' ? 3 : 2;
    let calls = 0;
    SEARCH_LIMITS.now = () => (calls++ < readsInside ? 0 : 100);
    let thrown: unknown;
    try {
      make(/a/g)(['a'], 1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SearchTimeout);
    expect((thrown as SearchTimeout).limit).toBe('budget');
  });
});

describe('literalMatcher budget', () => {
  it('looks at the budget while it reads the texts, not only after the last', () => {
    SEARCH_LIMITS.budgetMs = 50;
    let calls = 0;
    SEARCH_LIMITS.now = () => (calls++ < 3 ? 0 : 100);
    let reads = 0;
    const texts = new Proxy(Array.from({ length: 1000 }, () => 'a'), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => literalMatcher(/a/g)(texts, 1)).toThrow(SearchTimeout);
    expect(reads).toBe(512);
  });
});

describe('regexMatcher time limit', () => {
  it('throws a call timeout for a catastrophic pattern', () => {
    SEARCH_LIMITS.perCallMs = 50;
    let thrown: unknown;
    try {
      regexMatcher(/(a+)+$/g)([`${'a'.repeat(28)}b`], 1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SearchTimeout);
    expect((thrown as SearchTimeout).limit).toBe('call');
  });
});
