/**
 * Where the ACE catalogue of a release comes from: a local folder named by
 * C3_ACE_SOURCE_DIR, else the per-user cache file, else a fetch of the
 * editor's files that is then cached. Nothing is requested or read until a
 * check asks for a catalogue, and each release is tried once per process.
 */

import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { AceCatalog } from './ace-types.js';
import {
  ACE_SOURCE_HOST,
  CACHE_DIR_NOT_ABSOLUTE,
  FALLBACK_RELEASE,
  catalogFromSources,
  defaultAceCacheDir,
  fetchCatalogSources,
  readCacheFile,
  readLocalSources,
  releaseFromSaved,
  releaseLabel,
  writeCacheFile,
  type FetchLike,
  type SourceFailure,
  type SourceLimits,
} from './ace-catalog-source.js';

/** A catalogue with the release it is for, or why there is none. */
export type CatalogLookup =
  | { ok: true; catalog: AceCatalog; release: string; substitute?: { why: 'not-served'; wanted: string } | { why: 'no-release' } }
  | { ok: false; reason: 'offline' | 'refused' | 'not-served'; message: string };

/** Where a provider looks, replaceable for tests. */
export interface AceCatalogProviderOptions {
  cacheDir: string;
  /** A folder with `<release>/` copies of the editor's files; when set, nothing is fetched or cached. */
  sourceDir?: string;
  fetch?: FetchLike;
  limits?: Partial<SourceLimits>;
  fallbackRelease?: string;
}

type ReleaseOutcome = { ok: true; catalog: AceCatalog } | SourceFailure;

const UNCHECKED = 'Conditions, actions and expressions were not checked against Construct\'s definitions: ';

/** The message of a failed lookup; `tried` holds the releases looked for, the wanted one first. */
function failureMessage(failed: SourceFailure, tried: string[], local: boolean): string {
  if (failed.reason === 'offline') {
    return `${UNCHECKED}${ACE_SOURCE_HOST} could not be reached (${failed.detail}). Set C3_ACE_SOURCE_DIR to a folder with a local copy to check offline.`;
  }
  if (failed.reason === 'refused' && failed.detail === CACHE_DIR_NOT_ABSOLUTE) {
    return `${UNCHECKED}${CACHE_DIR_NOT_ABSOLUTE}; set C3_ACE_CACHE_DIR to an absolute path.`;
  }
  if (failed.reason === 'refused') {
    return local
      ? `${UNCHECKED}the files in C3_ACE_SOURCE_DIR were refused (${failed.detail}).`
      : `${UNCHECKED}the response from ${ACE_SOURCE_HOST} was refused (${failed.detail}).`;
  }
  const names = tried.map(releaseLabel);
  if (local) return `${UNCHECKED}C3_ACE_SOURCE_DIR holds no copy of ${names.join(' or ')}.`;
  return names.length === 1
    ? `${UNCHECKED}${names[0]} is not served by ${ACE_SOURCE_HOST}.`
    : `${UNCHECKED}neither ${names[0]} nor the fallback ${names[1]} is served by ${ACE_SOURCE_HOST}.`;
}

/** Hands out the catalogue for a release; one attempt per release for the life of the provider. */
export class AceCatalogProvider {
  private readonly options: AceCatalogProviderOptions;
  private readonly outcomes = new Map<string, Promise<ReleaseOutcome>>();

  /** Stores the options; reads nothing and requests nothing. */
  constructor(options: AceCatalogProviderOptions) {
    this.options = options;
  }

  /**
   * The catalogue for the release a project was saved with, or for the
   * fallback release (with `substitute` saying why) when that release is not
   * recorded or not served.
   */
  async catalogFor(savedWithRelease: unknown): Promise<CatalogLookup> {
    const wanted = releaseFromSaved(savedWithRelease);
    const fallback = this.options.fallbackRelease ?? FALLBACK_RELEASE;
    const local = this.options.sourceDir !== undefined;
    const tried = wanted === undefined || wanted === fallback ? [fallback] : [wanted, fallback];
    if (wanted !== undefined) {
      const first = await this.load(wanted);
      if (first.ok) return { ok: true, catalog: first.catalog, release: wanted };
      if (first.reason !== 'not-served' || wanted === fallback) {
        return { ok: false, reason: first.reason, message: failureMessage(first, tried, local) };
      }
    }
    const second = await this.load(fallback);
    if (second.ok) {
      return {
        ok: true,
        catalog: second.catalog,
        release: fallback,
        substitute: wanted === undefined ? { why: 'no-release' } : { why: 'not-served', wanted },
      };
    }
    return { ok: false, reason: second.reason, message: failureMessage(second, tried, local) };
  }

  /** The one attempt for a release; concurrent callers share it and a failure is kept. */
  private load(release: string): Promise<ReleaseOutcome> {
    let outcome = this.outcomes.get(release);
    if (!outcome) {
      outcome = this.loadOnce(release);
      this.outcomes.set(release, outcome);
    }
    return outcome;
  }

  /** Local copy, or cache file, or fetch then cache; both sources pass the same shape check. */
  private async loadOnce(release: string): Promise<ReleaseOutcome> {
    try {
      if (this.options.sourceDir !== undefined) {
        return catalogFromSources(await readLocalSources(this.options.sourceDir, release, this.options.limits?.maxBytes));
      }
      if (!isAbsolute(this.options.cacheDir)) return { ok: false, reason: 'refused', detail: CACHE_DIR_NOT_ABSOLUTE };
      const cached = await readCacheFile(this.options.cacheDir, release);
      if (cached) return { ok: true, catalog: cached };
      const fetchImpl: FetchLike = this.options.fetch ?? ((url, init) => globalThis.fetch(url, init));
      const built = catalogFromSources(await fetchCatalogSources(release, fetchImpl, this.options.limits));
      if (built.ok) {
        const written = await writeCacheFile(this.options.cacheDir, release, built.catalog);
        if (!written.written) console.error(`ACE catalogue ${release} is used from memory only: ${written.reason}`);
      }
      return built;
    } catch (error) {
      return { ok: false, reason: 'refused', detail: `unexpected error (${error instanceof Error ? error.name : 'Error'})` };
    }
  }
}

let defaultProvider: AceCatalogProvider | undefined;

/** The provider of this process, built on first call from the environment; C3_ACE_SOURCE_DIR, when set, means nothing is fetched. */
export function defaultAceCatalogProvider(): AceCatalogProvider {
  if (!defaultProvider) {
    const sourceDir = process.env.C3_ACE_SOURCE_DIR;
    defaultProvider = new AceCatalogProvider({
      cacheDir: defaultAceCacheDir(process.env, process.platform, homedir()),
      ...(sourceDir ? { sourceDir } : {}),
    });
  }
  return defaultProvider;
}

const overrides = new WeakMap<object, AceCatalogProvider>();

/** The provider a reader uses: the one set for it, else the process's. */
export function aceCatalogProviderFor(reader: object): AceCatalogProvider {
  return overrides.get(reader) ?? defaultAceCatalogProvider();
}

/** Use `provider` for a reader instead of the process's. */
export function setAceCatalogProvider(reader: object, provider: AceCatalogProvider): void {
  overrides.set(reader, provider);
}

/** The sentence saying a substitute release was used, or undefined when the project's own was. */
export function describeCatalogSubstitute(lookup: CatalogLookup): string | undefined {
  if (!lookup.ok || !lookup.substitute) return undefined;
  const used = `Conditions, actions and expressions were checked against Construct ${releaseLabel(lookup.release)}'s definitions, because `;
  return lookup.substitute.why === 'no-release'
    ? `${used}the project records no release.`
    : `${used}${releaseLabel(lookup.substitute.wanted)} is not served.`;
}
