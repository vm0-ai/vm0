import "server-only";
import { Axiom, Entry } from "@axiomhq/js";
import { logger } from "../logger";
import { getDatasetName, DATASETS } from "./datasets";

const log = logger("axiom");

let axiomClient: Axiom | null = null;

/**
 * Get the Axiom client singleton.
 * Returns null if AXIOM_TOKEN is not configured.
 */
export function getAxiomClient(): Axiom | null {
  const token = process.env.AXIOM_TOKEN;
  if (!token) {
    return null;
  }

  if (!axiomClient) {
    axiomClient = new Axiom({ token });
    log.debug("Axiom client initialized");
  }

  return axiomClient;
}

/**
 * Ingest events to Axiom dataset.
 * Non-blocking - logs errors but doesn't throw.
 */
export async function ingestToAxiom(
  dataset: string,
  events: Record<string, unknown>[],
): Promise<boolean> {
  const client = getAxiomClient();
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
 * Returns null if Axiom is not configured or query fails.
 */
export async function queryAxiom<T = Record<string, unknown>>(
  apl: string,
): Promise<T[] | null> {
  const client = getAxiomClient();
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

export interface RequestLogEntry {
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
  const client = getAxiomClient();
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

export interface SandboxOpLogEntry {
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
  const client = getAxiomClient();
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
