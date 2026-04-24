import type { RunEvent } from "@vm0/core/contracts/runs";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { agentRuns } from "../../../db/schema/agent-run";
import { and, eq, inArray, gte } from "drizzle-orm";
import { queryAxiom, getDatasetName, DATASETS } from "../../shared/axiom";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: unknown;
}

function escapeApl(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function getAgentNames(
  runIds: string[],
  userId: string,
  orgId: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (runIds.length === 0) return result;

  const rows = await globalThis.services.db
    .select({
      runId: agentRuns.id,
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
    .where(
      and(
        inArray(agentRuns.id, runIds),
        eq(agentRuns.userId, userId),
        eq(agentRuns.orgId, orgId),
      ),
    );

  for (const row of rows) {
    result.set(row.runId, row.composeName || "unknown");
  }

  return result;
}

async function getUserRunIds(
  userId: string,
  orgId: string,
  since: Date,
  agentName?: string,
): Promise<string[]> {
  const conditions = [
    eq(agentRuns.userId, userId),
    eq(agentRuns.orgId, orgId),
    gte(agentRuns.createdAt, since),
  ];

  if (agentName) {
    const rows = await globalThis.services.db
      .select({ runId: agentRuns.id })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .leftJoin(
        agentComposes,
        eq(agentComposeVersions.composeId, agentComposes.id),
      )
      .where(and(...conditions, eq(agentComposes.name, agentName)));

    return rows.map((r) => {
      return r.runId;
    });
  }

  const rows = await globalThis.services.db
    .select({ runId: agentRuns.id })
    .from(agentRuns)
    .where(and(...conditions));

  return rows.map((r) => {
    return r.runId;
  });
}

function buildRunIdFilter(runIds: string[]): string {
  return runIds.length === 1
    ? `| where runId == "${escapeApl(runIds[0]!)}"`
    : `| where runId in (${runIds
        .map((id) => {
          return `"${escapeApl(id)}"`;
        })
        .join(", ")})`;
}

/**
 * Search events using Axiom's search operator which supports maps and arrays.
 * See: https://axiom.co/docs/apl/tabular-operators/search-operator
 */
async function searchEventsInAxiom(
  dataset: string,
  sinceISO: string,
  runIdFilter: string,
  keyword: string,
  limit: number,
): Promise<AxiomAgentEvent[]> {
  const apl = `['${dataset}']
| where _time > datetime("${sinceISO}")
${runIdFilter}
| search "*${escapeApl(keyword)}*"
| order by _time desc
| limit ${limit + 1}`;

  return queryAxiom<AxiomAgentEvent>(apl);
}

/**
 * Fetch context events (surrounding events by sequenceNumber) for matched events.
 */
async function fetchContextEvents(
  dataset: string,
  matches: AxiomAgentEvent[],
  before: number,
  after: number,
): Promise<Map<string, AxiomAgentEvent>> {
  const contextMap = new Map<string, AxiomAgentEvent>();
  if (before === 0 && after === 0) return contextMap;

  const contextConditions = matches.map((match) => {
    const seqMin = Math.max(0, match.sequenceNumber - before);
    const seqMax = match.sequenceNumber + after;
    return `(runId == "${escapeApl(match.runId)}" and sequenceNumber >= ${seqMin} and sequenceNumber <= ${seqMax})`;
  });

  const apl = `['${dataset}']
| where ${contextConditions.join("\n  or ")}
| order by runId asc, sequenceNumber asc`;

  const contextEvents = await queryAxiom<AxiomAgentEvent>(apl);
  for (const event of contextEvents) {
    contextMap.set(`${event.runId}:${event.sequenceNumber}`, event);
  }

  return contextMap;
}

function toRunEvent(event: AxiomAgentEvent): RunEvent {
  return {
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    eventData: event.eventData,
    createdAt: event._time,
  };
}

/**
 * Shared search handler logic used by both `/api/logs/search` and `/api/zero/logs/search`.
 *
 * Accepts a pre-authenticated userId + orgId and the parsed query parameters,
 * then performs the full search flow: run-ID resolution, Axiom search,
 * context fetching, and result assembly.
 */
export async function handleSearchLogs(
  userId: string,
  orgId: string,
  query: {
    keyword: string;
    agent?: string;
    runId?: string;
    since?: number;
    limit: number;
    before: number;
    after: number;
  },
): Promise<{
  results: Array<{
    runId: string;
    agentName: string;
    matchedEvent: RunEvent;
    contextBefore: RunEvent[];
    contextAfter: RunEvent[];
  }>;
  hasMore: boolean;
}> {
  const { keyword, agent, runId, limit, before, after } = query;
  const since = query.since ?? Date.now() - SEVEN_DAYS_MS;
  const sinceDate = new Date(since);
  const sinceISO = sinceDate.toISOString();
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);

  // Determine which run IDs to search (ownership verified via DB).
  let targetRunIds: string[];
  if (runId) {
    const [run] = await globalThis.services.db
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

    if (!run) {
      return { results: [], hasMore: false };
    }
    targetRunIds = [runId];
  } else {
    targetRunIds = await getUserRunIds(userId, orgId, sinceDate, agent);
    if (targetRunIds.length === 0) {
      return { results: [], hasMore: false };
    }
  }

  const runIdFilter = buildRunIdFilter(targetRunIds);

  const matchedEvents = await searchEventsInAxiom(
    dataset,
    sinceISO,
    runIdFilter,
    keyword,
    limit,
  );

  if (matchedEvents.length === 0) {
    return { results: [], hasMore: false };
  }

  const hasMore = matchedEvents.length > limit;
  const matches = hasMore ? matchedEvents.slice(0, limit) : matchedEvents;

  // Fetch context events
  const contextMap = await fetchContextEvents(dataset, matches, before, after);

  // Assemble results
  const matchedRunIds = [
    ...new Set(
      matches.map((e) => {
        return e.runId;
      }),
    ),
  ];
  const agentNames = await getAgentNames(matchedRunIds, userId, orgId);

  const results = matches.map((match) => {
    const contextBefore: RunEvent[] = [];
    const contextAfter: RunEvent[] = [];

    for (let i = match.sequenceNumber - before; i < match.sequenceNumber; i++) {
      const event = contextMap.get(`${match.runId}:${i}`);
      if (event) contextBefore.push(toRunEvent(event));
    }

    for (
      let i = match.sequenceNumber + 1;
      i <= match.sequenceNumber + after;
      i++
    ) {
      const event = contextMap.get(`${match.runId}:${i}`);
      if (event) contextAfter.push(toRunEvent(event));
    }

    return {
      runId: match.runId,
      agentName: agentNames.get(match.runId) || "unknown",
      matchedEvent: toRunEvent(match),
      contextBefore,
      contextAfter,
    };
  });

  return { results, hasMore };
}
