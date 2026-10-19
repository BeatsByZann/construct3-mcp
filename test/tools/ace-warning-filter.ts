/**
 * The event tools now check the conditions and actions they write against the
 * catalogue. Tests whose subject is another warning use ids the hand-written
 * catalogue fixture does not hold (every-tick, else, is-visible); this removes
 * the catalogue's "defines no condition/action" lines so they assert on the
 * warnings that are their subject.
 */
export function withoutAceLookupWarnings(warnings: string[] | undefined): string[] {
  return (warnings ?? []).filter(w => !/: Construct r\d+(\.\d+)? defines no (condition|action) /.test(w));
}
