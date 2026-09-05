import { command, state, type Command } from "ccstate";
import { withCleanup } from "../utils.ts";

type LoadDraftCommand = Command<Promise<void>, [AbortSignal]>;

interface PendingDraftHydration {
  readonly promise: Promise<void>;
  readonly signal: AbortSignal;
}

/** Share the initial draft load between route setup and composer actions. */
export function createDraftHydrationCommand() {
  const hydrated$ = state(false);
  const pending$ = state<PendingDraftHydration | null>(null);
  const load$ = command(
    async ({ set }, loader: LoadDraftCommand, signal: AbortSignal) => {
      await set(loader, signal);
      signal.throwIfAborted();
      set(hydrated$, true);
    },
  );

  return command(
    async ({ get, set }, loader: LoadDraftCommand, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (get(hydrated$)) {
        return;
      }
      const pending = get(pending$);
      if (pending && !pending.signal.aborted) {
        await pending.promise;
        signal.throwIfAborted();
        return;
      }

      // A cached draft can outlive the route that began loading it. A new
      // owner must be able to retry an aborted or failed initial load.
      const loading = set(load$, loader, signal);
      set(pending$, { promise: loading, signal });
      await withCleanup(loading, () => {
        if (get(pending$)?.promise === loading) {
          set(pending$, null);
        }
      });
    },
  );
}
