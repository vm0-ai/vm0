import { computed, type Computed } from "ccstate";
import { Axiom } from "@axiomhq/js";
import { env } from "../../lib/env";
import { singleton } from "../../lib/singleton";
import { getAxiomTokenEnvNameForApl } from "./axiom-datasets";

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
