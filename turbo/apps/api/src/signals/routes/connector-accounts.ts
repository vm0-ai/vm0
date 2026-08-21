import { command, computed } from "ccstate";
import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
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
import { deleteCustomConnectorAccount$ } from "../services/custom-connector.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";

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
      throw new Error("Exact connector account deletion returned no result");
    }
    if (result.kind === "missing" || result.kind === "managed") {
      return notFound("Connector account not found");
    }
    if (result.kind === "invalid-replacement") {
      return conflict("Replacement connector account is not available");
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
    route: connectorAccountsContract.delete,
    handler: authRoute(writeAuth, deleteInner$),
  },
];
