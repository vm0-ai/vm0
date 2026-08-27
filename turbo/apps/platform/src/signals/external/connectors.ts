import { command, computed, state, type Computed } from "ccstate";
import { connectorsMainContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogDiscoveryResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { apiClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "./feature-switch.ts";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";

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

  const createClient = get(apiClient$);
  const client = createClient(connectorsMainContract);
  const result = await accept(client.list(), [200]);
  return result.body;
});

/**
 * Public connector catalog metadata joined with the current user's connector status.
 */
export const connectorCatalogStatus$ = computed(async (get) => {
  get(connectorsReloadVersion$);
  get(featureSwitch$);

  const createClient = get(apiClient$);
  const client = createClient(connectorCatalogContract);
  const result = await accept(client.status(), [200]);
  return result.body;
});

export const connectorCatalogStatusBySlug$ = computed(async (get) => {
  const { connectors } = await get(connectorCatalogStatus$);
  return new Map(
    connectors.map((connector) => {
      return [connector.slug, connector];
    }),
  );
});

export function relatedConnectorCatalog(
  keyword$: Computed<string>,
): Computed<Promise<PublicConnectorCatalogDiscoveryResponse>> {
  return computed(async (get) => {
    get(connectorsReloadVersion$);
    get(featureSwitch$);
    const keyword = get(keyword$).trim();
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(
      client.discovery({ query: keyword ? { keyword } : {} }),
      [200],
    );
    return result.body;
  });
}

export function connectorCatalogItemBySlug(
  connectorSlug: ConnectorSlug,
): Computed<Promise<PlatformConnectorCatalogStatusItem | null>> {
  return computed(async (get) => {
    get(connectorsReloadVersion$);
    get(featureSwitch$);
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(
      client.get({ params: { connectorSlug } }),
      [200, 404],
    );
    return result.status === 200 ? result.body.connector : null;
  });
}

/**
 * Trigger a reload of connectors data.
 */
export const reloadConnectors$ = command(({ set }) => {
  set(internalReloadConnectors$, (x) => {
    return x + 1;
  });
});

/**
 * Delete a connector by slug.
 */
export const deleteConnector$ = command(
  async ({ get, set }, connectorSlug: ConnectorSlug, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(connectorAccountsContract);
    await accept(
      client.disconnectSingleAccount({
        body: {
          target: { kind: "builtin", connectorSlug },
        },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();

    set(internalReloadConnectors$, (x) => {
      return x + 1;
    });
  },
);
