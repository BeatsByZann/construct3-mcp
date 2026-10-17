/** A gate a test opens by hand, to hold one operation at a chosen point while another runs. */
export function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

/** Run `operation` and track whether it has settled (resolved or rejected). */
export function track<T>(operation: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const promise = operation.finally(() => { done = true; });
  return { promise, settled: () => done };
}

/** Give other pending work a chance to run (it reaches a lock, or finishes when nothing holds it). */
export async function letOthersRun(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}
