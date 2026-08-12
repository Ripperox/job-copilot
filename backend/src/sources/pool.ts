/**
 * Run tasks with a fixed number in flight.
 *
 * Both enterprise ATS sources need a second request per posting to get the full
 * description — the list endpoints return titles only, or a blurb. `Promise.all`
 * over a hundred of those opens a hundred sockets against one employer's server
 * at once, which is the behaviour that gets a scraper rate-limited or blocked.
 * A worker pool keeps the concurrency at a number a stranger's site can absorb.
 *
 * Results stay in input order regardless of completion order, so a caller can
 * zip them against the list they came from by index.
 */
export async function pooled<T>(tasks: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(width, tasks.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= tasks.length) return;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}
