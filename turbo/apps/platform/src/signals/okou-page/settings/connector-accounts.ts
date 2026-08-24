import { command, computed, state } from "ccstate";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
  type ConnectorAccountSummary,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { onRejection } from "../../utils.ts";

const CONNECTOR_ACCOUNT_PAGE_SIZE = 50;

export type ConnectorAccountMutationVersion = number | string | null;

function connectorAccountTargetKey(target: ConnectorAccountTarget): string {
  return target.kind === "builtin"
    ? `builtin:${target.connectorSlug}`
    : `custom:${target.customConnectorId}`;
}

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

export async function readConnectorAccountMutationVersion(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  account: ConnectorAccountMutationIntent,
  signal: AbortSignal,
): Promise<ConnectorAccountMutationVersion> {
  if (account.intent === "add") {
    const result = await accept(
      createClient(connectorAccountsContract).summaries({
        fetchOptions: { signal },
      }),
      [200],
    );
    return (
      result.body.summaries.find((summary) => {
        return (
          connectorAccountTargetKey(summary.target) ===
          connectorAccountTargetKey(target)
        );
      })?.accountCount ?? 0
    );
  }
  if (account.intent === "reconnect") {
    const result = await accept(
      createClient(connectorAccountsContract).connection({
        params: { connectionId: account.connectionId },
        query: target,
        fetchOptions: { signal },
      }),
      [200, 404],
    );
    return result.status === 404 ? null : result.body.updatedAt;
  }
  return null;
}

export async function connectorAccountConnectionExists(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  connectionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await accept(
    createClient(connectorAccountsContract).connection({
      params: { connectionId },
      query: target,
      fetchOptions: { signal },
    }),
    [200, 404],
  );
  return result.status === 200;
}

export function connectorAccountMutationCompleted(
  account: ConnectorAccountMutationIntent,
  initialVersion: ConnectorAccountMutationVersion,
  currentVersion: ConnectorAccountMutationVersion,
): boolean {
  if (account.intent === "add") {
    return (
      typeof initialVersion === "number" &&
      typeof currentVersion === "number" &&
      currentVersion > initialVersion
    );
  }
  return account.intent === "reconnect"
    ? typeof currentVersion === "string" && currentVersion !== initialVersion
    : true;
}

interface ConnectorAccountPage {
  readonly connections: readonly ConnectorAccountConnection[];
  readonly nextCursor: string | null;
  readonly available: boolean;
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

function createConnectorAccountListSignals() {
  const target$ = state<ConnectorAccountTarget | null>(null);
  const search$ = state("");
  const reloadVersion$ = state(0);
  const generation$ = state(0);
  const pages$ = state<readonly ConnectorAccountPage[]>([]);
  const loadingCursor$ = state<string | null>(null);

  const resetPages$ = command(({ set }) => {
    set(pages$, []);
    set(loadingCursor$, null);
    set(generation$, (generation) => {
      return generation + 1;
    });
  });

  const firstPage$ = computed(async (get): Promise<ConnectorAccountPage> => {
    get(reloadVersion$);
    const target = get(target$);
    if (!target) {
      return { connections: [], nextCursor: null, available: false };
    }
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).connections({
        query: targetListQuery(target, get(search$)),
      }),
      [200, 404],
    );
    return result.status === 404
      ? { connections: [], nextCursor: null, available: false }
      : { ...result.body, available: true };
  });

  const accounts$ = computed(async (get): Promise<ConnectorAccountList> => {
    const firstPage = await get(firstPage$);
    return mergeConnectorAccountPages(firstPage, get(pages$));
  });

  const setTarget$ = command(
    ({ get, set }, target: ConnectorAccountTarget | null) => {
      const current = get(target$);
      if (
        current &&
        target &&
        connectorAccountTargetKey(current) === connectorAccountTargetKey(target)
      ) {
        return;
      }
      set(target$, target);
      set(search$, "");
      set(resetPages$);
    },
  );

  const setSearch$ = command(({ get, set }, search: string) => {
    const normalized = search.trimStart();
    if (get(search$) === normalized) {
      return;
    }
    set(search$, normalized);
    set(resetPages$);
  });

  const reload$ = command(({ set }) => {
    set(resetPages$);
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });

  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const generation = get(generation$);
      const target = get(target$);
      if (!target) {
        return;
      }
      const loaded = await get(accounts$);
      signal.throwIfAborted();
      if (get(generation$) !== generation) {
        return;
      }
      const cursor = loaded.nextCursor;
      if (!cursor || get(loadingCursor$) !== null) {
        return;
      }
      set(loadingCursor$, cursor);
      const result = await onRejection(
        accept(
          get(apiClient$)(connectorAccountsContract).connections({
            query: targetListQuery(target, get(search$), cursor),
            fetchOptions: { signal },
          }),
          [200, 404],
          signal,
        ),
        () => {
          if (get(generation$) !== generation) {
            return;
          }
          set(loadingCursor$, null);
        },
      );
      signal.throwIfAborted();
      if (get(generation$) !== generation) {
        return;
      }
      if (result.status === 404) {
        set(reload$);
        return;
      }
      set(pages$, (pages) => {
        return [...pages, { ...result.body, available: true }];
      });
      set(loadingCursor$, null);
    },
  );

  return {
    search$: computed((get) => {
      return get(search$);
    }),
    accounts$,
    setTarget$,
    setSearch$,
    reload$,
    loadMore$,
  };
}

export const settingsConnectorAccounts = createConnectorAccountListSignals();

const invalidateConnectorAccounts$ = command(({ set }) => {
  set(reloadConnectorAccountSummaries$);
  set(settingsConnectorAccounts.reload$);
});

export const renameConnectorAccount$ = command(
  async (
    { get, set },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
      readonly displayName: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await accept(
      get(apiClient$)(connectorAccountsContract).rename({
        params: { connectionId: args.connectionId },
        body: { target: args.target, displayName: args.displayName },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(invalidateConnectorAccounts$);
  },
);

export const setDefaultConnectorAccount$ = command(
  async (
    { get, set },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await accept(
      get(apiClient$)(connectorAccountsContract).setDefault({
        params: { connectionId: args.connectionId },
        body: { target: args.target },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(invalidateConnectorAccounts$);
  },
);

export const connectorAccountDeletionImpact$ = command(
  async (
    { get },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ) => {
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).deletionImpact({
        params: { connectionId: args.connectionId },
        query: args.target,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const deleteConnectorAccount$ = command(
  async (
    { get, set },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ) => {
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).delete({
        params: { connectionId: args.connectionId },
        body: { target: args.target },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(invalidateConnectorAccounts$);
    return result.body;
  },
);
