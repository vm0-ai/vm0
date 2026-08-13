import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type {
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/zero-connector-catalog";
import type { UserPermissionGrantResponse } from "@okouai/api-contracts/contracts/zero-user-permission-grants";
import type {
  ZeroWorkflowConnectorReadinessEntry,
  ZeroWorkflowConnectorReadinessResponse,
} from "@okouai/api-contracts/contracts/zero-workflows";

export type PlatformConnector = ConnectorResponse;
export type PlatformConnectorCatalogStatusItem =
  PublicConnectorCatalogStatusItem;
export type PlatformConnectorPermissionMetadata =
  PublicConnectorCatalogPermissionDetail;
export type PlatformUserPermissionGrant = UserPermissionGrantResponse;
export type PlatformWorkflowConnectorReadinessEntry =
  ZeroWorkflowConnectorReadinessEntry;
export type PlatformWorkflowConnectorReadinessResponse =
  ZeroWorkflowConnectorReadinessResponse;
