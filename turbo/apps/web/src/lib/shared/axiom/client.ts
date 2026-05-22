import "server-only";
import type {
  Axiom,
  QueryOptions as AxiomQueryOptions,
  QueryResult,
} from "@axiomhq/js";
import { Entry } from "@axiomhq/js";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import { env } from "../../../env";
import { logger } from "../logger";
import { getDatasetName, DATASETS, isSessionsDataset } from "./datasets";
import {
  getSessionsInstance,
  getTelemetryInstance,
  getSessionsClient,
  getTelemetryClient,
} from "./instances";

const log = logger("axiom");

/**
 * Get the appropriate Axiom client for a dataset name.
 * Initializes the client on first access, routes to sessions client
 * for agent-run-events and telemetry client for everything else.
 */
function getClientForDataset(dataset: string): Axiom | null {
  return isSessionsDataset(dataset)
    ? getSessionsInstance(env().AXIOM_TOKEN_SESSIONS)
    : getTelemetryInstance(env().AXIOM_TOKEN_TELEMETRY);
}

export function isAxiomDatasetConfigured(dataset: string): boolean {
  return isSessionsDataset(dataset)
    ? Boolean(env().AXIOM_TOKEN_SESSIONS)
    : Boolean(env().AXIOM_TOKEN_TELEMETRY);
}

/**
 * Extract the dataset name from an APL query string.
 * APL queries always start with ['dataset-name'].
 * Returns null if extraction fails.
 */
function extractDatasetFromApl(apl: string): string | null {
  const match = apl.match(/\['([^']+)'\]/);
  return match?.[1] ?? null;
}

/**
 * Buffer events for Axiom ingestion.
 *
 * Events are queued in the Axiom SDK's internal batch and flushed at request
 * boundaries by callers that need durable ingestion.
 */
export function ingestToAxiom(
  dataset: string,
  events: Record<string, unknown>[],
): boolean {
  const client = getClientForDataset(dataset);
  if (!client) {
    log.debug("Axiom not configured, skipping ingest");
    return false;
  }

  client.ingest(dataset, events);
  log.debug(`Buffered ${events.length} events for ${dataset}`);
  return true;
}

/**
 * Flush all pending Axiom ingestion batches.
 *
 * Call at request/response boundaries to ensure buffered events are sent
 * before the serverless function terminates.
 *
 * Errors are logged by default. Callers that need durability for a specific
 * request path can opt into propagation with `throwOnError`.
 */
interface FlushAxiomOptions {
  throwOnError?: boolean;
  client?: "all" | "sessions" | "telemetry";
}

export async function flushAxiom(
  options: FlushAxiomOptions = {},
): Promise<void> {
  const client = options.client ?? "all";
  const flushes: Array<{ name: string; promise: Promise<void> | undefined }> =
    [];
  if (client === "all" || client === "sessions") {
    flushes.push({ name: "sessions", promise: getSessionsClient()?.flush() });
  }
  if (client === "all" || client === "telemetry") {
    flushes.push({ name: "telemetry", promise: getTelemetryClient()?.flush() });
  }

  const results = await Promise.allSettled(
    flushes.map((flush) => {
      return flush.promise;
    }),
  );
  const errors: unknown[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      errors.push(r.reason);
      log.error(
        `Axiom ${flushes[i]?.name ?? "unknown"} flush failed:`,
        r.reason,
      );
    }
  }
  if (options.throwOnError && errors.length > 0) {
    throw new AggregateError(errors, "Axiom flush failed");
  }
}

// ── Query retry ─────────────────────────────────────────────────────────

const MAX_QUERY_RETRIES = 3;
const QUERY_BACKOFF_BASE_MS = 2000;

export interface QueryAxiomOptions {
  maxRetries?: number;
  noCache?: AxiomQueryOptions["noCache"];
  streamingDuration?: AxiomQueryOptions["streamingDuration"];
  timeoutMs?: number;
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("rate limit") || msg.includes("429");
  }
  return false;
}

function extractRetryAfterMs(error: unknown): number | null {
  if (error instanceof Error) {
    // Axiom error format: "try again in 0m19s"
    const match = error.message.match(/try again in (\d+)m(\d+)s/);
    if (match?.[1] && match[2]) {
      return (parseInt(match[1], 10) * 60 + parseInt(match[2], 10)) * 1000;
    }
  }
  return null;
}

/**
 * Query events from Axiom dataset using APL.
 * Automatically routes to the correct client based on the dataset in the APL query.
 * Returns empty array if Axiom is not configured.
 *
 * Retries up to {@link MAX_QUERY_RETRIES} times on rate-limit (429) errors
 * with exponential backoff, respecting the server's `retry_after` hint when
 * available.
 */
export async function queryAxiom<T = Record<string, unknown>>(
  apl: string,
  options: QueryAxiomOptions = {},
): Promise<T[]> {
  const dataset = extractDatasetFromApl(apl);
  // If we can't determine the dataset, default to telemetry client (broader scope)
  const client =
    options.timeoutMs === undefined
      ? dataset
        ? getClientForDataset(dataset)
        : getTelemetryInstance(env().AXIOM_TOKEN_TELEMETRY)
      : null;
  if (options.timeoutMs === undefined && !client) {
    log.debug("Axiom not configured, skipping query");
    return [];
  }

  const maxRetries = options.maxRetries ?? MAX_QUERY_RETRIES;
  const axiomQueryOptions: AxiomQueryOptions = {};
  if (options.noCache !== undefined) {
    axiomQueryOptions.noCache = options.noCache;
  }
  if (options.streamingDuration !== undefined) {
    axiomQueryOptions.streamingDuration = options.streamingDuration;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let result: QueryResult;
      if (options.timeoutMs === undefined) {
        if (!client) {
          log.debug("Axiom not configured, skipping query");
          return [];
        }
        result = (await client.query(apl, axiomQueryOptions)) as QueryResult;
      } else {
        result = await queryAxiomWithTimeout(apl, dataset, options);
      }
      // Axiom stores _time separately from data, merge them for the response
      return (
        result.matches?.map((m: Entry) => {
          return { _time: m._time, ...m.data } as T;
        }) ?? []
      );
    } catch (error) {
      if (attempt < maxRetries && isRateLimitError(error)) {
        const waitMs =
          extractRetryAfterMs(error) ??
          QUERY_BACKOFF_BASE_MS * Math.pow(2, attempt);
        log.warn(
          `Axiom query rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => {
          return setTimeout(r, waitMs);
        });
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    "queryAxiom: unreachable — retry loop exited without return or throw",
  );
}

async function queryAxiomWithTimeout(
  apl: string,
  dataset: string | null,
  options: QueryAxiomOptions,
): Promise<QueryResult> {
  const token = dataset
    ? isSessionsDataset(dataset)
      ? env().AXIOM_TOKEN_SESSIONS
      : env().AXIOM_TOKEN_TELEMETRY
    : env().AXIOM_TOKEN_TELEMETRY;
  if (!token) {
    log.debug("Axiom not configured, skipping query");
    return emptyQueryResult(dataset);
  }

  const timeoutMs = Math.max(1, options.timeoutMs ?? 1);
  const params = new URLSearchParams({ format: "legacy" });
  if (options.noCache !== undefined) {
    params.set("nocache", String(options.noCache));
  }
  if (options.streamingDuration !== undefined) {
    params.set("streaming-duration", options.streamingDuration);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(
      `https://api.axiom.co/v1/datasets/_apl?${params.toString()}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ apl }),
        signal: controller.signal,
        cache: "no-store",
      },
    );

    if (response.status === 429) {
      throw new Error("429 rate limit");
    }
    if (response.status === 401) {
      throw new Error("forbidden");
    }
    if (response.status >= 400) {
      const payload = (await response.json().catch(() => {
        return {};
      })) as { message?: string };
      throw new Error(
        payload.message ?? `Axiom query failed: ${response.status}`,
      );
    }

    return (await response.json()) as QueryResult;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Axiom query timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function emptyQueryResult(dataset: string | null): QueryResult {
  const epoch = "1970-01-01T00:00:00.000Z";
  return {
    request: {
      startTime: epoch,
      endTime: epoch,
      resolution: "auto",
    },
    buckets: {},
    datasetNames: dataset ? [dataset] : [],
    matches: [],
    status: {
      blocksExamined: 0,
      elapsedTime: 0,
      isPartial: false,
      maxBlockTime: epoch,
      minBlockTime: epoch,
      numGroups: 0,
      rowsExamined: 0,
      rowsMatched: 0,
      maxCursor: "",
      minCursor: "",
    },
  };
}

// ── Run context snapshot ────────────────────────────────────────────────

/**
 * Snapshot of dynamically-computed execution context fields stored in Axiom.
 * Derived from the API response shape (defined by Zod schema in @vm0/core)
 * but excludes `vars` (which comes from agent_runs at query time) and adds
 * Axiom-only field (userId) that is not exposed to clients.
 *
 * This keeps the Axiom storage type and the API response type in sync —
 * changes to the Zod schema in zero-runs.ts are automatically reflected here.
 */
export interface RunContextSnapshot extends Omit<RunContextResponse, "vars"> {
  userId: string;
}

/**
 * Ingest run execution context snapshot to Axiom.
 * The snapshot must already be sanitized (secrets masked, auth headers stripped).
 * Fire-and-forget - doesn't block the response.
 */
export function ingestRunContext(snapshot: RunContextSnapshot): void {
  const client = getTelemetryInstance(env().AXIOM_TOKEN_TELEMETRY);
  if (!client) {
    return;
  }

  const dataset = getDatasetName(DATASETS.RUN_CONTEXT);
  client.ingest(dataset, [
    {
      _time: new Date().toISOString(),
      ...snapshot,
    },
  ]);
}

/**
 * End-to-end pipeline op log entry. One dataset covers:
 *   - `source: "web"` — api_to_executor / api_to_claim spans from the run dispatch path
 *   - `source: "web-chat"` — Phase-1 `/api/zero/chat/messages` stage spans; `run_id`
 *     is absent until the transaction commits, so it's optional here.
 *   - `source: "runner"` — runner-side step.op spans
 *   - `source: "sandbox"` — in-sandbox op spans
 * Additional dimensions (agent_id, thread_id, org_id, …) are spread in
 * schemaless by callers.
 */
interface SandboxOpLogEntry {
  source: "web" | "web-chat" | "runner" | "sandbox";
  op_type: string;
  sandbox_type: string;
  duration_ms: number;
  run_id?: string;
  [key: string]: unknown;
}

/**
 * Ingest sandbox operation log to Axiom.
 * Fire-and-forget - doesn't block the response.
 */
export function ingestSandboxOpLog(entry: SandboxOpLogEntry): void {
  const client = getTelemetryInstance(env().AXIOM_TOKEN_TELEMETRY);
  if (!client) {
    return;
  }

  const dataset = getDatasetName(DATASETS.SANDBOX_OP_LOG);
  client.ingest(dataset, [
    {
      _time: new Date().toISOString(),
      ...entry,
    },
  ]);
  // Don't await flush - let it batch automatically
}
