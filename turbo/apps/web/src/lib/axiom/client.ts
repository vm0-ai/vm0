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
 * Ingest events to Axiom dataset.
 * Non-blocking - logs errors but doesn't throw.
 */
export async function ingestToAxiom(
  dataset: string,
  events: Record<string, unknown>[],
): Promise<boolean> {
  const client = getClientForDataset(dataset);
  if (!client) {
    log.debug("Axiom not configured, skipping ingest");
    return false;
  }

  try {
    client.ingest(dataset, events);
    await client.flush();
    log.debug(`Ingested ${events.length} events to ${dataset}`);
    return true;
  } catch (error) {
    log.error(`Axiom ingest failed for ${dataset}:`, error);
    return false;
  }
}

/**
 * Query events from Axiom dataset using APL.
 * Automatically routes to the correct client based on the dataset in the APL query.
 * Returns null if Axiom is not configured or query fails.
 */
export async function queryAxiom<T = Record<string, unknown>>(
  apl: string,
): Promise<T[] | null> {
  const dataset = extractDatasetFromApl(apl);
  // If we can't determine the dataset, default to telemetry client (broader scope)
  const client = dataset ? getClientForDataset(dataset) : getTelemetryClient();
  if (!client) {
    log.debug("Axiom not configured, skipping query");
    return null;
  }

  try {
    const result = await client.query(apl);
    // Axiom stores _time separately from data, merge them for the response
    return (
      result.matches?.map((m: Entry) => ({ _time: m._time, ...m.data }) as T) ??
      []
    );
  } catch (error) {
    log.error("Axiom query failed:", error);
    return null;
  }
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
