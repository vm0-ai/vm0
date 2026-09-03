import { command, computed } from "ccstate";
import {
  connectorAccountTargetKey,
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { bestEffort } from "../utils";
import {
  connectorAccountDeletionImpact,
  getConnectorAccount,
  listConnectorAccountsByIds,
  listConnectorAccountsForTarget,
  listConnectorAccountSummaries,
  renameConnectorAccount,
  setDefaultConnectorAccount,
} from "../services/connector-account-lifecycle.service";
import { commitConnectorRuntimeMutation } from "../services/connector-runtime-wakeup.service";
import {
  connectorScopeDiff,
  deleteConnectorLocalState$,
} from "../services/connector-data.service";
import {
  deleteCustomConnectorAccount$,
  disconnectCustomConnector$,
  integrationManagedCustomConnectorMutationForbidden,
} from "../services/custom-connector.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { reconcileGmailWatchesForUser } from "../services/gmail-automation-event.service";
import { reconcileGoogleCalendarWatchesForUser } from "../services/google-calendar-automation-event.service";
import { reconcileGoogleFormsWatchesForUser } from "../services/google-forms-automation-event.service";
import { reconcileGoogleMeetSubscriptionsForUser } from "../services/google-meet-automation-event.service";

const log = logger("api:connector-account-mutation");

const connectorAccountsEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await get(userFeatureSwitchContext(auth.orgId, auth.userId));
  return isFeatureEnabled(FeatureSwitchKey.ConnectorAccounts, context);
});

function targetFromQuery(
  query: ConnectorAccountTarget,
): ConnectorAccountTarget {
  return query.kind === "builtin"
    ? { kind: "builtin", connectorSlug: query.connectorSlug }
    : { kind: "custom", customConnectorId: query.customConnectorId };
}

const inspectInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(connectorAccountsEnabled$))) {
    return notFound("Resource not found");
  }
  const body = await get(bodyResultOf(connectorAccountsContract.inspect));
  if (!body.ok) {
    return body.response;
  }
  const accounts = await listConnectorAccountsByIds(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    connectionIds: body.data.selections.map((selection) => {
      return selection.connectionId;
    }),
  });
  const accountsById = new Map(
    accounts.map((account) => {
      return [account.id, account];
    }),
  );
  return {
    status: 200 as const,
    body: {
      results: body.data.selections.map((selection) => {
        const account = accountsById.get(selection.connectionId);
        if (
          !account ||
          connectorAccountTargetKey(account.target) !==
            connectorAccountTargetKey(selection.target)
        ) {
          return { kind: "unavailable" as const, ...selection };
        }
        return {
          kind: "available" as const,
          connectionId: account.id,
          target: account.target,
          authMethod: account.authMethod,
          displayName: account.displayName,
          externalId: account.externalId,
          externalUsername: account.externalUsername,
          externalEmail: account.externalEmail,
          connectionStatus: account.connectionStatus,
          reconnectReason: account.reconnectReason,
        };
      }),
    },
  };
});

const summariesInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(connectorAccountsEnabled$))) {
    return notFound("Resource not found");
  }
  const summaries = await listConnectorAccountSummaries(get(db$), auth);
  return { status: 200 as const, body: { summaries: [...summaries] } };
});

const connectionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(connectorAccountsEnabled$))) {
    return notFound("Resource not found");
  }
  const query = get(queryOf(connectorAccountsContract.connections));
  const result = await listConnectorAccountsForTarget(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    target: targetFromQuery(query),
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(query.kind === "builtin" && query.includeScopeMismatch === "true"
      ? { includeScopeMismatch: true }
      : {}),
  });
  if (result.kind === "invalid-cursor") {
    return badRequestMessage("Invalid connector account cursor");
  }
  if (result.kind === "missing") {
    return notFound("Connector target not found");
  }
  return {
    status: 200 as const,
    body: {
      connections: [...result.connections],
      nextCursor: result.nextCursor,
    },
  };
});

const connectionInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(connectorAccountsEnabled$))) {
    return notFound("Resource not found");
  }
  const params = get(pathParamsOf(connectorAccountsContract.connection));
  const query = get(queryOf(connectorAccountsContract.connection));
  const account = await getConnectorAccount(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    target: targetFromQuery(query),
    connectionId: params.connectionId,
  });
  return account
    ? { status: 200 as const, body: account }
    : notFound("Connector account not found");
});

const scopeDiffInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(connectorAccountsEnabled$))) {
    return notFound("Resource not found");
  }
  const params = get(pathParamsOf(connectorAccountsContract.scopeDiff));
  const query = get(queryOf(connectorAccountsContract.scopeDiff));
  const diff = await get(
    connectorScopeDiff({
      orgId: auth.orgId,
      userId: auth.userId,
      connectorSlug: query.connectorSlug,
      selection: { kind: "exact", connectorId: params.connectionId },
    }),
  );
  return diff
    ? { status: 200 as const, body: diff }
    : notFound("Connector account not found");
});

const renameInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await get(connectorAccountsEnabled$))) {
      return notFound("Resource not found");
    }
    const params = get(pathParamsOf(connectorAccountsContract.rename));
    const body = await get(bodyResultOf(connectorAccountsContract.rename));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const request = {
      orgId: auth.orgId,
      userId: auth.userId,
      target: body.data.target,
      connectionId: params.connectionId,
    };
    const existing = await getConnectorAccount(get(db$), request);
    signal.throwIfAborted();
    if (!existing) {
      return notFound("Connector account not found");
    }
    const writeDb = set(writeDb$);
    const updatedAt = await renameConnectorAccount(writeDb, {
      ...request,
      displayName: body.data.displayName,
    });
    signal.throwIfAborted();
    if (!updatedAt) {
      return notFound("Connector account not found");
    }
    return {
      status: 200 as const,
      body: {
        ...existing,
        displayName: body.data.displayName,
        updatedAt: updatedAt.toISOString(),
      },
    };
  },
);

const setDefaultInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await get(connectorAccountsEnabled$))) {
      return notFound("Resource not found");
    }
    const params = get(pathParamsOf(connectorAccountsContract.setDefault));
    const body = await get(bodyResultOf(connectorAccountsContract.setDefault));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const request = {
      orgId: auth.orgId,
      userId: auth.userId,
      target: body.data.target,
      connectionId: params.connectionId,
    };
    const existing = await getConnectorAccount(get(db$), request);
    signal.throwIfAborted();
    if (!existing) {
      return notFound("Connector account not found");
    }
    const writeDb = set(writeDb$);
    const updatedAt = await commitConnectorRuntimeMutation(
      setDefaultConnectorAccount(writeDb, request, signal),
      (changed) => {
        return changed
          ? {
              db: writeDb,
              scope: { orgId: auth.orgId, userId: auth.userId },
              targets: [body.data.target],
            }
          : undefined;
      },
    );
    signal.throwIfAborted();
    if (!updatedAt) {
      return notFound("Connector account not found");
    }
    if (
      body.data.target.kind === "builtin" &&
      (body.data.target.connectorSlug === "gmail" ||
        body.data.target.connectorSlug === "google-calendar" ||
        body.data.target.connectorSlug === "google-forms" ||
        body.data.target.connectorSlug === "google-meet")
    ) {
      await bestEffort(
        body.data.target.connectorSlug === "gmail"
          ? reconcileGmailWatchesForUser(
              { db: writeDb, orgId: auth.orgId, userId: auth.userId },
              signal,
            )
          : body.data.target.connectorSlug === "google-calendar"
            ? reconcileGoogleCalendarWatchesForUser(
                { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                signal,
              )
            : body.data.target.connectorSlug === "google-forms"
              ? reconcileGoogleFormsWatchesForUser(
                  { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                  signal,
                )
              : reconcileGoogleMeetSubscriptionsForUser(
                  { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                  signal,
                ),
        signal,
      );
    }
    return {
      status: 200 as const,
      body: {
        ...existing,
        isDefault: true,
        updatedAt: updatedAt.toISOString(),
      },
    };
  },
);

const deletionImpactInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(connectorAccountsEnabled$))) {
    return notFound("Resource not found");
  }
  const params = get(pathParamsOf(connectorAccountsContract.deletionImpact));
  const query = get(queryOf(connectorAccountsContract.deletionImpact));
  const request = {
    orgId: auth.orgId,
    userId: auth.userId,
    target: targetFromQuery(query),
    connectionId: params.connectionId,
  };
  if (!(await getConnectorAccount(get(db$), request))) {
    return notFound("Connector account not found");
  }
  const impact = await connectorAccountDeletionImpact(get(db$), request);
  if (!impact) {
    return notFound("Connector account not found");
  }
  return {
    status: 200 as const,
    body: { connectionId: params.connectionId, ...impact },
  };
});

type SingleAccountDisconnectOutcome =
  | "missing"
  | "ambiguous"
  | "managed"
  | "deleted";

function observeSingleAccountDisconnect(args: {
  readonly targetKind: ConnectorAccountTarget["kind"];
  readonly outcome: SingleAccountDisconnectOutcome;
  readonly accountCardinality?: "zero" | "one" | "multiple";
}): void {
  log.debug("Resolved single-account connector disconnect", {
    targetKind: args.targetKind,
    outcome: args.outcome,
    ...(args.accountCardinality
      ? { accountCardinality: args.accountCardinality }
      : {}),
  });
}

const disconnectSingleAccountInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const body = await get(
      bodyResultOf(connectorAccountsContract.disconnectSingleAccount),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    if (body.data.target.kind === "builtin") {
      const result = await set(
        deleteConnectorLocalState$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          connectorSlug: body.data.target.connectorSlug,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result === "deleted") {
        observeSingleAccountDisconnect({
          targetKind: "builtin",
          outcome: "deleted",
          accountCardinality: "one",
        });
        return { status: 204 as const, body: undefined };
      }
      if (result === "missing") {
        observeSingleAccountDisconnect({
          targetKind: "builtin",
          outcome: "missing",
          accountCardinality: "zero",
        });
        return notFound("Connector account not found");
      }
      if (result === "ambiguous") {
        observeSingleAccountDisconnect({
          targetKind: "builtin",
          outcome: "ambiguous",
          accountCardinality: "multiple",
        });
        return conflict("Multiple connector accounts require an exact choice");
      }
      throw new Error(
        "Single-account built-in deletion returned an exact-account result",
      );
    }

    const result = await set(
      disconnectCustomConnector$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        connectorId: body.data.target.customConnectorId,
        requireAccount: true,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result === "deleted") {
      observeSingleAccountDisconnect({
        targetKind: "custom",
        outcome: "deleted",
        accountCardinality: "one",
      });
      return { status: 204 as const, body: undefined };
    }
    if (result === "missing-account") {
      observeSingleAccountDisconnect({
        targetKind: "custom",
        outcome: "missing",
        accountCardinality: "zero",
      });
      return notFound("Connector account not found");
    }
    if (result === "missing-definition") {
      observeSingleAccountDisconnect({
        targetKind: "custom",
        outcome: "missing",
      });
      return notFound("Connector target not found");
    }
    if (result === "ambiguous") {
      observeSingleAccountDisconnect({
        targetKind: "custom",
        outcome: "ambiguous",
        accountCardinality: "multiple",
      });
      return conflict("Multiple connector accounts require an exact choice");
    }
    observeSingleAccountDisconnect({
      targetKind: "custom",
      outcome: "managed",
    });
    return integrationManagedCustomConnectorMutationForbidden();
  },
);

const deleteInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await get(connectorAccountsEnabled$))) {
      return notFound("Resource not found");
    }
    const params = get(pathParamsOf(connectorAccountsContract.delete));
    const body = await get(bodyResultOf(connectorAccountsContract.delete));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const request = {
      orgId: auth.orgId,
      userId: auth.userId,
      target: body.data.target,
      connectionId: params.connectionId,
    };
    if (!(await getConnectorAccount(get(db$), request))) {
      return notFound("Connector account not found");
    }
    const result =
      body.data.target.kind === "builtin"
        ? await set(
            deleteConnectorLocalState$,
            {
              orgId: auth.orgId,
              userId: auth.userId,
              connectorSlug: body.data.target.connectorSlug,
              sourceId: params.connectionId,
            },
            signal,
          )
        : await set(
            deleteCustomConnectorAccount$,
            {
              orgId: auth.orgId,
              userId: auth.userId,
              connectorId: body.data.target.customConnectorId,
              memberConnectorId: params.connectionId,
            },
            signal,
          );
    signal.throwIfAborted();
    if (typeof result === "string") {
      if (result === "missing") {
        return notFound("Connector account not found");
      }
      if (result === "ambiguous") {
        return conflict("Multiple connector accounts require an exact choice");
      }
      throw new Error("Exact connector account deletion returned no result");
    }
    if (result.kind === "missing" || result.kind === "managed") {
      return notFound("Connector account not found");
    }
    return {
      status: 200 as const,
      body: {
        deletedConnectionId: params.connectionId,
        resolvedSelectionCount: result.resolvedSelectionCount,
        promotedDefaultConnectionId: result.promotedDefaultConnectionId,
      },
    };
  },
);

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const writeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:write",
} as const;

export const connectorAccountRoutes: readonly RouteEntry[] = [
  {
    route: connectorAccountsContract.inspect,
    handler: authRoute(readAuth, inspectInner$),
  },
  {
    route: connectorAccountsContract.summaries,
    handler: authRoute(readAuth, summariesInner$),
  },
  {
    route: connectorAccountsContract.connections,
    handler: authRoute(readAuth, connectionsInner$),
  },
  {
    route: connectorAccountsContract.scopeDiff,
    handler: authRoute(readAuth, scopeDiffInner$),
  },
  {
    route: connectorAccountsContract.connection,
    handler: authRoute(readAuth, connectionInner$),
  },
  {
    route: connectorAccountsContract.rename,
    handler: authRoute(writeAuth, renameInner$),
  },
  {
    route: connectorAccountsContract.setDefault,
    handler: authRoute(writeAuth, setDefaultInner$),
  },
  {
    route: connectorAccountsContract.deletionImpact,
    handler: authRoute(readAuth, deletionImpactInner$),
  },
  {
    route: connectorAccountsContract.disconnectSingleAccount,
    handler: authRoute(writeAuth, disconnectSingleAccountInner$),
  },
  {
    route: connectorAccountsContract.delete,
    handler: authRoute(writeAuth, deleteInner$),
  },
];
