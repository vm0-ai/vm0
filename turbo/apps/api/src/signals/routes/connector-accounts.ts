import { command, computed } from "ccstate";
import {
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
import {
  connectorAccountDeletionImpact,
  getConnectorAccount,
  listConnectorAccountsForTarget,
  listConnectorAccountSummaries,
  renameConnectorAccount,
  setDefaultConnectorAccount,
} from "../services/connector-account-lifecycle.service";
import { commitConnectorRuntimeMutation } from "../services/connector-runtime-wakeup.service";
import { deleteConnectorLocalState$ } from "../services/connector-data.service";
import {
  deleteCustomConnectorAccount$,
  disconnectCustomConnector$,
  integrationManagedCustomConnectorMutationForbidden,
} from "../services/custom-connector.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";

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
      setDefaultConnectorAccount(writeDb, request),
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
  | "referenced"
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
          selectionResolution: { kind: "reject" },
        },
        signal,
      );
      signal.throwIfAborted();
      if (typeof result !== "string") {
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
      if (result === "referenced") {
        observeSingleAccountDisconnect({
          targetKind: "builtin",
          outcome: "referenced",
          accountCardinality: "one",
        });
        return conflict("Connector account is selected by chat threads");
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
        selectionResolution: { kind: "reject" },
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
    if (result === "referenced") {
      observeSingleAccountDisconnect({
        targetKind: "custom",
        outcome: "referenced",
        accountCardinality: "one",
      });
      return conflict("Connector account is selected by chat threads");
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
              selectionResolution: body.data.selectionResolution,
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
              selectionResolution: body.data.selectionResolution,
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
      if (result === "invalid-replacement") {
        return conflict("Replacement connector account is not available");
      }
      if (result === "referenced") {
        return conflict("Connector account is selected by chat threads");
      }
      throw new Error("Exact connector account deletion returned no result");
    }
    if (result.kind === "missing" || result.kind === "managed") {
      return notFound("Connector account not found");
    }
    if (result.kind === "invalid-replacement") {
      return conflict("Replacement connector account is not available");
    }
    if (result.kind === "referenced") {
      return conflict("Connector account is selected by chat threads");
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
    route: connectorAccountsContract.summaries,
    handler: authRoute(readAuth, summariesInner$),
  },
  {
    route: connectorAccountsContract.connections,
    handler: authRoute(readAuth, connectionsInner$),
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
