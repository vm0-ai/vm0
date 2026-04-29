import { computed, type Computed } from "ccstate";

import { env } from "../../lib/env";

const axiomClient$ = computed(
  (): Promise<{
    query: (apl: string) => Promise<{
      matches?: { _time: string; data: Record<string, unknown> }[];
    }>;
  } | null> => {
    const token = env("AXIOM_TOKEN_TELEMETRY");
    if (!token) {
      return Promise.resolve(null);
    }
    return import("@axiomhq/js")
      .then(({ Axiom }) => {
        return new Axiom({ token }) as {
          query: (apl: string) => Promise<{
            matches?: { _time: string; data: Record<string, unknown> }[];
          }>;
        };
      })
      .catch(() => {
        return null;
      });
  },
);

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
