// Test-only storage for Next.js `after()` callbacks captured by the
// next/server mock in setup.ts. Exposed as module-scoped arrays so tests
// can import them directly instead of reaching through globalThis.

// The arrays are mutated in place (never reassigned) so every importer
// shares the same reference across the test lifecycle. Call
// `resetNextAfterHooks()` from lifecycle hooks or between drain loops.

export const nextAfterCallbacks: Array<() => unknown | Promise<unknown>> = [];

// Per-call record of the after() argument form: "fn" when called with a
// callback, "promise" when called with an already-started promise. Callback
// form is required for nested after() to propagate the Next.js request
// context — promise form defers a chain that may register nested after()
// calls after the context has been finalized.
export const nextAfterArgForms: Array<"fn" | "promise"> = [];

const MAX_ASYNC_HOOK_DRAIN_PASSES = 100;

export async function flushNextAsyncHooks(): Promise<void> {
  let passes = 0;
  while (nextAfterCallbacks.length > 0) {
    passes++;
    if (passes > MAX_ASYNC_HOOK_DRAIN_PASSES) {
      throw new Error("Exceeded async hook drain limit");
    }

    const callbacks = [...nextAfterCallbacks];
    nextAfterCallbacks.length = 0;
    await Promise.all(
      callbacks.map((fn) => {
        return fn();
      }),
    );
  }
}

export function resetNextAfterHooks(): void {
  nextAfterCallbacks.length = 0;
  nextAfterArgForms.length = 0;
}
