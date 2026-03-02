import { computed } from "ccstate";
import type { SecretResponse, VariableResponse } from "@vm0/core";
import { secrets$ } from "./secrets.ts";
import { variables$ } from "./variables.ts";

// ---------------------------------------------------------------------------
// Merged items
// ---------------------------------------------------------------------------

export type MergedItem =
  | {
      kind: "secret";
      name: string;
      data: SecretResponse;
    }
  | {
      kind: "variable";
      name: string;
      data: VariableResponse;
    };

export const mergedItems$ = computed(async (get) => {
  const [secretsList, variablesList] = await Promise.all([
    get(secrets$),
    get(variables$),
  ]);

  const items: MergedItem[] = [];

  for (const secret of secretsList) {
    items.push({
      kind: "secret",
      name: secret.name,
      data: secret,
    });
  }

  for (const variable of variablesList) {
    items.push({
      kind: "variable",
      name: variable.name,
      data: variable,
    });
  }

  return items;
});
