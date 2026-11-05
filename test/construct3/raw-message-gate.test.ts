import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** A line in `src` that interpolates a caught error's message raw, and why it may stay that way. */
interface RawMessageSite {
  /** The file, relative to the repository root, with forward slashes. */
  file: string;
  /** The line's text with leading and trailing white space removed. */
  text: string;
  /** Why the raw message is safe or intended at this site. */
  reason: string;
}

/**
 * Every place in `src` that words a caught error as `<v> instanceof Error ? <v>.message : String(<v>)` without
 * `errorMessage` (src/construct3/error-text.ts), which strips absolute paths. A tool message must not carry an
 * absolute path, so a new site is either routed through `errorMessage` or admitted here with a reason.
 */
const ALLOWED: RawMessageSite[] = [
  {
    file: 'src/construct3/ace-catalog-source.ts',
    text: 'const reason = error instanceof Error ? error.message : String(error);',
    reason: 'a JSON.parse SyntaxError on a registration literal taken from the ACE source text: no file path is in it',
  },
  {
    file: 'src/construct3/ace-catalog-source.ts',
    text: 'console.error(`ACE catalogue: ${error instanceof Error ? error.message : String(error)}`);',
    reason: 'console.error to stderr, not a tool message',
  },
  {
    file: 'src/construct3/analyzers/legacy-event-shapes.ts',
    text: 'result.manual.push({ ...hit, detail: error instanceof Error ? error.message : String(error) });',
    reason: 'toPositionalArguments (event-shapes.ts) is pure and throws only its own texts, which quote event parameter values; errorMessage would rewrite a "/x/y" string value',
  },
  {
    file: 'src/construct3/atomic-write.ts',
    text: "return (error instanceof Error ? error.message : String(error)).replace(/\\.+$/, '');",
    reason: 'atomicReplace keeps the fs error text and code for its callers (test/construct3/atomic-write-fallback.test.ts pins it); it has no project folder, so stripping here would call project files outside the project. Its errors reach a tool only through the writer, whose tool catches pass them through errorMessage with the project folder',
  },
  {
    file: 'src/construct3/c3p-archive.ts',
    text: "const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\\.$/, '');",
    reason: 'the .c3p archive messages name the archive file and working folder the caller opened by design (archivePath and sessionDir are interpolated directly in about ten messages); scrubbing only messageOf would leave those, so the archive wording is left for a separate change',
  },
  {
    file: 'src/construct3/data-file-body.ts',
    text: 'throw new Error(`content for kind "${kind}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);',
    reason: 'a JSON.parse SyntaxError on the caller\'s content argument: no file is read, and errorMessage would rewrite a "/x/y" quoted from the content',
  },
  {
    file: 'src/construct3/error-text.ts',
    text: 'return withoutAbsolutePaths(error instanceof Error ? error.message : String(error), projectDir);',
    reason: 'the helper itself: errorMessage passes the message through withoutAbsolutePaths',
  },
  {
    file: 'src/construct3/error-text.ts',
    text: 'const message = error instanceof Error ? error.message : String(error);',
    reason: 'the helper itself: errorReason passes the message through withoutAbsolutePaths on the next line',
  },
  {
    file: 'src/construct3/flowchart-files.ts',
    text: 'const message = error instanceof Error ? error.message : String(error);',
    reason: 'describeError: the message goes through withoutAbsolutePaths(message, projectDir) on the next line',
  },
  {
    file: 'src/construct3/project-writer.ts',
    text: 'super(withoutAbsolutePaths(cause instanceof Error ? cause.message : String(cause), projectDir), { cause });',
    reason: 'EntityWriteError: the message goes through withoutAbsolutePaths(message, projectDir) on the same line',
  },
  {
    file: 'src/construct3/project-writer.ts',
    text: 'throw new Error(`Generated JSON for "${entityName}" is not valid: ${e instanceof Error ? e.message : String(e)}`);',
    reason: 'a JSON.parse SyntaxError on JSON the writer just generated: no file path is in it',
  },
  {
    file: 'src/index.ts',
    text: '`Failed to start server: ${error instanceof Error ? error.message : String(error)}`',
    reason: 'console.error to stderr before exit, not a tool message',
  },
  {
    file: 'src/runtime/cdp-client.ts',
    text: 'reject(new Error(`Failed to send CDP ${method}: ${error instanceof Error ? error.message : String(error)}`));',
    reason: 'a WebSocket send() failure, which names no file; the runtime tools that report it pass their message through errorMessage',
  },
  {
    file: 'src/tools/archive-sync.ts',
    text: "refresh = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };",
    reason: 'the reason of an archive refresh that escaped refresh(); same archive wording as c3p-archive.ts',
  },
  {
    file: 'src/tools/archive-sync.ts',
    text: "sync = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };",
    reason: 'the reason of an archive sync that escaped sync(); same archive wording as c3p-archive.ts',
  },
  {
    file: 'src/tools/call-rollback.ts',
    text: 'const message = error instanceof Error ? error.message : String(error);',
    reason: 'rollBackFailedCall: the message goes through withoutAbsolutePaths(message, writer.projectDir()) a few lines later; the early return carries a StaleFileError message, which is built from project-relative labels',
  },
  {
    file: 'src/tools/replace-tools.ts',
    text: 'return refuse(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);',
    reason: 'a RegExp SyntaxError on the caller\'s pattern: it quotes the pattern as /source/, which errorMessage rewrites to the placeholder',
  },
  {
    file: 'src/tools/tilemap-data-tools.ts',
    text: 'return { error: `The stored tile data cannot be read: ${e instanceof Error ? e.message : String(e)}` };',
    reason: 'decodeTileData (tilemap-data.ts) is pure and throws only its own texts about the stored tile tokens',
  },
  {
    file: 'src/tools/usage-tools.ts',
    text: "const message = (error instanceof Error ? error.message : String(error)).replace(/^Invalid regular expression: /, '');",
    reason: 'a RegExp SyntaxError on the caller\'s pattern, as in replace-tools.ts',
  },
];

const RAW_MESSAGE = /([A-Za-z]+) instanceof Error \? \1\.message : String\(\1\)/;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Every .ts file under a folder, as absolute paths. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** The `<file>: <line text>` key of every raw-message line in `src`, sorted. */
function rawSites(): string[] {
  const keys: string[] = [];
  for (const path of sourceFiles(join(REPO_ROOT, 'src'))) {
    const file = relative(REPO_ROOT, path).replace(/\\/g, '/');
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (RAW_MESSAGE.test(line)) keys.push(`${file}: ${line.trim()}`);
    }
  }
  return keys.sort();
}

describe('raw error messages in src', () => {
  it('are exactly the sites admitted in the allow list, each with a reason', () => {
    const allowed = ALLOWED.map((site) => `${site.file}: ${site.text}`).sort();
    expect(rawSites()).toEqual(allowed);
  });

  it('gives every admitted site a reason', () => {
    for (const site of ALLOWED) expect(site.reason.trim(), `${site.file}: ${site.text}`).not.toBe('');
  });
});
