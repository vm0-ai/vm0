import { command, computed, state, type Command, type State } from "ccstate";
import { delay } from "signal-timers";
import {
  connectorAccountTargetKey,
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountSummary,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { onRejection, resetSignal } from "../utils.ts";

const CONNECTOR_ACCOUNT_PAGE_SIZE = 50;
/** Keep account search responsive while coalescing normal typing bursts. */
const CONNECTOR_ACCOUNT_SEARCH_DEBOUNCE_MS = 250;
export const CONNECTOR_ACCOUNT_SEARCH_THRESHOLD = 6;

export { connectorAccountTargetKey };

const internalSummariesReload$ = state(0);

const connectorAccountSummaries$ = computed(
  async (get): Promise<readonly ConnectorAccountSummary[]> => {
    get(internalSummariesReload$);
    const enabled =
      get(featureSwitch$)[FeatureSwitchKey.ConnectorAccounts] ?? false;
    if (!enabled) {
      return [];
    }
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).summaries(),
      [200],
    );
    return result.body.summaries;
  },
);

export const connectorAccountSummaryByTarget$ = computed(
  async (get): Promise<ReadonlyMap<string, ConnectorAccountSummary>> => {
    const summaries = await get(connectorAccountSummaries$);
    return new Map(
      summaries.map((summary) => {
        return [connectorAccountTargetKey(summary.target), summary];
      }),
    );
  },
);

export const reloadConnectorAccountSummaries$ = command(({ set }) => {
  set(internalSummariesReload$, (version) => {
    return version + 1;
  });
});

interface ConnectorAccountPage {
  readonly connections: readonly ConnectorAccountConnection[];
  readonly nextCursor: string | null;
  readonly available: boolean;
}

function emptyConnectorAccountPage(): ConnectorAccountPage {
  return { connections: [], nextCursor: null, available: false };
}

export interface ConnectorAccountList {
  readonly connections: readonly ConnectorAccountConnection[];
  readonly nextCursor: string | null;
  readonly available: boolean;
}

function mergeConnectorAccountPages(
  firstPage: ConnectorAccountPage,
  pages: readonly ConnectorAccountPage[],
): ConnectorAccountList {
  return {
    connections: [
      ...firstPage.connections,
      ...pages.flatMap((page) => {
        return page.connections;
      }),
    ],
    nextCursor: pages.at(-1)?.nextCursor ?? firstPage.nextCursor,
    available: firstPage.available,
  };
}

function targetListQuery(
  target: ConnectorAccountTarget,
  search: string,
  cursor?: string,
) {
  const page = {
    limit: CONNECTOR_ACCOUNT_PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(cursor ? { cursor } : {}),
  };
  return target.kind === "builtin"
    ? { ...page, kind: target.kind, connectorSlug: target.connectorSlug }
    : {
        ...page,
        kind: target.kind,
        customConnectorId: target.customConnectorId,
      };
}

async function fetchConnectorAccountFirstPage(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  search: string,
  signal: AbortSignal,
): Promise<ConnectorAccountPage> {
  const result = await accept(
    createClient(connectorAccountsContract).connections({
      query: targetListQuery(target, search),
      fetchOptions: { signal },
    }),
    [200, 404],
    signal,
  );
  signal.throwIfAborted();
  return result.status === 404
    ? emptyConnectorAccountPage()
    : { ...result.body, available: true };
}

function createConnectorAccountFirstPageQuery(
  effectiveSearch$: State<string>,
  resetPages$: Command<void, []>,
) {
  return command(
    async (
      { get, set },
      target: ConnectorAccountTarget,
      search: string,
      debounce: boolean,
      signal: AbortSignal,
    ): Promise<ConnectorAccountPage> => {
      if (debounce) {
        await delay(CONNECTOR_ACCOUNT_SEARCH_DEBOUNCE_MS, { signal });
      }
      signal.throwIfAborted();
      set(effectiveSearch$, search);
      set(resetPages$);
      return fetchConnectorAccountFirstPage(
        get(apiClient$),
        target,
        search,
        signal,
      );
    },
  );
}

function createConnectorAccountFirstPageSignals() {
  const target$ = state<ConnectorAccountTarget | null>(null);
  const search$ = state("");
  const effectiveSearch$ = state("");
  const generation$ = state(0);
  const pages$ = state<readonly ConnectorAccountPage[]>([]);
  const loadingCursor$ = state<string | null>(null);
  const firstPage$ = state<Promise<ConnectorAccountPage>>(
    Promise.resolve(emptyConnectorAccountPage()),
  );
  const resetQuerySignal$ = resetSignal();

  const resetPages$ = command(({ set }) => {
    set(pages$, []);
    set(loadingCursor$, null);
    set(generation$, (generation) => {
      return generation + 1;
    });
  });

  const queryFirstPage$ = createConnectorAccountFirstPageQuery(
    effectiveSearch$,
    resetPages$,
  );

  const startFirstPageQuery$ = command(
    (
      { set },
      target: ConnectorAccountTarget,
      search: string,
      debounce: boolean,
      signal: AbortSignal,
    ): void => {
      const request = set(queryFirstPage$, target, search, debounce, signal);
      set(firstPage$, request);
    },
  );

  const accounts$ = computed(async (get): Promise<ConnectorAccountList> => {
    const firstPage = await get(firstPage$);
    return mergeConnectorAccountPages(firstPage, get(pages$));
  });

  const setTarget$ = command(
    ({ get, set }, target: ConnectorAccountTarget, signal: AbortSignal) => {
      const current = get(target$);
      if (
        current &&
        connectorAccountTargetKey(current) === connectorAccountTargetKey(target)
      ) {
        return;
      }
      set(target$, target);
      set(search$, "");
      const querySignal = set(resetQuerySignal$, signal);
      set(startFirstPageQuery$, target, "", false, querySignal);
    },
  );

  const clearTarget$ = command(({ set }) => {
    set(resetQuerySignal$);
    set(target$, null);
    set(search$, "");
    set(effectiveSearch$, "");
    set(resetPages$);
    set(firstPage$, Promise.resolve(emptyConnectorAccountPage()));
  });

  const setSearch$ = command(
    ({ get, set }, search: string, signal: AbortSignal) => {
      const normalized = search.trimStart();
      if (get(search$) === normalized) {
        return;
      }
      set(search$, normalized);
      const target = get(target$);
      if (!target) {
        return;
      }

      const querySignal = set(resetQuerySignal$, signal);
      set(
        startFirstPageQuery$,
        target,
        normalized,
        normalized.length > 0,
        querySignal,
      );
    },
  );

  const resetSearch$ = command(({ set }) => {
    set(resetQuerySignal$);
    set(search$, "");
    set(effectiveSearch$, "");
  });

  const reload$ = command(({ get, set }, signal: AbortSignal) => {
    const target = get(target$);
    if (!target) {
      return;
    }

    const querySignal = set(resetQuerySignal$, signal);
    set(startFirstPageQuery$, target, get(search$), false, querySignal);
  });

  return {
    target$,
    effectiveSearch$,
    generation$,
    pages$,
    loadingCursor$,
    search$: computed((get) => {
      return get(search$);
    }),
    accounts$,
    setTarget$,
    clearTarget$,
    setSearch$,
    resetSearch$,
    reload$,
  };
}

export function createConnectorAccountListSignals() {
  const firstPageSignals = createConnectorAccountFirstPageSignals();
  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const generation = get(firstPageSignals.generation$);
      const target = get(firstPageSignals.target$);
      if (!target) {
        return;
      }
      const loaded = await get(firstPageSignals.accounts$);
      signal.throwIfAborted();
      if (get(firstPageSignals.generation$) !== generation) {
        return;
      }
      const cursor = loaded.nextCursor;
      if (!cursor || get(firstPageSignals.loadingCursor$) !== null) {
        return;
      }
      set(firstPageSignals.loadingCursor$, cursor);
      const result = await onRejection(
        accept(
          get(apiClient$)(connectorAccountsContract).connections({
            query: targetListQuery(
              target,
              get(firstPageSignals.effectiveSearch$),
              cursor,
            ),
            fetchOptions: { signal },
          }),
          [200, 404],
          signal,
        ),
        () => {
          if (get(firstPageSignals.generation$) !== generation) {
            return;
          }
          set(firstPageSignals.loadingCursor$, null);
        },
      );
      signal.throwIfAborted();
      if (get(firstPageSignals.generation$) !== generation) {
        return;
      }
      if (result.status === 404) {
        set(firstPageSignals.reload$, signal);
        return;
      }
      set(firstPageSignals.pages$, (pages) => {
        return [...pages, { ...result.body, available: true }];
      });
      set(firstPageSignals.loadingCursor$, null);
    },
  );

  return {
    search$: firstPageSignals.search$,
    accounts$: firstPageSignals.accounts$,
    setTarget$: firstPageSignals.setTarget$,
    clearTarget$: firstPageSignals.clearTarget$,
    setSearch$: firstPageSignals.setSearch$,
    resetSearch$: firstPageSignals.resetSearch$,
    reload$: firstPageSignals.reload$,
    loadMore$,
  };
}
