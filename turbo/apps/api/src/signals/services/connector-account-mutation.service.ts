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
  | { readonly intent: "target-only-client-singleton" }
  | ConnectorAccountMutationIntent;

export function connectorAccountSiblingWritesEnabled(
  context: FeatureSwitchContext,
): boolean {
  return isFeatureEnabled(FeatureSwitchKey.ConnectorAccounts, context);
}

export function normalizeConnectorAccountMutation(
  intent: ConnectorAccountMutationIntent | undefined,
): ConnectorAccountMutation {
  return intent ?? { intent: "target-only-client-singleton" };
}

export function parseStoredConnectorAccountMutationIntent(
  value: StoredConnectorAccountMutation | null,
): ConnectorAccountMutationIntent | undefined {
  const mutation: ConnectorAccountMutation =
    value === null
      ? { intent: "target-only-client-singleton" }
      : connectorAccountMutationIntentSchema.parse(value);
  return mutation.intent === "target-only-client-singleton"
    ? undefined
    : mutation;
}

export function storedConnectorAccountMutationSelection(relation: SQLWrapper) {
  // Keep old authorization state readable until #28589 proves its browser,
  // state-lifetime, and API rollback gates have drained.
  return sql`
    to_jsonb(${relation}) -> 'account_mutation'
  `.mapWith(storedConnectorAccountMutationDecoder);
}

export function storedConnectorAccountMutationWrite(
  intent: ConnectorAccountMutationIntent | null | undefined,
): { readonly accountMutation?: StoredConnectorAccountMutation } {
  // Omitted client intent remains a supported compatibility boundary until
  // #28589 contracts each applicable route and persisted state authority.
  return intent === null || intent === undefined
    ? {}
    : { accountMutation: intent };
}
