import { eq, and } from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import { agentComposeVersions } from "../../db/schema/agent-compose";
import { queryAxiom, getDatasetName, DATASETS } from "../axiom";
import { notFound } from "../errors";

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
  const sinceFilter = since
    ? `| where _time > datetime("${new Date(since).toISOString()}")`
    : "";
  const apl = `['${dataset}']
| where runId == "${runId}"
${sinceFilter}
| order by _time ${order}
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
