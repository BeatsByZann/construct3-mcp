/**
 * Error text for tool messages without absolute paths. A path inside the
 * project folder becomes its project-relative form (written with `/`, the
 * folder alone as "."); every other absolute path becomes
 * "<a path outside the project>".
 *
 * Known risk: an unquoted POSIX path with a space in a segment is cut at the
 * space, so the part after the space stays in the text. Node's fs messages
 * quote their paths, and fs errors are worded from their `code` and `path`
 * fields (errorReason), so this reaches only a message that prints a POSIX
 * path unquoted.
 */

/** What replaces a path that is not inside the project folder. */
const OUTSIDE_PATH = '<a path outside the project>';

/**
 * Where an absolute path starts: a drive letter (not preceded by a letter,
 * digit or "/", so "https://" is not one), a UNC prefix, or a POSIX root
 * (not preceded by a word character, ".", ":", "\", "/", "~" or "-", and
 * followed by a word character, ".", "~" or "-").
 */
const PATH_START = /(?<![A-Za-z0-9/])[A-Za-z]:[\\/]|(?<!\w)\\\\|(?<![\w.:\\/~-])\/(?=[\w.~-])/g;

/** The rest of a drive-letter or UNC path: segments joined by "\" or "/", each free of the characters no file name holds. */
const PATH_SEGMENTS = /[^:'"<>|*?\\/\r\n]*(?:[\\/][^:'"<>|*?\\/\r\n]*)*/y;

/**
 * Where the last segment of an unquoted drive-letter or UNC path ends: before " -> ", ", " or "; ", at a full stop
 * followed by a space or the end, or at the space after a file extension. (A path also ends before a ")" that
 * closes a bracket opened before it; see closingBracket.)
 */
const LAST_SEGMENT_END = / -> |, |; |\.(?: |$)|(?<=\.[A-Za-z0-9]+) /;

/** A drive letter at the end of a segment, when the next path starts there: the segment ends before it. */
const NEXT_DRIVE_LETTER = / [A-Za-z]$/;

/** The rest of an unquoted POSIX path: up to the first whitespace, quote or ")". */
const POSIX_RUN = /[^\s'")]*/y;

/**
 * The index of the first ")" in a path run that closes a bracket opened before the path,
 * that is, a ")" whose segment holds no "(" before it ("Games (old)" keeps its ")"), or undefined.
 */
function closingBracket(run: string): number | undefined {
  let opened = false;
  for (let i = 0; i < run.length; i++) {
    const char = run[i];
    if (char === '\\' || char === '/') opened = false;
    else if (char === '(') opened = true;
    else if (char === ')') {
      if (!opened) return i;
      opened = false;
    }
  }
  return undefined;
}

/**
 * The end of the path that starts at `start`, or undefined when the text there is not a path.
 * `folder` is the project folder in comparable form, or '' when there is none.
 */
function pathEnd(text: string, start: number, prefix: string, folder: string): number | undefined {
  const quote = text[start - 1];
  if (quote === '\'' || quote === '"') {
    const closing = text.indexOf(quote, start);
    if (closing !== -1 && !/[\r\n]/.test(text.slice(start, closing))) return closing;
  }
  const bodyStart = start + prefix.length;
  if (prefix !== '/') {
    PATH_SEGMENTS.lastIndex = bodyStart;
    const runEnd = PATH_SEGMENTS.exec(text)?.[0].length ?? 0;
    const fullRun = text.slice(bodyStart, bodyStart + runEnd);
    const closing = closingBracket(fullRun);
    const run = closing === undefined ? fullRun : fullRun.slice(0, closing);
    const lastSegment = run.slice(Math.max(run.lastIndexOf('\\'), run.lastIndexOf('/')) + 1);
    const nextIsDrive = closing === undefined && /^:[\\/]/.test(text.slice(bodyStart + run.length, bodyStart + run.length + 2));
    const ends = [LAST_SEGMENT_END.exec(lastSegment)?.index, nextIsDrive ? NEXT_DRIVE_LETTER.exec(lastSegment)?.index : undefined];
    const cut = Math.min(lastSegment.length, ...ends.filter((end): end is number => end !== undefined));
    const end = bodyStart + run.length - lastSegment.length + cut;
    // The project folder followed by a space and words, with no separator after them, is the folder and then text
    const folderEnd = start + folder.length;
    if (folder !== '' && comparable(text.slice(start, folderEnd)) === folder && text[folderEnd] === ' ' && end > folderEnd
      && !/[\\/]/.test(text.slice(folderEnd, end))) return folderEnd;
    return end;
  }
  POSIX_RUN.lastIndex = bodyStart;
  const run = (POSIX_RUN.exec(text)?.[0] ?? '').replace(/[.,:;]+$/, '');
  // An unquoted POSIX path needs a second "/" ("Self.X /Self.Y" is a division)
  return run.includes('/') ? bodyStart + run.length : undefined;
}

/** A path in one slash form with the drive letter in lower case, for comparing with the project folder. */
function comparable(path: string): string {
  return path.replace(/\\/g, '/').replace(/(?<!^)\/{2,}/g, '/').replace(/^[A-Za-z]:/, drive => drive.toLowerCase());
}

/**
 * What `path` is shown as: a relative path as it is (the `path` field of an fs error that is relative is taken
 * as project-relative already); an absolute one in its project-relative form when it is the project folder or
 * inside it, else a placeholder.
 */
function shownPath(path: string, projectDir: string | undefined): string {
  if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)) return path;
  if (projectDir === undefined || projectDir === '') return OUTSIDE_PATH;
  const folder = comparable(projectDir).replace(/\/+$/, '');
  const full = comparable(path);
  if (full === folder || full === `${folder}/`) return '.';
  if (!full.startsWith(`${folder}/`)) return OUTSIDE_PATH;
  const rest = full.slice(folder.length + 1).replace(/\/+$/, '');
  return rest === '' ? '.' : rest;
}

/**
 * The text with every absolute path (drive letter, UNC or POSIX root)
 * replaced: a path inside `projectDir` by its project-relative form, any other
 * by "<a path outside the project>". The text around a path is kept.
 */
export function withoutAbsolutePaths(text: string, projectDir?: string): string {
  const folder = projectDir === undefined ? '' : comparable(projectDir).replace(/\/+$/, '');
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(PATH_START)) {
    if (match.index < cursor) continue;
    const end = pathEnd(text, match.index, match[0], folder);
    if (end === undefined) continue;
    result += text.slice(cursor, match.index) + shownPath(text.slice(match.index, end), projectDir);
    cursor = end;
  }
  return result + text.slice(cursor);
}

/**
 * An error's message (any other thrown value as text) with its final full
 * stop kept and every absolute path replaced as withoutAbsolutePaths does.
 */
export function errorMessage(error: unknown, projectDir?: string): string {
  return withoutAbsolutePaths(error instanceof Error ? error.message : String(error), projectDir);
}

/**
 * An error's text for a message, without its final full stop so a sentence
 * can follow. An fs error (a `code` and a `path`) is worded from those two
 * fields as "<code> on <path>", `context.relative` giving the path (else the
 * path shown as withoutAbsolutePaths shows one); any other error is its
 * message through withoutAbsolutePaths.
 */
export function errorReason(
  error: unknown,
  context: { projectDir?: string; relative?: (path: string) => string },
): string {
  if (typeof error === 'object' && error !== null) {
    const { code, path } = error as { code?: unknown; path?: unknown };
    if (typeof code === 'string' && typeof path === 'string') {
      return `${code} on ${context.relative === undefined ? shownPath(path, context.projectDir) : context.relative(path)}`;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  // The full stop is dropped first: one that follows a path stays outside it, and a path that becomes "." must keep its own
  return withoutAbsolutePaths(message.replace(/\.$/, ''), context.projectDir);
}
