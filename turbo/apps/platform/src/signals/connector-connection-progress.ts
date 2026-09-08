import { command, computed, state, type Command } from "ccstate";
import { withCleanup } from "./utils.ts";

const pendingConnections$ = state<ReadonlySet<symbol>>(new Set());

export const connectorConnectionPending$ = computed((get) => {
  return get(pendingConnections$).size > 0;
});

/** Keep feedback visible through nested connection commands and continuations. */
export function withConnectorConnectionProgress<T, Args extends unknown[]>(
  source$: Command<Promise<T>, [...Args, AbortSignal]>,
): Command<Promise<T>, [...Args, AbortSignal]> {
  const tracked$ = command(
    async (
      { set },
      args: [...Args, AbortSignal],
      signal: AbortSignal,
    ): Promise<T> => {
      signal.throwIfAborted();
      const invocation = Symbol();
      set(pendingConnections$, (pending) => {
        return new Set([...pending, invocation]);
      });
      const release = () => {
        set(pendingConnections$, (pending) => {
          if (!pending.has(invocation)) {
            return pending;
          }
          const remaining = new Set(pending);
          remaining.delete(invocation);
          return remaining;
        });
      };
      signal.addEventListener("abort", release, { once: true });

      return await withCleanup(
        (async () => {
          // Invoke synchronously so window.open retains the click's user activation.
          return await set(source$, ...args);
        })(),
        () => {
          signal.removeEventListener("abort", release);
          release();
        },
      );
    },
  );

  return command(({ set }, ...args: [...Args, AbortSignal]) => {
    // TypeScript cannot address the last element of a generic variadic tuple.
    const signal = args[args.length - 1] as AbortSignal;
    return set(tracked$, args, signal);
  });
}
