import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { runsQueueContract, orgTierSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
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
import { eq, and, or, gt, count, asc } from "drizzle-orm";

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

    // Count active runs (same logic as checkRunConcurrencyLimit)
    const staleThreshold = new Date(Date.now() - PENDING_RUN_TTL_MS);
    const [activeResult] = await globalThis.services.db
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

    // Fetch queued runs in FIFO order
    const queuedRuns = await globalThis.services.db
      .select({
        id: agentRuns.id,
        runUserId: agentRuns.userId,
        createdAt: agentRuns.createdAt,
        agentName: agentComposes.name,
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
      .where(
        and(eq(agentRuns.orgId, org.orgId), eq(agentRuns.status, "queued")),
      )
      .orderBy(asc(agentRuns.createdAt));

    // Only resolve email for the requesting user (skip others for privacy + perf)
    const hasOwnRuns = queuedRuns.some((r) => r.runUserId === userId);
    const ownEmail = hasOwnRuns ? (await getCachedUser(userId)).email : null;

    // Build response with privacy masking
    const queue = queuedRuns.map((run, index) => {
      const isOwner = run.runUserId === userId;
      return {
        position: index + 1,
        agentName: isOwner ? (run.agentName ?? "unknown") : null,
        userEmail: isOwner ? (ownEmail ?? "unknown") : null,
        createdAt: run.createdAt.toISOString(),
        runId: isOwner ? run.id : null,
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
      },
    };
  },
});

const handler = createHandler(runsQueueContract, router);

export { handler as GET };
