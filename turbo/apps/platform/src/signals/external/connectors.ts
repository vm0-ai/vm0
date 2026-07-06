import { command, computed, state } from "ccstate";
import {
  zeroConnectorsMainContract,
  zeroConnectorsByTypeContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
  type PublicConnectorCatalogStatusResponse,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type { ConnectorListResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { zeroClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "./feature-switch.ts";

export interface ConnectorCatalogDisplayMetadata {
  readonly connectorRef: string;
  readonly label: string;
  readonly helpText: string;
}

/**
 * Reload trigger for connector signals.
 * Increment to force recomputation of connectors$.
 */
const internalReloadConnectors$ = state(0);

export const connectorsReloadVersion$ = computed((get) => {
  return get(internalReloadConnectors$);
});

/**
 * Current user's connectors.
 */
export const connectors$ = computed(async (get) => {
  get(connectorsReloadVersion$);
  get(featureSwitch$);

  const createClient = get(zeroClient$);
  const client = createClient(zeroConnectorsMainContract);
  const result = await accept(client.list(), [200]);
  return result.body as ConnectorListResponse;
});

/**
 * Public connector catalog metadata joined with the current user's connector status.
 */
export const connectorCatalogStatus$ = computed(async (get) => {
  get(connectorsReloadVersion$);
  get(featureSwitch$);

  const createClient = get(zeroClient$);
  const client = createClient(zeroConnectorCatalogContract);
  const result = await accept(client.status(), [200]);
  return result.body as PublicConnectorCatalogStatusResponse;
});

export const connectorCatalogStatusByRef$ = computed(async (get) => {
  const { connectors } = await get(connectorCatalogStatus$);
  return new Map(
    connectors.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );
});

function connectorCatalogDisplayMetadata(
  connector: PublicConnectorCatalogStatusItem,
): ConnectorCatalogDisplayMetadata {
  return {
    connectorRef: connector.connectorRef,
    label: connector.label,
    helpText: connector.description,
  };
}

export const connectorCatalogDisplayMetadataByRef$ = computed(async (get) => {
  const connectorsByRef = await get(connectorCatalogStatusByRef$);
  return new Map(
    [...connectorsByRef.values()].map((connector) => {
      return [
        connector.connectorRef,
        connectorCatalogDisplayMetadata(connector),
      ];
    }),
  );
});

/**
 * Trigger a reload of connectors data.
 */
export const reloadConnectors$ = command(({ set }) => {
  set(internalReloadConnectors$, (x) => {
    return x + 1;
  });
});

/**
 * Delete a connector by type.
 */
export const deleteConnector$ = command(
  async ({ get, set }, type: ConnectorType, _signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroConnectorsByTypeContract);
    await accept(
      client.delete({
        params: { type },
        fetchOptions: { signal: _signal },
      }),
      [204],
    );

    set(internalReloadConnectors$, (x) => {
      return x + 1;
    });
  },
);
