import { command, computed, state, type Command, type Computed } from "ccstate";

import {
  zeroWorkflowQueueContract,
  type WorkflowQueueResponse,
} from "@vm0/api-contracts/contracts/zero-workflow-queue";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

export interface WorkflowQueueSignals {
  readonly queue$: Computed<Promise<WorkflowQueueResponse | null>>;
  readonly reload$: Command<void, []>;
  readonly skipEvent$: Command<Promise<void>, [string, AbortSignal]>;
  readonly clear$: Command<Promise<void>, [AbortSignal]>;
  readonly setPaused$: Command<Promise<void>, [boolean, AbortSignal]>;
  readonly handleChanged$: Command<Promise<boolean>, [AbortSignal]>;
}

/**
 * Create the workflow queue graph owned by one chat-thread signal instance.
 */
export function createWorkflowQueueSignals(
  threadId: string,
): WorkflowQueueSignals {
  const reloadVersion$ = state(0);

  const reload$ = command(({ set }) => {
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });

  const queue$ = computed(
    async (get): Promise<WorkflowQueueResponse | null> => {
      get(reloadVersion$);
      const client = get(zeroClient$)(zeroWorkflowQueueContract);
      const response = await accept(
        client.get({ params: { threadId } }),
        [200, 403, 404],
      );
      return response.status === 200 ? response.body : null;
    },
  );

  const skipEvent$ = command(
    async ({ get, set }, eventId: string, signal: AbortSignal) => {
      const client = get(zeroClient$)(zeroWorkflowQueueContract);
      await accept(
        client.skipEvent({
          params: { id: eventId },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(reload$);
    },
  );

  const clear$ = command(async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroWorkflowQueueContract);
    await accept(
      client.clear({
        params: { threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reload$);
  });

  const setPaused$ = command(
    async ({ get, set }, paused: boolean, signal: AbortSignal) => {
      const client = get(zeroClient$)(zeroWorkflowQueueContract);
      const request = paused
        ? client.pause({
            params: { threadId },
            fetchOptions: { signal },
          })
        : client.resume({
            params: { threadId },
            fetchOptions: { signal },
          });
      await accept(request, [200]);
      signal.throwIfAborted();
      set(reload$);
    },
  );

  const handleChanged$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      set(reload$);
      await get(queue$);
      signal.throwIfAborted();
      return false;
    },
  );

  return {
    queue$,
    reload$,
    skipEvent$,
    clear$,
    setPaused$,
    handleChanged$,
  };
}
