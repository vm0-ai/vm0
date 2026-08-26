import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";

export interface ConnectorCatalogConnection {
  readonly response: ConnectorResponse;
  readonly oauthRequestedScopes: readonly string[] | null;
}
