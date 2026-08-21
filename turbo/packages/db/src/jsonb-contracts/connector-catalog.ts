import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorCatalogCompatibilityReason } from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";

import type { JsonValue } from "./shared";

export interface ConnectorCatalogCompatibilityFilteredAuthMethod {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly reasons: readonly ConnectorCatalogCompatibilityReason[];
}

export interface ConnectorCatalogCompatibilityEvaluationPayload {
  readonly filteredAuthMethods: readonly ConnectorCatalogCompatibilityFilteredAuthMethod[];
}

export type ConnectorCatalogRuntimeProjection = JsonValue;
