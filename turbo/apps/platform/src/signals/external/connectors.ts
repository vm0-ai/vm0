import { command, computed, state, type Computed } from "ccstate";
import { connectorsMainContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogDiscoveryQuery,
  type PublicConnectorCatalogDiscoveryResponse,
  type PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { apiClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "./feature-switch.ts";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";
import { onRejection } from "../utils.ts";

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

type RelatedConnectorCatalogResponse =
  | PublicConnectorCatalogDiscoveryResponse
  | PublicConnectorCatalogStatusResponse;

interface ConnectorCatalogPagingState {
  readonly key: string;
  readonly pages: readonly PublicConnectorCatalogDiscoveryResponse[];
  readonly fetchedCursors: ReadonlySet<string>;
}

function connectorCatalogPagingKey(
  query: PublicConnectorCatalogDiscoveryQuery,
  reloadVersion: number,
): string {
  return `${reloadVersion}:${JSON.stringify(query)}`;
}

export function createRelatedConnectorCatalog(
  query$: Computed<PublicConnectorCatalogDiscoveryQuery>,
) {
  const paging$ = state<ConnectorCatalogPagingState>({
    key: "",
    pages: [],
    fetchedCursors: new Set(),
  });

  const firstPage$ = computed(
    async (get): Promise<RelatedConnectorCatalogResponse> => {
      const featureStates = get(featureSwitch$);
      if (!featureStates[FeatureSwitchKey.ConnectorDiscovery]) {
        return await get(connectorCatalogStatus$);
      }

      get(connectorsReloadVersion$);
      const query = get(query$);
      const createClient = get(apiClient$);
      const client = createClient(connectorCatalogContract);
      const result = await accept(client.discovery({ query }), [200]);
      return result.body;
    },
  );

  const catalog$ = computed(
    async (get): Promise<RelatedConnectorCatalogResponse> => {
      const firstPage = await get(firstPage$);
      if (!("totalConnectorCount" in firstPage)) {
        return firstPage;
      }
      const key = connectorCatalogPagingKey(
        get(query$),
        get(connectorsReloadVersion$),
      );
      const paging = get(paging$);
      const pages = paging.key === key ? paging.pages : [];
      const lastPage = pages.at(-1) ?? firstPage;
      return {
        ...firstPage,
        connectors: [
          ...firstPage.connectors,
          ...pages.flatMap((page) => {
            return page.connectors;
          }),
        ],
        nextCursor: lastPage.nextCursor ?? null,
      };
    },
  );

  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const featureStates = get(featureSwitch$);
      if (!featureStates[FeatureSwitchKey.ConnectorDiscovery]) {
        return;
      }
      const query = get(query$);
      const key = connectorCatalogPagingKey(
        query,
        get(connectorsReloadVersion$),
      );
      const loaded = await get(catalog$);
      signal.throwIfAborted();
      if (!("totalConnectorCount" in loaded)) {
        return;
      }
      const cursor = loaded.nextCursor;
      const current = get(paging$);
      if (
        !cursor ||
        (current.key === key && current.fetchedCursors.has(cursor))
      ) {
        return;
      }
      set(paging$, {
        key,
        pages: current.key === key ? current.pages : [],
        fetchedCursors: new Set([
          ...(current.key === key ? current.fetchedCursors : []),
          cursor,
        ]),
      });

      const client = get(apiClient$)(connectorCatalogContract);
      const result = await onRejection(
        accept(
          client.discovery({
            query: { ...query, cursor },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        ),
        () => {
          const failed = get(paging$);
          if (failed.key !== key) {
            return;
          }
          const retryableCursors = new Set(failed.fetchedCursors);
          retryableCursors.delete(cursor);
          set(paging$, { ...failed, fetchedCursors: retryableCursors });
        },
      );
      signal.throwIfAborted();
      const latest = get(paging$);
      if (latest.key !== key) {
        return;
      }
      set(paging$, {
        ...latest,
        pages: [...latest.pages, result.body],
      });
    },
  );

  return { catalog$, loadMore$ };
}

export function relatedConnectorCatalog(
  keyword$: Computed<string>,
): Computed<Promise<RelatedConnectorCatalogResponse>> {
  const query$ = computed((get): PublicConnectorCatalogDiscoveryQuery => {
    const keyword = get(keyword$).trim();
    return keyword ? { keyword } : {};
  });
  return createRelatedConnectorCatalog(query$).catalog$;
}

export function connectorCatalogItemBySlug(
  connectorSlug: ConnectorSlug,
): Computed<Promise<PlatformConnectorCatalogStatusItem | null>> {
  return computed(async (get) => {
    get(connectorsReloadVersion$);
    const featureStates = get(featureSwitch$);
    if (!featureStates[FeatureSwitchKey.ConnectorDiscovery]) {
      return (
        (await get(connectorCatalogStatusBySlug$)).get(connectorSlug) ?? null
      );
    }

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
