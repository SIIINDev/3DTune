/* A fixed sleep encodes a guess about how long something takes, so it is both slow when the guess
   is generous and flaky when the machine is loaded. Wait for the condition instead: the test
   proceeds the moment it holds, and fails with a useful message if it never does. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
  pollMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/* Some assertions are about state that has already settled and only needs the event loop to drain
   (a throttled broadcast, a queued microtask). This is bounded and does not encode a duration. */
export async function settle(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}
