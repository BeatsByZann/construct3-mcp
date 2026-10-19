/**
 * Bodies of the data files create_data_file writes (Array and Dictionary
 * plugin files, JSON, text) and the MIME type of a Project File by its
 * extension.
 */

import { extname } from 'node:path';

/** The MIME type recorded for a Project File: the explicit one, else by extension. */
export function projectFileMimeType(name: string, explicit?: string): string {
  if (explicit) return explicit;
  switch (extname(name).toLowerCase()) {
    case '.json': return 'application/json';
    case '.js': return 'application/javascript';
    case '.css': return 'text/css';
    case '.html': case '.htm': return 'text/html';
    case '.svg': return 'image/svg+xml';
    case '.txt': return 'text/plain';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webm': return 'video/webm';
    case '.mp4': return 'video/mp4';
    case '.ogg': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    default: return 'application/octet-stream';
  }
}

/** Kinds of data file create_data_file can write. */
export type DataFileKind = 'array' | 'dictionary' | 'json' | 'text';

/** The most cells a default or supplied Array file may have: the body is built in memory. */
export const MAX_ARRAY_CELLS = 1_000_000;

/** Parse the content of a data file; the refusal names the kind and carries the parser's reason. */
function parseJsonArgument(content: string, kind: DataFileKind): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`content for kind "${kind}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Build the file body Construct 3 expects for a data file.
 *
 * Array files are `{"c2array":true,"size":[w,h,d],"data":[[[...]]]}` and
 * Dictionary files are `{"c2dictionary":true,"data":{}}`; both are the shapes
 * the Array and Dictionary plugins load through AJAX. JSON and text files are
 * written verbatim for a project that reads them itself.
 */
export function buildDataFileBody(
  kind: DataFileKind,
  content: string | undefined,
  arraySize: number[] | undefined,
): { body: string; type: string } {
  if (kind === 'array') {
    const width = arraySize?.[0] ?? 1;
    const height = arraySize?.[1] ?? 1;
    const depth = arraySize?.[2] ?? 1;
    const cells = width * height * Math.max(depth, 1);
    if (cells > MAX_ARRAY_CELLS) {
      throw new Error(
        `arraySize [${width}, ${height}, ${depth}] holds ${cells} cells (a depth of 0 counts as 1); create_data_file builds arrays of up to ${MAX_ARRAY_CELLS} cells.`,
      );
    }
    let data: unknown;
    if (content !== undefined) {
      const parsed = parseJsonArgument(content, kind);
      if (!Array.isArray(parsed) || parsed.length !== width) {
        throw new Error(`content for kind "array" must be a JSON array of ${width} column(s) to match arraySize.`);
      }
      for (const column of parsed) {
        if (!Array.isArray(column) || column.length !== height) {
          throw new Error(`content for kind "array" must nest ${height} row(s) in every column to match arraySize.`);
        }
        for (const cell of column) {
          if (!Array.isArray(cell) || cell.length !== depth) {
            throw new Error(`content for kind "array" must nest ${depth} value(s) in every cell to match arraySize.`);
          }
        }
      }
      data = parsed;
    } else {
      data = Array.from({ length: width }, () =>
        Array.from({ length: height }, () => Array.from({ length: depth }, () => 0)));
    }
    return { body: JSON.stringify({ c2array: true, size: [width, height, depth], data }), type: 'application/json' };
  }

  if (kind === 'dictionary') {
    let data: unknown = {};
    if (content !== undefined) {
      const parsed = parseJsonArgument(content, kind);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('content for kind "dictionary" must be a JSON object holding the dictionary keys.');
      }
      data = parsed;
    }
    return { body: JSON.stringify({ c2dictionary: true, data }), type: 'application/json' };
  }

  if (kind === 'json') {
    const text = content ?? '{}';
    parseJsonArgument(text, kind);
    return { body: text, type: 'application/json' };
  }

  return { body: content ?? '', type: 'text/plain' };
}
