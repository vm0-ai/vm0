import { command } from "ccstate";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";

import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import {
  connectorAccountTargetKey,
  createConnectorAccountListSignals,
  reloadConnectorAccountSummaries$,
} from "../connector-accounts.ts";

export type ConnectorAccountMutationVersion = number | string | null;

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

export const settingsConnectorAccounts = createConnectorAccountListSignals({
  includeBuiltinScopeMismatch: true,
});

const invalidateConnectorAccounts$ = command(({ set }, signal: AbortSignal) => {
  set(reloadConnectorAccountSummaries$);
  set(settingsConnectorAccounts.reload$, signal);
});

export const readConnectorAccount$ = command(
  async (
    { get },
    args: {
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ): Promise<ConnectorAccountConnection> => {
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).connection({
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
    set(invalidateConnectorAccounts$, signal);
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
    set(invalidateConnectorAccounts$, signal);
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
    set(invalidateConnectorAccounts$, signal);
    return result.body;
  },
);
