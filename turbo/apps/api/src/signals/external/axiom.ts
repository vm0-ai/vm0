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

export function queryAxiom(
  apl: string,
): Computed<Promise<readonly Record<string, unknown>[]>> {
  return computed(async (): Promise<readonly Record<string, unknown>[]> => {
    const client = axiomClientForApl(apl);
    if (!client) {
      return [];
    }

    const result = await client.query(apl);
    return (
      result.matches?.map((m) => {
        return { _time: m._time, ...m.data };
      }) ?? []
    );
  });
}
