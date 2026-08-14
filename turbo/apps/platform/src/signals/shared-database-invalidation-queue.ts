import { command, computed } from "ccstate";
import {
  sharedDatabaseDataKeyId,
  type SharedDatabaseDataKey,
} from "../shared-database/data-key.ts";
import { rootSignal$ } from "./root-signal.ts";
import { createDeferredPromise } from "./utils.ts";

interface InvalidationQueue {
  readonly pending: Map<string, SharedDatabaseDataKey>;
  wake: ReturnType<typeof createDeferredPromise<void>>;
}

const invalidationQueue$ = computed((get): InvalidationQueue => {
  return {
    pending: new Map(),
    wake: createDeferredPromise<void>(get(rootSignal$)),
  };
});

export const enqueueSharedDatabaseInvalidation$ = command(
  ({ get }, dataKey: SharedDatabaseDataKey): void => {
    const queue = get(invalidationQueue$);
    queue.pending.set(sharedDatabaseDataKeyId(dataKey), dataKey);
    if (!queue.wake.settled()) {
      queue.wake.resolve();
    }
  },
);

export const takeSharedDatabaseInvalidations$ = command(
  async ({ get }, signal: AbortSignal): Promise<SharedDatabaseDataKey[]> => {
    const queue = get(invalidationQueue$);
    await queue.wake.promise;
    signal.throwIfAborted();
    const pending = Array.from(queue.pending.values());
    queue.pending.clear();
    queue.wake = createDeferredPromise<void>(signal);
    return pending;
  },
);
