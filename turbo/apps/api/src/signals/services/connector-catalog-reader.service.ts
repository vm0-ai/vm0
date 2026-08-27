import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { ConnectorSearchItem } from "@okouai/api-contracts/contracts/connectors";
import type {
  PublicConnectorCatalogListResponse,
  PublicConnectorCatalogDiscoveryResponse,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
  PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";

import type { ReadonlyDb } from "../external/db";
import type { ConnectorFeatureStates } from "./connector-catalog-feature-states";
import type { ConnectorCatalogConnection } from "./connector-catalog-connection";
import {
  discoverExternalPublicConnectorCatalogStatus,
  ExternalConnectorCatalogUnavailableError,
  getExternalPublicConnectorCatalogStatus,
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

interface BrandedConnectorCatalogReadArgs extends ConnectorCatalogReadArgs {
  readonly publicBrand: PublicBrand;
}

interface ConnectorCatalogSearchArgs extends ConnectorCatalogReadArgs {
  readonly keyword: string | undefined;
}

interface ConnectorCatalogConnectorReadArgs extends BrandedConnectorCatalogReadArgs {
  readonly connectorSlug: string;
}

export async function searchConnectorCatalog(
  args: ConnectorCatalogSearchArgs,
): Promise<ConnectorSearchItem[]> {
  return await searchExternalConnectorCatalog(args);
}

export async function listPublicConnectorCatalog(
  args: BrandedConnectorCatalogReadArgs,
): Promise<PublicConnectorCatalogListResponse> {
  return await listExternalPublicConnectorCatalog(args);
}

export async function readPublicConnectorCatalogStatus(
  args: BrandedConnectorCatalogReadArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
    readonly referenceConnectorSlugs: readonly string[];
  },
): Promise<ConnectorCatalogStatusRead> {
  return await listExternalPublicConnectorCatalogStatus(args);
}

export async function listPublicConnectorCatalogStatus(
  args: BrandedConnectorCatalogReadArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
  },
): Promise<PublicConnectorCatalogStatusResponse> {
  const read = await readPublicConnectorCatalogStatus({
    ...args,
    referenceConnectorSlugs: [],
  });
  return read.status;
}

export async function discoverPublicConnectorCatalogStatus(
  args: BrandedConnectorCatalogReadArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
    readonly keyword: string | undefined;
    readonly category: string | undefined;
    readonly connection: "connected" | "not-connected" | undefined;
    readonly sort: "recommended" | "alphabetical" | undefined;
    readonly cursor: string | undefined;
    readonly limit: number | undefined;
  },
): Promise<PublicConnectorCatalogDiscoveryResponse> {
  const read = await discoverExternalPublicConnectorCatalogStatus({
    ...args,
    referenceConnectorSlugs: [],
  });
  return read.status;
}

export async function getPublicConnectorCatalogStatus(
  args: ConnectorCatalogConnectorReadArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
  },
): Promise<PublicConnectorCatalogStatusItem | null> {
  return await getExternalPublicConnectorCatalogStatus(args);
}

export async function getPublicConnectorCatalogPermissionDetail(
  args: ConnectorCatalogConnectorReadArgs,
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  return await getExternalPublicConnectorCatalogPermissionDetail(args);
}
