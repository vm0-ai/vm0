import { computed, type Computed } from "ccstate";
import {
  triggerSourceSchema,
  type TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import {
  ALL_RUN_STATUSES,
  type GetRunResponse,
  type QueueResponse,
  type RunStatus,
  type RunsListResponse,
} from "@vm0/api-contracts/contracts/runs";
import {
  sandboxReuseResultSchema,
  type SandboxReuseResult,
} from "@vm0/api-contracts/contracts/webhooks";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { now } from "../../lib/time";
import { db$, type Db } from "../external/db";

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
const RECENT_RUNS_FOR_ETA = 10;
const PROMPT_TRUNCATE_LENGTH = 200;
const TIER_CONCURRENCY_LIMITS = Object.freeze<Record<OrgTier, number>>({
  free: 1,
  "pro-suspend": 0,
  pro: 2,
  team: 10,
});

type ReadDb = Pick<Db, "select">;
type QueueItem = QueueResponse["queue"][number];
type RunningTaskItem = QueueResponse["runningTasks"][number];

type RunListResult =
  | { readonly kind: "ok"; readonly body: RunsListResponse }
  | { readonly kind: "bad-request"; readonly message: string };

interface QueuedRunRow {
  readonly id: string;
  readonly runUserId: string;
  readonly createdAt: Date;
  readonly agentName: string | null;
  readonly agentDisplayName: string | null;
  readonly prompt: string;
  readonly triggerSource: string | null;
  readonly continuedFromSessionId: string | null;
}

interface RunningRunRow {
  readonly id: string;
  readonly runUserId: string;
  readonly startedAt: Date | null;
  readonly agentName: string | null;
  readonly agentDisplayName: string | null;
}

function truncatePrompt(prompt: string): string {
  return prompt.length > PROMPT_TRUNCATE_LENGTH
    ? `${prompt.slice(0, PROMPT_TRUNCATE_LENGTH)}...`
    : prompt;
}

function effectiveConcurrencyLimit(tier: OrgTier): number {
  return TIER_CONCURRENCY_LIMITS[tier];
}

async function activeRunCount(db: ReadDb, orgId: string): Promise<number> {
  const staleThreshold = new Date(now() - PENDING_RUN_TTL_MS);
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
  return Number(activeResult?.count ?? 0);
}

function queuedRunRows(db: ReadDb, orgId: string): Promise<QueuedRunRow[]> {
  return db
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
}

function runningRunRows(db: ReadDb, orgId: string): Promise<RunningRunRow[]> {
  return db
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
}

async function estimatedTimePerRun(
  db: ReadDb,
  orgId: string,
): Promise<number | null> {
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
    .select({ avgMs: avg(recentRuns.durationMs) })
    .from(recentRuns);
  return etaResult?.avgMs ? Math.round(Number(etaResult.avgMs)) : null;
}

async function userEmailMap(
  db: ReadDb,
  queuedRuns: readonly QueuedRunRow[],
  runningRuns: readonly RunningRunRow[],
): Promise<ReadonlyMap<string, string>> {
  const userIds = [
    ...new Set([
      ...queuedRuns.map((run) => {
        return run.runUserId;
      }),
      ...runningRuns.map((run) => {
        return run.runUserId;
      }),
    ]),
  ];
  const rows =
    userIds.length > 0
      ? await db
          .select({ userId: userCache.userId, email: userCache.email })
          .from(userCache)
          .where(inArray(userCache.userId, userIds))
      : [];
  return new Map(
    rows.map((row) => {
      return [row.userId, row.email] as const;
    }),
  );
}

function queueItem(
  run: QueuedRunRow,
  index: number,
  userId: string,
  emails: ReadonlyMap<string, string>,
): QueueItem {
  const isOwner = run.runUserId === userId;
  const triggerSource = triggerSourceSchema.parse(run.triggerSource ?? "cli");
  return {
    position: index + 1,
    agentName: isOwner ? (run.agentName ?? "unknown") : null,
    agentDisplayName: isOwner ? (run.agentDisplayName ?? null) : null,
    userEmail: isOwner ? (emails.get(run.runUserId) ?? "unknown") : null,
    createdAt: run.createdAt.toISOString(),
    isOwner,
    runId: isOwner ? run.id : null,
    prompt: isOwner ? truncatePrompt(run.prompt) : null,
    triggerSource: isOwner ? (triggerSource as TriggerSource) : null,
    sessionLink:
      isOwner && run.continuedFromSessionId
        ? `/chat/${run.continuedFromSessionId}`
        : null,
  };
}

function runningTaskItem(
  run: RunningRunRow,
  userId: string,
  emails: ReadonlyMap<string, string>,
): RunningTaskItem {
  const isOwner = run.runUserId === userId;
  return {
    runId: isOwner ? run.id : null,
    agentName: run.agentName ?? "unknown",
    agentDisplayName: run.agentDisplayName ?? null,
    userEmail: emails.get(run.runUserId) ?? "unknown",
    startedAt: run.startedAt?.toISOString() ?? null,
    isOwner,
  };
}

export function zeroRunById(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<GetRunResponse | null>> {
  return computed(async (get): Promise<GetRunResponse | null> => {
    const [run] = await get(db$)
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!run) {
      return null;
    }

    return {
      runId: run.id,
      agentComposeVersionId: run.agentComposeVersionId,
      status: run.status as RunStatus,
      prompt: run.prompt,
      appendSystemPrompt: run.appendSystemPrompt,
      vars:
        run.vars === null ? undefined : (run.vars as Record<string, string>),
      sandboxId: run.sandboxId || undefined,
      result:
        run.result === null
          ? undefined
          : (run.result as GetRunResponse["result"]),
      error: run.error || undefined,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
    };
  });
}

export function agentRunList(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}): Computed<Promise<RunListResult>> {
  return computed(async (get): Promise<RunListResult> => {
    const statusValues = args.status
      ? args.status.split(",").map((status) => {
          return status.trim();
        })
      : ["queued", "pending", "running"];

    for (const status of statusValues) {
      if (!ALL_RUN_STATUSES.includes(status as RunStatus)) {
        return {
          kind: "bad-request",
          message: `Invalid status: ${status}. Valid values: ${ALL_RUN_STATUSES.join(", ")}`,
        };
      }
    }

    const conditions = [
      eq(agentRuns.userId, args.userId),
      eq(agentRuns.orgId, args.orgId),
      inArray(agentRuns.status, statusValues as RunStatus[]),
    ];

    if (args.agent) {
      conditions.push(eq(agentComposes.name, args.agent));
    }

    if (args.since) {
      const sinceDate = new Date(args.since);
      if (Number.isNaN(sinceDate.getTime())) {
        return {
          kind: "bad-request",
          message: "Invalid since timestamp format",
        };
      }
      conditions.push(gte(agentRuns.createdAt, sinceDate));
    }

    if (args.until) {
      const untilDate = new Date(args.until);
      if (Number.isNaN(untilDate.getTime())) {
        return {
          kind: "bad-request",
          message: "Invalid until timestamp format",
        };
      }
      conditions.push(lte(agentRuns.createdAt, untilDate));
    }

    const rows = await get(db$)
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        composeName: agentComposes.name,
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
      .where(and(...conditions))
      .orderBy(desc(agentRuns.createdAt))
      .limit(args.limit);

    return {
      kind: "ok",
      body: {
        runs: rows.map((run) => {
          return {
            id: run.id,
            agentName: run.composeName ?? "unknown",
            status: run.status as RunStatus,
            prompt: run.prompt,
            appendSystemPrompt: run.appendSystemPrompt,
            createdAt: run.createdAt.toISOString(),
            startedAt: run.startedAt?.toISOString() ?? null,
          };
        }),
      },
    };
  });
}

export function zeroRunRunner(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): Computed<
  Promise<{ readonly sandboxReuseResult: SandboxReuseResult | null } | null>
> {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select({ sandboxReuseResult: agentRuns.sandboxReuseResult })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      sandboxReuseResult: sandboxReuseResultSchema
        .nullable()
        .parse(row.sandboxReuseResult ?? null),
    };
  });
}

export function zeroOrgTier(orgId: string): Computed<Promise<OrgTier>> {
  return computed(async (get): Promise<OrgTier> => {
    const [row] = await get(db$)
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    if (
      row?.tier === "free" ||
      row?.tier === "pro-suspend" ||
      row?.tier === "pro" ||
      row?.tier === "team"
    ) {
      return row.tier;
    }
    return "pro-suspend";
  });
}

export function zeroRunQueueStatus(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly orgTier: OrgTier;
}): Computed<Promise<QueueResponse>> {
  return computed(async (get): Promise<QueueResponse> => {
    const db = get(db$);
    const limit = effectiveConcurrencyLimit(args.orgTier);
    const [active, queuedRuns, runningRuns, estimatedTime] = await Promise.all([
      activeRunCount(db, args.orgId),
      queuedRunRows(db, args.orgId),
      runningRunRows(db, args.orgId),
      estimatedTimePerRun(db, args.orgId),
    ]);
    const emails = await userEmailMap(db, queuedRuns, runningRuns);

    return {
      concurrency: {
        tier: args.orgTier,
        limit,
        active,
        available: limit === 0 ? -1 : Math.max(0, limit - active),
      },
      queue: queuedRuns.map((run, index) => {
        return queueItem(run, index, args.userId, emails);
      }),
      runningTasks: runningRuns.map((run) => {
        return runningTaskItem(run, args.userId, emails);
      }),
      estimatedTimePerRun: estimatedTime,
    };
  });
}
