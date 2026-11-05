import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACE_SOURCE_FILES,
  CACHE_FORMAT,
  MAX_CACHE_BYTES,
  MAX_SOURCE_BYTES,
  RELEASE_PATTERN,
  buildCatalog,
  cacheFilePath,
  catalogCounts,
  catalogDigest,
  catalogFromSources,
  defaultAceCacheDir,
  fetchCatalogSources,
  readLocalSources,
  runBuildCatalog,
  sourceUrl,
  writeCacheFile,
  type BuildCatalogDeps,
  type FetchLike,
  UNKNOWN_PARAM_TYPE,
  isAceCatalog,
  literalToJson,
  releaseFromSaved,
  releaseLabel,
  releaseNumber,
  type CatalogSources,
} from '../../src/construct3/ace-catalog-source.js';
import { SYSTEM_EXPRESSION_NAMES } from '../../src/construct3/event-variable-names.js';
import type { AceCatalog } from '../../src/construct3/ace-types.js';
import { TEST_CATALOG } from '../fixtures/ace-catalog.js';
import { fetchStub, fixtureRoutes, guardNetwork, guardedCalls, neverAnswers, streamOf } from './ace-fetch-stub.js';

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ace-source', 'r495-2');

async function loadSources(): Promise<CatalogSources> {
  const [plugins, behaviors, mainJs] = await Promise.all([
    readFile(join(sourceDir, 'plugins', 'allAces.json'), 'utf8').then(text => JSON.parse(text) as unknown),
    readFile(join(sourceDir, 'behaviors', 'allAces.json'), 'utf8').then(text => JSON.parse(text) as unknown),
    readFile(join(sourceDir, 'main.js'), 'utf8'),
  ]);
  return { release: 'r495-2', plugins, behaviors, mainJs };
}

const clone = (catalog: AceCatalog): AceCatalog => JSON.parse(JSON.stringify(catalog)) as AceCatalog;

describe('buildCatalog', () => {
  it('turns the hand-written source folder into TEST_CATALOG', async () => {
    expect(buildCatalog(await loadSources())).toEqual(TEST_CATALOG);
  });

  it('counts what the catalogue holds', () => {
    expect(catalogCounts(TEST_CATALOG)).toEqual({
      plugins: 4,
      behaviors: 1,
      aces: 7,
      expressions: 15,
      commonAces: 4,
      commonExpressions: 5,
    });
  });

  it('refuses sources it cannot read', async () => {
    const sources = await loadSources();
    expect(() => buildCatalog({ ...sources, mainJs: 'x({id:"set-x",scriptName:"SetX"});' }))
      .toThrow('Could not tell the condition, action and expression registrations apart');
    expect(() => buildCatalog({ ...sources, mainJs: sources.mainJs.replace('"SetX"', 'SetX') }))
      .toThrow('not a data literal');
    expect(() => buildCatalog({ ...sources, plugins: [] })).toThrow('plugins/allAces.json is not an object of addons');
    expect(() => buildCatalog({ ...sources, behaviors: null })).toThrow('behaviors/allAces.json is not an object of addons');
  });

  it('leaves no registration out, whatever the order of its keys', async () => {
    const sources = await loadSources();
    const catalog = buildCatalog(sources);
    // The fixture writes set-x with the id second.
    expect(sources.mainJs).toContain('{scriptName:"SetX",id:"set-x"');
    expect(catalog.common.actions['set-x']).toEqual([{ id: 'x', type: 'number' }]);
    // A literal the transform does not understand stops the build; it never returns a catalogue without the entry.
    const broken = sources.mainJs.replace('{scriptName:"SetX",id:"set-x"', '{scriptName:f(),id:"set-x"');
    expect(broken).not.toBe(sources.mainJs);
    expect(() => buildCatalog({ ...sources, mainJs: broken })).toThrow('Could not read a common ACE registration');
    // A call whose nested object alone holds the marker keys registers nothing.
    expect(JSON.stringify(catalog.common)).not.toContain('nested-only');
  });
});

describe('common ACE candidates', () => {
  it('reads a registration inside an enclosing call that is not itself a registration', async () => {
    const sources = await loadSources();
    const enclosing = 'x({run:function(){return a({id:"set-y",scriptName:"SetY",params:[]})},valid:"yes",extra:{scriptName:"N"}});\n';
    const catalog = buildCatalog({ ...sources, mainJs: sources.mainJs + enclosing });
    expect(catalog.common.actions['set-y']).toEqual([]);
    expect(Object.keys(catalog.common.actions)).toHaveLength(Object.keys(TEST_CATALOG.common.actions).length + 1);
  });

  it('still refuses an unreadable object whose own keys are a registration', async () => {
    const sources = await loadSources();
    const text = sources.mainJs + 'a({id:"set-z",scriptName:g(),valid:1});\n';
    expect(() => buildCatalog({ ...sources, mainJs: text })).toThrow('Could not read a common ACE registration');
  });

  it('refuses a template string and names the reader error', async () => {
    const sources = await loadSources();
    const text = sources.mainJs + 'a({id:"set-z",scriptName:`SetZ`});\n';
    expect(() => buildCatalog({ ...sources, mainJs: text })).toThrow(/Could not read a common ACE registration near "\{id:"set-z",scriptName:`SetZ`\}": unexpected "`"/);
  });

  it('skips a call whose registering function is named like an Object.prototype member', async () => {
    const sources = await loadSources();
    const catalog = buildCatalog({ ...sources, mainJs: sources.mainJs + 'constructor({id:"ctor-one",scriptName:"Ctor"});\n' });
    expect(catalog).toEqual(TEST_CATALOG);
  });

  it('keeps an id such as __proto__ as an entry of its own', async () => {
    const sources = await loadSources();
    const plugins = JSON.parse('{"Odd":{"c":{"actions":[{"id":"__proto__","params":[]}]}}}') as unknown;
    const catalog = buildCatalog({ ...sources, plugins });
    expect(Object.keys(catalog.plugins.Odd.actions)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(catalog.plugins.Odd.actions)).toBe(Object.prototype);
  });
});

describe('literalToJson', () => {
  it('refuses a string that never ends', () => {
    expect(() => literalToJson('{a:"x')).toThrow('unterminated string');
  });

  it('refuses a character and a number it cannot read', () => {
    expect(() => literalToJson('{a:#}')).toThrow('unexpected "#"');
    expect(() => literalToJson('{a:-}')).toThrow('unexpected "-"');
  });

  it('refuses a name that is not a data literal', () => {
    expect(() => literalToJson('{a:f()}')).toThrow('not a data literal');
  });
});

describe('parameters that cannot be read', () => {
  const withParams = (list: unknown[]): unknown => ({
    X: { c: { actions: [{ id: 'act', params: list }], expressions: [{ id: 'ex', params: list }] } },
  });

  it('keep their position as an entry of unknown type', async () => {
    const sources = await loadSources();
    const list = [
      { id: 'a', type: 'number' },
      5,
      { id: 'b' },
      { type: 'string' },
      { id: 'c', type: 'combo', items: [1] },
      { id: 'd', type: 'string' },
    ];
    const catalog = buildCatalog({ ...sources, plugins: withParams(list) });
    expect(UNKNOWN_PARAM_TYPE).toBe('unknown');
    expect(catalog.plugins.X.actions.act).toEqual([
      { id: 'a', type: 'number' },
      { id: '', type: 'unknown' },
      { id: 'b', type: 'unknown' },
      { id: '', type: 'unknown' },
      { id: 'c', type: 'unknown' },
      { id: 'd', type: 'string' },
    ]);
    expect(catalog.plugins.X.expressions.ex.params).toEqual(['number', 'unknown', 'unknown', 'unknown', 'unknown', 'string']);
  });
});

describe('release names', () => {
  it('names the release a project was saved with', () => {
    expect(releaseFromSaved(49502)).toBe('r495-2');
    expect(releaseFromSaved(44000)).toBe('r440');
    expect(releaseFromSaved(44903)).toBe('r449-3');
    expect(releaseFromSaved(50602)).toBe('r506-2');
    for (const bad of [undefined, '49502', 49502.5, -1, 99, 1000000, NaN]) expect(releaseFromSaved(bad)).toBeUndefined();
  });

  it('orders and labels releases', () => {
    expect(releaseNumber('r495-2')).toBe(49502);
    expect(releaseNumber('r495.2')).toBe(49502);
    expect(releaseNumber('r440')).toBe(44000);
    expect(releaseNumber('bad')).toBeNaN();
    expect(releaseLabel('r495-2')).toBe('r495.2');
    expect(releaseLabel('r495.2')).toBe('r495.2');
    expect(releaseLabel('r440')).toBe('r440');
    expect(releaseLabel('bad')).toBe('bad');
  });

  it('accepts only names that cannot reach a URL or a path as anything else', () => {
    expect(RELEASE_PATTERN.test('r495')).toBe(true);
    expect(RELEASE_PATTERN.test('r495-2')).toBe(true);
    for (const bad of ['r495-2/../x', 'r495-2?x', 'r495-2#x', 'r495-2%2F', 'R495', 'r0495', 'r495-', 'r495-2 ', 'https://x', '']) {
      expect(RELEASE_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe('isAceCatalog', () => {
  it('accepts a whole catalogue', () => {
    expect(isAceCatalog(TEST_CATALOG)).toBe(true);
  });

  it('refuses a partial or malformed one', () => {
    expect(isAceCatalog(null)).toBe(false);

    const noSystem = clone(TEST_CATALOG);
    delete noSystem.plugins.system;
    expect(isAceCatalog(noSystem)).toBe(false);

    const noConditions = clone(TEST_CATALOG);
    noConditions.plugins.system.conditions = {};
    expect(isAceCatalog(noConditions)).toBe(false);

    const numericType = clone(TEST_CATALOG) as unknown as { common: { actions: Record<string, Array<{ type: unknown }>> } };
    numericType.common.actions['set-x'][0].type = 5;
    expect(isAceCatalog(numericType)).toBe(false);

    const numericItems = clone(TEST_CATALOG) as unknown as { plugins: { Sprite: { actions: Record<string, Array<{ items?: unknown }>> } } };
    numericItems.plugins.Sprite.actions['set-animation'][1].items = [1];
    expect(isAceCatalog(numericItems)).toBe(false);

    const noName = clone(TEST_CATALOG) as unknown as { plugins: { system: { expressions: Record<string, { name?: string }> } } };
    delete noName.plugins.system.expressions.int.name;
    expect(isAceCatalog(noName)).toBe(false);

    expect(isAceCatalog({ ...clone(TEST_CATALOG), release: '../x' })).toBe(false);
  });
});

describe('the hand-written catalogue', () => {
  it('uses real System expression names', () => {
    for (const expression of Object.values(TEST_CATALOG.plugins.system.expressions)) {
      expect(SYSTEM_EXPRESSION_NAMES, expression.name).toContain(expression.name);
    }
  });
});

const sourcesRoot = join(sourceDir, '..');
const PLUGINS_URL = sourceUrl('r495-2', 'plugins/allAces.json');
const BEHAVIORS_URL = sourceUrl('r495-2', 'behaviors/allAces.json');
const MAIN_URL = sourceUrl('r495-2', 'main.js');

const redirectTo = (location: string) => (): Response => new Response(null, { status: 302, headers: { location } });
const status = (code: number) => (): Response => new Response('', { status: code });

describe('fetching the sources', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = guardNetwork();
  });
  afterEach(() => {
    restore();
  });

  it('requests the three files in order without following redirects itself, and reports their sizes', async () => {
    const stub = fetchStub(fixtureRoutes());
    const result = await fetchCatalogSources('r495-2', stub);
    expect(result.ok).toBe(true);
    expect(stub.calls.map(call => call.url)).toEqual([PLUGINS_URL, BEHAVIORS_URL, MAIN_URL]);
    for (const call of stub.calls) {
      expect(call.init.redirect).toBe('manual');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    if (result.ok) {
      expect(result.bytes).toEqual(await Promise.all(ACE_SOURCE_FILES.map(async file => (await readFile(join(sourceDir, file))).length)));
      expect(catalogFromSources(result)).toEqual({ ok: true, catalog: TEST_CATALOG });
    }
    expect(guardedCalls).toEqual([]);
  });

  it('never lets a release name reach a URL or a path', async () => {
    for (const bad of ['r495-2/../x', 'r495-2?x', 'R495']) {
      const stub = fetchStub(fixtureRoutes());
      expect(await fetchCatalogSources(bad, stub)).toEqual({ ok: false, reason: 'refused', detail: 'not a release name' });
      expect(stub.calls).toEqual([]);
      expect(await readLocalSources(sourcesRoot, bad)).toEqual({ ok: false, reason: 'refused', detail: 'not a release name' });
      expect(() => sourceUrl(bad, 'main.js')).toThrow('not a release name');
      expect(() => cacheFilePath('dir', bad)).toThrow('not a release name');
    }
    expect(() => cacheFilePath('dir', '../x')).toThrow();
  });

  describe('redirects', () => {
    it('follows a redirect to the same file on the same host, also a relative one', async () => {
      const served = fixtureRoutes();
      const routes = {
        ...served,
        [PLUGINS_URL]: redirectTo(`${PLUGINS_URL}?x=1`),
        [`${PLUGINS_URL}?x=1`]: redirectTo('/r495-2/plugins/allAces.json?x=2'),
        [`${PLUGINS_URL}?x=2`]: served[PLUGINS_URL],
      };
      const stub = fetchStub(routes);
      expect((await fetchCatalogSources('r495-2', stub)).ok).toBe(true);
      expect(stub.calls.map(call => call.url)).toEqual([PLUGINS_URL, `${PLUGINS_URL}?x=1`, `${PLUGINS_URL}?x=2`, BEHAVIORS_URL, MAIN_URL]);
    });

    it('refuses another host, another scheme, another port, and requests none of them', async () => {
      for (const target of [
        'https://example.com/r495-2/plugins/allAces.json',
        'http://editor.construct.net/r495-2/plugins/allAces.json',
        'https://editor.construct.net:8443/r495-2/plugins/allAces.json',
        'https://user@editor.construct.net/r495-2/plugins/allAces.json',
      ]) {
        const stub = fetchStub({ ...fixtureRoutes(), [PLUGINS_URL]: redirectTo(target) });
        expect(await fetchCatalogSources('r495-2', stub), target).toEqual({ ok: false, reason: 'refused', detail: 'redirected to another host' });
        expect(stub.calls.map(call => call.url)).toEqual([PLUGINS_URL]);
      }
    });

    it('refuses a Location that is not a URL, and requests nothing more', async () => {
      const stub = fetchStub({ ...fixtureRoutes(), [PLUGINS_URL]: redirectTo('http://[') });
      expect(await fetchCatalogSources('r495-2', stub)).toEqual({ ok: false, reason: 'refused', detail: 'redirected to another host' });
      expect(stub.calls.map(call => call.url)).toEqual([PLUGINS_URL]);
    });

    it('refuses four hops', async () => {
      const stub = fetchStub({
        [PLUGINS_URL]: redirectTo(`${PLUGINS_URL}?1`),
        [`${PLUGINS_URL}?1`]: redirectTo(`${PLUGINS_URL}?2`),
        [`${PLUGINS_URL}?2`]: redirectTo(`${PLUGINS_URL}?3`),
        [`${PLUGINS_URL}?3`]: redirectTo(`${PLUGINS_URL}?4`),
      });
      expect(await fetchCatalogSources('r495-2', stub)).toEqual({ ok: false, reason: 'refused', detail: 'too many redirects' });
      expect(stub.calls).toHaveLength(4);
    });

    it('refuses a redirect to another release or file on the allowed host', async () => {
      const otherRelease = sourceUrl('r506-2', 'plugins/allAces.json');
      const stub = fetchStub({ ...fixtureRoutes(), [otherRelease]: redirectTo(PLUGINS_URL) });
      expect(await fetchCatalogSources('r506-2', stub)).toEqual({ ok: false, reason: 'refused', detail: 'redirected to another release or file' });
      expect(stub.calls.map(call => call.url)).toEqual([otherRelease]);

      const otherFile = fetchStub({ ...fixtureRoutes(), [MAIN_URL]: redirectTo(PLUGINS_URL) });
      expect(await fetchCatalogSources('r495-2', otherFile)).toEqual({ ok: false, reason: 'refused', detail: 'redirected to another release or file' });
      expect(otherFile.calls.map(call => call.url)).toEqual([PLUGINS_URL, BEHAVIORS_URL, MAIN_URL]);
    });
  });

  describe('size cap', () => {
    it('refuses a content-length over the cap before the body is read', async () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('the body was pulled');
        },
      });
      const stub = fetchStub({ [PLUGINS_URL]: () => new Response(body, { status: 200, headers: { 'content-length': '2048' } }) });
      expect(await fetchCatalogSources('r495-2', stub, { maxBytes: 1024 })).toEqual({ ok: false, reason: 'refused', detail: 'the file is too large' });
    });

    it('stops reading a body that grows past the cap whatever the header said, and cancels it', async () => {
      const response = streamOf(Array.from({ length: 8 }, () => new Uint8Array(256)));
      const stub = fetchStub({ [PLUGINS_URL]: () => response });
      expect(await fetchCatalogSources('r495-2', stub, { maxBytes: 1024 })).toEqual({ ok: false, reason: 'refused', detail: 'the file is too large' });
      expect(response.cancelled()).toBe(true);
    });
  });

  it('gives up on a request that never answers once the timeout is over', async () => {
    const started = Date.now();
    const result = await fetchCatalogSources('r495-2', neverAnswers, { timeoutMs: 50 });
    expect(result).toEqual({ ok: false, reason: 'offline', detail: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops the whole attempt at the overall deadline though every request is within its own timeout', async () => {
    const urls: string[] = [];
    const slowRedirects: FetchLike = (url, init) => new Promise<Response>((resolve, reject) => {
      urls.push(url);
      if (init.signal.aborted) return reject(init.signal.reason);
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      setTimeout(() => resolve(new Response(null, { status: 302, headers: { location: `${PLUGINS_URL}?n=${urls.length}` } })), 40);
    });
    const started = Date.now();
    const result = await fetchCatalogSources('r495-2', slowRedirects, { timeoutMs: 10_000, deadlineMs: 70 });
    expect(result).toEqual({ ok: false, reason: 'offline', detail: 'TimeoutError' });
    expect(urls.length).toBeLessThan(4);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('gives up on a body that stalls after its headers once the timeout is over', async () => {
    const stalled: FetchLike = (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    expect(await fetchCatalogSources('r495-2', stalled, { timeoutMs: 50 })).toEqual({ ok: false, reason: 'offline', detail: 'TimeoutError' });
  });

  describe('failures', () => {
    it('calls a network error offline and keeps only its code', async () => {
      const failing: FetchLike = () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND', hostname: 'secret.example' } }));
      expect(await fetchCatalogSources('r495-2', failing)).toEqual({ ok: false, reason: 'offline', detail: 'ENOTFOUND' });
    });

    it('refuses other errors, other statuses and files that are not JSON', async () => {
      const odd: FetchLike = () => Promise.reject(new RangeError('odd'));
      expect(await fetchCatalogSources('r495-2', odd)).toEqual({ ok: false, reason: 'refused', detail: 'unexpected error (RangeError)' });
      expect(await fetchCatalogSources('r495-2', fetchStub({ [PLUGINS_URL]: status(503) }))).toEqual({ ok: false, reason: 'refused', detail: 'HTTP 503' });
      const notJson = fetchStub({ ...fixtureRoutes(), [PLUGINS_URL]: () => new Response('<html>secret page</html>', { status: 200 }) });
      expect(await fetchCatalogSources('r495-2', notJson)).toEqual({ ok: false, reason: 'refused', detail: 'plugins/allAces.json is not valid JSON' });
    });

    it('tells an unserved release from a partly served one', async () => {
      expect(await fetchCatalogSources('r495-2', fetchStub({ [PLUGINS_URL]: status(404) }))).toMatchObject({ reason: 'not-served' });
      expect(await fetchCatalogSources('r495-2', fetchStub({ [PLUGINS_URL]: status(403) }))).toMatchObject({ reason: 'not-served' });
      const partly = fetchStub({ ...fixtureRoutes(), [MAIN_URL]: status(404) });
      expect(await fetchCatalogSources('r495-2', partly)).toEqual({ ok: false, reason: 'refused', detail: 'the release is only partly served' });
    });

    it('keeps response text out of the failure of a main.js the transform cannot read', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const text = `${await readFile(join(sourceDir, 'main.js'), 'utf8')}\nSECRETWORD({id:"set-z",scriptName:g()});\n`;
        const stub = fetchStub({ ...fixtureRoutes(), [MAIN_URL]: () => new Response(text, { status: 200 }) });
        const built = catalogFromSources(await fetchCatalogSources('r495-2', stub));
        expect(built).toEqual({ ok: false, reason: 'refused', detail: 'the editor\'s files could not be read' });
        expect(JSON.stringify(built)).not.toContain('SECRETWORD');
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe('making a catalogue from sources', () => {
  it('passes a failed result through and refuses sources that give no System plugin', async () => {
    const failed = { ok: false, reason: 'offline', detail: 'ENOTFOUND' } as const;
    expect(catalogFromSources(failed)).toBe(failed);
    const sources = await loadSources();
    expect(catalogFromSources({ ok: true, sources: { ...sources, plugins: {} }, bytes: [0, 0, 0] }))
      .toEqual({ ok: false, reason: 'refused', detail: 'the editor\'s files did not give a complete catalogue' });
  });
});

describe('local copies', () => {
  const dirs: string[] = [];
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ace-source-'));
    dirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('reads the three files of a release folder', async () => {
    const result = await readLocalSources(sourcesRoot, 'r495-2');
    expect(catalogFromSources(result)).toEqual({ ok: true, catalog: TEST_CATALOG });
  });

  it('tells no copy from an incomplete one', async () => {
    const dir = await tempDir();
    expect(await readLocalSources(dir, 'r495-2')).toEqual({ ok: false, reason: 'not-served', detail: 'no local copy' });
    await mkdir(join(dir, 'r495-2', 'plugins'), { recursive: true });
    await writeFile(join(dir, 'r495-2', 'plugins', 'allAces.json'), '{}');
    expect(await readLocalSources(dir, 'r495-2')).toEqual({ ok: false, reason: 'refused', detail: 'incomplete local copy' });
  });

  it('refuses a file over the cap by its size, before reading it', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'r495-2', 'plugins'), { recursive: true });
    const file = join(dir, 'r495-2', 'plugins', 'allAces.json');
    await writeFile(file, '');
    await truncate(file, MAX_SOURCE_BYTES + 1);
    expect(await readLocalSources(dir, 'r495-2')).toEqual({ ok: false, reason: 'refused', detail: 'plugins/allAces.json is too large' });
    expect(await readLocalSources(sourcesRoot, 'r495-2', 10)).toMatchObject({ ok: false, reason: 'refused' });
  });
});

describe('the cache write', () => {
  const dirs: string[] = [];
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ace-cache-'));
    dirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<BuildCatalogDeps> = {}): BuildCatalogDeps & { lines: string[]; errors: string[] } {
    const lines: string[] = [];
    const errors: string[] = [];
    return {
      fetch: () => Promise.reject(new Error('no fetch expected')),
      env: {},
      platform: process.platform,
      home: tmpdir(),
      out: line => lines.push(line),
      err: line => errors.push(line),
      ...overrides,
      lines,
      errors,
    };
  }

  it('writes the entry with its digest through a temporary file that is gone afterwards', async () => {
    const dir = await tempDir();
    const outcome = await writeCacheFile(join(dir, 'nested'), 'r495-2', TEST_CATALOG);
    expect(outcome).toEqual({ written: true, path: join(dir, 'nested', 'r495-2.json') });
    expect(JSON.parse(await readFile(join(dir, 'nested', 'r495-2.json'), 'utf8'))).toEqual({
      format: CACHE_FORMAT,
      sourceRelease: 'r495-2',
      digest: catalogDigest(TEST_CATALOG),
      catalog: TEST_CATALOG,
    });
    expect(await readdir(join(dir, 'nested'))).toEqual(['r495-2.json']);
  });

  it('reports a failed rename without throwing, without a path and without a temporary file', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'r495-2.json'));
    const outcome = await writeCacheFile(dir, 'r495-2', TEST_CATALOG);
    expect(outcome.written).toBe(false);
    if (!outcome.written) {
      expect(outcome.reason).toMatch(/^the cache file could not be written \(\w+\)$/);
      expect(outcome.reason).not.toContain(dir);
    }
    expect(await readdir(dir)).toEqual(['r495-2.json']);
  });

  it('removes the temporary files of this process when a write fails, and no one else\'s', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'r495-2.json'));
    const mine = `r495-2.json.${process.pid}-deadbeef.tmp`;
    const theirs = `r495-2.json.${process.pid + 1}-deadbeef.tmp`;
    await writeFile(join(dir, mine), 'left behind');
    await writeFile(join(dir, theirs), 'another process');
    expect((await writeCacheFile(dir, 'r495-2', TEST_CATALOG)).written).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(['r495-2.json', theirs].sort());
  });

  it('does not throw for a release that is not a release name, and refuses an entry over the cache cap', async () => {
    const dir = await tempDir();
    expect(await writeCacheFile(dir, '../x', TEST_CATALOG)).toEqual({ written: false, reason: 'the cache file could not be written (error)' });
    const big = clone(TEST_CATALOG);
    big.plugins.Sprite.actions.huge = [{ id: 'x'.repeat(MAX_CACHE_BYTES), type: 'string' }];
    expect(await writeCacheFile(dir, 'r495-2', big)).toEqual({ written: false, reason: 'the catalogue is too large to cache' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses before any request when the default cache folder is not absolute', async () => {
    const stub = fetchStub(fixtureRoutes());
    const run = deps({ fetch: stub, env: {}, home: 'relative-home' });
    expect(await runBuildCatalog(['r495-2'], run)).toBe(1);
    expect(run.errors).toEqual(['the cache folder is not an absolute path. Set C3_ACE_CACHE_DIR to an absolute path.']);
    expect(stub.calls).toEqual([]);
  });

  it('makes the script fail when the write fails, and succeed once it can', async () => {
    const dir = await tempDir();
    const target = join(dir, 'r495-2.json');
    await mkdir(target);
    const failed = deps();
    expect(await runBuildCatalog(['r495-2', '--from', sourcesRoot, '--out', target], failed)).toBe(1);
    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]).toContain('could not be written');
    expect(failed.lines.filter(line => line.startsWith('Wrote'))).toEqual([]);

    await rm(target, { recursive: true });
    const ok = deps();
    expect(await runBuildCatalog(['r495-2', '--from', sourcesRoot, '--out', target], ok)).toBe(0);
    expect(ok.lines[0]).toBe(`Wrote ${target}`);
    expect(ok.lines).toContain(`plugins/allAces.json: ${(await readFile(join(sourceDir, 'plugins', 'allAces.json'))).length} bytes`);
    expect(ok.lines).toContain(`plugins: ${catalogCounts(TEST_CATALOG).plugins}`);
    expect(ok.errors).toEqual([]);
  });

  it('fetches with the injected fetch and writes to the default folder', async () => {
    const dir = await tempDir();
    const stub = fetchStub(fixtureRoutes());
    const run = deps({ fetch: stub, env: { C3_ACE_CACHE_DIR: dir } });
    expect(await runBuildCatalog(['r495-2'], run)).toBe(0);
    expect(stub.calls).toHaveLength(3);
    expect(run.lines[0]).toBe(`Wrote ${join(dir, 'r495-2.json')}`);
  });

  it('exits 1 for sources that give no catalogue and 2 for a usage error, with no request', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src', 'r495-2', 'plugins'), { recursive: true });
    await mkdir(join(dir, 'src', 'r495-2', 'behaviors'), { recursive: true });
    await writeFile(join(dir, 'src', 'r495-2', 'plugins', 'allAces.json'), '{}');
    await writeFile(join(dir, 'src', 'r495-2', 'behaviors', 'allAces.json'), '{}');
    await writeFile(join(dir, 'src', 'r495-2', 'main.js'), await readFile(join(sourceDir, 'main.js')));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const empty = deps();
      expect(await runBuildCatalog(['r495-2', '--from', join(dir, 'src'), '--out', join(dir, 'out', 'r495-2.json')], empty)).toBe(1);
      expect(empty.lines).toEqual([]);
      expect(await readdir(dir)).toEqual(['src']);
    } finally {
      spy.mockRestore();
    }
    const named = deps({ fetch: fetchStub(fixtureRoutes()) });
    expect(await runBuildCatalog(['r495-2', '--out', join(dir, 'x', 'other.json')], named)).toBe(2);
    expect(named.errors).toEqual([expect.stringContaining('--out must name a file called r495-2.json')]);
    const stub = fetchStub(fixtureRoutes());
    for (const args of [['bad'], [], ['r495-2', '--out', join(dir, 'wrong.json')], ['r495-2', '--what'], ['r495-2', '--from']]) {
      const run = deps({ fetch: stub });
      expect(await runBuildCatalog(args, run), args.join(' ')).toBe(2);
      expect(run.errors).toHaveLength(1);
    }
    expect(stub.calls).toEqual([]);
  });
});

describe('the cache folder', () => {
  const win = (...parts: string[]): string => path.win32.join(...parts, 'construct3-mcp', 'ace-catalog');
  const posix = (...parts: string[]): string => path.posix.join(...parts, 'construct3-mcp', 'ace-catalog');

  it('follows each platform\'s cache folder', () => {
    expect(defaultAceCacheDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u')).toBe(win('C:\\Users\\u\\AppData\\Local'));
    expect(defaultAceCacheDir({}, 'win32', 'C:\\Users\\u')).toBe(win('C:\\Users\\u', 'AppData', 'Local'));
    expect(defaultAceCacheDir({}, 'darwin', '/Users/u')).toBe(posix('/Users/u', 'Library', 'Caches'));
    expect(defaultAceCacheDir({ XDG_CACHE_HOME: '/x/cache' }, 'linux', '/home/u')).toBe(posix('/x/cache'));
    expect(defaultAceCacheDir({ XDG_CACHE_HOME: 'cache' }, 'linux', '/home/u')).toBe(posix('/home/u', '.cache'));
    expect(defaultAceCacheDir({}, 'linux', '/home/u')).toBe(posix('/home/u', '.cache'));
  });

  it('uses C3_ACE_CACHE_DIR as it is', () => {
    expect(defaultAceCacheDir({ C3_ACE_CACHE_DIR: '/abs/dir' }, 'linux', '/home/u')).toBe('/abs/dir');
    expect(defaultAceCacheDir({ C3_ACE_CACHE_DIR: 'D:\\cache' }, 'win32', 'C:\\Users\\u')).toBe('D:\\cache');
  });

  it('gives a relative folder, for the caller to refuse, from a relative C3_ACE_CACHE_DIR, LOCALAPPDATA or home', () => {
    const isAbsolute = (platform: NodeJS.Platform, dir: string): boolean => (platform === 'win32' ? path.win32 : path.posix).isAbsolute(dir);
    expect(isAbsolute('linux', defaultAceCacheDir({ C3_ACE_CACHE_DIR: 'rel/dir' }, 'linux', '/home/u'))).toBe(false);
    expect(isAbsolute('win32', defaultAceCacheDir({ LOCALAPPDATA: 'relative' }, 'win32', 'C:\\Users\\u'))).toBe(false);
    expect(isAbsolute('win32', defaultAceCacheDir({}, 'win32', 'home'))).toBe(false);
    expect(isAbsolute('darwin', defaultAceCacheDir({}, 'darwin', 'home'))).toBe(false);
    expect(isAbsolute('linux', defaultAceCacheDir({}, 'linux', 'home'))).toBe(false);
    expect(isAbsolute('linux', defaultAceCacheDir({ XDG_CACHE_HOME: '/x/cache' }, 'linux', 'home'))).toBe(true);
  });
});
