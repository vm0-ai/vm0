import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type { ConnectorSearchItem } from "@vm0/api-contracts/contracts/zero-connectors";
import type {
  PublicConnectorCatalogDetail,
  PublicConnectorCatalogListResponse,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusResponse,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { ConnectorFeatureStates } from "@vm0/connectors/connector-auth-method";

import type { ReadonlyDb } from "../external/db";
import {
  ExternalConnectorCatalogUnavailableError,
  getExternalPublicConnectorCatalogDetail,
  getExternalPublicConnectorCatalogPermissionDetail,
  listExternalPublicConnectorCatalog,
  listExternalPublicConnectorCatalogStatus,
  searchExternalConnectorCatalog,
  type ConnectorCatalogStatusRead,
} from "./connector-catalog-external-reader.service";

export function isConnectorCatalogUnavailableError(error: unknown): boolean {
  return error instanceof ExternalConnectorCatalogUnavailableError;
}

interface ConnectorCatalogReadArgs {
  readonly db: ReadonlyDb;
  readonly featureStates: ConnectorFeatureStates;
}

interface ConnectorCatalogSearchArgs extends ConnectorCatalogReadArgs {
  readonly keyword: string | undefined;
}

interface ConnectorCatalogConnectorReadArgs extends ConnectorCatalogReadArgs {
  readonly connectorRef: string;
}

export async function searchConnectorCatalog(
  args: ConnectorCatalogSearchArgs,
): Promise<ConnectorSearchItem[]> {
  const read = await searchExternalConnectorCatalog(args);
  return read.value;
}

export async function listPublicConnectorCatalog(
  args: ConnectorCatalogReadArgs,
): Promise<PublicConnectorCatalogListResponse> {
  const read = await listExternalPublicConnectorCatalog(args);
  return read.value;
}

export async function readPublicConnectorCatalogStatus(
  args: ConnectorCatalogReadArgs & {
    readonly connectors: readonly ConnectorResponse[];
    readonly referenceConnectorRefs: readonly string[];
  },
): Promise<ConnectorCatalogStatusRead> {
  const read = await listExternalPublicConnectorCatalogStatus(args);
  return read.value;
}

export async function listPublicConnectorCatalogStatus(
  args: ConnectorCatalogReadArgs & {
    readonly connectors: readonly ConnectorResponse[];
  },
): Promise<PublicConnectorCatalogStatusResponse> {
  const read = await readPublicConnectorCatalogStatus({
    ...args,
    referenceConnectorRefs: [],
  });
  return read.status;
}

export async function getPublicConnectorCatalogDetail(
  args: ConnectorCatalogConnectorReadArgs,
): Promise<PublicConnectorCatalogDetail | null> {
  const read = await getExternalPublicConnectorCatalogDetail(args);
  return read.value;
}

export async function getPublicConnectorCatalogPermissionDetail(
  args: ConnectorCatalogConnectorReadArgs,
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  const read = await getExternalPublicConnectorCatalogPermissionDetail(args);
  return read.value;
}
