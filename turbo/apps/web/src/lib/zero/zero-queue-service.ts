import {
  eq,
  and,
  count,
  gt,
  or,
  sql,
  asc,
  desc,
  isNotNull,
  avg,
} from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import { zeroRuns } from "../../db/schema/zero-run";
import {
  agentComposeVersions,
  agentComposes,
} from "../../db/schema/agent-compose";
import { zeroAgents } from "../../db/schema/zero-agent";
import { getCachedUser } from "../auth/user-cache-service";
import {
  PENDING_RUN_TTL_MS,
  getEffectiveConcurrencyLimit,
  dispatchQueuedRun,
  buildAndDispatchRun,
  loadCompose,
  authorizeCompose,
  validateComposeRequirements,
} from "../run/run-service";
import type { CreateRunParams } from "../run/run-service";
import { generateZeroToken, generateSandboxToken } from "../auth/sandbox-token";
import { buildZeroExecutionContext } from "./build-zero-context";
import type { OrgTier, QueueResponse, TriggerSource } from "@vm0/core";

/**
 * Zero-layer dispatch wrapper for queued runs.
 * For zero runs (ZERO_AGENT_ID in vars): generates tokens, builds zero context
 * (secrets, model provider, firewalls), and dispatches with pre-built context.
 * For non-zero runs: delegates directly to the infra dispatcher unchanged.
 */
export async function dispatchQueuedZeroRun(
  runId: string,
  params: CreateRunParams,
): Promise<void> {
  if (params.vars?.ZERO_AGENT_ID) {
    const apiStartTime = Date.now();

    // Generate fresh ZERO_TOKEN for queued dispatch
    const zeroToken = await generateZeroToken(
      params.userId,
      runId,
      params.orgId,
    );
    const updatedParams: CreateRunParams = {
      ...params,
      secrets: { ...params.secrets, ZERO_TOKEN: zeroToken },
    };

    // Load compose + authorize (same validation as direct path)
    const { composeContent, compose } = await loadCompose(
      params.agentComposeVersionId,
      params.composeId,
    );
    authorizeCompose(params.userId, params.orgId, compose);
    const authorizeTime = Date.now();

    // Validate compose requirements for new runs only
    if (!params.checkpointId && !params.sessionId) {
      await validateComposeRequirements(
        params.userId,
        composeContent,
        params.orgId,
        params.vars,
        params.checkEnv,
      );
    }

    // Generate sandbox token + build zero context
    const sandboxToken = await generateSandboxToken(params.userId, runId);
    const tokenTime = Date.now();
    const contextResult = await buildZeroExecutionContext({
      ...updatedParams,
      sandboxToken,
      agentCompose: composeContent,
      runId,
      agentName: params.agentName,
    });

    // Update zero_runs with resolved model fields before dispatch so metadata
    // is recorded even if dispatch succeeds but a later step fails.
    // Zero queued path: row already exists (created at enqueue time), so UPDATE is safe.
    await globalThis.services.db
      .update(zeroRuns)
      .set({
        modelProvider: contextResult.resolvedModelProvider ?? null,
        selectedModel: contextResult.selectedModel ?? null,
      })
      .where(eq(zeroRuns.id, runId));

    await buildAndDispatchRun({
      runId,
      context: contextResult.context,
      timings: {
        apiStart: apiStartTime,
        authorize: authorizeTime,
        transaction: apiStartTime,
        token: tokenTime,
        resolveSourceDuration: contextResult.timings.resolveSourceAndOrg,
        resolveSecretsDuration: contextResult.timings.resolveSecrets,
      },
    });

    return;
  }

  // Non-zero path — delegate to infra dispatcher
  return dispatchQueuedRun(runId, params, dispatchQueuedZeroRun);
}

const RECENT_RUNS_FOR_ETA = 20;
const PROMPT_TRUNCATE_LENGTH = 200;

/**
 * Get run queue status for an org, including concurrency info,
 * queued/running entries, and estimated time per run.
 *
 * Privacy filtering: non-owners see nullified personal fields.
 *
 * This is a Zero-layer concern because it joins zero_runs and zero_agents
 * to enrich queue entries with triggerSource and agent display names.
 */
export async function getRunQueueStatus(
  userId: string,
  orgId: string,
  orgTier: OrgTier,
): Promise<QueueResponse> {
  const db = globalThis.services.db;
  const limit = getEffectiveConcurrencyLimit(orgTier);

  // Count active runs (same logic as checkRunConcurrencyLimit)
  const staleThreshold = new Date(Date.now() - PENDING_RUN_TTL_MS);
  const [activeResult] = await db
    .select({ count: count() })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        or(
          eq(agentRuns.status, "running"),
          and(
            eq(agentRuns.status, "pending"),
            gt(agentRuns.createdAt, staleThreshold),
          ),
        ),
      ),
    );
  const active = Number(activeResult?.count ?? 0);

  // Fetch queued runs in FIFO order (with extra fields for owner details)
  const queuedRuns = await db
    .select({
      id: agentRuns.id,
      runUserId: agentRuns.userId,
      createdAt: agentRuns.createdAt,
      agentName: agentComposes.name,
      agentDisplayName: zeroAgents.displayName,
      prompt: agentRuns.prompt,
      triggerSource: zeroRuns.triggerSource,
      continuedFromSessionId: agentRuns.continuedFromSessionId,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "queued")))
    .orderBy(asc(agentRuns.createdAt));

  // Fetch running tasks
  const runningRuns = await db
    .select({
      id: agentRuns.id,
      runUserId: agentRuns.userId,
      startedAt: agentRuns.startedAt,
      agentName: agentComposes.name,
      agentDisplayName: zeroAgents.displayName,
    })
    .from(agentRuns)
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "running")))
    .orderBy(asc(agentRuns.startedAt));

  // Calculate estimated time per run from recent completed runs
  const recentRuns = db
    .select({
      durationMs:
        sql<number>`EXTRACT(EPOCH FROM (${agentRuns.completedAt} - ${agentRuns.startedAt})) * 1000`.as(
          "duration_ms",
        ),
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "completed"),
        isNotNull(agentRuns.completedAt),
        isNotNull(agentRuns.startedAt),
      ),
    )
    .orderBy(desc(agentRuns.completedAt))
    .limit(RECENT_RUNS_FOR_ETA)
    .as("recent_runs");
  const [etaResult] = await db
    .select({
      avgMs: avg(recentRuns.durationMs),
    })
    .from(recentRuns);
  const estimatedTimePerRun = etaResult?.avgMs
    ? Math.round(Number(etaResult.avgMs))
    : null;

  // Resolve user emails in parallel (for both queued and running)
  const allUserIds = [
    ...new Set([
      ...queuedRuns.map((r) => {
        return r.runUserId;
      }),
      ...runningRuns.map((r) => {
        return r.runUserId;
      }),
    ]),
  ];
  const userMap = new Map<string, string>();
  await Promise.all(
    allUserIds.map(async (uid) => {
      const user = await getCachedUser(uid);
      userMap.set(uid, user.email);
    }),
  );

  // Build queue response with privacy filtering
  const queue = queuedRuns.map((run, index) => {
    const isOwner = run.runUserId === userId;
    return {
      position: index + 1,
      agentName: isOwner ? (run.agentName ?? "unknown") : null,
      agentDisplayName: isOwner ? (run.agentDisplayName ?? null) : null,
      userEmail: isOwner ? (userMap.get(run.runUserId) ?? "unknown") : null,
      createdAt: run.createdAt.toISOString(),
      isOwner,
      runId: isOwner ? run.id : null,
      prompt: isOwner
        ? run.prompt.length > PROMPT_TRUNCATE_LENGTH
          ? run.prompt.slice(0, PROMPT_TRUNCATE_LENGTH) + "..."
          : run.prompt
        : null,
      triggerSource: isOwner
        ? ((run.triggerSource ?? "cli") as TriggerSource)
        : null,
      sessionLink:
        isOwner && run.continuedFromSessionId
          ? `/chat/${run.continuedFromSessionId}`
          : null,
    };
  });

  // Build running tasks response with privacy filtering
  const runningTasks = runningRuns.map((run) => {
    const isOwner = run.runUserId === userId;
    return {
      runId: isOwner ? run.id : null,
      agentName: run.agentName ?? "unknown",
      agentDisplayName: run.agentDisplayName ?? null,
      userEmail: userMap.get(run.runUserId) ?? "unknown",
      startedAt: run.startedAt?.toISOString() ?? null,
      isOwner,
    };
  });

  return {
    concurrency: {
      tier: orgTier,
      limit,
      active,
      available: limit === 0 ? -1 : Math.max(0, limit - active),
    },
    queue,
    runningTasks,
    estimatedTimePerRun,
  };
}
