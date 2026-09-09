import { command, computed, state } from "ccstate";

const SHARED_WORKER_FAILED_EVENT = "shared-database-worker-failed";

const sharedWorkerFailureDialogOpenState$ = state(false);

export const sharedWorkerFailureDialogOpen$ = computed((get) => {
  return get(sharedWorkerFailureDialogOpenState$);
});

export function reportSharedWorkerFailure(): void {
  window.dispatchEvent(new Event(SHARED_WORKER_FAILED_EVENT));
}

export const listenSharedWorkerFailure$ = command(
  ({ set }, signal: AbortSignal): void => {
    window.addEventListener(
      SHARED_WORKER_FAILED_EVENT,
      () => {
        set(sharedWorkerFailureDialogOpenState$, true);
      },
      { signal },
    );
  },
);
