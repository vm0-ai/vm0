import { Axiom } from "@axiomhq/js";

import { logger } from "../signals/log.ts";
import { detach, onRejection, Reason } from "../signals/utils.ts";
import { resolvePlatformClientTelemetryConfig } from "./platform-host.ts";
import { nowDate } from "./time.ts";

// The browser-visible token is a write-only credential whose dataset scope is
// the security boundary for this direct-ingest client.
const AXIOM_CLIENT_TELEMETRY_DATASET = "vm0-client-telemetry-prod";
const L = logger("ClientTelemetry");

type ClientTelemetryOutcome = "aborted" | "error" | "success";

interface ClientTelemetryMeasurement {
  readonly startedAt: string;
  readonly startedAtMonotonic: number;
}

interface IndexedDbTransactionTelemetry {
  readonly event_name: "indexeddb.transaction";
  readonly database: "chat" | "intro_video_drafts";
  readonly template: string;
  readonly transaction_mode: IDBTransactionMode;
  readonly request_count: number;
}

interface SharedDatabaseQueryTelemetry {
  readonly event_name: "shared_database.query";
  readonly template: string;
}

export type ClientTelemetryOperation =
  | IndexedDbTransactionTelemetry
  | SharedDatabaseQueryTelemetry;

function runtimeName(): "shared_worker" | "window" {
  return typeof window === "undefined" ? "shared_worker" : "window";
}

function createTelemetryClientCache(): (token: string) => Axiom {
  let cached:
    | {
        readonly client: Axiom;
        readonly token: string;
      }
    | undefined;

  return (token) => {
    if (cached?.token === token) {
      return cached.client;
    }
    const client = new Axiom({
      token,
      onError(error) {
        L.warn("Axiom client telemetry failed", { error });
      },
    });
    cached = { client, token };
    return client;
  };
}

const telemetryClient = createTelemetryClientCache();

function outcomeForError(error: unknown): ClientTelemetryOutcome {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
    ? "aborted"
    : "error";
}

export function startClientTelemetryMeasurement(): ClientTelemetryMeasurement {
  return {
    startedAt: nowDate().toISOString(),
    startedAtMonotonic: performance.now(),
  };
}

async function ingestClientTelemetry(
  measurement: ClientTelemetryMeasurement,
  operation: ClientTelemetryOperation,
  outcome: ClientTelemetryOutcome,
): Promise<void> {
  // Keep telemetry failures outside the measured operation's control flow.
  await Promise.resolve();
  const config = resolvePlatformClientTelemetryConfig();
  if (!config.token) {
    return;
  }
  const client = telemetryClient(config.token);

  client.ingest(AXIOM_CLIENT_TELEMETRY_DATASET, [
    {
      _time: measurement.startedAt,
      source: runtimeName(),
      environment: config.environment,
      public_brand: config.publicBrand,
      app_version: __OKOU_APP_VERSION__,
      duration_ms: Math.max(
        0,
        performance.now() - measurement.startedAtMonotonic,
      ),
      outcome,
      ...operation,
    },
  ]);
}

export function recordClientTelemetry(
  measurement: ClientTelemetryMeasurement,
  operation: ClientTelemetryOperation,
  outcome: ClientTelemetryOutcome,
): void {
  detach(
    ingestClientTelemetry(measurement, operation, outcome),
    Reason.Daemon,
    "Axiom client telemetry ingest",
  );
}

export async function observeClientOperation<TResult>(
  operation: ClientTelemetryOperation,
  execute: () => Promise<TResult>,
): Promise<TResult> {
  const measurement = startClientTelemetryMeasurement();
  const result = await onRejection(execute(), (error) => {
    recordClientTelemetry(measurement, operation, outcomeForError(error));
  });
  recordClientTelemetry(measurement, operation, "success");
  return result;
}

export function clientTelemetryOutcomeForError(
  error: unknown,
): ClientTelemetryOutcome {
  return outcomeForError(error);
}
