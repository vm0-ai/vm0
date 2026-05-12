import { computed, type Computed } from "ccstate";
import { Axiom } from "@axiomhq/js";
import { env, optionalEnv } from "../../lib/env";
import { singleton } from "../../lib/singleton";
import {
  getAxiomTokenEnvNameForApl,
  getAxiomTokenEnvNameForDataset,
} from "./axiom-datasets";

const sessionsAxiomClient = singleton(() => {
  return new Axiom({ token: env("AXIOM_TOKEN_SESSIONS") });
});

const telemetryAxiomClient = singleton(() => {
  return new Axiom({ token: env("AXIOM_TOKEN_TELEMETRY") });
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

interface FlushAxiomOptions {
  readonly throwOnError?: boolean;
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
  const errors: unknown[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      errors.push({
        client: flushes[index]?.name ?? "unknown",
        error: result.reason,
      });
    }
  }
  if (options.throwOnError && errors.length > 0) {
    throw new AggregateError(errors, "Axiom flush failed");
  }
}

// Minimal options surface — only the `noCache` knob is wired today (used by
// the agent-event watermark wait to bypass Axiom's per-request cache for
// freshly-completed runs). Other options from web's queryAxiom (maxRetries,
// streamingDuration, timeoutMs) intentionally NOT ported — see leader
// guidance on issue #12424; add them when a caller actually needs them.
export interface QueryAxiomOptions {
  readonly noCache?: boolean;
}

export async function queryAxiomDirect<T = Record<string, unknown>>(
  apl: string,
  options?: QueryAxiomOptions,
): Promise<readonly T[]> {
  const client = axiomClientForApl(apl);
  const axiomOptions =
    options?.noCache !== undefined ? { noCache: options.noCache } : undefined;
  const result = await client.query(apl, axiomOptions);
  return (
    result.matches?.map((m) => {
      return { _time: m._time, ...m.data } as T;
    }) ?? []
  );
}

export function queryAxiom(
  apl: string,
  options?: QueryAxiomOptions,
): Computed<Promise<readonly Record<string, unknown>[]>> {
  return computed((): Promise<readonly Record<string, unknown>[]> => {
    return queryAxiomDirect(apl, options);
  });
}
