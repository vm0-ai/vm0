import { command, computed, state } from "ccstate";
import {
  zeroConnectorsMainContract,
  zeroConnectorsByTypeContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusResponse,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type { ConnectorListResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { zeroClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "./feature-switch.ts";

/**
 * Reload trigger for connector signals.
 * Increment to force recomputation of connectors$.
 */
const internalReloadConnectors$ = state(0);

/**
 * Current user's connectors.
 */
export const connectors$ = computed(async (get) => {
  get(internalReloadConnectors$);

  const createClient = get(zeroClient$);
  const client = createClient(zeroConnectorsMainContract);
  const result = await accept(client.list(), [200]);
  return result.body as ConnectorListResponse;
});

/**
 * Public connector catalog metadata joined with the current user's connector status.
 */
export const connectorCatalogStatus$ = computed(async (get) => {
  get(internalReloadConnectors$);
  get(featureSwitch$);

  const createClient = get(zeroClient$);
  const client = createClient(zeroConnectorCatalogContract);
  const result = await accept(client.status(), [200]);
  return result.body as PublicConnectorCatalogStatusResponse;
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
