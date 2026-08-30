import chalk from "chalk";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorCatalogStatus } from "../../lib/api/domains/connectors";
import type { ConnectorDiscoveryAgentContext } from "./agent-context";
import { renderConnectedAsCell } from "./connected-as";

interface CatalogConnectorDiscoveryItem {
  readonly kind: "catalog";
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly generation: readonly string[];
  readonly authMethods: ConnectorCatalogStatus["authMethods"];
  readonly catalogConnector: ConnectorCatalogStatus;
}

interface CustomConnectorDiscoveryItem {
  readonly kind: "custom";
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly generation: readonly string[];
  readonly authMethods: readonly [];
  readonly customConnector: CustomConnectorResponse;
}

export type ConnectorDiscoveryItem =
  | CatalogConnectorDiscoveryItem
  | CustomConnectorDiscoveryItem;

export function connectorDiscoveryItems(
  catalogConnectors: readonly ConnectorCatalogStatus[],
  customConnectors: readonly CustomConnectorResponse[],
): readonly ConnectorDiscoveryItem[] {
  return [
    ...catalogConnectors.map((connector): CatalogConnectorDiscoveryItem => {
      return {
        kind: "catalog",
        slug: connector.slug,
        label: connector.label,
        description: connector.description,
        category: connector.category,
        tags: connector.tags,
        generation: connector.generation,
        authMethods: connector.authMethods,
        catalogConnector: connector,
      };
    }),
    ...customConnectors.map((connector): CustomConnectorDiscoveryItem => {
      return {
        kind: "custom",
        slug: connector.slug,
        label: connector.displayName,
        description: "",
        category: "custom",
        tags: [],
        generation: [],
        authMethods: [],
        customConnector: connector,
      };
    }),
  ];
}

export function renderConnectorDiscoveryConnectedAsCell(
  connector: ConnectorDiscoveryItem,
): string {
  if (connector.kind === "catalog") {
    return renderConnectedAsCell(connector.catalogConnector);
  }
  if (connector.customConnector.connected) {
    return chalk.green("connected");
  }
  if (connector.customConnector.missingRequiredFields.length === 0) {
    return chalk.dim("(not connected)");
  }
  return chalk.yellow(
    `missing ${connector.customConnector.missingRequiredFields.join(", ")}`,
  );
}

export function isConnectorDiscoveryAuthorized(
  connector: ConnectorDiscoveryItem,
  agentContext: ConnectorDiscoveryAgentContext,
): boolean {
  if (connector.kind === "catalog") {
    return agentContext.authorizedConnectorSlugs.has(connector.slug);
  }
  return agentContext.authorizedCustomConnectorIds.has(
    connector.customConnector.id,
  );
}
