import {
  connectorAccountMutationIntentSchema,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { StoredConnectorAccountMutation } from "@okouai/db/jsonb-contracts/connector-account-mutation";

export type ConnectorAccountMutation =
  | { readonly intent: "legacy-singleton" }
  | ConnectorAccountMutationIntent;

export function normalizeConnectorAccountMutation(
  intent: ConnectorAccountMutationIntent | undefined,
): ConnectorAccountMutation {
  return intent ?? { intent: "legacy-singleton" };
}

export function parseStoredConnectorAccountMutationIntent(
  value: StoredConnectorAccountMutation | null,
): ConnectorAccountMutationIntent | undefined {
  const mutation: ConnectorAccountMutation =
    value === null
      ? { intent: "legacy-singleton" }
      : connectorAccountMutationIntentSchema.parse(value);
  return mutation.intent === "legacy-singleton" ? undefined : mutation;
}
