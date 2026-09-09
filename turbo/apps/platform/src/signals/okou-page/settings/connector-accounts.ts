import { command } from "ccstate";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";

import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import type { PlatformConnectorAccountMutationIntent } from "../../connector-domain.ts";
import {
  connectorAccountTargetKey,
  createConnectorAccountListSignals,
  reloadConnectorAccountSummaries$,
} from "../connector-accounts.ts";

export async function readConnectorAccountCount(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  signal: AbortSignal,
): Promise<number> {
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

export async function readConnectorOAuthCompletion(
  createClient: ApiClientFactory,
  target: ConnectorAccountTarget,
  account: PlatformConnectorAccountMutationIntent,
  attemptId: string | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  // New App -> old API: absent attempt IDs cannot prove authorization.
  // Remove after receipt-capable APIs are the serving and rollback floor (#32870).
  if (!attemptId) {
    return null;
  }
  const result = await accept(
    createClient(connectorAccountsContract).oauthCompletion({
      params: { attemptId },
      query: target,
      fetchOptions: { signal },
    }),
    [200, 404],
  );
  if (
    result.status === 404 ||
    (account.intent === "reconnect" &&
      result.body.connectionId !== account.connectionId)
  ) {
    return null;
  }
  return result.body.connectionId;
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
