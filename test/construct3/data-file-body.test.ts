import { afterEach, describe, it, expect, vi } from 'vitest';
import { MAX_ARRAY_CELLS, buildDataFileBody, projectFileMimeType } from '../../src/construct3/data-file-body.js';

/**
 * Run `build` with Array.from counting its calls (through the original). The
 * spy throws on its MAX_ARRAY_CELLS + 1-th call, so a missing guard fails
 * quickly instead of allocating the arrays. Returns what build threw and the
 * number of calls.
 */
function buildWithSpy(build: () => unknown): { error: unknown; calls: number } {
  const original = Array.from.bind(Array) as (...args: unknown[]) => unknown[];
  let calls = 0;
  const spy = vi.spyOn(Array, 'from').mockImplementation(((...args: unknown[]) => {
    calls += 1;
    if (calls > MAX_ARRAY_CELLS) throw new Error('test error: Array.from called too often');
    return original(...args);
  }) as unknown as typeof Array.from);
  let error: unknown;
  try {
    build();
  } catch (caught) {
    error = caught;
  } finally {
    spy.mockRestore();
  }
  return { error, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildDataFileBody array', () => {
  it('builds a default array of zeros, compact', () => {
    const { body, type } = buildDataFileBody('array', undefined, [2, 3, 1]);
    expect(type).toBe('application/json');
    expect(body).toBe('{"c2array":true,"size":[2,3,1],"data":[[[0],[0],[0]],[[0],[0],[0]]]}');
    expect(buildDataFileBody('array', undefined, undefined).body).toBe('{"c2array":true,"size":[1,1,1],"data":[[[0]]]}');
  });

  it('keeps supplied data of the right shape', () => {
    const { body } = buildDataFileBody('array', '[[[1],[2]]]', [1, 2, 1]);
    expect(body).toBe('{"c2array":true,"size":[1,2,1],"data":[[[1],[2]]]}');
  });

  it('refuses a wrong column, row or depth count', () => {
    expect(() => buildDataFileBody('array', '[[[1]]]', [2, 1, 1]))
      .toThrow('content for kind "array" must be a JSON array of 2 column(s) to match arraySize.');
    expect(() => buildDataFileBody('array', '[[[1]]]', [1, 2, 1]))
      .toThrow('content for kind "array" must nest 2 row(s) in every column to match arraySize.');
    expect(() => buildDataFileBody('array', '[[[1]]]', [1, 1, 2]))
      .toThrow('content for kind "array" must nest 2 value(s) in every cell to match arraySize.');
  });

  it('builds an array of exactly MAX_ARRAY_CELLS cells', () => {
    const { body } = buildDataFileBody('array', undefined, [1000, 1000, 1]);
    expect(body.startsWith('{"c2array":true,"size":[1000,1000,1],"data":[[[0],[0]')).toBe(true);
  });

  it('refuses more than MAX_ARRAY_CELLS cells before building anything', () => {
    const { error, calls } = buildWithSpy(() => buildDataFileBody('array', undefined, [1001, 1000, 1]));
    expect(String(error)).toContain('holds 1001000 cells');
    expect(calls).toBe(0);
  });

  it('does not let a zero depth get round the limit', () => {
    const { error, calls } = buildWithSpy(() => buildDataFileBody('array', undefined, [10000, 10000, 0]));
    expect(String(error)).toContain('holds 100000000 cells');
    expect(calls).toBe(0);
  });

  it('bounds each dimension, so a zero dimension cannot build a billion arrays', () => {
    for (const size of [[1e9, 0, 1], [0, 1e9, 1], [1, 0, 1e9], [10001, 0, 1]]) {
      const { error, calls } = buildWithSpy(() => buildDataFileBody('array', undefined, size));
      expect(String(error), size.join(',')).toContain('has a dimension that is not a whole number from 0 to 10000');
      expect(calls).toBe(0);
    }
  });

  it('refuses a negative, fractional or NaN dimension', () => {
    for (const size of [[-1, 1, 1], [1.5, 1, 1], [1, Number.NaN, 1]]) {
      expect(() => buildDataFileBody('array', undefined, size), size.join(',')).toThrow('has a dimension that is not a whole number');
    }
  });

  it('builds a zero depth within the limit and the shapes with no cells', () => {
    const flat = JSON.parse(buildDataFileBody('array', undefined, [1000, 1000, 0]).body) as { size: number[]; data: unknown[][] };
    expect(flat.size).toEqual([1000, 1000, 0]);
    expect(flat.data).toHaveLength(1000);
    expect(flat.data[0]).toHaveLength(1000);
    expect(flat.data[0][0]).toEqual([]);

    const noRows = JSON.parse(buildDataFileBody('array', undefined, [10000, 0, 10000]).body) as { size: number[]; data: unknown[][] };
    expect(noRows.size).toEqual([10000, 0, 10000]);
    expect(noRows.data).toHaveLength(10000);
    expect(noRows.data[0]).toEqual([]);

    const noColumns = JSON.parse(buildDataFileBody('array', undefined, [0, 10000, 10000]).body) as { size: number[]; data: unknown[] };
    expect(noColumns.size).toEqual([0, 10000, 10000]);
    expect(noColumns.data).toEqual([]);
  });
});

describe('buildDataFileBody dictionary, json and text', () => {
  it('builds a default dictionary and keeps a supplied one', () => {
    expect(buildDataFileBody('dictionary', undefined, undefined)).toEqual({ body: '{"c2dictionary":true,"data":{}}', type: 'application/json' });
    expect(buildDataFileBody('dictionary', '{"a": 1}', undefined).body).toBe('{"c2dictionary":true,"data":{"a":1}}');
  });

  it('refuses a dictionary whose content is not an object', () => {
    expect(() => buildDataFileBody('dictionary', '[1]', undefined)).toThrow('must be a JSON object holding the dictionary keys.');
    expect(() => buildDataFileBody('dictionary', 'null', undefined)).toThrow('must be a JSON object holding the dictionary keys.');
    expect(() => buildDataFileBody('dictionary', '3', undefined)).toThrow('must be a JSON object holding the dictionary keys.');
  });

  it('writes json exactly as given, and {} without content', () => {
    const text = '{"levels":3,"big":12345678901234567890}';
    expect(buildDataFileBody('json', text, undefined)).toEqual({ body: text, type: 'application/json' });
    expect(buildDataFileBody('json', undefined, undefined)).toEqual({ body: '{}', type: 'application/json' });
  });

  it('writes text as given', () => {
    expect(buildDataFileBody('text', 'a\r\nb', undefined)).toEqual({ body: 'a\r\nb', type: 'text/plain' });
    expect(buildDataFileBody('text', undefined, undefined)).toEqual({ body: '', type: 'text/plain' });
  });

  it('refuses malformed JSON with the parser reason', () => {
    for (const kind of ['array', 'dictionary', 'json'] as const) {
      expect(() => buildDataFileBody(kind, '{"a":', [1, 1, 1]), kind).toThrow(new RegExp(`content for kind "${kind}" is not valid JSON: .+`));
    }
    let reason = '';
    try {
      JSON.parse('{"a":');
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    expect(() => buildDataFileBody('json', '{"a":', undefined)).toThrow(reason);
  });
});

describe('projectFileMimeType', () => {
  it('maps the known extensions', () => {
    const expected: Record<string, string> = {
      'a.json': 'application/json',
      'a.js': 'application/javascript',
      'a.css': 'text/css',
      'a.html': 'text/html',
      'a.htm': 'text/html',
      'a.jpeg': 'image/jpeg',
      'a.svg': 'image/svg+xml',
      'a.txt': 'text/plain',
      'a.png': 'image/png',
      'a.jpg': 'image/jpeg',
      'a.webm': 'video/webm',
      'a.mp4': 'video/mp4',
      'a.ogg': 'audio/ogg',
      'a.wav': 'audio/wav',
      'a.mp3': 'audio/mpeg',
    };
    for (const [name, mime] of Object.entries(expected)) expect(projectFileMimeType(name), name).toBe(mime);
    expect(projectFileMimeType('A.JSON')).toBe('application/json');
  });

  it('falls back to octet-stream and honors an explicit type', () => {
    expect(projectFileMimeType('a.xyz')).toBe('application/octet-stream');
    expect(projectFileMimeType('a.json', 'text/x-custom')).toBe('text/x-custom');
  });
});
