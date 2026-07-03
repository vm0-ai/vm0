import { createHash, randomUUID } from "node:crypto";

import {
  type TestCronCleanupSandboxesStateActionBody,
  testCronCleanupSandboxesStateContract,
} from "@vm0/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import {
  agentComposeVersions,
  agentComposes,
} from "@vm0/db/schema/agent-compose";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { exportJobs } from "@vm0/db/schema/export-job";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { command } from "ccstate";
import { eq, inArray, sql } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testCronCleanupSandboxesStateContract.action);

function actionOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200 as const,
    body: { ok: true as const, ...extra },
  };
}

function actionBadRequest(error: string) {
  return { status: 400 as const, body: { error } };
}

type CronCleanupSandboxesAction =
  TestCronCleanupSandboxesStateActionBody["action"];
type CronCleanupSandboxesActionResponse =
  | ReturnType<typeof actionOk>
  | ReturnType<typeof actionBadRequest>;
type CronCleanupSandboxesActionHandler = (
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<CronCleanupSandboxesActionResponse>;

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  return readString(body, key) ?? undefined;
}

function readDate(body: Record<string, unknown>, key: string): Date | null {
  const value = body[key];
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readNullableDate(
  body: Record<string, unknown>,
  key: string,
): Date | null | undefined {
  if (!(key in body)) {
    return undefined;
  }
  if (body[key] === null) {
    return null;
  }
  return readDate(body, key) ?? undefined;
}

function versionId(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

async function seedRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const userId = readOptionalString(body, "user_id") ?? `user-${randomUUID()}`;
  const orgId = readOptionalString(body, "org_id") ?? `org-${randomUUID()}`;
  const composeName =
    readOptionalString(body, "compose_name") ?? `cleanup-${randomUUID()}`;
  const [compose] = await db
    .insert(agentComposes)
    .values({ userId, orgId, name: composeName })
    .returning({ id: agentComposes.id });
  signal.throwIfAborted();
  if (!compose) {
    return actionBadRequest("failed to seed compose");
  }

  const agentComposeVersionId = versionId();
  await db.insert(agentComposeVersions).values({
    id: agentComposeVersionId,
    composeId: compose.id,
    createdBy: userId,
    content: { agents: {} },
  });
  signal.throwIfAborted();
  await db
    .update(agentComposes)
    .set({ headVersionId: agentComposeVersionId })
    .where(eq(agentComposes.id, compose.id));
  signal.throwIfAborted();

  await db.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });
  signal.throwIfAborted();

  const [session] = await db
    .insert(agentSessions)
    .values({ userId, orgId, agentComposeId: compose.id, artifacts: [] })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  if (!session) {
    return actionBadRequest("failed to seed session");
  }

  const [run] = await db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId,
      sessionId: session.id,
      status: readOptionalString(body, "status") ?? "pending",
      prompt: readOptionalString(body, "prompt") ?? "cleanup sandboxes test",
      sandboxId:
        readOptionalString(body, "sandbox_id") ?? `sandbox-${randomUUID()}`,
      createdAt: readDate(body, "created_at") ?? undefined,
      lastHeartbeatAt: readNullableDate(body, "last_heartbeat_at"),
    })
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("failed to seed run");
  }

  return actionOk({
    run_id: run.id,
    session_id: session.id,
    compose_id: compose.id,
    version_id: agentComposeVersionId,
    org_id: orgId,
  });
}

async function deleteRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({
      sessionId: agentRuns.sessionId,
      orgId: agentRuns.orgId,
      versionId: agentRuns.agentComposeVersionId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  const [session] = run
    ? await db
        .select({ composeId: agentSessions.agentComposeId })
        .from(agentSessions)
        .where(eq(agentSessions.id, run.sessionId))
        .limit(1)
    : [];
  signal.throwIfAborted();
  const runThreadRows = await db
    .select({ id: chatMessages.chatThreadId })
    .from(chatMessages)
    .where(eq(chatMessages.runId, runId));
  signal.throwIfAborted();
  const runThreadIds = runThreadRows.map((row) => {
    return row.id;
  });
  if (runThreadIds.length > 0) {
    await db.delete(chatMessages).where(eq(chatMessages.runId, runId));
    signal.throwIfAborted();
    await db.delete(chatThreads).where(
      sql`${inArray(chatThreads.id, runThreadIds)} AND NOT EXISTS (
        SELECT 1
        FROM ${chatMessages}
        WHERE ${chatMessages.chatThreadId} = ${chatThreads.id}
      )`,
    );
    signal.throwIfAborted();
  }
  await db.delete(agentRunQueue).where(eq(agentRunQueue.runId, runId));
  signal.throwIfAborted();
  await db.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
  signal.throwIfAborted();
  await db.delete(agentRuns).where(eq(agentRuns.id, runId));
  signal.throwIfAborted();
  if (run) {
    await db.delete(agentSessions).where(eq(agentSessions.id, run.sessionId));
    signal.throwIfAborted();
    if (run.versionId) {
      await db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, run.versionId));
      signal.throwIfAborted();
    }
    if (session) {
      await db
        .delete(agentComposes)
        .where(eq(agentComposes.id, session.composeId));
      signal.throwIfAborted();
    }
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, run.orgId));
    signal.throwIfAborted();
  }
  return actionOk();
}

async function seedRunnerJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  const expiresAt = readDate(body, "expires_at");
  if (!runId || !expiresAt) {
    return actionBadRequest("run_id and expires_at are required");
  }
  await db.insert(runnerJobQueue).values({
    runId,
    runnerGroup: readOptionalString(body, "runner_group") ?? "vm0/test",
    profile: readOptionalString(body, "profile") ?? "vm0/default",
    executionContext: {
      storageManifest: null,
      environment: null,
      resumeSession: null,
      encryptedSecrets: null,
      cliAgentType: "claude-code",
      apiStartTime: readDate(body, "api_start_time")?.getTime() ?? 0,
    },
    expiresAt,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function seedQueueEntryForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  const expiresAt = readDate(body, "expires_at");
  if (!runId || !expiresAt) {
    return actionBadRequest("run_id and expires_at are required");
  }
  const [run] = await db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("run not found");
  }
  await db.insert(agentRunQueue).values({
    runId,
    userId: run.userId,
    orgId: run.orgId,
    createdAt: run.createdAt,
    expiresAt,
    encryptedParams: readOptionalString(body, "encrypted_params"),
  });
  signal.throwIfAborted();
  return actionOk();
}

async function seedQueueMarkerForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({
      userId: agentRuns.userId,
      sessionId: agentRuns.sessionId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("run not found");
  }
  const [session] = await db
    .select({ composeId: agentSessions.agentComposeId })
    .from(agentSessions)
    .where(eq(agentSessions.id, run.sessionId))
    .limit(1);
  signal.throwIfAborted();
  if (!session) {
    return actionBadRequest("session not found");
  }
  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: run.userId,
      agentComposeId: session.composeId,
      title: "cron cleanup marker test",
    })
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!thread) {
    return actionBadRequest("failed to seed chat thread");
  }
  const [marker] = await db
    .insert(chatMessages)
    .values({
      chatThreadId: thread.id,
      role: "assistant",
      content: "Waiting in queue...",
      runId,
      runEventId: "queue:queued",
    })
    .returning({ id: chatMessages.id });
  signal.throwIfAborted();
  if (!marker) {
    return actionBadRequest("failed to seed queue marker");
  }
  return actionOk({ marker_id: marker.id, thread_id: thread.id });
}

async function seedExportJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const status = readString(body, "status");
  if (!status) {
    return actionBadRequest("status is required");
  }
  const [job] = await db
    .insert(exportJobs)
    .values({
      userId: readOptionalString(body, "user_id") ?? `user-${randomUUID()}`,
      orgId: readOptionalString(body, "org_id") ?? `org-${randomUUID()}`,
      status,
      createdAt: readDate(body, "created_at") ?? undefined,
      expiresAt: readNullableDate(body, "expires_at"),
      s3Key: readOptionalString(body, "s3_key") ?? null,
    })
    .returning({ id: exportJobs.id });
  signal.throwIfAborted();
  if (!job) {
    return actionBadRequest("failed to seed export job");
  }
  return actionOk({ export_job_id: job.id });
}

async function deleteExportJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const jobId = readString(body, "export_job_id");
  if (!jobId) {
    return actionBadRequest("export_job_id is required");
  }
  await db.delete(exportJobs).where(eq(exportJobs.id, jobId));
  signal.throwIfAborted();
  return actionOk();
}

async function getRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({ status: agentRuns.status, error: agentRuns.error })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ run: run ?? null });
}

async function getRunnerJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [job] = await db
    .select({ runId: runnerJobQueue.runId })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ runner_job: job ?? null });
}

async function getQueueEntryForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [entry] = await db
    .select({ runId: agentRunQueue.runId })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ queue_entry: entry ?? null });
}

async function getQueueMarkerRevokerForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const markerId = readString(body, "marker_id");
  if (!markerId) {
    return actionBadRequest("marker_id is required");
  }
  const [revoker] = await db
    .select({
      id: chatMessages.id,
      revokesMessageId: chatMessages.revokesMessageId,
      runEventId: chatMessages.runEventId,
    })
    .from(chatMessages)
    .where(eq(chatMessages.revokesMessageId, markerId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ queue_marker_revoker: revoker ?? null });
}

async function getExportJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const jobId = readString(body, "export_job_id");
  if (!jobId) {
    return actionBadRequest("export_job_id is required");
  }
  const [job] = await db
    .select({ status: exportJobs.status, error: exportJobs.error })
    .from(exportJobs)
    .where(eq(exportJobs.id, jobId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ export_job: job ?? null });
}

const cronCleanupSandboxesActionHandlers = {
  "seed-run": seedRunForAction,
  "delete-run": deleteRunForAction,
  "seed-runner-job": seedRunnerJobForAction,
  "seed-queue-entry": seedQueueEntryForAction,
  "seed-queue-marker": seedQueueMarkerForAction,
  "seed-export-job": seedExportJobForAction,
  "delete-export-job": deleteExportJobForAction,
  "get-run": getRunForAction,
  "get-runner-job": getRunnerJobForAction,
  "get-queue-entry": getQueueEntryForAction,
  "get-queue-marker-revoker": getQueueMarkerRevokerForAction,
  "get-export-job": getExportJobForAction,
} satisfies Record<
  CronCleanupSandboxesAction,
  CronCleanupSandboxesActionHandler
>;

const mutateTestCronCleanupSandboxesState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.data as Record<string, unknown>;
    const db = set(writeDb$);
    const handler = cronCleanupSandboxesActionHandlers[bodyResult.data.action];
    return await handler(db, body, signal);
  },
);

export const testCronCleanupSandboxesStateRoutes: readonly RouteEntry[] = [
  {
    route: testCronCleanupSandboxesStateContract.action,
    handler: mutateTestCronCleanupSandboxesState$,
  },
];
