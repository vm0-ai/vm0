import { command, computed, state, type Command } from "ccstate";
import { onRef, withCleanup } from "./utils.ts";

const pendingConnections$ = state<ReadonlySet<symbol>>(new Set());
const progressDismissed$ = state(false);
const progressDialogRequested$ = state(false);
const connectionDialogs$ = state(0);

export const connectorConnectionPending$ = computed((get) => {
  return get(pendingConnections$).size > 0;
});

export const connectorConnectionProgressActive$ = computed((get) => {
  return (
    get(connectorConnectionPending$) &&
    get(progressDialogRequested$) &&
    !get(progressDismissed$)
  );
});

export const connectorConnectionProgressVisible$ = computed((get) => {
  return (
    get(connectorConnectionProgressActive$) && get(connectionDialogs$) === 0
  );
});

export const dismissConnectorConnectionProgress$ = command(({ set }) => {
  set(progressDismissed$, true);
});

/** Existing connection dialogs own their feedback until they unmount. */
export const registerConnectorConnectionDialog$ = onRef(
  command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
    set(connectionDialogs$, (count) => {
      return count + 1;
    });
    signal.addEventListener(
      "abort",
      () => {
        set(connectionDialogs$, (count) => {
          return count - 1;
        });
      },
      { once: true },
    );
  }),
);

/** Keep feedback visible through nested connection commands and continuations. */
export function withConnectorConnectionProgress<T, Args extends unknown[]>(
  source$: Command<Promise<T>, [...Args, AbortSignal]>,
  {
    showDialog = false,
  }: {
    readonly showDialog?: boolean;
  } = {},
): Command<Promise<T>, [...Args, AbortSignal]> {
  const tracked$ = command(
    async (
      { get, set },
      args: [...Args, AbortSignal],
      signal: AbortSignal,
    ): Promise<T> => {
      signal.throwIfAborted();
      if (!get(connectorConnectionPending$)) {
        set(progressDismissed$, false);
        // Most entry points already show connecting feedback. Only callers
        // without visible feedback opt in to the shared dialog.
        set(progressDialogRequested$, showDialog);
      }
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
