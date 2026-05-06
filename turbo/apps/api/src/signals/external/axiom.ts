import { computed, type Computed } from "ccstate";
import { Axiom } from "@axiomhq/js";
import { env } from "../../lib/env";
import { singleton } from "../../lib/singleton";

const axiomClient = singleton(() => {
  return new Axiom({ token: env("AXIOM_TOKEN_TELEMETRY") });
});
const axiomClient$ = computed(() => {
  return axiomClient();
});

export function getDatasetName(base: string): string {
  return `vm0-${base}-${env("AXIOM_DATASET_SUFFIX")}`;
}

export function queryAxiom(
  apl: string,
): Computed<Promise<readonly Record<string, unknown>[]>> {
  return computed(async (get): Promise<readonly Record<string, unknown>[]> => {
    const client = await get(axiomClient$);
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
