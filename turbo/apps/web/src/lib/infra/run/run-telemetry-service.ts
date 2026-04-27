import { eq, and } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { queryAxiom, getDatasetName, DATASETS } from "../../shared/axiom";
import { notFound } from "@vm0/api-services/errors";

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

interface AgentEventsQuery {
  since?: number;
  limit: number;
  order: "asc" | "desc";
}

interface AgentEventsResult {
  events: Array<{
    sequenceNumber: number;
    eventType: string;
    eventData: Record<string, unknown>;
    createdAt: string;
  }>;
  hasMore: boolean;
  framework: string;
}

/**
 * Get agent telemetry events for a run.
 * Verifies run ownership, extracts framework from compose, queries Axiom.
 */
export async function getRunAgentEvents(
  runId: string,
  userId: string,
  orgId: string,
  query: AgentEventsQuery,
): Promise<AgentEventsResult> {
  const db = globalThis.services.db;

  const [runWithCompose] = await db
    .select({
      id: agentRuns.id,
      composeContent: agentComposeVersions.content,
    })
    .from(agentRuns)
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.userId, userId),
        eq(agentRuns.orgId, orgId),
      ),
    )
    .limit(1);

  if (!runWithCompose) {
    throw notFound("Agent run not found");
  }

  const composeContent = runWithCompose.composeContent as {
    agent?: { framework?: string };
  } | null;
  const framework = composeContent?.agent?.framework ?? "claude-code";

  const { since, limit, order } = query;

  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  // `since` is an exclusive sequenceNumber cursor (integer).
  // Historically this filter used `_time`, but Axiom stores `_time` at
  // nanosecond precision while JS Date is millisecond precision — passing
  // the last-seen event's `createdAt` through `new Date(...).toISOString()`
  // truncated sub-millisecond digits, so the server-side `>` comparison
  // still matched the boundary event and returned it again. Using the
  // integer `sequenceNumber` avoids any precision loss.
  const sinceFilter =
    since !== undefined ? `| where sequenceNumber > ${since}` : "";
  const apl = `['${dataset}']
| where runId == "${runId}"
${sinceFilter}
| order by sequenceNumber ${order}
| limit ${limit + 1}`;

  const events = await queryAxiom<AxiomAgentEvent>(apl);

  const hasMore = events.length > limit;
  const resultEvents = hasMore ? events.slice(0, limit) : events;

  return {
    events: resultEvents.map((e) => {
      return {
        sequenceNumber: e.sequenceNumber,
        eventType: e.eventType,
        eventData: e.eventData,
        createdAt: e._time,
      };
    }),
    hasMore,
    framework,
  };
}
