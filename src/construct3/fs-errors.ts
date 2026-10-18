/**
 * fs errors in messages. A Node fs error's message spells out the absolute
 * path it failed on; messages of this server name files by their path in
 * the project instead.
 */

/**
 * An error's text for a tool message without absolute paths: an fs error
 * (it carries a code and the path it failed on, which its message spells
 * out absolutely) as "<code> on <path in the project>", `relative` giving
 * that path; any other error's message as it is (the writer's own messages
 * name files project-relative). For an EntityWriteError the fs error is
 * its cause.
 */
export function fileErrorText(error: unknown, relative: (path: string) => string): string {
  const isFsError = (e: unknown): e is { code: string; path: string } => typeof e === 'object' && e !== null
    && typeof (e as { code?: unknown }).code === 'string' && typeof (e as { path?: unknown }).path === 'string';
  const fsError = [error, error instanceof Error ? error.cause : undefined].find(isFsError);
  if (fsError !== undefined) return `${fsError.code} on ${relative(fsError.path)}`;
  return error instanceof Error ? error.message : String(error);
}
