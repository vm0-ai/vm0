import {
  connectorAccountMutationIntentSchema,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { sql, type SQLWrapper } from "drizzle-orm";

import { zodDriverValueDecoder } from "../../lib/db-structured-result";

const storedConnectorAccountMutationDecoder = zodDriverValueDecoder(
  connectorAccountMutationIntentSchema,
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

export function storedConnectorAccountMutationSelection(
  accountMutation: SQLWrapper,
) {
  return sql`${accountMutation}`.mapWith(storedConnectorAccountMutationDecoder);
}
