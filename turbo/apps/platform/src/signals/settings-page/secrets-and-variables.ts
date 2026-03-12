import { computed } from "ccstate";
import {
  getConnectorManagedSecretNames,
  type ConnectorType,
  type SecretResponse,
  type VariableResponse,
} from "@vm0/core";
import { secrets$ } from "./secrets.ts";
import { variables$ } from "./variables.ts";
import { connectors$ } from "../external/connectors.ts";

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
  const [secretsList, variablesList, connectorsData] = await Promise.all([
    get(secrets$),
    get(variables$),
    get(connectors$),
  ]);

  const connectedTypes = connectorsData.connectors.map(
    (c) => c.type as ConnectorType,
  );
  const managedNames = getConnectorManagedSecretNames(connectedTypes);

  const items: MergedItem[] = [];

  for (const secret of secretsList) {
    if (managedNames.has(secret.name)) {
      continue;
    }
    items.push({
      kind: "secret",
      name: secret.name,
      data: secret,
    });
  }

  for (const variable of variablesList) {
    if (managedNames.has(variable.name)) {
      continue;
    }
    items.push({
      kind: "variable",
      name: variable.name,
      data: variable,
    });
  }

  return items;
});
