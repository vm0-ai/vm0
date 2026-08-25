import { command, computed, state } from "ccstate";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  ConnectorAccountConnection,
  ConnectorAccountMutationIntent,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";

import type { PlatformConnectorCatalogStatusItem } from "../../connector-domain.ts";
import {
  connectorAccountDeletionImpact$,
  reloadConnectorAccountSummaries$,
  settingsConnectorAccounts,
} from "./connector-accounts.ts";

export type ConnectorAccountConnectMode =
  | { readonly kind: "add" }
  | {
      readonly kind: "reconnect";
      readonly account: ConnectorAccountConnection;
    };

export function connectorAccountMutationFor(
  mode: ConnectorAccountConnectMode | undefined,
): ConnectorAccountMutationIntent | undefined {
  if (!mode) {
    return undefined;
  }
  if (mode.kind === "reconnect") {
    return { intent: "reconnect", connectionId: mode.account.id };
  }
  return { intent: "add" };
}

interface BuiltinAccountConnectDialog {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly mode: ConnectorAccountConnectMode;
}

interface CustomAccountConnectDialog {
  readonly connector: CustomConnectorResponse;
  readonly mode: ConnectorAccountConnectMode;
}

const internalBuiltinAccountManager$ =
  state<PlatformConnectorCatalogStatusItem | null>(null);
const internalBuiltinAccountConnectDialog$ =
  state<BuiltinAccountConnectDialog | null>(null);
const internalCustomAccountManager$ = state<CustomConnectorResponse | null>(
  null,
);
const internalCustomAccountConnectDialog$ =
  state<CustomAccountConnectDialog | null>(null);

export const builtinAccountManager$ = computed((get) => {
  return get(internalBuiltinAccountManager$);
});

export const builtinAccountConnectDialog$ = computed((get) => {
  return get(internalBuiltinAccountConnectDialog$);
});

export const customAccountManager$ = computed((get) => {
  return get(internalCustomAccountManager$);
});

export const customAccountConnectDialog$ = computed((get) => {
  return get(internalCustomAccountConnectDialog$);
});

export const openBuiltinAccountManager$ = command(
  ({ set }, connector: PlatformConnectorCatalogStatusItem) => {
    set(internalBuiltinAccountManager$, connector);
    set(internalBuiltinAccountConnectDialog$, null);
    set(settingsConnectorAccounts.setTarget$, {
      kind: "builtin",
      connectorSlug: connector.slug,
    });
  },
);

export const closeBuiltinAccountManager$ = command(({ set }) => {
  set(internalBuiltinAccountManager$, null);
  set(settingsConnectorAccounts.setTarget$, null);
});

export const openBuiltinAccountConnectDialog$ = command(
  (
    { set },
    connector: PlatformConnectorCatalogStatusItem,
    mode: ConnectorAccountConnectMode,
  ) => {
    set(internalBuiltinAccountManager$, null);
    set(settingsConnectorAccounts.setTarget$, null);
    set(internalBuiltinAccountConnectDialog$, { connector, mode });
  },
);

export const closeBuiltinAccountConnectDialog$ = command(({ set }) => {
  set(internalBuiltinAccountConnectDialog$, null);
});

export const openCustomAccountManager$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalCustomAccountManager$, connector);
    set(internalCustomAccountConnectDialog$, null);
    set(settingsConnectorAccounts.setTarget$, {
      kind: "custom",
      customConnectorId: connector.id,
    });
  },
);

export const closeCustomAccountManager$ = command(({ set }) => {
  set(internalCustomAccountManager$, null);
  set(settingsConnectorAccounts.setTarget$, null);
});

export const openCustomAccountConnectDialog$ = command(
  (
    { set },
    connector: CustomConnectorResponse,
    mode: ConnectorAccountConnectMode,
  ) => {
    set(internalCustomAccountManager$, null);
    set(settingsConnectorAccounts.setTarget$, null);
    set(internalCustomAccountConnectDialog$, { connector, mode });
  },
);

export const closeCustomAccountConnectDialog$ = command(({ set }) => {
  set(internalCustomAccountConnectDialog$, null);
});

interface ConnectorAccountNamePrompt {
  readonly target: ConnectorAccountTarget;
  readonly connectionId: string;
  readonly connectorLabel: string;
}

const internalConnectorAccountNamePrompt$ =
  state<ConnectorAccountNamePrompt | null>(null);
const internalConnectorAccountNamePromptValue$ = state("");

export const connectorAccountNamePrompt$ = computed((get) => {
  return get(internalConnectorAccountNamePrompt$);
});

export const connectorAccountNamePromptValue$ = computed((get) => {
  return get(internalConnectorAccountNamePromptValue$);
});

export const setConnectorAccountNamePromptValue$ = command(
  ({ set }, value: string) => {
    set(internalConnectorAccountNamePromptValue$, value);
  },
);

export const openConnectorAccountNamePrompt$ = command(
  ({ set }, prompt: ConnectorAccountNamePrompt) => {
    set(internalConnectorAccountNamePromptValue$, "");
    set(internalConnectorAccountNamePrompt$, prompt);
  },
);

export const closeConnectorAccountNamePrompt$ = command(({ set }) => {
  set(internalConnectorAccountNamePrompt$, null);
  set(internalConnectorAccountNamePromptValue$, "");
});

export const finishConnectorAccountConnection$ = command(
  (
    { set },
    args: Omit<ConnectorAccountNamePrompt, "connectionId"> & {
      readonly connectionId: string | null;
      readonly mode: ConnectorAccountConnectMode;
    },
  ) => {
    set(reloadConnectorAccountSummaries$);
    set(settingsConnectorAccounts.reload$);
    if (args.mode.kind !== "add" || !args.connectionId) {
      return;
    }
    set(internalConnectorAccountNamePromptValue$, "");
    set(internalConnectorAccountNamePrompt$, {
      target: args.target,
      connectionId: args.connectionId,
      connectorLabel: args.connectorLabel,
    });
  },
);

interface ConnectorAccountRenameDraft {
  readonly account: ConnectorAccountConnection;
  readonly displayName: string;
}

const internalConnectorAccountRenameDraft$ =
  state<ConnectorAccountRenameDraft | null>(null);
const internalConnectorAccountManagerDraftGeneration$ = state(0);

export const connectorAccountRenameDraft$ = computed((get) => {
  return get(internalConnectorAccountRenameDraft$);
});

export const startConnectorAccountRename$ = command(
  ({ set }, account: ConnectorAccountConnection) => {
    set(internalConnectorAccountManagerDraftGeneration$, (generation) => {
      return generation + 1;
    });
    set(internalConnectorAccountDeletionDraft$, null);
    set(internalConnectorAccountRenameDraft$, {
      account,
      displayName: account.displayName ?? "",
    });
  },
);

export const setConnectorAccountRenameValue$ = command(
  ({ set }, displayName: string) => {
    set(internalConnectorAccountRenameDraft$, (draft) => {
      return draft ? { ...draft, displayName } : null;
    });
  },
);

export const clearConnectorAccountRename$ = command(({ set }) => {
  set(internalConnectorAccountRenameDraft$, null);
});

interface ConnectorAccountDeletionDraft {
  readonly account: ConnectorAccountConnection;
  readonly explicitSelectionCount: number;
}

const internalConnectorAccountDeletionDraft$ =
  state<ConnectorAccountDeletionDraft | null>(null);

export const connectorAccountDeletionDraft$ = computed((get) => {
  return get(internalConnectorAccountDeletionDraft$);
});

export const prepareConnectorAccountDeletion$ = command(
  async (
    { get, set },
    args: {
      readonly target: ConnectorAccountConnection["target"];
      readonly account: ConnectorAccountConnection;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const generation = get(internalConnectorAccountManagerDraftGeneration$) + 1;
    set(internalConnectorAccountManagerDraftGeneration$, generation);
    set(internalConnectorAccountRenameDraft$, null);
    set(internalConnectorAccountDeletionDraft$, null);
    const impact = await set(
      connectorAccountDeletionImpact$,
      { target: args.target, connectionId: args.account.id },
      signal,
    );
    signal.throwIfAborted();
    if (get(internalConnectorAccountManagerDraftGeneration$) !== generation) {
      return;
    }
    set(internalConnectorAccountDeletionDraft$, {
      account: args.account,
      explicitSelectionCount: impact.explicitSelectionCount,
    });
  },
);

export const clearConnectorAccountDeletion$ = command(({ set }) => {
  set(internalConnectorAccountDeletionDraft$, null);
});

export const resetConnectorAccountManagerDrafts$ = command(({ set }) => {
  set(internalConnectorAccountManagerDraftGeneration$, (generation) => {
    return generation + 1;
  });
  set(internalConnectorAccountRenameDraft$, null);
  set(internalConnectorAccountDeletionDraft$, null);
});

export const resetConnectorAccountDialogs$ = command(({ set }) => {
  set(internalBuiltinAccountManager$, null);
  set(internalBuiltinAccountConnectDialog$, null);
  set(internalCustomAccountManager$, null);
  set(internalCustomAccountConnectDialog$, null);
  set(internalConnectorAccountNamePrompt$, null);
  set(internalConnectorAccountNamePromptValue$, "");
  set(resetConnectorAccountManagerDrafts$);
  set(settingsConnectorAccounts.setTarget$, null);
});
