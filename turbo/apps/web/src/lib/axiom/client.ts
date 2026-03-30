import "server-only";
import { Axiom, Entry } from "@axiomhq/js";
import { env } from "../../env";
import { logger } from "../logger";
import { getDatasetName, DATASETS, isSessionsDataset } from "./datasets";

const log = logger("axiom");

let sessionsClient: Axiom | null = null;
let telemetryClient: Axiom | null = null;
let sessionsInitialized = false;
let telemetryInitialized = false;

/**
 * Resolve the token for the sessions scope (agent-run-events).
 */
function getSessionsToken(): string | undefined {
  return env().AXIOM_TOKEN_SESSIONS;
}

/**
 * Resolve the token for the telemetry scope (all other datasets).
 */
function getTelemetryToken(): string | undefined {
  return env().AXIOM_TOKEN_TELEMETRY;
}

/**
 * Get the Axiom client for the sessions scope (agent-run-events).
 * Returns null if no token is configured.
 */
function getSessionsClient(): Axiom | null {
  if (sessionsInitialized) return sessionsClient;
  sessionsInitialized = true;

  const token = getSessionsToken();
  if (!token) return null;

  sessionsClient = new Axiom({ token });
  log.debug("Axiom sessions client initialized");
  return sessionsClient;
}

/**
 * Get the Axiom client for the telemetry scope (all other datasets).
 * Returns null if no token is configured.
 */
function getTelemetryClient(): Axiom | null {
  if (telemetryInitialized) return telemetryClient;
  telemetryInitialized = true;

  const token = getTelemetryToken();
  if (!token) return null;

  telemetryClient = new Axiom({ token });
  log.debug("Axiom telemetry client initialized");
  return telemetryClient;
}

/**
 * Get the appropriate Axiom client for a dataset name.
 * Routes to sessions client for agent-run-events, telemetry client for everything else.
 */
function getClientForDataset(dataset: string): Axiom | null {
  return isSessionsDataset(dataset)
    ? getSessionsClient()
    : getTelemetryClient();
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
 * Events are queued in the Axiom SDK's internal batch and flushed at the
 * response boundary via {@link flushAxiom} (called from ts-rest-handler).
 * This avoids per-call HTTP requests and keeps API usage within org limits.
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
 */
export async function flushAxiom(): Promise<void> {
  const results = await Promise.allSettled([
    sessionsClient?.flush(),
    telemetryClient?.flush(),
  ]);
  for (const r of results) {
    if (r.status === "rejected") {
      log.error("Axiom flush failed:", r.reason);
    }
  }
}

// ── Query retry ─────────────────────────────────────────────────────────

const MAX_QUERY_RETRIES = 3;
const QUERY_BACKOFF_BASE_MS = 2000;

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
): Promise<T[]> {
  const dataset = extractDatasetFromApl(apl);
  // If we can't determine the dataset, default to telemetry client (broader scope)
  const client = dataset ? getClientForDataset(dataset) : getTelemetryClient();
  if (!client) {
    log.debug("Axiom not configured, skipping query");
    return [];
  }

  for (let attempt = 0; attempt <= MAX_QUERY_RETRIES; attempt++) {
    try {
      const result = await client.query(apl);
      // Axiom stores _time separately from data, merge them for the response
      return (
        result.matches?.map(
          (m: Entry) => ({ _time: m._time, ...m.data }) as T,
        ) ?? []
      );
    } catch (error) {
      if (attempt < MAX_QUERY_RETRIES && isRateLimitError(error)) {
        const waitMs =
          extractRetryAfterMs(error) ??
          QUERY_BACKOFF_BASE_MS * Math.pow(2, attempt);
        log.warn(
          `Axiom query rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_QUERY_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw error;
    }
  }

  // Unreachable — the final attempt either returns or throws above
  return [];
}

interface RequestLogEntry {
  remote_addr: string;
  user_agent: string;
  method: string;
  path_template: string;
  host: string;
  status: number;
  body_bytes_sent: number;
  request_time_ms: number;
}

/**
 * Ingest request log to Axiom (nginx-style).
 * Fire-and-forget - doesn't block the response.
 */
export function ingestRequestLog(entry: RequestLogEntry): void {
  const client = getTelemetryClient();
  if (!client) {
    return;
  }

  const dataset = getDatasetName(DATASETS.REQUEST_LOG);
  client.ingest(dataset, [
    {
      _time: new Date().toISOString(),
      ...entry,
    },
  ]);
  // Don't await flush - let it batch automatically
}

interface SandboxOpLogEntry {
  source: "web" | "runner" | "sandbox";
  op_type: string;
  sandbox_type: string;
  duration_ms: number;
}

/**
 * Ingest sandbox operation log to Axiom.
 * Fire-and-forget - doesn't block the response.
 */
export function ingestSandboxOpLog(entry: SandboxOpLogEntry): void {
  const client = getTelemetryClient();
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
