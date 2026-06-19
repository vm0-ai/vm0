import { computed, type Computed } from "ccstate";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import type {
  AgentEventsResponse,
  NetworkLogsResponse,
  RunEvent,
} from "@vm0/api-contracts/contracts/runs";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { and, eq } from "drizzle-orm";

import { db$, type Db } from "../external/db";
import { getDatasetName, queryAxiom } from "../external/axiom";
import {
  getAgentEventPageWatermarkTarget,
  waitForRunEventWatermarkVisible,
} from "../../lib/agent-event-visibility";
import { escapeAplString } from "../../lib/axiom-apl";
import {
  buildAgentEventPaginationFilters,
  buildTimePaginationFilters,
  nextSequenceCursor,
  nextTimeCursor,
  sequenceCursorValue,
  timeCursorTimestamp,
} from "./log-pagination";
import { sanitizeAxiomNetworkEvents } from "./network-log-sanitizer";
import { normalizeRunContextSnapshot } from "./run-context-snapshot.service";

type ServiceDb = Pick<Db, "select">;

interface AgentComposeContent {
  agent?: { framework?: string };
  agents?: Record<string, { framework?: string } | undefined>;
}

function extractFramework(composeContent: unknown): string {
  const content = composeContent as AgentComposeContent | null | undefined;
  if (content?.agent?.framework) {
    return content.agent.framework;
  }

  const agents = content?.agents;
  const agentNames = agents ? Object.keys(agents) : [];
  const firstAgent = agentNames.length > 0 ? agents?.[agentNames[0]!] : null;
  return firstAgent?.framework ?? "claude-code";
}

async function verifyRunOwnership(
  db: ServiceDb,
  runId: string,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.userId, userId),
        eq(agentRuns.orgId, orgId),
      ),
    )
    .limit(1);
  return run !== undefined;
}

interface NetworkLogsParams {
  runId: string;
  userId: string;
  orgId: string;
  since?: number;
  sinceTime?: number;
  cursor?: string;
  limit: number;
  order: "asc" | "desc";
}

type RunContextResult =
  | { readonly kind: "not-found" }
  | { readonly kind: "no-snapshot" }
  | { readonly kind: "ok"; readonly context: RunContextResponse };

export function zeroRunContext(
  runId: string,
  userId: string,
  orgId: string,
): Computed<Promise<RunContextResult>> {
  return computed(async (get): Promise<RunContextResult> => {
    const db = get(db$);

    const owned = await verifyRunOwnership(db, runId, userId, orgId);
    if (!owned) {
      return { kind: "not-found" };
    }

    // Get run metadata for vars
    const [run] = await db
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        vars: agentRuns.vars,
        secretNames: agentRuns.secretNames,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return { kind: "not-found" };
    }

    const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (sanitizedRunId !== runId) {
      return { kind: "not-found" };
    }

    const dataset = getDatasetName("run-context");
    const apl = `['${dataset}']
| where runId == "${sanitizedRunId}"
| limit 1`;

    const results = (await get(queryAxiom(apl))) as Record<string, unknown>[];
    const snapshot = results[0];

    if (!snapshot) {
      return { kind: "no-snapshot" };
    }
    const normalizedSnapshot = normalizeRunContextSnapshot(snapshot);

    return {
      kind: "ok",
      context: {
        prompt: run.prompt,
        appendSystemPrompt: run.appendSystemPrompt ?? null,
        runId,
        sessionId: normalizedSnapshot.sessionId,
        secretNames: (run.secretNames as string[]) ?? [],
        vars: (run.vars as Record<string, string> | undefined) ?? null,
        environment: normalizedSnapshot.environment,
        firewalls: normalizedSnapshot.firewalls,
        networkPolicies: normalizedSnapshot.networkPolicies,
        volumes: normalizedSnapshot.volumes,
        artifact: normalizedSnapshot.artifact,
        featureFlags: normalizedSnapshot.featureFlags,
      },
    };
  });
}

export function zeroRunNetworkLogs(
  params: NetworkLogsParams,
): Computed<Promise<NetworkLogsResponse | null>> {
  return computed(async (get): Promise<NetworkLogsResponse | null> => {
    const db = get(db$);

    const owned = await verifyRunOwnership(
      db,
      params.runId,
      params.userId,
      params.orgId,
    );
    if (!owned) {
      return null;
    }

    const { limit, order } = params;
    const previousCursorTimestamp = timeCursorTimestamp(params.cursor, order);

    const dataset = getDatasetName("sandbox-telemetry-network");
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${buildTimePaginationFilters(params)}
| order by _time ${order}
| limit ${limit + 1}`;

    const events = (await get(queryAxiom(apl))).slice();

    const pageHasMore = events.length > limit;
    const records = pageHasMore ? events.slice(0, limit) : events;
    const networkLogs = sanitizeAxiomNetworkEvents(records);
    const nextCursor = nextTimeCursor(
      records,
      pageHasMore,
      order,
      previousCursorTimestamp,
    );
    const hasMore = nextCursor !== null;

    return {
      networkLogs,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  });
}

interface AgentEventsParams {
  runId: string;
  userId: string;
  orgId: string;
  since?: number;
  sinceTime?: number;
  cursor?: string;
  limit: number;
  order: "asc" | "desc";
}

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

// Decide whether the page read needs to wait for Axiom indexing and which
// sequence to wait for.
function getAgentEventsVisibilityTarget(
  lastEventSequence: number | null,
  since: number | undefined,
  sinceTime: number | undefined,
  limit: number,
  order: "asc" | "desc",
): number | null {
  if (lastEventSequence === null) {
    return null;
  }

  if (sinceTime !== undefined && since === undefined) {
    return lastEventSequence;
  }

  if (order === "asc") {
    return getAgentEventPageWatermarkTarget(
      lastEventSequence,
      since,
      limit + 1,
    );
  }

  if (since !== undefined && since >= lastEventSequence) {
    return null;
  }

  return lastEventSequence;
}

export function zeroRunAgentEvents(
  params: AgentEventsParams,
): Computed<Promise<AgentEventsResponse | null>> {
  return computed(async (get): Promise<AgentEventsResponse | null> => {
    const db = get(db$);

    // Verify ownership and get compose content for framework extraction.
    // `lastEventSequence` is needed for the watermark wait below — without it
    // the api would fall through to a cached Axiom read for runs whose events
    // are still in-flight to the indexer. See issue #12424.
    const [runWithCompose] = await db
      .select({
        id: agentRuns.id,
        lastEventSequence: agentRuns.lastEventSequence,
        composeContent: agentComposeVersions.content,
      })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .where(
        and(
          eq(agentRuns.id, params.runId),
          eq(agentRuns.userId, params.userId),
          eq(agentRuns.orgId, params.orgId),
        ),
      )
      .limit(1);

    if (!runWithCompose) {
      return null;
    }

    const framework = extractFramework(runWithCompose.composeContent);

    const { since, limit, order } = params;
    const previousCursorValue = sequenceCursorValue(params.cursor, order);
    const sequenceSince = previousCursorValue ?? since;

    const watermarkTarget = getAgentEventsVisibilityTarget(
      runWithCompose.lastEventSequence,
      sequenceSince,
      params.sinceTime,
      limit,
      order,
    );
    if (watermarkTarget !== null) {
      await waitForRunEventWatermarkVisible(params.runId, watermarkTarget);
    }

    const dataset = getDatasetName("agent-run-events");
    // `since` is an exclusive sequenceNumber cursor (integer). The watermark
    // wait above ensures Axiom can serve the contiguous prefix; the noCache
    // hint below ensures we don't read a stale cached response.
    const paginationFilter = buildAgentEventPaginationFilters(params);
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${paginationFilter}
| order by sequenceNumber ${order}
| limit ${limit + 1}`;

    const events = (
      await get(
        queryAxiom(
          apl,
          watermarkTarget !== null ? { noCache: true } : undefined,
        ),
      )
    ).slice() as unknown as AxiomAgentEvent[];

    const hasMore = events.length > limit;
    const resultEvents = hasMore ? events.slice(0, limit) : events;
    const nextCursor = nextSequenceCursor(
      resultEvents,
      hasMore,
      order,
      previousCursorValue,
    );

    return {
      events: resultEvents.map((e) => {
        return {
          sequenceNumber: e.sequenceNumber,
          eventType: e.eventType,
          eventData: e.eventData,
          createdAt: e._time,
        } satisfies RunEvent;
      }),
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      framework,
    };
  });
}
