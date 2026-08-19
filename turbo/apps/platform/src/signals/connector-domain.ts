import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type {
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/zero-connector-catalog";
import type { UserPermissionGrantResponse } from "@okouai/api-contracts/contracts/zero-user-permission-grants";
import type {
  WorkflowConnectorReadinessEntry,
  WorkflowConnectorReadinessResponse,
} from "@okouai/api-contracts/contracts/workflows";

export type PlatformConnector = ConnectorResponse;
export type PlatformConnectorCatalogStatusItem =
  PublicConnectorCatalogStatusItem;
export type PlatformConnectorPermissionMetadata =
  PublicConnectorCatalogPermissionDetail;
export type PlatformUserPermissionGrant = UserPermissionGrantResponse;
export type PlatformWorkflowConnectorReadinessEntry =
  WorkflowConnectorReadinessEntry;
export type PlatformWorkflowConnectorReadinessResponse =
  WorkflowConnectorReadinessResponse;
