import { command, computed, state } from "ccstate";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";

import type { PlatformConnectorCatalogStatusItem } from "../../connector-domain.ts";
import {
  connectorAccountDeletionImpact$,
  settingsConnectorAccounts,
} from "./connector-accounts.ts";

export type ConnectorAccountConnectMode =
  | { readonly kind: "add" }
  | {
      readonly kind: "reconnect";
      readonly account: ConnectorAccountConnection;
    };

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
const internalConnectorAccountLabel$ = state("");

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

export const connectorAccountLabel$ = computed((get) => {
  return get(internalConnectorAccountLabel$);
});

export const setConnectorAccountLabel$ = command(
  ({ set }, displayName: string) => {
    set(internalConnectorAccountLabel$, displayName);
  },
);

function modeDisplayName(mode: ConnectorAccountConnectMode): string {
  return mode.kind === "reconnect" ? (mode.account.displayName ?? "") : "";
}

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
    set(internalConnectorAccountLabel$, modeDisplayName(mode));
    set(internalBuiltinAccountConnectDialog$, { connector, mode });
  },
);

export const closeBuiltinAccountConnectDialog$ = command(({ set }) => {
  set(internalBuiltinAccountConnectDialog$, null);
  set(internalConnectorAccountLabel$, "");
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
    set(internalConnectorAccountLabel$, modeDisplayName(mode));
    set(internalCustomAccountConnectDialog$, { connector, mode });
  },
);

export const closeCustomAccountConnectDialog$ = command(({ set }) => {
  set(internalCustomAccountConnectDialog$, null);
  set(internalConnectorAccountLabel$, "");
});

interface ConnectorAccountRenameDraft {
  readonly account: ConnectorAccountConnection;
  readonly displayName: string;
}

const internalConnectorAccountRenameDraft$ =
  state<ConnectorAccountRenameDraft | null>(null);

export const connectorAccountRenameDraft$ = computed((get) => {
  return get(internalConnectorAccountRenameDraft$);
});

export const startConnectorAccountRename$ = command(
  ({ set }, account: ConnectorAccountConnection) => {
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
    { set },
    args: {
      readonly target: ConnectorAccountConnection["target"];
      readonly account: ConnectorAccountConnection;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const impact = await set(
      connectorAccountDeletionImpact$,
      { target: args.target, connectionId: args.account.id },
      signal,
    );
    signal.throwIfAborted();
    set(internalConnectorAccountRenameDraft$, null);
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
  set(internalConnectorAccountRenameDraft$, null);
  set(internalConnectorAccountDeletionDraft$, null);
});
