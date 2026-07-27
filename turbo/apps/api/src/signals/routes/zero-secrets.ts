import { command, computed } from "ccstate";
import {
  zeroSecretsContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import type { SecretListResponse } from "@vm0/api-contracts/contracts/secrets";
import { connectors } from "@vm0/db/schema/connector";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  setUserSecret$,
  setUserVariable$,
  userSecrets,
  userVariables,
} from "../services/zero-user-data.service";
import {
  getConnectorRuntimeStoredSecretDisplayInfo,
  loadConnectorRuntimeSnapshot,
} from "../services/connector-catalog-runtime.service";
import {
  connectorCredentialStoredSecretDisplayInfo,
  resolveConnectorCredentialAccess,
} from "../services/connector-credential-access.service";
import { zeroSecretsDeleteRoutes } from "./zero-secrets-delete";
import { zeroVariablesDeleteRoutes } from "./zero-variables-delete";

const setSecretBody$ = bodyResultOf(zeroSecretsContract.set);

const listSecretsInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  const [storedSecrets, snapshot, connectorRows] = await Promise.all([
    get(userSecrets({ orgId: auth.orgId, userId: auth.userId })),
    loadConnectorRuntimeSnapshot(db),
    db
      .select({
        authMethod: connectors.authMethod,
        connectorId: connectors.id,
        connectorRef: connectors.type,
        storageVersion: connectors.storageVersion,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, auth.orgId),
          eq(connectors.userId, auth.userId),
        ),
      ),
  ]);
  const connectorAccesses = connectorRows.flatMap((row) => {
    const result = resolveConnectorCredentialAccess({
      snapshot,
      stored: {
        authMethodId: row.authMethod,
        connectorId: row.connectorId,
        connectorRef: row.connectorRef,
        orgId: auth.orgId,
        storageVersion: row.storageVersion,
        userId: auth.userId,
      },
    });
    return result.kind === "ok" ? [result.access] : [];
  });
  const connectorAccessById = new Map(
    connectorAccesses.map((access) => {
      return [access.connectorId, access] as const;
    }),
  );

  function connectorDisplay(
    secretId: string,
    secretName: string,
  ): ReturnType<typeof connectorCredentialStoredSecretDisplayInfo> {
    const connectorId =
      storedSecrets.connectorOwnerBySecretId.get(secretId) ?? null;
    if (connectorId !== null) {
      const access = connectorAccessById.get(connectorId);
      return access === undefined
        ? null
        : connectorCredentialStoredSecretDisplayInfo({
            access,
            name: secretName,
            snapshot,
          });
    }
    return null;
  }

  const body: SecretListResponse = {
    secrets: storedSecrets.secrets.map((secret) => {
      const display =
        secret.type === "connector"
          ? connectorDisplay(secret.id, secret.name)
          : secret.type === "user"
            ? getConnectorRuntimeStoredSecretDisplayInfo(snapshot, secret.name)
            : null;
      return {
        ...secret,
        connectorDisplay: display
          ? {
              label: display.label,
              environmentNames: [...display.environmentNames],
            }
          : null,
      };
    }),
  };
  return {
    status: 200 as const,
    body,
  };
});

const setSecretInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const body = await get(setSecretBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const secret = await set(
      setUserSecret$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        secret: body.data,
      },
      signal,
    );

    return {
      status: 200 as const,
      body: secret,
    };
  },
);

const listVariablesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    userVariables({ orgId: auth.orgId, userId: auth.userId }),
  );
  return {
    status: 200 as const,
    body,
  };
});

const setVariableBody$ = bodyResultOf(zeroVariablesContract.set);

const setVariableInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(setVariableBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const variable = await set(
      setUserVariable$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        variable: bodyResult.data,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: variable,
    };
  },
);

export const zeroSecretsRoutes: readonly RouteEntry[] = [
  {
    route: zeroSecretsContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listSecretsInner$,
    ),
  },
  {
    route: zeroSecretsContract.set,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setSecretInner$,
    ),
  },
  {
    route: zeroVariablesContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listVariablesInner$,
    ),
  },
  {
    route: zeroVariablesContract.set,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setVariableInner$,
    ),
  },
  ...zeroSecretsDeleteRoutes,
  ...zeroVariablesDeleteRoutes,
];
