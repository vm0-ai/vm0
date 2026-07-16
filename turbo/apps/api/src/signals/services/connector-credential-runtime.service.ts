import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { refreshConnectorAuthProviderAccessTokenWithMethod } from "@vm0/connectors/auth-providers";
import { resolveConnectorAuthClient } from "@vm0/connectors/connector-utils";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { settleIncludingAbort } from "../utils";
import { lockConnectorState } from "./auth-state-lock.service";
import {
  getConnectorRuntimeMethod,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";

const log = logger("api:connector-credential-runtime");
const oauthScopesSchema = z.array(z.string());

export interface ConnectorCredentialConnection {
  readonly connectorId: string;
  readonly connectorRef: string;
  readonly externalEmail: string | null;
  readonly externalId: string | null;
  readonly needsReconnect: boolean;
  readonly oauthScopes: readonly string[] | null;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly tokenExpiresAt: Date | null;
}

type ConnectorCredentialConnectionResult =
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ok";
      readonly connection: ConnectorCredentialConnection;
    };

interface ConnectorStoredValueRef {
  readonly kind: "secret" | "variable";
  readonly name: string;
  readonly valueRef: string;
}

type ConnectorCredentialRefreshResult =
  | {
      readonly kind: "ok";
      readonly accessToken: string;
      readonly tokenExpiresAt: Date | null;
    }
  | {
      readonly kind:
        | "configuration-unavailable"
        | "invalid-output"
        | "missing-input"
        | "not-refreshable"
        | "provider-failed";
    };

function parseOauthScopes(value: string | null): readonly string[] | null {
  return value === null ? null : oauthScopesSchema.parse(JSON.parse(value));
}

function connectorStoredValueRef(valueRef: string): ConnectorStoredValueRef {
  if (valueRef.startsWith("$secrets.")) {
    return {
      kind: "secret",
      name: valueRef.slice("$secrets.".length),
      valueRef,
    };
  }
  if (valueRef.startsWith("$vars.")) {
    return {
      kind: "variable",
      name: valueRef.slice("$vars.".length),
      valueRef,
    };
  }
  throw new Error("Invalid connector stored value reference");
}

export async function loadConnectorCredentialConnection(args: {
  readonly connectorId?: string;
  readonly connectorRef: string;
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly userId: string;
}): Promise<ConnectorCredentialConnectionResult> {
  const conditions = [
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.type, args.connectorRef),
  ];
  if (args.connectorId !== undefined) {
    conditions.push(eq(connectors.id, args.connectorId));
  }
  const [row] = await args.db
    .select({
      authMethod: connectors.authMethod,
      connectorId: connectors.id,
      externalEmail: connectors.externalEmail,
      externalId: connectors.externalId,
      needsReconnect: connectors.needsReconnect,
      oauthScopes: connectors.oauthScopes,
      tokenExpiresAt: connectors.tokenExpiresAt,
    })
    .from(connectors)
    .where(and(...conditions))
    .limit(1);
  if (!row) {
    return { kind: "missing" };
  }
  const runtimeMethod = getConnectorRuntimeMethod({
    snapshot: args.snapshot,
    connectorRef: args.connectorRef,
    authMethodId: row.authMethod,
    requireExecutable: true,
  });
  if (!runtimeMethod) {
    return { kind: "unavailable" };
  }
  return {
    kind: "ok",
    connection: {
      connectorId: row.connectorId,
      connectorRef: args.connectorRef,
      externalEmail: row.externalEmail,
      externalId: row.externalId,
      needsReconnect: row.needsReconnect,
      oauthScopes: parseOauthScopes(row.oauthScopes),
      runtimeMethod,
      tokenExpiresAt: row.tokenExpiresAt,
    },
  };
}

export function connectorCredentialRuntimeValueRef(
  connection: ConnectorCredentialConnection,
  environmentName: string,
): string | null {
  const access = connection.runtimeMethod.method.access;
  if (access.kind === "none") {
    return null;
  }
  const binding = access.envBindings[environmentName];
  if (binding === undefined) {
    return null;
  }
  return typeof binding === "string" ? binding : binding.valueRef;
}

export async function loadConnectorCredentialValues(args: {
  readonly db: ReadonlyDb;
  readonly featureSwitchContext?: FeatureSwitchContext;
  readonly orgId: string;
  readonly userId: string;
  readonly valueRefs: readonly string[];
}): Promise<ReadonlyMap<string, string>> {
  const refs = args.valueRefs.map(connectorStoredValueRef);
  const secretNames = refs.flatMap((ref) => {
    return ref.kind === "secret" ? [ref.name] : [];
  });
  const variableNames = refs.flatMap((ref) => {
    return ref.kind === "variable" ? [ref.name] : [];
  });
  const secretRows =
    secretNames.length === 0
      ? []
      : await args.db
          .select({
            name: secrets.name,
            encryptedValue: secrets.encryptedValue,
          })
          .from(secrets)
          .where(
            and(
              eq(secrets.orgId, args.orgId),
              eq(secrets.userId, args.userId),
              eq(secrets.type, "connector"),
              inArray(secrets.name, secretNames),
            ),
          );
  const variableRows =
    variableNames.length === 0
      ? []
      : await args.db
          .select({ name: variables.name, value: variables.value })
          .from(variables)
          .where(
            and(
              eq(variables.orgId, args.orgId),
              eq(variables.userId, args.userId),
              eq(variables.type, "connector"),
              inArray(variables.name, variableNames),
            ),
          );
  const values = new Map<string, string>();
  for (const row of secretRows) {
    values.set(
      `$secrets.${row.name}`,
      await decryptStoredSecretValue(
        row.encryptedValue,
        args.featureSwitchContext,
      ),
    );
  }
  for (const row of variableRows) {
    values.set(`$vars.${row.name}`, row.value);
  }
  return values;
}

async function upsertConnectorSecret(args: {
  readonly db: Db;
  readonly name: string;
  readonly orgId: string;
  readonly userId: string;
  readonly value: string;
}): Promise<void> {
  const encryptedValue = await encryptStoredSecretValue(args.value);
  await args.db
    .insert(secrets)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      encryptedValue,
      description: null,
      type: "connector",
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue,
        description: null,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

async function upsertConnectorVariable(args: {
  readonly db: Db;
  readonly name: string;
  readonly orgId: string;
  readonly userId: string;
  readonly value: string;
}): Promise<void> {
  await args.db
    .insert(variables)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      value: args.value,
      description: null,
      type: "connector",
    })
    .onConflictDoUpdate({
      target: [
        variables.orgId,
        variables.userId,
        variables.name,
        variables.type,
      ],
      set: {
        value: args.value,
        description: null,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

function refreshTokenExpiresAt(
  expiresIn: number | undefined,
  defaultExpiresInMs: number | undefined,
): Date | null {
  if (expiresIn !== undefined) {
    return new Date(nowDate().getTime() + expiresIn * 1000);
  }
  return defaultExpiresInMs === undefined
    ? null
    : new Date(nowDate().getTime() + defaultExpiresInMs);
}

async function persistConnectorRefresh(args: {
  readonly connection: ConnectorCredentialConnection;
  readonly db: Db;
  readonly defaultExpiresInMs?: number;
  readonly orgId: string;
  readonly outputs: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly userId: string;
  readonly expiresIn: number | undefined;
}): Promise<Date | null> {
  const access = args.connection.runtimeMethod.method.access;
  if (access.kind !== "refresh-token") {
    throw new Error("Connector credential is not refreshable");
  }
  const tokenExpiresAt = refreshTokenExpiresAt(
    args.expiresIn,
    args.defaultExpiresInMs,
  );
  await args.db.transaction(async (tx) => {
    await lockConnectorState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      type: args.connection.connectorRef,
    });
    args.signal.throwIfAborted();
    for (const [outputName, value] of Object.entries(args.outputs)) {
      if (value === undefined) {
        continue;
      }
      const valueRef = access.outputs[outputName];
      if (valueRef === undefined) {
        throw new Error("Connector refresh returned an undeclared output");
      }
      const target = connectorStoredValueRef(valueRef);
      if (target.kind === "secret") {
        await upsertConnectorSecret({
          db: tx,
          name: target.name,
          orgId: args.orgId,
          userId: args.userId,
          value,
        });
      } else {
        await upsertConnectorVariable({
          db: tx,
          name: target.name,
          orgId: args.orgId,
          userId: args.userId,
          value,
        });
      }
      args.signal.throwIfAborted();
    }
    await tx
      .update(connectors)
      .set({
        tokenExpiresAt,
        needsReconnect: false,
        reconnectReason: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(connectors.id, args.connection.connectorId));
  });
  args.signal.throwIfAborted();
  return tokenExpiresAt;
}

export async function refreshConnectorCredentialAccess(args: {
  readonly connection: ConnectorCredentialConnection;
  readonly db: ReadonlyDb;
  readonly featureSwitchContext?: FeatureSwitchContext;
  readonly orgId: string;
  readonly persist?: {
    readonly db: Db;
    readonly defaultExpiresInMs?: number;
  };
  readonly runtimeEnvironmentName: string;
  readonly signal: AbortSignal;
  readonly userId: string;
}): Promise<ConnectorCredentialRefreshResult> {
  const access = args.connection.runtimeMethod.method.access;
  if (access.kind !== "refresh-token") {
    return { kind: "not-refreshable" };
  }
  const authClient = args.connection.runtimeMethod.method.client
    ? resolveConnectorAuthClient(
        args.connection.runtimeMethod.method.client,
        optionalEnv,
      )
    : undefined;
  if (args.connection.runtimeMethod.method.client && !authClient) {
    return { kind: "configuration-unavailable" };
  }
  const inputValues = await loadConnectorCredentialValues({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    valueRefs: Object.values(access.inputs),
    ...(args.featureSwitchContext === undefined
      ? {}
      : { featureSwitchContext: args.featureSwitchContext }),
  });
  const inputs: Record<string, string> = {};
  for (const [inputName, valueRef] of Object.entries(access.inputs)) {
    const value = inputValues.get(valueRef);
    if (value === undefined) {
      return { kind: "missing-input" };
    }
    inputs[inputName] = value;
  }
  const refreshed = await settleIncludingAbort(
    refreshConnectorAuthProviderAccessTokenWithMethod({
      connectorRef: args.connection.runtimeMethod.connectorRef,
      authMethodId: args.connection.runtimeMethod.authMethodId,
      method: args.connection.runtimeMethod.method,
      ...(authClient === undefined ? {} : { authClient }),
      inputs,
      signal: args.signal,
    }),
  );
  args.signal.throwIfAborted();
  if (!refreshed.ok) {
    log.warn("Connector credential refresh failed", {
      connectorRef: args.connection.connectorRef,
      authMethodId: args.connection.runtimeMethod.authMethodId,
      error: refreshed.error,
    });
    return { kind: "provider-failed" };
  }
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
    args.connection,
    args.runtimeEnvironmentName,
  );
  if (accessTokenValueRef === null) {
    return { kind: "invalid-output" };
  }
  const accessTokenOutput = Object.entries(access.outputs).find(
    ([, valueRef]) => {
      return valueRef === accessTokenValueRef;
    },
  );
  const accessToken = accessTokenOutput
    ? refreshed.value.outputs[accessTokenOutput[0]]
    : undefined;
  if (accessToken === undefined) {
    return { kind: "invalid-output" };
  }
  const tokenExpiresAt = args.persist
    ? await persistConnectorRefresh({
        connection: args.connection,
        db: args.persist.db,
        orgId: args.orgId,
        outputs: refreshed.value.outputs,
        signal: args.signal,
        userId: args.userId,
        expiresIn: refreshed.value.expiresIn,
        ...(args.persist.defaultExpiresInMs === undefined
          ? {}
          : { defaultExpiresInMs: args.persist.defaultExpiresInMs }),
      })
    : refreshTokenExpiresAt(refreshed.value.expiresIn, undefined);
  return { kind: "ok", accessToken, tokenExpiresAt };
}

export async function markConnectorCredentialNeedsReconnect(args: {
  readonly connectorId: string;
  readonly db: Db;
  readonly signal: AbortSignal;
}): Promise<void> {
  await args.db
    .update(connectors)
    .set({ needsReconnect: true, updatedAt: sql`clock_timestamp()` })
    .where(eq(connectors.id, args.connectorId));
  args.signal.throwIfAborted();
}
