import { command, computed } from "ccstate";
import { zeroWorkflowQueueContract } from "@vm0/api-contracts/contracts/zero-workflow-queue";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import {
  clearWorkflowQueueEvents,
  deleteWorkflowQueueEventById,
  listPendingWorkflowQueueEvents,
  loadRunningWorkflowThreadRun,
  loadWorkflowQueueThread,
  type WorkflowQueueThreadRow,
} from "../services/workflow-chat-event-queue.service";
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
      // Automation queues are no longer pausable. Keep the previous response
      // shape during the rolling-deployment window without restoring pause
      // state or scheduler gating.
      pausedAt: null,
      pauseReason: null,
    },
  };
}

async function loadOwnedQueue(
  db: ReadonlyDb,
  auth: { readonly orgId: string; readonly userId: string },
  threadId: string,
) {
  return await loadWorkflowQueueThread(db, {
    orgId: auth.orgId,
    userId: auth.userId,
    threadId,
  });
}

const getQueueInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowQueueContract.get));
  const db = get(db$);
  const thread = await loadOwnedQueue(db, auth, params.threadId);
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
  const thread = await loadOwnedQueue(db, auth, deleted.chatThreadId);
  signal.throwIfAborted();
  if (!thread) {
    return notFound(`No workflow queue for thread: ${deleted.chatThreadId}`);
  }
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
  const thread = await loadOwnedQueue(db, auth, params.threadId);
  signal.throwIfAborted();
  if (!thread) {
    return notFound(`No workflow queue for thread: ${params.threadId}`);
  }
  await clearWorkflowQueueEvents(db, thread);
  signal.throwIfAborted();
  await publishChatThreadMessageCreatedSafely(auth.userId, params.threadId);
  signal.throwIfAborted();
  return await workflowQueueResponse(db, thread, params.threadId);
});

function removedPauseActionInner(
  route:
    | typeof zeroWorkflowQueueContract.pause
    | typeof zeroWorkflowQueueContract.resume,
) {
  return command(async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(route));
    const db = get(db$);
    const thread = await loadOwnedQueue(db, auth, params.threadId);
    signal.throwIfAborted();
    if (!thread) {
      return notFound(`No workflow queue for thread: ${params.threadId}`);
    }
    return await workflowQueueResponse(db, thread, params.threadId);
  });
}

const pauseQueueInner$ = removedPauseActionInner(
  zeroWorkflowQueueContract.pause,
);
const resumeQueueInner$ = removedPauseActionInner(
  zeroWorkflowQueueContract.resume,
);

/**
 * Previous-frontend compatibility adapter. No current platform code consumes
 * this contract; pending rows and supported controls use canonical ChatEvents.
 */
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
