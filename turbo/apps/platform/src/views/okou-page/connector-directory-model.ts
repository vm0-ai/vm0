import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { PublicConnectorCatalogCategoryMetadata } from "@okouai/api-contracts/contracts/connector-catalog";

import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import {
  groupConnectorsByCategory,
  type ConnectorCategorySection,
} from "../../signals/okou-page/settings/connector-categories.ts";
import {
  connectorCurrentConnectionStatus,
  matchesConnectorDirectorySearch,
} from "../../signals/okou-page/settings/connectors.ts";
import { customConnectorTarget } from "./components/settings/custom-connector-display.ts";
import { localizeConnectorCategoryMetadata } from "./components/settings/connector-category-labels.ts";

export interface ConnectorDirectoryModel {
  /** Connected connectors whose connection or permissions need a fix. */
  readonly attention: readonly PlatformConnectorCatalogStatusItem[];
  /** Connected connectors that are working. */
  readonly healthy: readonly PlatformConnectorCatalogStatusItem[];
  readonly discover: readonly PlatformConnectorCatalogStatusItem[];
  readonly custom: readonly CustomConnectorResponse[];
  readonly categorySections: readonly ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[];
  readonly connectedCount: number;
  readonly yoursSlugs: readonly ConnectorSlug[];
  readonly discoverSlugs: readonly ConnectorSlug[];
  readonly bySlug: ReadonlyMap<
    ConnectorSlug,
    PlatformConnectorCatalogStatusItem
  >;
  readonly categoryLabelOf: (category: string) => string | undefined;
}

function needsAttention(
  connector: PlatformConnectorCatalogStatusItem,
): boolean {
  const status = connectorCurrentConnectionStatus(connector);
  return status === "reconnect-required" || status === "scope-mismatch";
}

function matchesCustomConnectorSearch(
  search: string,
  connector: CustomConnectorResponse,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    connector.displayName,
    connector.slug,
    customConnectorTarget(connector),
  ].some((value) => {
    return value.toLowerCase().includes(needle);
  });
}

function slugsOf(
  connectors: readonly PlatformConnectorCatalogStatusItem[],
): ConnectorSlug[] {
  return connectors.map((connector) => {
    return connector.slug;
  });
}

/**
 * Derives everything the directory renders from the raw connector lists, so the
 * dialog stays a view: which connected connectors need a fix, what discovery
 * shows for the current search and category, and the order the arrow keys walk.
 */
export function buildConnectorDirectoryModel({
  connected,
  unconnected,
  connectedCustom,
  unconnectedCustom,
  search,
  category,
  categoryMetadata,
  otherCategoryLabel,
}: {
  readonly connected: readonly PlatformConnectorCatalogStatusItem[];
  readonly unconnected: readonly PlatformConnectorCatalogStatusItem[];
  readonly connectedCustom: readonly CustomConnectorResponse[];
  readonly unconnectedCustom: readonly CustomConnectorResponse[];
  readonly search: string;
  readonly category: string | null;
  readonly categoryMetadata: PublicConnectorCatalogCategoryMetadata | undefined;
  readonly otherCategoryLabel: string;
}): ConnectorDirectoryModel {
  const matchedConnected = connected.filter((connector) => {
    return matchesConnectorDirectorySearch(search, connector);
  });
  const attention = matchedConnected.filter(needsAttention);
  const healthy = matchedConnected.filter((connector) => {
    return !needsAttention(connector);
  });
  const discover = unconnected.filter((connector) => {
    return (
      matchesConnectorDirectorySearch(search, connector) &&
      (category === null || connector.category === category)
    );
  });
  const custom = [...connectedCustom, ...unconnectedCustom].filter(
    (connector) => {
      return matchesCustomConnectorSearch(search, connector);
    },
  );
  const categorySections = groupConnectorsByCategory(
    unconnected,
    localizeConnectorCategoryMetadata(categoryMetadata),
    otherCategoryLabel,
  ).flatMap((group) => {
    return group.sections;
  });
  const categoryLabels = new Map(
    categorySections.map((section) => {
      return [section.category, section.label];
    }),
  );

  return {
    attention,
    healthy,
    discover,
    custom,
    categorySections,
    connectedCount: connected.length,
    yoursSlugs: [...slugsOf(attention), ...slugsOf(healthy)],
    discoverSlugs: slugsOf(discover),
    bySlug: new Map(
      [...connected, ...unconnected].map((connector) => {
        return [connector.slug, connector];
      }),
    ),
    categoryLabelOf: (value) => {
      return categoryLabels.get(value);
    },
  };
}
