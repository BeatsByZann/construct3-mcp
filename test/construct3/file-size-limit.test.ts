/**
 * The project file size limit (#ISSUE): C3MCP_MAX_FILE_MB, whole megabytes
 * from 1 to MAX_FILE_MB_CEILING, 10 by default, a setting of whoever starts
 * the server. Written so that a measured ceiling of 10 (no raise) passes.
 * Synthetic values only.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_MAX_FILE_MB, describeFileSizeLimit, describeSize, fileSizeLimit, MAX_FILE_MB_CEILING } from '../../src/construct3/file-size-limit.js';
import { describeReadFailure } from '../../src/construct3/analyzers/unscanned-uses.js';

const MB = 1024 * 1024;
const canRaise = MAX_FILE_MB_CEILING > DEFAULT_MAX_FILE_MB;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fileSizeLimit', () => {
  it('is 10MB without the setting', () => {
    expect(fileSizeLimit({})).toEqual({ megabytes: 10, bytes: 10 * MB });
    expect(fileSizeLimit({ C3MCP_MAX_FILE_MB: '' })).toEqual({ megabytes: 10, bytes: 10 * MB });
  });

  it('takes a whole number of megabytes from 1 to the ceiling', () => {
    expect(fileSizeLimit({ C3MCP_MAX_FILE_MB: ' 1 ' })).toEqual({ megabytes: 1, bytes: MB });
    expect(fileSizeLimit({ C3MCP_MAX_FILE_MB: String(MAX_FILE_MB_CEILING) }).megabytes).toBe(MAX_FILE_MB_CEILING);
  });

  it('keeps the default for any other value, and says so', () => {
    for (const value of ['0', String(MAX_FILE_MB_CEILING + 1), '1.5', 'abc', '-3', '1e2', '64MB']) {
      const limit = fileSizeLimit({ C3MCP_MAX_FILE_MB: value });
      expect(limit).toEqual({ megabytes: 10, bytes: 10 * MB, ignored: value });
      expect(describeFileSizeLimit(limit)).toBe(`10MB limit (C3MCP_MAX_FILE_MB="${value}" was ignored: it must be a whole number `
        + `of megabytes from 1 to ${MAX_FILE_MB_CEILING})`);
    }
  });

  it('says how to raise the limit, or that it is at its maximum', () => {
    expect(describeFileSizeLimit({ megabytes: 1, bytes: MB })).toBe('1MB limit (the server setting C3MCP_MAX_FILE_MB raises it)');
    expect(describeFileSizeLimit({ megabytes: 10, bytes: 10 * MB })).toBe(canRaise
      ? '10MB limit (the server setting C3MCP_MAX_FILE_MB raises it)'
      : '10MB limit (the largest C3MCP_MAX_FILE_MB allows)');
    expect(describeFileSizeLimit({ megabytes: MAX_FILE_MB_CEILING, bytes: MAX_FILE_MB_CEILING * MB }))
      .toBe(`${MAX_FILE_MB_CEILING}MB limit (the largest C3MCP_MAX_FILE_MB allows)`);
  });

  it('never shows a size that rounds to the limit as over it', () => {
    const limit = { megabytes: 12, bytes: 12 * MB };
    expect(describeSize(12 * MB + 4, limit)).toBe(`${12 * MB + 4} bytes`);
    expect(describeSize(13 * MB, limit)).toBe('13.0MB');
  });

  it('is read from the server environment at each use', () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    expect(fileSizeLimit().megabytes).toBe(1);
    expect(describeReadFailure('E_FILE_TOO_LARGE')).toBe('over the 1MB size limit');
  });

  it('describes a skipped file with the default limit', () => {
    expect(describeReadFailure('E_FILE_TOO_LARGE')).toBe('over the 10MB size limit');
  });

  it('says in a skipped file reason that the setting was ignored', () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1e2');
    expect(describeReadFailure('E_FILE_TOO_LARGE')).toBe('over the 10MB size limit (C3MCP_MAX_FILE_MB="1e2" was ignored: '
      + `it must be a whole number of megabytes from 1 to ${MAX_FILE_MB_CEILING})`);
    expect(describeReadFailure('E_INVALID_JSON')).toBe('not valid JSON');
  });
});
