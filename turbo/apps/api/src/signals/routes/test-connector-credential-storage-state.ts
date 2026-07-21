import { command } from "ccstate";
import {
  testConnectorCredentialStorageStateContract,
  type TestConnectorCredentialStorageStateActionBody,
} from "@vm0/api-contracts/contracts/test-connector-credential-storage-state";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq, inArray } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(
  testConnectorCredentialStorageStateContract.action,
);

/**
 * This route is explicitly mounted only by tests. Connector owner/version
 * metadata has no production API, and cross-owner states cannot be constructed
 * through one. Keeping that exception here lets route tests exercise the real
 * public behavior without registering a production diagnostics surface.
 */
type ConnectorCredentialStorageAction<
  TAction extends TestConnectorCredentialStorageStateActionBody["action"],
> = Extract<TestConnectorCredentialStorageStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function requiredConnectorCredentialOwnerId(
  connectorId: string | null,
): string {
  if (connectorId === null) {
    throw new Error("Connector credential is missing its owner");
  }
  return connectorId;
}

async function readState(
  db: Db,
  body: ConnectorCredentialStorageAction<"read">,
  signal: AbortSignal,
) {
  const [connector] = await db
    .select({
      id: connectors.id,
      storageVersion: connectors.storageVersion,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
        eq(connectors.type, body.connector_ref),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  const secretRows =
    body.secret_names.length === 0
      ? []
      : await db
          .select({
            name: secrets.name,
            connectorId: secrets.connectorId,
            encryptedValue: secrets.encryptedValue,
            description: secrets.description,
          })
          .from(secrets)
          .where(
            and(
              eq(secrets.orgId, body.org_id),
              eq(secrets.userId, body.user_id),
              eq(secrets.type, "connector"),
              inArray(secrets.name, body.secret_names),
            ),
          );
  signal.throwIfAborted();
  const variableRows =
    body.variable_names.length === 0
      ? []
      : await db
          .select({
            name: variables.name,
            connectorId: variables.connectorId,
          })
          .from(variables)
          .where(
            and(
              eq(variables.orgId, body.org_id),
              eq(variables.userId, body.user_id),
              eq(variables.type, "connector"),
              inArray(variables.name, body.variable_names),
            ),
          );
  signal.throwIfAborted();
  return actionOk({
    connector: connector
      ? {
          id: connector.id,
          storage_version: connector.storageVersion,
        }
      : null,
    secrets: secretRows.map((row) => {
      return {
        name: row.name,
        connector_id: requiredConnectorCredentialOwnerId(row.connectorId),
        encrypted_value: row.encryptedValue,
        description: row.description,
      };
    }),
    variables: variableRows.map((row) => {
      return {
        name: row.name,
        connector_id: requiredConnectorCredentialOwnerId(row.connectorId),
      };
    }),
  });
}

async function seedOwnedSecret(
  db: Db,
  body: ConnectorCredentialStorageAction<"seed-owned-secret">,
  signal: AbortSignal,
) {
  const connectorId = await db.transaction(async (tx) => {
    const [connector] = await tx
      .insert(connectors)
      .values({
        orgId: body.org_id,
        userId: body.user_id,
        type: body.connector_ref,
        authMethod: body.auth_method,
        storageVersion: body.storage_version,
      })
      .returning({ id: connectors.id });
    if (!connector) {
      throw new Error("Expected connector storage test fixture");
    }
    await tx.insert(secrets).values({
      connectorId: connector.id,
      orgId: body.org_id,
      userId: body.user_id,
      name: body.name,
      encryptedValue: body.encrypted_value,
      description: body.description,
      type: "connector",
    });
    return connector.id;
  });
  signal.throwIfAborted();
  return actionOk({ connector_id: connectorId });
}

async function seedConnector(
  db: Db,
  body: ConnectorCredentialStorageAction<"seed-connector">,
  signal: AbortSignal,
) {
  const [connector] = await db
    .insert(connectors)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      type: body.connector_ref,
      authMethod: body.auth_method,
      storageVersion: body.storage_version,
    })
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  if (!connector) {
    throw new Error("Expected connector storage test fixture");
  }
  return actionOk({ connector_id: connector.id });
}

async function setConnectorState(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-connector-state">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(connectors)
    .set({
      storageVersion: body.storage_version,
      ...(body.token_expires_at === undefined
        ? {}
        : {
            tokenExpiresAt:
              body.token_expires_at === null
                ? null
                : new Date(body.token_expires_at),
          }),
    })
    .where(
      and(
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
        eq(connectors.type, body.connector_ref),
      ),
    )
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return updated
    ? actionOk({ connector_id: updated.id })
    : {
        status: 400 as const,
        body: { error: "Connector storage test fixture was not found" },
      };
}

async function setSecretOwner(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-secret-owner">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(secrets)
    .set({ connectorId: body.connector_id })
    .where(
      and(
        eq(secrets.orgId, body.org_id),
        eq(secrets.userId, body.user_id),
        eq(secrets.name, body.name),
        eq(secrets.type, "connector"),
      ),
    )
    .returning({ id: secrets.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Connector secret test fixture was not found" },
      };
}

async function setVariableOwner(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-variable-owner">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(variables)
    .set({ connectorId: body.connector_id })
    .where(
      and(
        eq(variables.orgId, body.org_id),
        eq(variables.userId, body.user_id),
        eq(variables.name, body.name),
        eq(variables.type, "connector"),
      ),
    )
    .returning({ id: variables.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Connector variable test fixture was not found" },
      };
}

const mutateConnectorCredentialStorageState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "read": {
        return await readState(db, body, signal);
      }
      case "seed-owned-secret": {
        return await seedOwnedSecret(db, body, signal);
      }
      case "seed-connector": {
        return await seedConnector(db, body, signal);
      }
      case "set-connector-state": {
        return await setConnectorState(db, body, signal);
      }
      case "set-secret-owner": {
        return await setSecretOwner(db, body, signal);
      }
      case "set-variable-owner": {
        return await setVariableOwner(db, body, signal);
      }
    }
  },
);

export const testConnectorCredentialStorageStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testConnectorCredentialStorageStateContract.action,
      handler: mutateConnectorCredentialStorageState$,
    },
  ];
