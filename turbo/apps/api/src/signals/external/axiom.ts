import { computed, type Computed } from "ccstate";
import { Axiom } from "@axiomhq/js";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { startUntrackedBestEffortCleanup } from "../utils";
import {
  getAxiomTokenEnvNameForApl,
  getAxiomTokenEnvNameForDataset,
} from "./axiom-datasets";

const AXIOM_API_ORIGIN = "https://api.axiom.co";
const AXIOM_QUERY_TIMEOUT_MS = 120_000;
const AXIOM_INGEST_FAILURE_DETAIL_LIMIT = 3;
const AXIOM_INGEST_FAILURE_ERROR_MAX_LENGTH = 512;

const L = logger("api:axiom");

function logClientError(client: "sessions" | "telemetry", error: Error): void {
  L.error("Axiom client operation failed", { client, error });
}

const sessionsAxiomClient = singleton(() => {
  return new Axiom({
    token: env("AXIOM_TOKEN_SESSIONS"),
    onError: (error) => {
      logClientError("sessions", error);
    },
  });
});

const telemetryAxiomClient = singleton(() => {
  return new Axiom({
    token: env("AXIOM_TOKEN_TELEMETRY"),
    onError: (error) => {
      logClientError("telemetry", error);
    },
  });
});

export function getDatasetName(base: string): string {
  return `vm0-${base}-${env("AXIOM_DATASET_SUFFIX")}`;
}

function axiomClientForApl(apl: string): Axiom {
  const tokenEnvName = getAxiomTokenEnvNameForApl(apl);
  if (tokenEnvName === "AXIOM_TOKEN_SESSIONS") {
    return sessionsAxiomClient();
  }
  return telemetryAxiomClient();
}

function axiomClientForDataset(dataset: string): Axiom | null {
  const tokenEnvName = getAxiomTokenEnvNameForDataset(dataset);
  if (!optionalEnv(tokenEnvName)) {
    return null;
  }
  if (tokenEnvName === "AXIOM_TOKEN_SESSIONS") {
    return sessionsAxiomClient();
  }
  return telemetryAxiomClient();
}

export function ingestToAxiom(
  dataset: string,
  events: readonly Record<string, unknown>[],
): boolean {
  const client = axiomClientForDataset(dataset);
  if (!client) {
    return false;
  }
  client.ingest(dataset, [...events]);
  return true;
}

interface AxiomIngestFailure {
  readonly timestamp: string;
  readonly error: string;
}

interface AxiomIngestStatus {
  readonly ingested: number;
  readonly failed: number;
  readonly failures?: readonly AxiomIngestFailure[];
  readonly processedBytes: number;
  readonly blocksCreated?: number;
  readonly walLength?: number;
}

type DirectAxiomIngestResult =
  | { readonly configured: false }
  | { readonly configured: true };

type DirectAxiomIngestErrorOptions =
  | {
      readonly reason: "http_status";
      readonly dataset: string;
      readonly status: number;
    }
  | {
      readonly reason: "invalid_response";
      readonly dataset: string;
    }
  | {
      readonly reason: "partial_ingest";
      readonly dataset: string;
      readonly expected: number;
      readonly ingested: number;
      readonly failed: number;
      readonly failureDetailsReturned: number;
      readonly failureDetails: readonly AxiomIngestFailure[];
      readonly failureDetailsOmitted: number;
    };

class DirectAxiomIngestError extends Error {
  readonly reason: "http_status" | "invalid_response" | "partial_ingest";
  readonly dataset: string;
  readonly status?: number;
  readonly expected?: number;
  readonly ingested?: number;
  readonly failed?: number;
  readonly failureDetailsReturned?: number;
  readonly failureDetails?: readonly AxiomIngestFailure[];
  readonly failureDetailsOmitted?: number;

  constructor(message: string, options: DirectAxiomIngestErrorOptions) {
    super(message);
    this.name = "DirectAxiomIngestError";
    this.reason = options.reason;
    this.dataset = options.dataset;
    if (options.reason === "http_status") {
      this.status = options.status;
    }
    if (options.reason === "partial_ingest") {
      this.expected = options.expected;
      this.ingested = options.ingested;
      this.failed = options.failed;
      this.failureDetailsReturned = options.failureDetailsReturned;
      this.failureDetails = options.failureDetails;
      this.failureDetailsOmitted = options.failureDetailsOmitted;
    }
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isAxiomIngestFailure(value: unknown): value is AxiomIngestFailure {
  return (
    isRecord(value) &&
    typeof value.timestamp === "string" &&
    typeof value.error === "string"
  );
}

function isAxiomIngestStatus(value: unknown): value is AxiomIngestStatus {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonNegativeInteger(value.ingested) &&
    isNonNegativeInteger(value.failed) &&
    isNonNegativeInteger(value.processedBytes) &&
    (value.blocksCreated === undefined ||
      isNonNegativeInteger(value.blocksCreated)) &&
    (value.walLength === undefined || isNonNegativeInteger(value.walLength)) &&
    (value.failures === undefined ||
      (Array.isArray(value.failures) &&
        value.failures.every(isAxiomIngestFailure)))
  );
}

function boundedAxiomIngestFailureError(error: string): string {
  const normalized = error.replace(/\s+/g, " ").trim();
  if (normalized.length <= AXIOM_INGEST_FAILURE_ERROR_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, AXIOM_INGEST_FAILURE_ERROR_MAX_LENGTH - 3)}...`;
}

function axiomIngestUrl(dataset: string): string {
  return new URL(
    `/v1/datasets/${encodeURIComponent(dataset)}/ingest`,
    AXIOM_API_ORIGIN,
  ).toString();
}

export async function ingestAxiomDirect(
  dataset: string,
  events: readonly Record<string, unknown>[],
  signal: AbortSignal,
): Promise<DirectAxiomIngestResult> {
  const tokenEnvName = getAxiomTokenEnvNameForDataset(dataset);
  const token = optionalEnv(tokenEnvName);
  if (!token) {
    return { configured: false };
  }

  const response = await fetch(axiomIngestUrl(dataset), {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(events),
    signal,
  });

  if (!response.ok) {
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    throw new DirectAxiomIngestError(
      `Axiom ingest failed with status ${response.status}`,
      {
        reason: "http_status",
        dataset,
        status: response.status,
      },
    );
  }

  const payload: unknown = await response.json();
  if (!isAxiomIngestStatus(payload)) {
    throw new DirectAxiomIngestError(
      "Axiom ingest returned an unexpected response shape",
      { reason: "invalid_response", dataset },
    );
  }
  if (
    payload.failed !== 0 ||
    (payload.failures?.length ?? 0) !== 0 ||
    payload.ingested !== events.length
  ) {
    const returnedFailureDetails = payload.failures ?? [];
    const failureDetails = returnedFailureDetails
      .slice(0, AXIOM_INGEST_FAILURE_DETAIL_LIMIT)
      .map((failure) => {
        return {
          timestamp: failure.timestamp,
          error: boundedAxiomIngestFailureError(failure.error),
        };
      });
    throw new DirectAxiomIngestError(
      `Axiom ingest accepted ${payload.ingested} of ${events.length} events with ${payload.failed} failed events and ${payload.failures?.length ?? 0} failure details`,
      {
        reason: "partial_ingest",
        dataset,
        expected: events.length,
        ingested: payload.ingested,
        failed: payload.failed,
        failureDetailsReturned: returnedFailureDetails.length,
        failureDetails,
        failureDetailsOmitted:
          returnedFailureDetails.length - failureDetails.length,
      },
    );
  }

  return { configured: true };
}

interface FlushAxiomOptions {
  readonly client?: "all" | "sessions" | "telemetry";
}

export async function flushAxiom(
  options: FlushAxiomOptions = {},
): Promise<void> {
  const client = options.client ?? "all";
  const flushes: {
    readonly name: string;
    readonly promise?: Promise<void>;
  }[] = [];

  if (client === "all" || client === "sessions") {
    flushes.push({
      name: "sessions",
      promise: optionalEnv("AXIOM_TOKEN_SESSIONS")
        ? sessionsAxiomClient().flush()
        : undefined,
    });
  }
  if (client === "all" || client === "telemetry") {
    flushes.push({
      name: "telemetry",
      promise: optionalEnv("AXIOM_TOKEN_TELEMETRY")
        ? telemetryAxiomClient().flush()
        : undefined,
    });
  }

  const results = await Promise.allSettled(
    flushes.map((flush) => {
      return flush.promise;
    }),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      L.error("Axiom client flush failed", {
        client: flushes[index]?.name ?? "unknown",
        error: result.reason,
      });
    }
  }
}

// Minimal options surface. Fresh-read consumers bypass Axiom's per-request
// cache while waiting for asynchronously ingested terminal data; `cursor` is
// used for Axiom-managed time pagination.
interface QueryAxiomOptions {
  readonly noCache?: boolean;
  readonly cursor?: string;
}

interface AxiomQueryMatch {
  readonly _time: string;
  readonly data: Record<string, unknown>;
}

interface AxiomQueryResult {
  readonly matches?: readonly AxiomQueryMatch[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAxiomQueryMatch(value: unknown): value is AxiomQueryMatch {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value._time === "string" && isRecord(value.data);
}

function isAxiomQueryResult(value: unknown): value is AxiomQueryResult {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.matches === undefined ||
    (Array.isArray(value.matches) && value.matches.every(isAxiomQueryMatch))
  );
}

function axiomAplQueryUrl(options: QueryAxiomOptions): string {
  const url = new URL("/v1/datasets/_apl", AXIOM_API_ORIGIN);
  url.searchParams.set("format", "legacy");
  if (options.noCache === true) {
    url.searchParams.set("nocache", "true");
  }
  return url.toString();
}

function mapAxiomMatches<T>(result: AxiomQueryResult): readonly T[] {
  return (
    result.matches?.map((m) => {
      return { ...m.data, _time: m._time } as T;
    }) ?? []
  );
}

async function queryAxiomDirectWithCursor<T>(
  apl: string,
  options: QueryAxiomOptions & { readonly cursor: string },
): Promise<readonly T[]> {
  const response = await fetch(axiomAplQueryUrl(options), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env(getAxiomTokenEnvNameForApl(apl))}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      apl,
      cursor: options.cursor,
    }),
    signal: AbortSignal.timeout(AXIOM_QUERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Axiom query failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isAxiomQueryResult(payload)) {
    throw new Error("Axiom query returned an unexpected response shape");
  }

  return mapAxiomMatches<T>(payload);
}

async function queryAxiomDirect<T = Record<string, unknown>>(
  apl: string,
  options?: QueryAxiomOptions,
): Promise<readonly T[]> {
  if (options?.cursor !== undefined) {
    return queryAxiomDirectWithCursor<T>(apl, {
      ...options,
      cursor: options.cursor,
    });
  }

  const client = axiomClientForApl(apl);
  const axiomOptions =
    options?.noCache !== undefined
      ? {
          noCache: options.noCache,
        }
      : undefined;
  const result = await client.query(apl, axiomOptions);
  return mapAxiomMatches<T>(result);
}

export function queryAxiom<T = Record<string, unknown>>(
  apl: string,
  options?: QueryAxiomOptions,
): Computed<Promise<readonly T[]>> {
  return computed((): Promise<readonly T[]> => {
    return queryAxiomDirect<T>(apl, options);
  });
}
