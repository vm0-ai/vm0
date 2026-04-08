import { command, computed, state } from "ccstate";
import {
  zeroConnectorsMainContract,
  zeroConnectorsByTypeContract,
  type ConnectorListResponse,
  type ConnectorType,
} from "@vm0/core";
import { zeroClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";

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
    await accept(client.delete({ params: { type } }), [204]);

    set(internalReloadConnectors$, (x) => {
      return x + 1;
    });
  },
);
