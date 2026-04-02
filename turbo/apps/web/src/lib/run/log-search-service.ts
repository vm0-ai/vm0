import type { RunEvent } from "@vm0/core";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { and, eq, inArray, gte } from "drizzle-orm";
import { queryAxiom } from "../axiom";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

export async function getAgentNames(
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

export async function getUserRunIds(
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

export function buildRunIdFilter(runIds: string[]): string {
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
export async function searchEventsInAxiom(
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
export async function fetchContextEvents(
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

export function toRunEvent(event: AxiomAgentEvent): RunEvent {
  return {
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    eventData: event.eventData,
    createdAt: event._time,
  };
}
