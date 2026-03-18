import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { runsQueueContract, orgTierSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import {
  getEffectiveConcurrencyLimit,
  PENDING_RUN_TTL_MS,
} from "../../../../../src/lib/run/run-service";
import { getCachedUser } from "../../../../../src/lib/auth/user-cache-service";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  agentComposeVersions,
  agentComposes,
} from "../../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import {
  eq,
  and,
  or,
  gt,
  count,
  asc,
  desc,
  isNotNull,
  avg,
  sql,
} from "drizzle-orm";

const RECENT_RUNS_FOR_ETA = 20;
const PROMPT_TRUNCATE_LENGTH = 200;

function inferTriggerSource(run: {
  scheduleId: string | null;
  continuedFromSessionId: string | null;
}): "schedule" | "chat" | "api" {
  if (run.scheduleId) return "schedule";
  if (run.continuedFromSessionId) return "chat";
  return "api";
}

const router = tsr.router(runsQueueContract, {
  getQueue: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);
    const orgTier = orgTierSchema.parse(org.tier);

    const limit = getEffectiveConcurrencyLimit(orgTier);

    const db = globalThis.services.db;

    // Count active runs (same logic as checkRunConcurrencyLimit)
    const staleThreshold = new Date(Date.now() - PENDING_RUN_TTL_MS);
    const [activeResult] = await db
      .select({ count: count() })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, org.orgId),
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
        scheduleId: agentRuns.scheduleId,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
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
      .leftJoin(
        zeroAgents,
        and(
          eq(agentComposes.orgId, zeroAgents.orgId),
          eq(agentComposes.name, zeroAgents.name),
        ),
      )
      .where(
        and(eq(agentRuns.orgId, org.orgId), eq(agentRuns.status, "queued")),
      )
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
      .leftJoin(
        zeroAgents,
        and(
          eq(agentComposes.orgId, zeroAgents.orgId),
          eq(agentComposes.name, zeroAgents.name),
        ),
      )
      .where(
        and(eq(agentRuns.orgId, org.orgId), eq(agentRuns.status, "running")),
      )
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
          eq(agentRuns.orgId, org.orgId),
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
        ...queuedRuns.map((r) => r.runUserId),
        ...runningRuns.map((r) => r.runUserId),
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
        triggerSource: isOwner ? inferTriggerSource(run) : null,
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
      status: 200 as const,
      body: {
        concurrency: {
          tier: orgTier,
          limit,
          active,
          available: limit === 0 ? -1 : Math.max(0, limit - active),
        },
        queue,
        runningTasks,
        estimatedTimePerRun,
      },
    };
  },
});

const handler = createHandler(runsQueueContract, router);

export { handler as GET };
