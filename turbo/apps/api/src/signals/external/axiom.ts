import { computed, type Computed } from "ccstate";
import { Axiom, AxiomWithoutBatching } from "@axiomhq/js";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import {
  getAxiomTokenEnvNameForApl,
  getAxiomTokenEnvNameForDataset,
} from "./axiom-datasets";

const AXIOM_API_ORIGIN = "https://api.axiom.co";
const AXIOM_QUERY_TIMEOUT_MS = 120_000;
const L = logger("axiom");

type AxiomClientName = "sessions" | "telemetry";

interface AxiomDatasetTarget {
  readonly client: AxiomClientName;
  readonly token: string;
}

function logBestEffortDeliveryError(
  client: AxiomClientName,
  error: unknown,
): void {
  L.error("Best-effort Axiom delivery failed", { client, error });
}

const sessionsAxiomClient = singleton(() => {
  return new Axiom({
    token: env("AXIOM_TOKEN_SESSIONS"),
    onError(error) {
      logBestEffortDeliveryError("sessions", error);
    },
  });
});

const telemetryAxiomClient = singleton(() => {
  return new Axiom({
    token: env("AXIOM_TOKEN_TELEMETRY"),
    onError(error) {
      logBestEffortDeliveryError("telemetry", error);
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

function axiomTargetForDataset(dataset: string): AxiomDatasetTarget | null {
  const tokenEnvName = getAxiomTokenEnvNameForDataset(dataset);
  const token = optionalEnv(tokenEnvName);
  if (!token) {
    return null;
  }
  return {
    client: tokenEnvName === "AXIOM_TOKEN_SESSIONS" ? "sessions" : "telemetry",
    token,
  };
}

function axiomClientForDataset(dataset: string): Axiom | null {
  const target = axiomTargetForDataset(dataset);
  if (!target) {
    return null;
  }
  if (target.client === "sessions") {
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

function requiredIngestError(
  target: AxiomDatasetTarget,
  dataset: string,
  cause: unknown,
): Error {
  return new Error(
    `Required Axiom ingest failed for ${target.client} dataset "${dataset}"`,
    { cause },
  );
}

export async function ingestRequiredToAxiom(
  dataset: string,
  events: readonly Record<string, unknown>[],
): Promise<boolean> {
  const target = axiomTargetForDataset(dataset);
  if (!target) {
    return false;
  }

  let reportedError: Error | undefined;
  const client = new AxiomWithoutBatching({
    token: target.token,
    onError(error) {
      reportedError ??= error;
    },
  });
  const status = await client.ingest(dataset, [...events]);
  if (reportedError) {
    throw requiredIngestError(target, dataset, reportedError);
  }
  if (status.failed > 0) {
    throw requiredIngestError(
      target,
      dataset,
      new Error(`Axiom reported ${status.failed} failed event(s)`),
    );
  }
  return true;
}

interface FlushAxiomOptions {
  readonly client?: "all" | AxiomClientName;
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
      const name = flushes[index]?.name;
      if (name === "sessions" || name === "telemetry") {
        logBestEffortDeliveryError(name, result.reason);
      }
    }
  }
}

// Minimal options surface. `noCache` is used by the agent-event watermark wait
// to bypass Axiom's per-request cache for freshly-completed runs; `cursor` is
// used for Axiom-managed time pagination. Other options from web's queryAxiom
// (maxRetries, streamingDuration, timeoutMs) intentionally NOT ported — see
// leader guidance on issue #12424; add them when a caller actually needs them.
export interface QueryAxiomOptions {
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

export async function queryAxiomDirect<T = Record<string, unknown>>(
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
          ...(options.noCache !== undefined && { noCache: options.noCache }),
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
