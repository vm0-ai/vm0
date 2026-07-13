import { command, computed, state, type Computed } from "ccstate";

import {
  zeroWorkflowQueueContract,
  type WorkflowQueueResponse,
} from "@vm0/api-contracts/contracts/zero-workflow-queue";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { openHeaderAutomationSidebar$ } from "./header-automation-sidebar.ts";

const workflowQueueReload$ = state(0);

/** Bump to force the workflow queue panel to refetch. */
const reloadWorkflowQueue$ = command(({ get, set }) => {
  set(workflowQueueReload$, get(workflowQueueReload$) + 1);
});

/**
 * The chat thread's workflow queue snapshot, or null when the WorkflowQueue
 * switch is off or the thread has no workflow queue (403/404 from the API).
 */
function createWorkflowQueueFactory(): (
  threadId: string,
) => Computed<Promise<WorkflowQueueResponse | null>> {
  const cache = new Map<
    string,
    Computed<Promise<WorkflowQueueResponse | null>>
  >();
  return (threadId: string) => {
    const cached = cache.get(threadId);
    if (cached) {
      return cached;
    }
    const queue$ = computed(
      async (get): Promise<WorkflowQueueResponse | null> => {
        get(workflowQueueReload$);
        const switches = get(featureSwitch$);
        if (!switches[FeatureSwitchKey.WorkflowQueue]) {
          return null;
        }
        const client = get(zeroClient$)(zeroWorkflowQueueContract);
        const response = await client.get({ params: { threadId } });
        if (response.status !== 200) {
          return null;
        }
        return response.body;
      },
    );
    cache.set(threadId, queue$);
    return queue$;
  };
}

export const workflowQueueForThread = createWorkflowQueueFactory();

export const skipWorkflowQueueEvent$ = command(
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
    set(reloadWorkflowQueue$);
  },
);

export const clearWorkflowQueue$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroWorkflowQueueContract);
    await accept(
      client.clear({
        params: { threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflowQueue$);
  },
);

export const setWorkflowQueuePaused$ = command(
  async (
    { get, set },
    args: { readonly threadId: string; readonly paused: boolean },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowQueueContract);
    const request = args.paused
      ? client.pause({
          params: { threadId: args.threadId },
          fetchOptions: { signal },
        })
      : client.resume({
          params: { threadId: args.threadId },
          fetchOptions: { signal },
        });
    await accept(request, [200]);
    signal.throwIfAborted();
    set(reloadWorkflowQueue$);
  },
);

// Last observed pending count per thread, for the 0 -> >0 auto-expand edge.
const lastPendingCounts$ = state<Readonly<Record<string, number>>>({});

/**
 * Realtime `chatThreadWorkflowQueueChanged` handler: refetch the queue and
 * auto-expand the Automations panel only when the backlog transitions from
 * empty to non-empty, so it never fights a user who closed the panel.
 */
const handleWorkflowQueueChanged$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    set(reloadWorkflowQueue$);
    const queue = await get(workflowQueueForThread(threadId));
    signal.throwIfAborted();
    if (!queue) {
      return;
    }
    const pending = queue.pending.length;
    const counts = get(lastPendingCounts$);
    const previous = counts[threadId] ?? 0;
    set(lastPendingCounts$, { ...counts, [threadId]: pending });
    if (previous === 0 && pending > 0) {
      set(openHeaderAutomationSidebar$, threadId);
    }
  },
);

/** Loop-style realtime handler bound to one thread, for the chat subscription. */
export function createWorkflowQueueChangedHandler(threadId: string) {
  return command(async ({ set }, signal: AbortSignal) => {
    await set(handleWorkflowQueueChanged$, threadId, signal);
    return false;
  });
}
