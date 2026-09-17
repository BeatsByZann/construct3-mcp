/** Remove absolute filesystem paths from client-visible error text. */
export function redactFsPaths(message: string): string {
  // Node filesystem errors quote their paths (including both rename/copy operands).
  // Greedy per-line matching also handles apostrophes inside a quoted path.
  const redacted = message.replace(/(['"`])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*\1/g, '[path]');
  // Other libraries can emit unquoted paths. Their boundary is ambiguous when
  // spaces are legal, so suppress the message rather than returning a fragment.
  if (/(?:[A-Za-z]:[\\/]|\\\\|(?:^|[\s(=])\/[^\s])/m.test(redacted)) {
    return 'Operation failed; filesystem path details omitted.';
  }
  return redacted;
}
