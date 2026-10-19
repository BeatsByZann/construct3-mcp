import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACE_SOURCE_FILES,
  sourceUrl,
  type FetchLike,
} from '../../src/construct3/ace-catalog-source.js';

/** One recorded call of a stub. */
export interface StubCall { url: string; init: { redirect: 'manual'; signal: AbortSignal } }
/** A fetch that records its calls. */
export type FetchStub = FetchLike & { calls: StubCall[] };

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ace-source');

/** A fetch that answers from `routes` by exact URL, records each call, and answers an unrouted URL with 404. */
export function fetchStub(routes: Record<string, () => Response | Promise<Response>>): FetchStub {
  const calls: StubCall[] = [];
  const stub = ((url, init) => {
    calls.push({ url, init });
    const route = Object.hasOwn(routes, url) ? routes[url] : undefined;
    return Promise.resolve(route ? route() : new Response('', { status: 404 }));
  }) as FetchStub;
  stub.calls = calls;
  return stub;
}

/** Routes serving the fixture files of `release` under the URLs of release `as`. */
export function fixtureRoutes(release = 'r495-2', as: string = release): Record<string, () => Response> {
  const routes: Record<string, () => Response> = {};
  for (const file of ACE_SOURCE_FILES) {
    routes[sourceUrl(as, file)] = () => new Response(readFileSync(join(sourceRoot, release, file)), { status: 200 });
  }
  return routes;
}

/** A fetch that records its calls and fails each with a network error whose code is `code`. */
export function offlineStub(code = 'ENOTFOUND'): FetchStub {
  const calls: StubCall[] = [];
  const stub = ((url, init) => {
    calls.push({ url, init });
    return Promise.reject(new TypeError('fetch failed', { cause: { code } }));
  }) as FetchStub;
  stub.calls = calls;
  return stub;
}

/** A fetch that never answers; it rejects with the signal's reason once the signal aborts. */
export const neverAnswers: FetchLike = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });

/** A response whose body arrives in chunks. */
export function streamOf(chunks: Array<string | Uint8Array>, headers: Record<string, string> = {}): Response & { cancelled: () => boolean } {
  let index = 0;
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) controller.close();
      else {
        const chunk = chunks[index++];
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return Object.assign(new Response(body, { status: 200, headers }), { cancelled: () => cancelled });
}

/** The calls the network guard saw. */
export const guardedCalls: string[] = [];

/** Replace globalThis.fetch with a function that throws; returns the function that restores it. */
export function guardNetwork(): () => void {
  const original = globalThis.fetch;
  guardedCalls.length = 0;
  globalThis.fetch = ((input: unknown) => {
    guardedCalls.push(String(input));
    throw new Error('network used in a test');
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}
