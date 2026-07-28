import { command, computed } from "ccstate";
import { zeroWorkflowQueueContract } from "@vm0/api-contracts/contracts/zero-workflow-queue";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishChatThreadWorkflowQueueChangedSafely,
} from "../external/realtime";
import { notFound } from "../../lib/error";
import { nowDate } from "../external/time";
import {
  clearWorkflowQueueEvents,
  deleteWorkflowQueueEventById,
  listPendingWorkflowQueueEvents,
  loadRunningWorkflowThreadRun,
  loadWorkflowQueueThread,
  setWorkflowQueuePause,
  type WorkflowQueueThreadRow,
} from "../services/chat-message-queue.service";
import { dispatchFailedRunCallbacks } from "../services/agent-run-callback.service";
import { drainChatThreadQueueForThread$ } from "../services/chat-thread-queue-drain.service";
import type { RouteEntry } from "../route-entry";

const workflowReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const workflowWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

async function workflowQueueResponse(
  db: ReadonlyDb,
  thread: WorkflowQueueThreadRow,
  threadId: string,
) {
  const [running, pending] = await Promise.all([
    loadRunningWorkflowThreadRun(db, threadId),
    listPendingWorkflowQueueEvents(db, thread),
  ]);
  return {
    status: 200 as const,
    body: {
      running: running
        ? {
            runId: running.runId,
            status: running.status,
            triggerBrief: running.triggerBrief,
            createdAt: running.createdAt.toISOString(),
          }
        : null,
      pending: pending.map((event) => {
        return {
          id: event.id,
          automationId: event.automationId,
          triggerSource: event.triggerSource,
          triggerBrief: event.triggerBrief,
          createdAt: event.createdAt.toISOString(),
        };
      }),
      pausedAt: thread.automationPausedAt?.toISOString() ?? null,
      pauseReason: thread.pauseReason,
    },
  };
}

const getQueueInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowQueueContract.get));
  const db = get(db$);
  const thread = await loadWorkflowQueueThread(db, {
    orgId: auth.orgId,
    userId: auth.userId,
    threadId: params.threadId,
  });
  if (!thread) {
    return notFound(`No workflow queue for thread: ${params.threadId}`);
  }
  return await workflowQueueResponse(db, thread, params.threadId);
});

const skipEventInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowQueueContract.skipEvent));
  const db = set(writeDb$);
  const deleted = await deleteWorkflowQueueEventById(db, {
    orgId: auth.orgId,
    userId: auth.userId,
    eventId: params.id,
  });
  signal.throwIfAborted();
  if (!deleted) {
    return notFound(`No workflow queue event: ${params.id}`);
  }
  const thread = await loadWorkflowQueueThread(db, {
    orgId: auth.orgId,
    userId: auth.userId,
    threadId: deleted.chatThreadId,
  });
  signal.throwIfAborted();
  if (!thread) {
    return notFound(`No workflow queue for thread: ${deleted.chatThreadId}`);
  }
  await publishChatThreadWorkflowQueueChangedSafely(
    auth.userId,
    deleted.chatThreadId,
  );
  signal.throwIfAborted();
  await publishChatThreadMessageCreatedSafely(
    auth.userId,
    deleted.chatThreadId,
  );
  signal.throwIfAborted();
  return await workflowQueueResponse(db, thread, deleted.chatThreadId);
});

const clearQueueInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowQueueContract.clear));
  const db = set(writeDb$);
  const thread = await loadWorkflowQueueThread(db, {
    orgId: auth.orgId,
    userId: auth.userId,
    threadId: params.threadId,
  });
  signal.throwIfAborted();
  if (!thread) {
    return notFound(`No workflow queue for thread: ${params.threadId}`);
  }
  await clearWorkflowQueueEvents(db, thread);
  signal.throwIfAborted();
  await publishChatThreadWorkflowQueueChangedSafely(
    auth.userId,
    params.threadId,
  );
  signal.throwIfAborted();
  await publishChatThreadMessageCreatedSafely(auth.userId, params.threadId);
  signal.throwIfAborted();
  return await workflowQueueResponse(db, thread, params.threadId);
});

const setPauseInner = (paused: boolean) => {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(
        paused
          ? zeroWorkflowQueueContract.pause
          : zeroWorkflowQueueContract.resume,
      ),
    );
    const db = set(writeDb$);
    const thread = await loadWorkflowQueueThread(db, {
      orgId: auth.orgId,
      userId: auth.userId,
      threadId: params.threadId,
    });
    signal.throwIfAborted();
    if (!thread) {
      return notFound(`No workflow queue for thread: ${params.threadId}`);
    }
    const currentTime = nowDate();
    await setWorkflowQueuePause(
      db,
      thread,
      paused ? { pausedAt: currentTime, pauseReason: null } : null,
      currentTime,
    );
    signal.throwIfAborted();
    if (!paused) {
      // Resuming re-drains immediately instead of waiting for the next
      // terminal run or the safety-net cron.
      await set(
        drainChatThreadQueueForThread$,
        {
          chatThreadId: params.threadId,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        },
        signal,
      );
      signal.throwIfAborted();
    }
    await publishChatThreadWorkflowQueueChangedSafely(
      auth.userId,
      params.threadId,
    );
    signal.throwIfAborted();
    await publishChatThreadMessageCreatedSafely(auth.userId, params.threadId);
    signal.throwIfAborted();
    const updated = await loadWorkflowQueueThread(db, {
      orgId: auth.orgId,
      userId: auth.userId,
      threadId: params.threadId,
    });
    signal.throwIfAborted();
    if (!updated) {
      return notFound(`No workflow queue for thread: ${params.threadId}`);
    }
    return await workflowQueueResponse(db, updated, params.threadId);
  });
};

const pauseQueueInner$ = setPauseInner(true);
const resumeQueueInner$ = setPauseInner(false);

export const zeroWorkflowQueueRoutes: readonly RouteEntry[] = [
  {
    route: zeroWorkflowQueueContract.get,
    handler: authRoute(workflowReadAuth, getQueueInner$),
  },
  {
    route: zeroWorkflowQueueContract.skipEvent,
    handler: authRoute(workflowWriteAuth, skipEventInner$),
  },
  {
    route: zeroWorkflowQueueContract.clear,
    handler: authRoute(workflowWriteAuth, clearQueueInner$),
  },
  {
    route: zeroWorkflowQueueContract.pause,
    handler: authRoute(workflowWriteAuth, pauseQueueInner$),
  },
  {
    route: zeroWorkflowQueueContract.resume,
    handler: authRoute(workflowWriteAuth, resumeQueueInner$),
  },
];
