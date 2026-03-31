import { command, computed, state } from "ccstate";
import {
  zeroConnectorsMainContract,
  zeroConnectorsByTypeContract,
  type ConnectorListResponse,
  type ConnectorType,
} from "@vm0/core";
import { zeroClient$ } from "../api-client";

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
  const result = await client.list();

  if (result.status === 200) {
    return result.body as ConnectorListResponse;
  }

  throw new Error(`Failed to fetch connectors: ${result.status}`);
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
    const result = await client.delete({ params: { type } });

    if (result.status !== 204) {
      throw new Error(`Failed to delete connector: ${result.status}`);
    }

    set(internalReloadConnectors$, (x) => {
      return x + 1;
    });
  },
);
