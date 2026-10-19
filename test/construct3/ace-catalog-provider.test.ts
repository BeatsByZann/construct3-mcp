import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CACHE_BYTES,
  cacheFilePath,
  catalogDigest,
  sourceUrl,
} from '../../src/construct3/ace-catalog-source.js';
import {
  AceCatalogProvider,
  aceCatalogProviderFor,
  defaultAceCatalogProvider,
  describeCatalogSubstitute,
  setAceCatalogProvider,
  type CatalogLookup,
} from '../../src/construct3/ace-catalog-provider.js';
import type { AceCatalog } from '../../src/construct3/ace-types.js';
import { TEST_CATALOG } from '../fixtures/ace-catalog.js';
import { fetchStub, fixtureRoutes, guardNetwork, guardedCalls, offlineStub, type FetchStub } from './ace-fetch-stub.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const sourcesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ace-source');
const url = (release: string, file: 'plugins/allAces.json' | 'behaviors/allAces.json' | 'main.js'): string => sourceUrl(release, file);
const R495 = ['plugins/allAces.json', 'behaviors/allAces.json', 'main.js'] as const;
const urlsOf = (stub: FetchStub): string[] => stub.calls.map(call => call.url);
const status = (code: number) => (): Response => new Response('', { status: code });

/** Read a file with the real readFile, not the spied one. */
async function readActual(file: string): Promise<string> {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return actual.readFile(file, 'utf8');
}

type Entry = { format: unknown; sourceRelease: unknown; digest?: unknown; catalog: AceCatalog };
const clone = (catalog: AceCatalog): AceCatalog => JSON.parse(JSON.stringify(catalog)) as AceCatalog;

let restore: () => void;
let errors: MockInstance<typeof console.error>;
const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ace-provider-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  restore = guardNetwork();
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(readFile).mockClear();
});
afterEach(async () => {
  restore();
  errors.mockRestore();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const catalogOf = (lookup: CatalogLookup): AceCatalog => {
  if (!lookup.ok) throw new Error(`lookup failed: ${lookup.message}`);
  return lookup.catalog;
};
const failureOf = (lookup: CatalogLookup): Extract<CatalogLookup, { ok: false }> => {
  if (lookup.ok) throw new Error('lookup succeeded');
  return lookup;
};

describe('building and caching', () => {
  it('builds the catalogue from the three files and caches it', async () => {
    const dir = await tempDir();
    const stub = fetchStub(fixtureRoutes());
    const lookup = await new AceCatalogProvider({ cacheDir: dir, fetch: stub }).catalogFor(49502);
    expect(lookup).toEqual({ ok: true, catalog: TEST_CATALOG, release: 'r495-2' });
    expect(urlsOf(stub)).toEqual(R495.map(file => url('r495-2', file)));
    for (const call of stub.calls) {
      expect(call.init.redirect).toBe('manual');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.parse(await readActual(join(dir, 'r495-2.json')))).toEqual({
      format: 2,
      sourceRelease: 'r495-2',
      digest: catalogDigest(TEST_CATALOG),
      catalog: TEST_CATALOG,
    });
    expect(await readdir(dir)).toEqual(['r495-2.json']);
  });

  it('uses a valid cache file without a request', async () => {
    const dir = await tempDir();
    await new AceCatalogProvider({ cacheDir: dir, fetch: fetchStub(fixtureRoutes()) }).catalogFor(49502);
    const stub = offlineStub();
    const lookup = await new AceCatalogProvider({ cacheDir: dir, fetch: stub }).catalogFor(49502);
    expect(lookup).toEqual({ ok: true, catalog: TEST_CATALOG, release: 'r495-2' });
    expect(stub.calls).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('a cache file that cannot be trusted', () => {
  const withDigest = (entry: Entry): string => JSON.stringify({ ...entry, digest: catalogDigest(entry.catalog) });
  const variants: Record<string, (entry: Entry, text: string) => string> = {
    'is not JSON': () => '{ broken',
    'is cut in half': (_entry, text) => text.slice(0, Math.floor(text.length / 2)),
    'has an earlier format': entry => JSON.stringify({ ...entry, format: 1 }),
    'names another source release': entry => JSON.stringify({ ...entry, sourceRelease: 'r506-2' }),
    'holds a catalogue of another release': entry => withDigest({ ...entry, catalog: { ...entry.catalog, release: 'r506-2' } }),
    'holds a catalogue without System': entry => {
      const catalog = clone(entry.catalog);
      delete catalog.plugins.system;
      return withDigest({ ...entry, catalog });
    },
    'has lost an action but keeps the shape and the digest': entry => {
      const catalog = clone(entry.catalog);
      delete catalog.plugins.Sprite.actions['set-animation'];
      return JSON.stringify({ ...entry, catalog });
    },
    'has its common actions replaced by an empty record': entry => {
      const catalog = clone(entry.catalog);
      catalog.common.actions = {};
      return JSON.stringify({ ...entry, catalog });
    },
    'has no digest': entry => {
      const { digest: _digest, ...rest } = entry;
      return JSON.stringify(rest);
    },
  };

  for (const [name, damage] of Object.entries(variants)) {
    it(`is rebuilt, never trusted, when it ${name}`, async () => {
      const dir = await tempDir();
      await new AceCatalogProvider({ cacheDir: dir, fetch: fetchStub(fixtureRoutes()) }).catalogFor(49502);
      const file = cacheFilePath(dir, 'r495-2');
      const text = await readActual(file);
      await writeFile(file, damage(JSON.parse(text) as Entry, text));

      const offline = offlineStub();
      const refused = failureOf(await new AceCatalogProvider({ cacheDir: dir, fetch: offline }).catalogFor(49502));
      expect(refused.reason).toBe('offline');
      expect('catalog' in refused).toBe(false);

      errors.mockClear();
      const stub = fetchStub(fixtureRoutes());
      expect(catalogOf(await new AceCatalogProvider({ cacheDir: dir, fetch: stub }).catalogFor(49502))).toEqual(TEST_CATALOG);
      expect(stub.calls).toHaveLength(3);
      expect(errors).toHaveBeenCalledWith('r495-2.json is not a valid ACE catalogue; rebuilding');
      const rebuilt = JSON.parse(await readActual(file)) as Entry;
      expect(rebuilt.digest).toBe(catalogDigest(TEST_CATALOG));
      expect(rebuilt.catalog).toEqual(TEST_CATALOG);
    });
  }

  it('is not read at all when it is over the size cap', async () => {
    const dir = await tempDir();
    const file = cacheFilePath(dir, 'r495-2');
    await writeFile(file, '');
    await truncate(file, MAX_CACHE_BYTES + 1);
    const stub = fetchStub(fixtureRoutes());
    expect(catalogOf(await new AceCatalogProvider({ cacheDir: dir, fetch: stub }).catalogFor(49502))).toEqual(TEST_CATALOG);
    expect(stub.calls).toHaveLength(3);
    expect(vi.mocked(readFile).mock.calls.filter(call => call[0] === file)).toEqual([]);
  });
});

describe('writing the cache', () => {
  it('serves the catalogue from memory with one stderr line when the cache cannot be written', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'r495-2.json'));
    errors.mockClear();
    const lookup = await new AceCatalogProvider({ cacheDir: dir, fetch: fetchStub(fixtureRoutes()) }).catalogFor(49502);
    expect(catalogOf(lookup)).toEqual(TEST_CATALOG);
    const writeLines = errors.mock.calls.filter(call => String(call[0]).includes('from memory only'));
    expect(writeLines).toHaveLength(1);
    expect(String(writeLines[0][0])).not.toContain(dir);
    expect(await readdir(dir)).toEqual(['r495-2.json']);
  });
});

describe('local sources', () => {
  it('refuses sources that give no complete catalogue, local or fetched', async () => {
    const source = await tempDir();
    await cp(join(sourcesRoot, 'r495-2'), join(source, 'r495-2'), { recursive: true });
    await writeFile(join(source, 'r495-2', 'plugins', 'allAces.json'), '{}');
    const local = failureOf(await new AceCatalogProvider({ cacheDir: await tempDir(), sourceDir: source }).catalogFor(49502));
    expect(local.reason).toBe('refused');
    expect('catalog' in local).toBe(false);

    const routes = { ...fixtureRoutes(), [url('r495-2', 'plugins/allAces.json')]: () => new Response('{}', { status: 200 }) };
    const fetched = failureOf(await new AceCatalogProvider({ cacheDir: await tempDir(), fetch: fetchStub(routes) }).catalogFor(49502));
    expect(fetched.reason).toBe('refused');
    expect('catalog' in fetched).toBe(false);
    expect(local.message).toContain('refused');
  });

  it('serves a release from the folder with no request and no cache file', async () => {
    const dir = await tempDir();
    const stub = offlineStub();
    const provider = new AceCatalogProvider({ cacheDir: dir, sourceDir: sourcesRoot, fetch: stub });
    expect(await provider.catalogFor(49502)).toEqual({ ok: true, catalog: TEST_CATALOG, release: 'r495-2' });
    expect(await provider.catalogFor(50602)).toEqual({ ok: true, catalog: TEST_CATALOG, release: 'r495-2', substitute: { why: 'not-served', wanted: 'r506-2' } });
    expect(stub.calls).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('says what the folder lacks', async () => {
    const lookup = failureOf(await new AceCatalogProvider({ cacheDir: await tempDir(), sourceDir: await tempDir() }).catalogFor(50602));
    expect(lookup).toEqual({
      ok: false,
      reason: 'not-served',
      message: 'Conditions, actions and expressions were not checked against Construct\'s definitions: C3_ACE_SOURCE_DIR holds no copy of r506.2 or r495.2.',
    });
  });

  it('refuses a local file over the size cap', async () => {
    const lookup = failureOf(await new AceCatalogProvider({ cacheDir: await tempDir(), sourceDir: sourcesRoot, limits: { maxBytes: 10 } }).catalogFor(49502));
    expect(lookup.reason).toBe('refused');
    expect(lookup.message).toContain('plugins/allAces.json is too large');
  });
});

describe('one attempt per release', () => {
  it('shares one load between concurrent callers', async () => {
    const stub = fetchStub(fixtureRoutes());
    const provider = new AceCatalogProvider({ cacheDir: await tempDir(), fetch: stub });
    const [a, b] = await Promise.all([provider.catalogFor(49502), provider.catalogFor(49502)]);
    expect(catalogOf(a)).toEqual(TEST_CATALOG);
    expect(catalogOf(b)).toEqual(TEST_CATALOG);
    expect(stub.calls).toHaveLength(3);
  });

  it('keeps a failure until the process restarts', async () => {
    const stub = offlineStub();
    const provider = new AceCatalogProvider({ cacheDir: await tempDir(), fetch: stub });
    const first = failureOf(await provider.catalogFor(49502));
    expect(stub.calls).toHaveLength(1);
    expect(await provider.catalogFor(49502)).toEqual(first);
    expect(stub.calls).toHaveLength(1);
    expect(first.message).toBe(
      'Conditions, actions and expressions were not checked against Construct\'s definitions: editor.construct.net could not be reached (ENOTFOUND). Set C3_ACE_SOURCE_DIR to a folder with a local copy to check offline.',
    );
  });
});

describe('no request until asked', () => {
  it('makes none when a provider is built or looked up', () => {
    const stub = offlineStub();
    const provider = new AceCatalogProvider({ cacheDir: 'unused', fetch: stub });
    const reader = {};
    expect(aceCatalogProviderFor(reader)).toBe(defaultAceCatalogProvider());
    expect(defaultAceCatalogProvider()).toBe(defaultAceCatalogProvider());
    setAceCatalogProvider(reader, provider);
    expect(aceCatalogProviderFor(reader)).toBe(provider);
    expect(stub.calls).toEqual([]);
    expect(guardedCalls).toEqual([]);
  });
});

describe('release choice and fallback', () => {
  it('falls back to r495-2 when the release is not served, for a 404 and for a 403', async () => {
    for (const code of [404, 403]) {
      const stub = fetchStub({ ...fixtureRoutes(), [url('r506-2', 'plugins/allAces.json')]: status(code) });
      const lookup = await new AceCatalogProvider({ cacheDir: await tempDir(), fetch: stub }).catalogFor(50602);
      expect(lookup).toEqual({ ok: true, catalog: TEST_CATALOG, release: 'r495-2', substitute: { why: 'not-served', wanted: 'r506-2' } });
      expect(urlsOf(stub)).toEqual([url('r506-2', 'plugins/allAces.json'), ...R495.map(file => url('r495-2', file))]);
      expect(describeCatalogSubstitute(lookup)).toBe(
        'Conditions, actions and expressions were checked against Construct r495.2\'s definitions, because r506.2 is not served.',
      );
    }
  });

  it('names both releases when neither is served', async () => {
    const stub = fetchStub({});
    const lookup = failureOf(await new AceCatalogProvider({ cacheDir: await tempDir(), fetch: stub }).catalogFor(50602));
    expect(lookup.reason).toBe('not-served');
    expect(lookup.message).toBe(
      'Conditions, actions and expressions were not checked against Construct\'s definitions: neither r506.2 nor the fallback r495.2 is served by editor.construct.net.',
    );
    expect(describeCatalogSubstitute(lookup)).toBeUndefined();
  });

  it('does not fall back from an offline or refused answer', async () => {
    const stub = fetchStub({ [url('r506-2', 'plugins/allAces.json')]: status(503) });
    const lookup = failureOf(await new AceCatalogProvider({ cacheDir: await tempDir(), fetch: stub }).catalogFor(50602));
    expect(lookup.reason).toBe('refused');
    expect(lookup.message).toBe(
      'Conditions, actions and expressions were not checked against Construct\'s definitions: the response from editor.construct.net was refused (HTTP 503).',
    );
    expect(stub.calls).toHaveLength(1);
  });

  it('uses the fallback when no release is recorded, and builds no request from a bad value', async () => {
    for (const saved of [undefined, '49502']) {
      const stub = fetchStub(fixtureRoutes());
      const lookup = await new AceCatalogProvider({ cacheDir: await tempDir(), fetch: stub }).catalogFor(saved);
      expect(lookup).toEqual({ ok: true, catalog: TEST_CATALOG, release: 'r495-2', substitute: { why: 'no-release' } });
      expect(urlsOf(stub)).toEqual(R495.map(file => url('r495-2', file)));
      expect(describeCatalogSubstitute(lookup)).toBe(
        'Conditions, actions and expressions were checked against Construct r495.2\'s definitions, because the project records no release.',
      );
    }
  });

  it('says so when the fallback itself is not served', async () => {
    const lookup = failureOf(await new AceCatalogProvider({ cacheDir: await tempDir(), fetch: fetchStub({}) }).catalogFor(undefined));
    expect(lookup.message).toBe('Conditions, actions and expressions were not checked against Construct\'s definitions: r495.2 is not served by editor.construct.net.');
  });
});
