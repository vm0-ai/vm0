import { computed, type Computed } from "ccstate";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import type {
  AgentEventsResponse,
  AxiomNetworkEvent,
  NetworkLogEntry,
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

type ServiceDb = Pick<Db, "select">;
type UnknownRecord = Record<string, unknown>;
type NetworkPolicyValue = "allow" | "deny" | "ask";

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
  limit: number;
  order: "asc" | "desc";
}

type RunContextResult =
  | { readonly kind: "not-found" }
  | { readonly kind: "no-snapshot" }
  | { readonly kind: "ok"; readonly context: RunContextResponse };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => {
    return typeof item === "string";
  });
  return strings.length === value.length ? strings : undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    },
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function booleanRecordValue(
  value: unknown,
): Record<string, boolean> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, boolean] => {
      return typeof entry[1] === "boolean";
    },
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function networkPolicyValue(value: unknown): NetworkPolicyValue | undefined {
  return value === "allow" || value === "deny" || value === "ask"
    ? value
    : undefined;
}

function sanitizeNetworkPolicies(
  value: unknown,
): RunContextResponse["networkPolicies"] {
  if (!isRecord(value)) {
    return null;
  }

  const policies: NonNullable<RunContextResponse["networkPolicies"]> = {};
  for (const [name, rawPolicy] of Object.entries(value)) {
    if (!isRecord(rawPolicy)) {
      continue;
    }
    const unknownPolicy = networkPolicyValue(rawPolicy.unknownPolicy);
    if (!unknownPolicy) {
      continue;
    }
    policies[name] = {
      allow: stringArrayValue(rawPolicy.allow) ?? [],
      deny: stringArrayValue(rawPolicy.deny) ?? [],
      ask: stringArrayValue(rawPolicy.ask) ?? [],
      unknownPolicy,
    };
  }

  return Object.keys(policies).length > 0 ? policies : null;
}

function networkActionValue(
  value: unknown,
): NetworkLogEntry["action"] | undefined {
  return value === "ALLOW" || value === "DENY" ? value : undefined;
}

function networkBodyEncodingValue(
  value: unknown,
): NetworkLogEntry["request_body_encoding"] | undefined {
  if (value !== "base64" && value !== "binary") {
    if (
      typeof value !== "string" ||
      value.length !== 5 ||
      value.slice(0, 3) !== "utf" ||
      value[3] !== "-" ||
      value[4] !== "8"
    ) {
      return undefined;
    }
  }
  return value as NetworkLogEntry["request_body_encoding"];
}

function omitUndefined<T extends UnknownRecord>(record: T): UnknownRecord {
  return Object.fromEntries(
    Object.entries(record).filter((entry) => {
      return entry[1] !== undefined;
    }),
  );
}

function sanitizeNetworkEvent(event: AxiomNetworkEvent): NetworkLogEntry {
  return omitUndefined({
    timestamp: event._time,
    type: stringValue(event.type),
    action: networkActionValue(event.action),
    host: stringValue(event.host),
    port: numberValue(event.port),
    method: stringValue(event.method),
    url: stringValue(event.url),
    status: numberValue(event.status),
    latency_ms: numberValue(event.latency_ms),
    request_size: numberValue(event.request_size),
    response_size: numberValue(event.response_size),
    dns_event: stringValue(event.dns_event),
    dns_query_type: stringValue(event.dns_query_type),
    dns_result: stringValue(event.dns_result),
    dns_serial: stringValue(event.dns_serial),
    firewall_base: stringValue(event.firewall_base),
    firewall_name: stringValue(event.firewall_name),
    firewall_permission: stringValue(event.firewall_permission),
    firewall_rule_match: stringValue(event.firewall_rule_match),
    firewall_params: stringRecordValue(event.firewall_params),
    firewall_billable: booleanValue(event.firewall_billable),
    firewall_error: stringValue(event.firewall_error),
    auth_resolved_secrets: stringArrayValue(event.auth_resolved_secrets),
    auth_refreshed_connectors: stringArrayValue(
      event.auth_refreshed_connectors,
    ),
    auth_refreshed_secrets: stringArrayValue(event.auth_refreshed_secrets),
    auth_cache_hit: booleanValue(event.auth_cache_hit),
    auth_url_rewrite: booleanValue(event.auth_url_rewrite),
    error: stringValue(event.error),
    request_headers: stringRecordValue(event.request_headers),
    request_body: stringValue(event.request_body),
    request_body_encoding: networkBodyEncodingValue(
      event.request_body_encoding,
    ),
    request_body_truncated: booleanValue(event.request_body_truncated),
    response_headers: stringRecordValue(event.response_headers),
    response_body: stringValue(event.response_body),
    response_body_encoding: networkBodyEncodingValue(
      event.response_body_encoding,
    ),
    response_body_truncated: booleanValue(event.response_body_truncated),
  }) as NetworkLogEntry;
}

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
    const snapshot = results[0] as
      | (Omit<
          RunContextResponse,
          "vars" | "prompt" | "appendSystemPrompt" | "runId" | "secretNames"
        > & {
          sessionId?: string;
          environment?: UnknownRecord;
          firewalls?: RunContextResponse["firewalls"];
          networkPolicies?: unknown;
          volumes?: RunContextResponse["volumes"];
          artifact?: RunContextResponse["artifact"];
          featureFlags?: UnknownRecord;
        })
      | undefined;

    if (!snapshot) {
      return { kind: "no-snapshot" };
    }

    return {
      kind: "ok",
      context: {
        prompt: run.prompt,
        appendSystemPrompt: run.appendSystemPrompt ?? null,
        runId,
        sessionId: (snapshot.sessionId as string) ?? null,
        secretNames: (run.secretNames as string[]) ?? [],
        vars: (run.vars as Record<string, string> | undefined) ?? null,
        environment: stringRecordValue(snapshot.environment) ?? {},
        firewalls:
          (snapshot.firewalls as RunContextResponse["firewalls"]) ?? [],
        networkPolicies: sanitizeNetworkPolicies(snapshot.networkPolicies),
        volumes: (snapshot.volumes as RunContextResponse["volumes"]) ?? [],
        artifact: (snapshot.artifact as RunContextResponse["artifact"]) ?? null,
        featureFlags: booleanRecordValue(snapshot.featureFlags) ?? null,
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

    const { since, limit, order } = params;

    const dataset = getDatasetName("sandbox-telemetry-network");
    const sinceFilter = since
      ? `| where _time > datetime("${new Date(since).toISOString()}")`
      : "";
    const apl = `['${dataset}']
| where runId == "${params.runId}"
${sinceFilter}
| order by _time ${order}
| limit ${limit + 1}`;

    const events = (await get(queryAxiom(apl))) as AxiomNetworkEvent[];

    const hasMore = events.length > limit;
    const records = hasMore ? events.slice(0, limit) : events;

    const networkLogs = records.map(sanitizeNetworkEvent);

    return { networkLogs, hasMore };
  });
}

interface AgentEventsParams {
  runId: string;
  userId: string;
  orgId: string;
  since?: number;
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
  limit: number,
  order: "asc" | "desc",
): number | null {
  if (lastEventSequence === null) {
    return null;
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

    const watermarkTarget = getAgentEventsVisibilityTarget(
      runWithCompose.lastEventSequence,
      since,
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
    const sinceFilter =
      since !== undefined ? `| where sequenceNumber > ${since}` : "";
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${sinceFilter}
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
      framework,
    };
  });
}
