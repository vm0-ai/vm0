import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { logsSearchContract, type RunEvent } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { and, eq, inArray, gte } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../src/lib/axiom";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS_PER_RUN = 200;

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: unknown;
}

/**
 * Escape a string for use inside APL string literals.
 */
function escapeApl(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Check if an event's data contains the keyword (case-insensitive).
 * Uses JSON.stringify to convert nested objects to searchable strings.
 */
function eventMatchesKeyword(event: AxiomAgentEvent, keyword: string): boolean {
  const json = JSON.stringify(event.eventData);
  return json.toLowerCase().includes(keyword.toLowerCase());
}

/**
 * Look up agent names for a set of run IDs.
 */
async function getAgentNames(
  runIds: string[],
  userId: string,
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
    .where(and(inArray(agentRuns.id, runIds), eq(agentRuns.userId, userId)));

  for (const row of rows) {
    result.set(row.runId, row.composeName || "unknown");
  }

  return result;
}

/**
 * Get run IDs belonging to a user, optionally filtered by agent name and time.
 */
async function getUserRunIds(
  userId: string,
  since: Date,
  agentName?: string,
): Promise<string[]> {
  const conditions = [
    eq(agentRuns.userId, userId),
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

    return rows.map((r) => r.runId);
  }

  const rows = await globalThis.services.db
    .select({ runId: agentRuns.id })
    .from(agentRuns)
    .where(and(...conditions));

  return rows.map((r) => r.runId);
}

const router = tsr.router(logsSearchContract, {
  searchLogs: async ({ query, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

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
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
        .limit(1);

      if (!run) {
        return {
          status: 200 as const,
          body: { results: [], hasMore: false },
        };
      }
      targetRunIds = [runId];
    } else {
      targetRunIds = await getUserRunIds(userId, sinceDate, agent);
      if (targetRunIds.length === 0) {
        return {
          status: 200 as const,
          body: { results: [], hasMore: false },
        };
      }
    }

    // Fetch events from Axiom using the same pattern as /telemetry/agent.
    // Keyword filtering is done in TypeScript using JSON.stringify,
    // avoiding Axiom APL compatibility issues with nested JSON search.
    const runIdFilter =
      targetRunIds.length === 1
        ? `| where runId == "${escapeApl(targetRunIds[0]!)}"`
        : `| where runId in (${targetRunIds.map((id) => `"${escapeApl(id)}"`).join(", ")})`;

    const fetchApl = `['${dataset}']
| where _time > datetime("${sinceISO}")
${runIdFilter}
| order by _time desc
| limit ${targetRunIds.length * MAX_EVENTS_PER_RUN}`;

    const allEvents = await queryAxiom<AxiomAgentEvent>(fetchApl);

    if (allEvents === null || allEvents.length === 0) {
      return {
        status: 200 as const,
        body: { results: [], hasMore: false },
      };
    }

    // Filter events by keyword in TypeScript
    const matchedEvents = allEvents.filter((e) =>
      eventMatchesKeyword(e, keyword),
    );

    if (matchedEvents.length === 0) {
      return {
        status: 200 as const,
        body: { results: [], hasMore: false },
      };
    }

    const hasMore = matchedEvents.length > limit;
    const matches = hasMore ? matchedEvents.slice(0, limit) : matchedEvents;

    // Build event index for context lookup
    const eventIndex = new Map<string, AxiomAgentEvent>();
    for (const event of allEvents) {
      eventIndex.set(`${event.runId}:${event.sequenceNumber}`, event);
    }

    // Assemble results with context
    const matchedRunIds = [...new Set(matches.map((e) => e.runId))];
    const agentNames = await getAgentNames(matchedRunIds, userId);

    const results = matches.map((match) => {
      const contextBefore: RunEvent[] = [];
      const contextAfter: RunEvent[] = [];

      for (
        let i = match.sequenceNumber - before;
        i < match.sequenceNumber;
        i++
      ) {
        const event = eventIndex.get(`${match.runId}:${i}`);
        if (event) contextBefore.push(toRunEvent(event));
      }

      for (
        let i = match.sequenceNumber + 1;
        i <= match.sequenceNumber + after;
        i++
      ) {
        const event = eventIndex.get(`${match.runId}:${i}`);
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

    return {
      status: 200 as const,
      body: { results, hasMore },
    };
  },
});

function toRunEvent(event: AxiomAgentEvent): RunEvent {
  return {
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    eventData: event.eventData,
    createdAt: event._time,
  };
}

function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "queryError" in err) {
    const validationError = err as {
      queryError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.queryError?.issues[0]) {
      const issue = validationError.queryError.issues[0];
      const path = issue.path.join(".");
      const message = path ? `${path}: ${issue.message}` : issue.message;
      return TsRestResponse.fromJson(
        { error: { message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
  }

  return undefined;
}

const handler = createHandler(logsSearchContract, router, {
  errorHandler,
});

export { handler as GET };
