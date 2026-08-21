import {
  connectorAccountMutationIntentSchema,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { StoredConnectorAccountMutation } from "@okouai/db/jsonb-contracts/connector-account-mutation";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { sql, type SQLWrapper } from "drizzle-orm";

import { zodDriverValueDecoder } from "../../lib/db-structured-result";

const storedConnectorAccountMutationDecoder = zodDriverValueDecoder(
  connectorAccountMutationIntentSchema.nullable(),
);

export type ConnectorAccountMutation =
  | { readonly intent: "legacy-singleton" }
  | ConnectorAccountMutationIntent;

export function connectorAccountSiblingWritesEnabled(
  context: FeatureSwitchContext,
): boolean {
  return isFeatureEnabled(FeatureSwitchKey.ConnectorAccounts, context);
}

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

export function storedConnectorAccountMutationSelection(relation: SQLWrapper) {
  // Keep legacy flows readable during the DB/API rollout, whose observed
  // exposure can reach 102 minutes. Remove this JSON projection in #27695
  // after migration 0951's rollback window closes, then select the column.
  return sql`
    to_jsonb(${relation}) -> 'account_mutation'
  `.mapWith(storedConnectorAccountMutationDecoder);
}

export function storedConnectorAccountMutationWrite(
  intent: ConnectorAccountMutationIntent | null | undefined,
): { readonly accountMutation?: StoredConnectorAccountMutation } {
  // Omitting the column keeps old-client inserts legal before migration 0951.
  // Explicit account callers are released only after that migration is live.
  return intent === null || intent === undefined
    ? {}
    : { accountMutation: intent };
}
