import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import type { ConnectorCatalogCompatibilityReason } from "@vm0/api-contracts/contracts/connector-catalog-diagnostics";

export interface LegacyConnectorCatalogFilteredAuthMethod {
  readonly connectorRef: ConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly reasons: readonly ConnectorCatalogCompatibilityReason[];
}

export type LegacyConnectorCatalogCompatibilityEvaluation =
  readonly LegacyConnectorCatalogFilteredAuthMethod[];

export interface CanonicalConnectorCatalogFilteredAuthMethod {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly reasons: readonly ConnectorCatalogCompatibilityReason[];
}

export interface CanonicalConnectorCatalogCompatibilityEvaluation {
  readonly filteredAuthMethods: readonly CanonicalConnectorCatalogFilteredAuthMethod[];
}

// TODO(#24186): Remove the legacy array after canonical readers have drained it.
export type ConnectorCatalogCompatibilityEvaluationPayload =
  | LegacyConnectorCatalogCompatibilityEvaluation
  | CanonicalConnectorCatalogCompatibilityEvaluation;
