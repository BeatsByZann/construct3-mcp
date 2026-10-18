/**
 * The size limit for the project files the server reads and writes (#ISSUE).
 *
 * The reader refuses an object type, family, event sheet, layout or script
 * file larger than the limit (ProjectReadError E_FILE_TOO_LARGE). The writer
 * refuses to write an entity file or project.c3proj whose new text, as
 * written (tab-indented, in the file's line endings, with its BOM, UTF-8),
 * is larger; writes through replaceFile (images, timelines, scripts, the
 * runtime bridge) are not checked. A file saved compact grows when the
 * server rewrites it, so one under the limit on disk can be over it once
 * written.
 *
 * Memory grows with the project, not only with the file: the cross-reference
 * index parses and keeps every layout under the limit. So the limit is a
 * setting of whoever starts the server, C3MCP_MAX_FILE_MB, not a tool
 * parameter, and its ceiling comes from whole-project measurements (see
 * TROUBLESHOOTING.md, "File too large"). The UID and SID scan and the
 * reference text search stream skipped files and have no limit.
 */

/** The limit without C3MCP_MAX_FILE_MB, in megabytes. */
export const DEFAULT_MAX_FILE_MB = 10;

/**
 * The largest C3MCP_MAX_FILE_MB accepted, in megabytes. Measured on whole
 * projects: seven layouts whose largest is the size (the others about 0.75,
 * 0.5, 0.35, 0.25, 0.25 and 0.12 of it), three event sheets of a tenth of
 * it, an index build (validate_project) and seven update_layer renames, with
 * V8's heap capped at half its default. The generator factor sets how much
 * of each layout is instances; the rest is padding. Factor 0.6 (about 23.5%
 * of each layout is padding): 16, 32, 64 and 128MB passed every counted run,
 * and 256MB ran out of memory in all four runs. Factor 0.7 (about 10%
 * padding): 128MB passed every counted run. 16, 32 and 64MB were not run at
 * 0.7; that they pass there is inferred from 128MB, not measured.
 */
export const MAX_FILE_MB_CEILING = 128;

const MB = 1024 * 1024;

/** The size limit in effect. */
export interface FileSizeLimit {
  megabytes: number;
  bytes: number;
  /** C3MCP_MAX_FILE_MB as set, when it is not a whole number from 1 to MAX_FILE_MB_CEILING (the default applies) */
  ignored?: string;
}

/** The size limit from the server environment (read at each use, so a test can set it). */
export function fileSizeLimit(env: NodeJS.ProcessEnv = process.env): FileSizeLimit {
  const raw = env.C3MCP_MAX_FILE_MB;
  const fallback = { megabytes: DEFAULT_MAX_FILE_MB, bytes: DEFAULT_MAX_FILE_MB * MB };
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!(value >= 1 && value <= MAX_FILE_MB_CEILING)) return { ...fallback, ignored: raw };
  return { megabytes: value, bytes: value * MB };
}

/** The notice that C3MCP_MAX_FILE_MB was set to a value that does not count and the default applies; undefined when it counts or is unset. */
export function describeIgnoredSetting(limit: FileSizeLimit = fileSizeLimit()): string | undefined {
  if (limit.ignored === undefined) return undefined;
  return `C3MCP_MAX_FILE_MB="${limit.ignored.slice(0, 40)}" was ignored: it must be a whole number `
    + `of megabytes from 1 to ${MAX_FILE_MB_CEILING}`;
}

/** "10MB limit (...)" for refusals: the limit, and how to raise it, or that it is at its maximum; when the setting was ignored, "10MB limit; ..." says why, without a second pair of parentheses. */
export function describeFileSizeLimit(limit: FileSizeLimit = fileSizeLimit()): string {
  const ignored = describeIgnoredSetting(limit);
  if (ignored !== undefined) return `${limit.megabytes}MB limit; ${ignored}`;
  if (limit.megabytes >= MAX_FILE_MB_CEILING) return `${limit.megabytes}MB limit (the largest C3MCP_MAX_FILE_MB allows)`;
  return `${limit.megabytes}MB limit (the server setting C3MCP_MAX_FILE_MB raises it)`;
}

/** A size for a refusal: in MB with one decimal, or in bytes when that would round to the limit or below it. */
export function describeSize(bytes: number, limit: FileSizeLimit): string {
  const megabytes = (bytes / MB).toFixed(1);
  return Number(megabytes) > limit.megabytes ? `${megabytes}MB` : `${bytes} bytes`;
}
