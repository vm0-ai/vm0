import {
  connectorAccountMutationIntentSchema,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";

import { safeJsonParse } from "../utils";

export type ConnectorAccountMutation =
  | { readonly intent: "legacy-singleton" }
  | ConnectorAccountMutationIntent;

export function normalizeConnectorAccountMutation(
  intent: ConnectorAccountMutationIntent | undefined,
): ConnectorAccountMutation {
  return intent ?? { intent: "legacy-singleton" };
}

export function serializeConnectorAccountMutation(
  intent: ConnectorAccountMutationIntent | undefined,
): string | null {
  return intent === undefined ? null : JSON.stringify(intent);
}

export function parseStoredConnectorAccountMutationIntent(
  value: string | null,
): ConnectorAccountMutationIntent | undefined {
  const mutation: ConnectorAccountMutation =
    value === null
      ? { intent: "legacy-singleton" }
      : connectorAccountMutationIntentSchema.parse(safeJsonParse(value));
  return mutation.intent === "legacy-singleton" ? undefined : mutation;
}
