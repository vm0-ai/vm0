import { command, computed, type Computed } from "ccstate";
import { zeroWorkflowQueueContract } from "@vm0/api-contracts/contracts/zero-workflow-queue";
import { FeatureSwitchKey } from "@vm0/core";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { publishChatThreadWorkflowQueueChangedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import { nowDate } from "../external/time";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  clearWorkflowQueueEvents,
  deleteWorkflowQueueEventById,
  listPendingWorkflowQueueEvents,
  loadRunningWorkflowThreadRun,
  loadWorkflowQueueThread,
  setWorkflowQueuePause,
  type WorkflowQueueThreadRow,
} from "../services/zero-workflow-queue.service";
import { drainWorkflowQueueForThread$ } from "../services/zero-workflow-queue-drain.service";
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

const featureDisabled = Object.freeze({
  status: 403 as const,
  body: {
    error: {
      message: "The workflow queue feature is not available",
      code: "FORBIDDEN",
    },
  },
});

interface AuthIdentity {
  readonly orgId: string;
  readonly userId: string;
}

type ComputedGetter = <T>(computedValue: Computed<T>) => T;

async function workflowQueueDisabled(
  get: ComputedGetter,
  auth: AuthIdentity,
): Promise<boolean> {
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return !isFeatureEnabled(FeatureSwitchKey.WorkflowQueue, {
    userId: auth.userId,
    orgId: auth.orgId,
    overrides,
  });
}

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
          triggerId: event.triggerId,
          triggerSource: event.triggerSource,
          triggerBrief: event.triggerBrief,
          createdAt: event.createdAt.toISOString(),
        };
      }),
      pausedAt: thread.queuePausedAt?.toISOString() ?? null,
      pauseReason: thread.pauseReason,
    },
  };
}

const getQueueInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowQueueContract.get));
  if (await workflowQueueDisabled(get, auth)) {
    return featureDisabled;
  }
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
  if (await workflowQueueDisabled(get, auth)) {
    return featureDisabled;
  }
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
  return await workflowQueueResponse(db, thread, deleted.chatThreadId);
});

const clearQueueInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowQueueContract.clear));
  if (await workflowQueueDisabled(get, auth)) {
    return featureDisabled;
  }
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
    if (await workflowQueueDisabled(get, auth)) {
      return featureDisabled;
    }
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
        drainWorkflowQueueForThread$,
        { chatThreadId: params.threadId },
        signal,
      );
      signal.throwIfAborted();
    }
    await publishChatThreadWorkflowQueueChangedSafely(
      auth.userId,
      params.threadId,
    );
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
