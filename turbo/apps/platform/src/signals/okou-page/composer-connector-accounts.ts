import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountSummary,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { withCleanup } from "../utils.ts";
import {
  connectorAccountSummaryByTarget$,
  connectorAccountTargetKey,
  createConnectorAccountListSignals,
  reloadConnectorAccountSummaries$,
} from "./connector-accounts.ts";

export interface ComposerConnectorAccountPreferenceState {
  readonly selections: readonly ConnectorAccountSelection[];
  readonly selectedConnections: readonly ConnectorAccountConnection[];
}

export interface ComposerConnectorAccountSignals {
  readonly enabled$: Computed<boolean>;
  readonly preferenceState$: Computed<
    Promise<ComposerConnectorAccountPreferenceState>
  >;
  readonly summaryByTarget$: Computed<
    Promise<ReadonlyMap<string, ConnectorAccountSummary>>
  >;
  readonly panelTarget$: Computed<ConnectorAccountTarget | null>;
  readonly panelOpen$: Computed<boolean>;
  readonly search$: Computed<string>;
  readonly accounts$: ReturnType<
    typeof createConnectorAccountListSignals
  >["accounts$"];
  readonly openTarget$: Command<void, [ConnectorAccountTarget]>;
  readonly closePanel$: Command<void, []>;
  readonly setSearch$: ReturnType<
    typeof createConnectorAccountListSignals
  >["setSearch$"];
  readonly loadMore$: ReturnType<
    typeof createConnectorAccountListSignals
  >["loadMore$"];
  readonly selectAccount$: Command<
    Promise<void>,
    [ConnectorAccountConnection, AbortSignal]
  >;
  readonly useDefault$: Command<
    Promise<void>,
    [ConnectorAccountTarget, AbortSignal]
  >;
  readonly reload$: Command<void, []>;
  readonly openPopover$: Command<void, []>;
  readonly resetPendingSelections$: Command<void, []>;
  readonly savingTargetKey$: Computed<string | null>;
}

function emptyPreferenceState(): ComposerConnectorAccountPreferenceState {
  return { selections: [], selectedConnections: [] };
}

function selectionForConnection(
  connection: ConnectorAccountConnection,
): ConnectorAccountSelection {
  return { connectionId: connection.id, target: connection.target };
}

function createConnectorAccountMutationSignals(args: {
  readonly threadId: string | undefined;
  readonly pendingState$: State<ComposerConnectorAccountPreferenceState>;
  readonly savingTargetKey$: State<string | null>;
  readonly reload$: Command<void, []>;
}): Pick<ComposerConnectorAccountSignals, "selectAccount$" | "useDefault$"> {
  const selectAccount$ = command(
    async (
      { get, set },
      connection: ConnectorAccountConnection,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const targetKey = connectorAccountTargetKey(connection.target);
      set(args.savingTargetKey$, targetKey);
      if (!args.threadId) {
        const current = get(args.pendingState$);
        const selection = selectionForConnection(connection);
        set(args.pendingState$, {
          selections: [
            ...current.selections.filter((candidate) => {
              return connectorAccountTargetKey(candidate.target) !== targetKey;
            }),
            selection,
          ],
          selectedConnections: [
            ...current.selectedConnections.filter((candidate) => {
              return connectorAccountTargetKey(candidate.target) !== targetKey;
            }),
            connection,
          ],
        });
        set(args.savingTargetKey$, null);
        return;
      }
      await withCleanup(
        accept(
          get(apiClient$)(chatThreadConnectorSelectionContract).update({
            params: { id: args.threadId },
            body: selectionForConnection(connection),
            fetchOptions: { signal },
          }),
          [200, 400, 404],
          signal,
        ),
        () => {
          set(args.savingTargetKey$, null);
        },
      );
      signal.throwIfAborted();
      set(args.reload$);
    },
  );

  const useDefault$ = command(
    async (
      { get, set },
      target: ConnectorAccountTarget,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const targetKey = connectorAccountTargetKey(target);
      set(args.savingTargetKey$, targetKey);
      if (!args.threadId) {
        const current = get(args.pendingState$);
        set(args.pendingState$, {
          selections: current.selections.filter((candidate) => {
            return connectorAccountTargetKey(candidate.target) !== targetKey;
          }),
          selectedConnections: current.selectedConnections.filter(
            (candidate) => {
              return connectorAccountTargetKey(candidate.target) !== targetKey;
            },
          ),
        });
        set(args.savingTargetKey$, null);
        return;
      }
      await withCleanup(
        accept(
          get(apiClient$)(chatThreadConnectorSelectionContract).clear({
            params: { id: args.threadId },
            body: target,
            fetchOptions: { signal },
          }),
          [204, 404],
          signal,
        ),
        () => {
          set(args.savingTargetKey$, null);
        },
      );
      signal.throwIfAborted();
      set(args.reload$);
    },
  );

  return { selectAccount$, useDefault$ };
}

export function createComposerConnectorAccountSignals(
  threadId?: string,
): ComposerConnectorAccountSignals {
  const list = createConnectorAccountListSignals();
  const panelTarget$ = state<ConnectorAccountTarget | null>(null);
  const panelOpen$ = state(false);
  const reloadVersion$ = state(0);
  const pendingState$ = state<ComposerConnectorAccountPreferenceState>(
    emptyPreferenceState(),
  );
  const savingTargetKey$ = state<string | null>(null);
  const enabled$ = computed((get): boolean => {
    return get(featureSwitch$)[FeatureSwitchKey.ConnectorAccounts] ?? false;
  });
  const preferenceState$ = computed(
    async (get): Promise<ComposerConnectorAccountPreferenceState> => {
      if (!get(enabled$)) {
        return emptyPreferenceState();
      }
      if (!threadId) {
        return get(pendingState$);
      }
      get(reloadVersion$);
      const result = await accept(
        get(apiClient$)(chatThreadConnectorSelectionContract).get({
          params: { id: threadId },
        }),
        [200, 404],
      );
      return result.status === 404 ? emptyPreferenceState() : result.body;
    },
  );

  const reload$ = command(({ set }) => {
    set(reloadVersion$, (version) => {
      return version + 1;
    });
    set(reloadConnectorAccountSummaries$);
    set(list.reload$);
  });
  const openPopover$ = command(({ set }) => {
    set(reloadVersion$, (version) => {
      return version + 1;
    });
    set(reloadConnectorAccountSummaries$);
  });
  const openTarget$ = command(
    ({ get, set }, target: ConnectorAccountTarget): void => {
      const currentTarget = get(panelTarget$);
      set(panelTarget$, target);
      if (
        currentTarget &&
        connectorAccountTargetKey(currentTarget) ===
          connectorAccountTargetKey(target)
      ) {
        set(list.reload$);
      } else {
        set(list.setTarget$, target);
      }
      set(panelOpen$, true);
    },
  );
  const closePanel$ = command(({ set }): void => {
    set(panelOpen$, false);
    set(list.setSearch$, "");
  });

  const { selectAccount$, useDefault$ } = createConnectorAccountMutationSignals(
    {
      threadId,
      pendingState$,
      savingTargetKey$,
      reload$,
    },
  );

  const resetPendingSelections$ = command(({ set }) => {
    if (!threadId) {
      set(pendingState$, emptyPreferenceState());
    }
  });

  return {
    enabled$,
    preferenceState$,
    summaryByTarget$: connectorAccountSummaryByTarget$,
    panelTarget$: computed((get) => {
      return get(panelTarget$);
    }),
    panelOpen$: computed((get) => {
      return get(panelOpen$);
    }),
    search$: list.search$,
    accounts$: list.accounts$,
    openTarget$,
    closePanel$,
    setSearch$: list.setSearch$,
    loadMore$: list.loadMore$,
    selectAccount$,
    useDefault$,
    reload$,
    openPopover$,
    resetPendingSelections$,
    savingTargetKey$: computed((get) => {
      return get(savingTargetKey$);
    }),
  };
}
