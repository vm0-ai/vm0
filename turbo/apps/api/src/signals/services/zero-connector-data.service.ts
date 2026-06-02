import { command, computed, type Computed } from "ccstate";
import type {
  ConnectorListResponse,
  ConnectorResponse,
  ScopeDiffResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import type { ConnectorSearchAuthMethod } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  connectorAuthMethodSupportsTokenRevoke,
  getAvailableConnectorAuthMethods,
  getConnectorAuthMethodAccessMetadata,
  getConnectorAuthMethodScopeDiff,
  getConnectorAuthMethod,
  getConnectorManualGrantFieldNamesForAuthMethod,
  getConnectorOwnedAccessSecretBindingEntries,
  getConnectorOwnedSecretNames,
  getConnectorVariableNames,
  getRuntimeAvailableConnectorTypes,
  type ConnectorAuthMethodAccessMetadata,
  type ManualGrantFieldNames,
} from "@vm0/connectors/connector-utils";
import { revokeConnectorAuthMethodAccessToken } from "@vm0/connectors/auth-providers";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorAuthMethodId,
  type ConnectorManualGrantFieldConfig,
  type ConnectorType,
  type ConnectorAuthProviderType,
  type TokenRevokeConnectorType,
} from "@vm0/connectors/connectors";
import {
  getAllFeatureStates,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { bestEffort } from "../utils";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { lockConnectorState } from "./auth-state-lock.service";
import {
  userFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";

type StoredConnectorRow = {
  readonly id: string;
  readonly authMethod: ConnectorResponse["authMethod"];
  readonly externalId: string | null;
  readonly externalUsername: string | null;
  readonly externalEmail: string | null;
  readonly oauthScopes: string | null;
  readonly needsReconnect: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

interface ConnectorScopedSecretNames {
  readonly secretNames: ReadonlySet<string>;
}

const oauthScopesSchema = z.array(z.string());
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS = 15 * 60;
type FeatureStates = ReturnType<typeof getAllFeatureStates>;

interface ExternalUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

interface PreparedManualGrantField {
  readonly name: string;
  readonly value: string;
}

interface ConnectorTokenSecretMetadata {
  readonly accessSecretName: string;
  readonly refreshSecretName: string | undefined;
  readonly isRefreshable: boolean;
}

interface PreparedManualGrantConnect {
  readonly secretValues: readonly PreparedManualGrantField[];
  readonly variableValues: readonly PreparedManualGrantField[];
  readonly configuredSecretNames: readonly string[];
  readonly configuredVariableNames: readonly string[];
}

type PreparedManualGrantConnectResult =
  | { readonly ok: true; readonly prepared: PreparedManualGrantConnect }
  | { readonly ok: false; readonly message: string };

type ConnectManualGrantConnectorResult =
  | { readonly status: "connected"; readonly connector: ConnectorResponse }
  | { readonly status: "invalid"; readonly message: string };

interface EncryptedManualGrantSecret {
  readonly name: string;
  readonly encryptedValue: string;
}

interface OmittedManualGrantFieldNames {
  readonly omittedSecretNames: readonly string[];
  readonly omittedVariableNames: readonly string[];
}

interface EncryptedConnectorTokenSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly description: string;
}

interface PendingConnectorTokenRevoke {
  readonly type: TokenRevokeConnectorType;
  readonly authMethod: string;
  readonly encryptedAccessToken: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}

function parseOauthScopes(value: string | null): string[] | null {
  return value ? oauthScopesSchema.parse(JSON.parse(value)) : null;
}

function storedConnectorRowToResponse(
  row: StoredConnectorRow,
  type: ConnectorType,
): ConnectorResponse {
  return {
    id: row.id,
    type,
    authMethod: row.authMethod,
    externalId: row.externalId,
    externalUsername: row.externalUsername,
    externalEmail: row.externalEmail,
    oauthScopes: parseOauthScopes(row.oauthScopes),
    needsReconnect: row.needsReconnect,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function storedConnectorTypeIsVisible(
  type: ConnectorType,
  featureStates: FeatureStates,
): boolean {
  return (
    getAvailableConnectorAuthMethods(type, featureStates, {
      apiAuthMethodPolicy: "include",
    }).length > 0
  );
}

function manualGrantFieldsForAuthMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): Record<string, ConnectorManualGrantFieldConfig> | null {
  const method = getConnectorAuthMethod(type, authMethod);
  return method?.grant.kind === "manual" ? method.grant.fields : null;
}

function sanitizeManualGrantValue(value: string): string {
  return value.replace(/\s+/gu, "");
}

function formatManualGrantFieldList(names: readonly string[]): string {
  return [...names].sort().join(", ");
}

function throwCapturedAbort(error: unknown): void {
  if (error !== null) {
    throw error;
  }
}

async function finalizeConnectorStateChangeAfterCommit(args: {
  readonly userId: string;
  readonly pendingTokenRevoke: PendingConnectorTokenRevoke | null;
  readonly signal: AbortSignal;
  readonly postCommitAbort: unknown;
}): Promise<void> {
  let postCommitAbort = args.postCommitAbort;
  if (args.pendingTokenRevoke) {
    await revokePendingConnectorToken({ pending: args.pendingTokenRevoke });
    if (args.signal.aborted) {
      postCommitAbort ??= args.signal.reason;
    }
  }

  await publishUserSignal([args.userId], "connector:changed");
  if (args.signal.aborted) {
    postCommitAbort ??= args.signal.reason;
  }
  throwCapturedAbort(postCommitAbort);
}

function prepareManualGrantConnect(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
  values: Readonly<Record<string, string>>,
): PreparedManualGrantConnectResult {
  const fields = manualGrantFieldsForAuthMethod(type, authMethod);
  if (!fields) {
    return {
      ok: false,
      message: `${type} ${authMethod} auth method does not use a manual grant`,
    };
  }

  const configuredFieldNames = new Set(Object.keys(fields));
  const unknownFieldNames = Object.keys(values).filter((name) => {
    return !configuredFieldNames.has(name);
  });
  if (unknownFieldNames.length > 0) {
    return {
      ok: false,
      message: `Unknown manual grant field(s): ${formatManualGrantFieldList(
        unknownFieldNames,
      )}`,
    };
  }

  const sanitizedValues = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    sanitizedValues.set(name, sanitizeManualGrantValue(value));
  }

  const secretValues: PreparedManualGrantField[] = [];
  const variableValues: PreparedManualGrantField[] = [];
  const configuredSecretNames: string[] = [];
  const configuredVariableNames: string[] = [];
  const missingRequiredNames: string[] = [];

  for (const [name, config] of Object.entries(fields)) {
    const storage = config.storage ?? "secret";
    if (storage === "variable") {
      configuredVariableNames.push(name);
    } else {
      configuredSecretNames.push(name);
    }

    const value = sanitizedValues.get(name) ?? "";
    if (!value) {
      if (config.required) {
        missingRequiredNames.push(name);
      }
      continue;
    }

    const target = storage === "variable" ? variableValues : secretValues;
    target.push({ name, value });
  }

  if (missingRequiredNames.length > 0) {
    return {
      ok: false,
      message: `Missing required manual grant field(s): ${formatManualGrantFieldList(
        missingRequiredNames,
      )}`,
    };
  }

  return {
    ok: true,
    prepared: {
      secretValues,
      variableValues,
      configuredSecretNames,
      configuredVariableNames,
    },
  };
}

async function encryptManualGrantSecrets(args: {
  readonly secretValues: readonly PreparedManualGrantField[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<readonly EncryptedManualGrantSecret[]> {
  const encryptedSecrets: EncryptedManualGrantSecret[] = [];
  for (const field of args.secretValues) {
    encryptedSecrets.push({
      name: field.name,
      encryptedValue: await encryptStoredSecretValue(
        field.value,
        args.featureSwitchContext,
      ),
    });
    args.signal.throwIfAborted();
  }
  return encryptedSecrets;
}

function omittedManualGrantFieldNames(
  prepared: PreparedManualGrantConnect,
): OmittedManualGrantFieldNames {
  const submittedSecretNames = new Set(
    prepared.secretValues.map((field) => {
      return field.name;
    }),
  );
  const submittedVariableNames = new Set(
    prepared.variableValues.map((field) => {
      return field.name;
    }),
  );
  return {
    omittedSecretNames: prepared.configuredSecretNames.filter((name) => {
      return !submittedSecretNames.has(name);
    }),
    omittedVariableNames: prepared.configuredVariableNames.filter((name) => {
      return !submittedVariableNames.has(name);
    }),
  };
}

export function zeroConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<ConnectorListResponse>> {
  return computed(async (get): Promise<ConnectorListResponse> => {
    const db = get(db$);
    const [storedRows, connectorSecretRows, overrides] = await Promise.all([
      db
        .select({
          id: connectors.id,
          type: connectors.type,
          authMethod: connectors.authMethod,
          externalId: connectors.externalId,
          externalUsername: connectors.externalUsername,
          externalEmail: connectors.externalEmail,
          oauthScopes: connectors.oauthScopes,
          needsReconnect: connectors.needsReconnect,
          createdAt: connectors.createdAt,
          updatedAt: connectors.updatedAt,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
          ),
        ),
      db
        .select({ name: secrets.name })
        .from(secrets)
        .where(
          and(
            eq(secrets.orgId, args.orgId),
            eq(secrets.userId, args.userId),
            eq(secrets.type, "connector"),
          ),
        ),
      get(userFeatureSwitchOverrides(args.orgId, args.userId)),
    ]);
    const featureStates = getAllFeatureStates({
      userId: args.userId,
      orgId: args.orgId,
      overrides,
    });

    const connectorList: ConnectorResponse[] = storedRows.flatMap((row) => {
      const parsed = connectorTypeSchema.safeParse(row.type);
      if (!parsed.success) {
        return [];
      }
      if (!storedConnectorTypeIsVisible(parsed.data, featureStates)) {
        return [];
      }
      return [storedConnectorRowToResponse(row, parsed.data)];
    });
    const connectorScopedSecretNames: ConnectorScopedSecretNames = {
      secretNames: new Set(
        connectorSecretRows.map((row) => {
          return row.name;
        }),
      ),
    };

    return {
      connectors: connectorList,
      configuredTypes: getRuntimeAvailableConnectorTypes((name) => {
        return optionalEnv(name);
      }),
      connectorProvidedEnvNames: [
        ...connectorProvidedEnvNamesForStoredConnectors(
          connectorList,
          connectorScopedSecretNames,
        ),
      ],
    };
  });
}

function connectorProvidedEnvNamesForStoredConnectors(
  connectorList: readonly ConnectorResponse[],
  connectorScopedSecretNames: ConnectorScopedSecretNames,
): Set<string> {
  const provided = new Set<string>();
  for (const connector of connectorList) {
    const accessMetadata = getConnectorAuthMethodAccessMetadata(
      connector.type,
      connector.authMethod,
    );
    if (!accessMetadata) {
      continue;
    }
    for (const {
      envName,
      secretName,
    } of getConnectorOwnedAccessSecretBindingEntries(accessMetadata)) {
      if (!connectorScopedSecretNames.secretNames.has(secretName)) {
        continue;
      }
      provided.add(envName);
    }
  }
  return provided;
}

function storedConnectorByType(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorType;
}): Computed<Promise<ConnectorResponse | null>> {
  return computed(async (get): Promise<ConnectorResponse | null> => {
    const db = get(db$);
    const oauthRows = await db
      .select({
        id: connectors.id,
        type: connectors.type,
        authMethod: connectors.authMethod,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
        oauthScopes: connectors.oauthScopes,
        needsReconnect: connectors.needsReconnect,
        createdAt: connectors.createdAt,
        updatedAt: connectors.updatedAt,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.type, args.type),
        ),
      )
      .limit(1);

    const oauthRow = oauthRows[0];
    if (oauthRow) {
      return storedConnectorRowToResponse(oauthRow, args.type);
    }

    return null;
  });
}

export function zeroConnectorByType(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorType;
  readonly includeHiddenStoredConnector?: boolean;
}): Computed<Promise<ConnectorResponse | null>> {
  return computed(async (get): Promise<ConnectorResponse | null> => {
    const overrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    const featureStates = getAllFeatureStates({
      userId: args.userId,
      orgId: args.orgId,
      overrides,
    });
    const storedConnector = await get(storedConnectorByType(args));
    if (storedConnector) {
      if (
        args.includeHiddenStoredConnector ||
        storedConnectorTypeIsVisible(args.type, featureStates)
      ) {
        return storedConnector;
      }
    }
    return null;
  });
}

async function loadPendingConnectorTokenRevoke(args: {
  readonly db: Db | ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly type: TokenRevokeConnectorType;
  readonly authMethod: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<PendingConnectorTokenRevoke | null> {
  const connectorType = args.type;
  const secretMetadata = connectorTokenSecretMetadataForAuthMethod({
    type: connectorType,
    authMethod: args.authMethod,
  });
  if (!secretMetadata) {
    return null;
  }
  const accessTokenName = secretMetadata.accessSecretName;

  const [accessTokenSecret] = await args.db
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, accessTokenName),
        eq(secrets.type, "connector"),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  if (!accessTokenSecret?.encryptedValue) {
    return null;
  }

  return {
    type: connectorType,
    authMethod: args.authMethod,
    encryptedAccessToken: accessTokenSecret.encryptedValue,
    featureSwitchContext: args.featureSwitchContext,
  };
}

async function revokePendingConnectorToken(args: {
  readonly pending: PendingConnectorTokenRevoke;
}): Promise<void> {
  // Provider revocation is best-effort; local cleanup still owns visible state.
  await bestEffort(
    revokeConnectorAuthMethodAccessToken({
      type: args.pending.type,
      authMethod: args.pending.authMethod,
      readEnv: optionalEnv,
      loadAccessToken: () => {
        return decryptStoredSecretValue(
          args.pending.encryptedAccessToken,
          args.pending.featureSwitchContext,
        );
      },
    }),
  );
}

async function deleteManualGrantConnectorLocalState(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly fields: ManualGrantFieldNames | null;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  if (!args.fields) {
    return false;
  }

  let deleted = false;
  for (const name of args.fields.secrets) {
    const result = await args.db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.name, name),
          eq(secrets.type, "user"),
        ),
      )
      .returning({ id: secrets.id });
    args.signal.throwIfAborted();
    deleted = deleted || result.length > 0;
  }

  for (const name of args.fields.variables) {
    const result = await args.db
      .delete(variables)
      .where(
        and(
          eq(variables.orgId, args.orgId),
          eq(variables.userId, args.userId),
          eq(variables.type, "user"),
          eq(variables.name, name),
        ),
      )
      .returning({ id: variables.id });
    args.signal.throwIfAborted();
    deleted = deleted || result.length > 0;
  }

  return deleted;
}

async function deleteManualGrantConnectorLocalStateForAuthMethods(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorType;
  readonly authMethods: readonly (string | null)[];
  readonly signal: AbortSignal;
}): Promise<void> {
  const cleanupAuthMethods = new Set<string>();
  for (const authMethod of args.authMethods) {
    if (authMethod) {
      cleanupAuthMethods.add(authMethod);
    }
  }

  for (const authMethod of cleanupAuthMethods) {
    args.signal.throwIfAborted();
    await deleteManualGrantConnectorLocalState({
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      fields: getConnectorManualGrantFieldNamesForAuthMethod(
        args.type,
        authMethod,
      ),
      signal: args.signal,
    });
  }
}

export const deleteZeroConnectorLocalState$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ConnectorType;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const featureSwitchContext = {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    } satisfies FeatureSwitchContext;

    let postCommitAbort: unknown = null;
    const deleteResult = await writeDb.transaction(async (tx) => {
      await lockConnectorState(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
      });
      signal.throwIfAborted();

      const [existing] = await tx
        .select({ id: connectors.id, authMethod: connectors.authMethod })
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            eq(connectors.type, args.type),
          ),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      if (!existing) {
        return { deleted: false, pendingTokenRevoke: null };
      }

      let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
      if (
        connectorAuthMethodSupportsTokenRevoke(args.type, existing.authMethod)
      ) {
        pendingTokenRevoke = await loadPendingConnectorTokenRevoke({
          db: tx,
          orgId: args.orgId,
          userId: args.userId,
          type: args.type,
          authMethod: existing.authMethod,
          featureSwitchContext,
          signal,
        });
      }
      signal.throwIfAborted();

      await tx.delete(connectors).where(eq(connectors.id, existing.id));
      signal.throwIfAborted();

      await deleteConnectorScopedSecretNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: getConnectorOwnedSecretNames(args.type, existing.authMethod),
        signal,
      });
      await deleteConnectorScopedVariableNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: getConnectorVariableNames(args.type, existing.authMethod),
        signal,
      });

      return { deleted: true, pendingTokenRevoke };
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }

    if (!deleteResult.deleted) {
      throwCapturedAbort(postCommitAbort);
      return false;
    }

    await finalizeConnectorStateChangeAfterCommit({
      userId: args.userId,
      pendingTokenRevoke: deleteResult.pendingTokenRevoke,
      signal,
      postCommitAbort,
    });
    signal.throwIfAborted();

    return true;
  },
);

async function upsertManualGrantConnectorSecret(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
    readonly encryptedValue: string;
  },
): Promise<void> {
  await db
    .insert(secrets)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      encryptedValue: args.encryptedValue,
      description: null,
      type: "connector",
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue: args.encryptedValue,
        description: null,
        updatedAt: nowDate(),
      },
    });
}

async function upsertManualGrantConnectorVariable(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
    readonly value: string;
  },
): Promise<void> {
  await db
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
        variables.type,
        variables.name,
      ],
      set: {
        value: args.value,
        description: null,
        updatedAt: nowDate(),
      },
    });
}

async function upsertManualGrantConnectorRow(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ConnectorType;
    readonly authMethod: ConnectorAuthMethodId;
  },
): Promise<StoredConnectorRow> {
  const [row] = await db
    .insert(connectors)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
      authMethod: args.authMethod,
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      tokenExpiresAt: null,
      needsReconnect: false,
    })
    .onConflictDoUpdate({
      target: [connectors.orgId, connectors.userId, connectors.type],
      set: {
        authMethod: args.authMethod,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        tokenExpiresAt: null,
        needsReconnect: false,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning({
      id: connectors.id,
      authMethod: connectors.authMethod,
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
      oauthScopes: connectors.oauthScopes,
      needsReconnect: connectors.needsReconnect,
      createdAt: connectors.createdAt,
      updatedAt: connectors.updatedAt,
    });

  if (!row) {
    throw new Error("Failed to upsert manual grant connector");
  }

  return row;
}

async function deleteUserSecretNames(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
    readonly signal: AbortSignal;
  },
): Promise<void> {
  for (const name of args.names) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.name, name),
          eq(secrets.type, "user"),
        ),
      );
    args.signal.throwIfAborted();
  }
}

async function deleteVariableNames(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
    readonly signal: AbortSignal;
  },
): Promise<void> {
  for (const name of args.names) {
    await db
      .delete(variables)
      .where(
        and(
          eq(variables.orgId, args.orgId),
          eq(variables.userId, args.userId),
          eq(variables.type, "user"),
          eq(variables.name, name),
        ),
      );
    args.signal.throwIfAborted();
  }
}

async function deleteConnectorScopedSecretNames(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
    readonly signal: AbortSignal;
  },
): Promise<void> {
  if (args.names.length === 0) {
    return;
  }
  await db
    .delete(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.type, "connector"),
        inArray(secrets.name, [...args.names]),
      ),
    );
  args.signal.throwIfAborted();
}

async function deleteConnectorScopedVariableNames(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
    readonly signal: AbortSignal;
  },
): Promise<void> {
  if (args.names.length === 0) {
    return;
  }
  await db
    .delete(variables)
    .where(
      and(
        eq(variables.orgId, args.orgId),
        eq(variables.userId, args.userId),
        eq(variables.type, "connector"),
        inArray(variables.name, [...args.names]),
      ),
    );
  args.signal.throwIfAborted();
}

async function cleanupExistingStoredConnectorForManualGrantConnect(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ConnectorType;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly signal: AbortSignal;
  },
): Promise<PendingConnectorTokenRevoke | null> {
  const [existing] = await db
    .select({ id: connectors.id, authMethod: connectors.authMethod })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.type, args.type),
      ),
    )
    .for("update")
    .limit(1);
  args.signal.throwIfAborted();
  if (!existing) {
    return null;
  }

  let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
  if (connectorAuthMethodSupportsTokenRevoke(args.type, existing.authMethod)) {
    pendingTokenRevoke = await loadPendingConnectorTokenRevoke({
      db,
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
      authMethod: existing.authMethod,
      featureSwitchContext: args.featureSwitchContext,
      signal: args.signal,
    });
  }

  await deleteConnectorScopedSecretNames(db, {
    orgId: args.orgId,
    userId: args.userId,
    names: getConnectorOwnedSecretNames(args.type, existing.authMethod),
    signal: args.signal,
  });
  await deleteConnectorScopedVariableNames(db, {
    orgId: args.orgId,
    userId: args.userId,
    names: getConnectorVariableNames(args.type, existing.authMethod),
    signal: args.signal,
  });

  return pendingTokenRevoke;
}

export const connectManualGrantConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
      readonly values: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ): Promise<ConnectManualGrantConnectorResult> => {
    const preparedResult = prepareManualGrantConnect(
      args.type,
      args.authMethod,
      args.values,
    );
    if (!preparedResult.ok) {
      return { status: "invalid", message: preparedResult.message };
    }

    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const encryptedSecrets = await encryptManualGrantSecrets({
      secretValues: preparedResult.prepared.secretValues,
      featureSwitchContext,
      signal,
    });
    signal.throwIfAborted();
    const { omittedSecretNames, omittedVariableNames } =
      omittedManualGrantFieldNames(preparedResult.prepared);

    const writeDb = set(writeDb$);
    let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
    let connectorRow: StoredConnectorRow | null = null;
    let postCommitAbort: unknown = null;

    await writeDb.transaction(async (tx) => {
      await lockConnectorState(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
      });
      signal.throwIfAborted();

      pendingTokenRevoke =
        await cleanupExistingStoredConnectorForManualGrantConnect(tx, {
          orgId: args.orgId,
          userId: args.userId,
          type: args.type,
          featureSwitchContext,
          signal,
        });

      await deleteConnectorScopedSecretNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: omittedSecretNames,
        signal,
      });
      await deleteConnectorScopedVariableNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: omittedVariableNames,
        signal,
      });

      for (const field of encryptedSecrets) {
        await upsertManualGrantConnectorSecret(tx, {
          orgId: args.orgId,
          userId: args.userId,
          name: field.name,
          encryptedValue: field.encryptedValue,
        });
        signal.throwIfAborted();
      }

      for (const field of preparedResult.prepared.variableValues) {
        await upsertManualGrantConnectorVariable(tx, {
          orgId: args.orgId,
          userId: args.userId,
          name: field.name,
          value: field.value,
        });
        signal.throwIfAborted();
      }

      connectorRow = await upsertManualGrantConnectorRow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        authMethod: args.authMethod,
      });
      signal.throwIfAborted();

      await deleteUserSecretNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: preparedResult.prepared.configuredSecretNames,
        signal,
      });
      await deleteVariableNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: preparedResult.prepared.configuredVariableNames,
        signal,
      });
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }

    if (!connectorRow) {
      throw new Error("Expected manual grant connector upsert to return a row");
    }

    await finalizeConnectorStateChangeAfterCommit({
      userId: args.userId,
      pendingTokenRevoke,
      signal,
      postCommitAbort,
    });
    signal.throwIfAborted();

    return {
      status: "connected",
      connector: storedConnectorRowToResponse(connectorRow, args.type),
    };
  },
);

async function encryptedConnectorTokenSecret(args: {
  readonly name: string;
  readonly value: string;
  readonly description: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<EncryptedConnectorTokenSecret> {
  return {
    name: args.name,
    encryptedValue: await encryptStoredSecretValue(
      args.value,
      args.featureSwitchContext,
    ),
    description: args.description,
  };
}

async function upsertConnectorEncryptedSecret(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
    readonly encryptedValue: string;
    readonly description: string;
  },
): Promise<void> {
  await db
    .insert(secrets)
    .values({
      userId: args.userId,
      name: args.name,
      encryptedValue: args.encryptedValue,
      type: "connector",
      description: args.description,
      orgId: args.orgId,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue: args.encryptedValue,
        description: args.description,
        updatedAt: nowDate(),
      },
    });
}

function connectorTokenExpiresAt(args: {
  readonly isRefreshable: boolean;
  readonly expiresIn: number | undefined;
}): Date | null {
  const fallbackSecs = args.isRefreshable
    ? DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS
    : null;
  const expiresInSecs = args.expiresIn ?? fallbackSecs;
  return expiresInSecs === null
    ? null
    : new Date(nowDate().getTime() + expiresInSecs * 1000);
}

function staticConnectorOwnedAccessSecretName(
  accessMetadata: Extract<
    ConnectorAuthMethodAccessMetadata,
    { readonly kind: "static" }
  >,
): string | undefined {
  const secretNames = new Set<string>();
  for (const { secretName } of getConnectorOwnedAccessSecretBindingEntries(
    accessMetadata,
  )) {
    secretNames.add(secretName);
  }
  if (secretNames.size !== 1) {
    return undefined;
  }
  return [...secretNames][0];
}

function connectorTokenSecretMetadataForAuthMethod(args: {
  readonly type: ConnectorType;
  readonly authMethod: string;
}): ConnectorTokenSecretMetadata | undefined {
  const accessMetadata = getConnectorAuthMethodAccessMetadata(
    args.type,
    args.authMethod,
  );

  switch (accessMetadata?.kind) {
    case "refresh-token": {
      return {
        accessSecretName: accessMetadata.accessToken,
        refreshSecretName: accessMetadata.refreshToken,
        isRefreshable: true,
      };
    }

    case "static": {
      const accessSecretName =
        staticConnectorOwnedAccessSecretName(accessMetadata);
      return accessSecretName
        ? {
            accessSecretName,
            refreshSecretName: undefined,
            isRefreshable: false,
          }
        : undefined;
    }

    case "none":
    case undefined: {
      return undefined;
    }
  }
}

function allowedConnectorTokenSecretNames(
  type: ConnectorAuthProviderType,
  authMethod: ConnectorAuthMethodId,
): Set<string> {
  return new Set(getConnectorOwnedSecretNames(type, authMethod));
}

function isPrimaryConnectorTokenSecret(args: {
  readonly name: string;
  readonly accessSecretName: string;
  readonly refreshSecretName: string | undefined;
}): boolean {
  return (
    args.name === args.accessSecretName || args.name === args.refreshSecretName
  );
}

function validateExtraConnectorTokenSecrets(args: {
  readonly type: ConnectorAuthProviderType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly extraConnectorSecrets: Readonly<Record<string, string>> | undefined;
  readonly accessSecretName: string;
  readonly refreshSecretName: string | undefined;
}): readonly (readonly [string, string])[] {
  const extraSecrets = Object.entries(args.extraConnectorSecrets ?? {});
  if (extraSecrets.length === 0) {
    return [];
  }

  const allowedSecretNames = allowedConnectorTokenSecretNames(
    args.type,
    args.authMethod,
  );
  for (const [name] of extraSecrets) {
    if (
      isPrimaryConnectorTokenSecret({
        name,
        accessSecretName: args.accessSecretName,
        refreshSecretName: args.refreshSecretName,
      })
    ) {
      throw new Error(
        `${args.type} connector provider returned primary token ${name} in extra connector secrets`,
      );
    }
    if (!allowedSecretNames.has(name)) {
      throw new Error(
        `${args.type} connector provider returned unsupported connector secret ${name}`,
      );
    }
  }

  return extraSecrets;
}

async function encryptExtraConnectorTokenSecrets(args: {
  readonly type: ConnectorAuthProviderType;
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<readonly EncryptedConnectorTokenSecret[]> {
  const encryptedSecrets: EncryptedConnectorTokenSecret[] = [];
  for (const [name, value] of args.extraSecrets) {
    encryptedSecrets.push(
      await encryptedConnectorTokenSecret({
        name,
        value,
        description: `Connector token secret for ${args.type}: ${name}`,
        featureSwitchContext: args.featureSwitchContext,
      }),
    );
    args.signal.throwIfAborted();
  }
  return encryptedSecrets;
}

async function encryptConnectorTokenSecretSet(args: {
  readonly type: ConnectorAuthProviderType;
  readonly accessSecretName: string;
  readonly accessToken: string;
  readonly refreshSecretName: string | undefined;
  readonly refreshToken: string | null | undefined;
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<readonly EncryptedConnectorTokenSecret[]> {
  const encryptedConnectorTokenSecrets: EncryptedConnectorTokenSecret[] = [
    await encryptedConnectorTokenSecret({
      name: args.accessSecretName,
      value: args.accessToken,
      description: `Connector access token for ${args.type}`,
      featureSwitchContext: args.featureSwitchContext,
    }),
  ];
  args.signal.throwIfAborted();

  if (args.refreshToken && args.refreshSecretName) {
    encryptedConnectorTokenSecrets.push(
      await encryptedConnectorTokenSecret({
        name: args.refreshSecretName,
        value: args.refreshToken,
        description: `Connector refresh token for ${args.type}`,
        featureSwitchContext: args.featureSwitchContext,
      }),
    );
    args.signal.throwIfAborted();
  }

  encryptedConnectorTokenSecrets.push(
    ...(await encryptExtraConnectorTokenSecrets({
      type: args.type,
      extraSecrets: args.extraSecrets,
      featureSwitchContext: args.featureSwitchContext,
      signal: args.signal,
    })),
  );
  return encryptedConnectorTokenSecrets;
}

async function upsertConnectorTokenSecrets(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: readonly EncryptedConnectorTokenSecret[];
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.secrets.length === 0) {
    return;
  }

  for (const secret of args.secrets) {
    await upsertConnectorEncryptedSecret(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      name: secret.name,
      encryptedValue: secret.encryptedValue,
      description: secret.description,
    });
    args.signal.throwIfAborted();
  }
}

async function loadExistingConnectorAuthMethod(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ConnectorType;
    readonly signal: AbortSignal;
  },
): Promise<string | null> {
  const [existingConnector] = await db
    .select({ authMethod: connectors.authMethod })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.type, args.type),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return existingConnector?.authMethod ?? null;
}

async function upsertConnectorTokenConnectionRow(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ConnectorAuthProviderType;
    readonly authMethod: ConnectorAuthMethodId;
    readonly userInfo: ExternalUserInfo;
    readonly oauthScopes: readonly string[];
    readonly tokenExpiresAt: Date | null;
    readonly signal: AbortSignal;
  },
): Promise<StoredConnectorRow> {
  const [connectorRow] = await db
    .insert(connectors)
    .values({
      userId: args.userId,
      type: args.type,
      authMethod: args.authMethod,
      externalId: args.userInfo.id,
      externalUsername: args.userInfo.username,
      externalEmail: args.userInfo.email,
      oauthScopes: JSON.stringify(args.oauthScopes),
      tokenExpiresAt: args.tokenExpiresAt,
      needsReconnect: false,
      orgId: args.orgId,
    })
    .onConflictDoUpdate({
      target: [connectors.orgId, connectors.userId, connectors.type],
      set: {
        authMethod: args.authMethod,
        externalId: args.userInfo.id,
        externalUsername: args.userInfo.username,
        externalEmail: args.userInfo.email,
        oauthScopes: JSON.stringify(args.oauthScopes),
        tokenExpiresAt: args.tokenExpiresAt,
        needsReconnect: false,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning({
      id: connectors.id,
      authMethod: connectors.authMethod,
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
      oauthScopes: connectors.oauthScopes,
      needsReconnect: connectors.needsReconnect,
      createdAt: connectors.createdAt,
      updatedAt: connectors.updatedAt,
    });
  args.signal.throwIfAborted();

  if (!connectorRow) {
    throw new Error("Failed to upsert connector");
  }

  return connectorRow;
}

async function deleteObsoleteConnectorScopedStateForTokenConnect(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ConnectorAuthProviderType;
    readonly authMethod: ConnectorAuthMethodId;
    readonly existingAuthMethod: string | null;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  if (!args.existingAuthMethod || args.existingAuthMethod === args.authMethod) {
    return;
  }

  const targetSecretNames = new Set(
    getConnectorOwnedSecretNames(args.type, args.authMethod),
  );
  const obsoleteSecretNames = getConnectorOwnedSecretNames(
    args.type,
    args.existingAuthMethod,
  ).filter((name) => {
    return !targetSecretNames.has(name);
  });
  const targetVariableNames = new Set(
    getConnectorVariableNames(args.type, args.authMethod),
  );
  const obsoleteVariableNames = getConnectorVariableNames(
    args.type,
    args.existingAuthMethod,
  ).filter((name) => {
    return !targetVariableNames.has(name);
  });
  await deleteConnectorScopedSecretNames(db, {
    orgId: args.orgId,
    userId: args.userId,
    names: obsoleteSecretNames,
    signal: args.signal,
  });
  await deleteConnectorScopedVariableNames(db, {
    orgId: args.orgId,
    userId: args.userId,
    names: obsoleteVariableNames,
    signal: args.signal,
  });
}

export const upsertConnectorTokenConnection$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ConnectorAuthProviderType;
      readonly authMethod: ConnectorAuthMethodId;
      readonly accessToken: string;
      readonly userInfo: ExternalUserInfo;
      readonly oauthScopes: readonly string[];
      readonly refreshToken?: string | null;
      readonly expiresIn?: number;
      readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly connector: ConnectorResponse;
    readonly created: boolean;
  }> => {
    const writeDb = set(writeDb$);
    const secretMetadata = connectorTokenSecretMetadataForAuthMethod({
      type: args.type,
      authMethod: args.authMethod,
    });
    if (!secretMetadata) {
      throw new Error(
        `${args.type} connector auth method ${args.authMethod} does not expose an access token secret`,
      );
    }
    const tokenExpiresAt = connectorTokenExpiresAt({
      isRefreshable: secretMetadata.isRefreshable,
      expiresIn: args.expiresIn,
    });
    const extraSecrets = validateExtraConnectorTokenSecrets({
      type: args.type,
      authMethod: args.authMethod,
      extraConnectorSecrets: args.extraConnectorSecrets,
      accessSecretName: secretMetadata.accessSecretName,
      refreshSecretName: secretMetadata.refreshSecretName,
    });
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const encryptedConnectorTokenSecrets = await encryptConnectorTokenSecretSet(
      {
        type: args.type,
        accessSecretName: secretMetadata.accessSecretName,
        accessToken: args.accessToken,
        refreshSecretName: secretMetadata.refreshSecretName,
        refreshToken: args.refreshToken,
        extraSecrets,
        featureSwitchContext,
        signal,
      },
    );
    signal.throwIfAborted();

    let postCommitAbort: unknown = null;
    const connectorRow = await writeDb.transaction(async (tx) => {
      await lockConnectorState(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
      });
      signal.throwIfAborted();

      const existingAuthMethod = await loadExistingConnectorAuthMethod(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        signal,
      });

      await upsertConnectorTokenSecrets({
        db: tx,
        orgId: args.orgId,
        userId: args.userId,
        secrets: encryptedConnectorTokenSecrets,
        signal,
      });
      signal.throwIfAborted();

      const row = await upsertConnectorTokenConnectionRow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        authMethod: args.authMethod,
        userInfo: args.userInfo,
        oauthScopes: args.oauthScopes,
        tokenExpiresAt,
        signal,
      });

      await deleteObsoleteConnectorScopedStateForTokenConnect(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        authMethod: args.authMethod,
        existingAuthMethod,
        signal,
      });

      await deleteManualGrantConnectorLocalStateForAuthMethods({
        db: tx,
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        authMethods: [existingAuthMethod, args.authMethod],
        signal,
      });

      return row;
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }

    await finalizeConnectorStateChangeAfterCommit({
      userId: args.userId,
      pendingTokenRevoke: null,
      signal,
      postCommitAbort,
    });
    signal.throwIfAborted();

    return {
      connector: storedConnectorRowToResponse(connectorRow, args.type),
      created:
        connectorRow.createdAt.getTime() === connectorRow.updatedAt.getTime(),
    };
  },
);

export function zeroConnectorScopeDiff(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorType;
}): Computed<Promise<ScopeDiffResponse | null>> {
  return computed(async (get): Promise<ScopeDiffResponse | null> => {
    const connector = await get(zeroConnectorByType(args));
    if (!connector) {
      return null;
    }
    return getConnectorAuthMethodScopeDiff(
      args.type,
      connector.authMethod,
      connector.oauthScopes,
    );
  });
}

export function zeroConnectorSearch(args: {
  readonly orgId: string | undefined;
  readonly userId: string;
  readonly keyword: string | undefined;
}): Computed<
  Promise<
    {
      readonly id: string;
      readonly label: string;
      readonly description: string;
      readonly authMethods: ConnectorSearchAuthMethod[];
    }[]
  >
> {
  return computed(async (get) => {
    const overrides = args.orgId
      ? await get(userFeatureSwitchOverrides(args.orgId, args.userId))
      : {};
    const featureStates = getAllFeatureStates({
      userId: args.userId,
      orgId: args.orgId,
      overrides,
    });
    const keyword = args.keyword?.toLowerCase();
    return CONNECTOR_TYPE_KEYS.flatMap((type) => {
      const config = CONNECTOR_TYPES[type];
      const authMethods: ConnectorSearchAuthMethod[] =
        getAvailableConnectorAuthMethods(type, featureStates, {
          apiAuthMethodPolicy: "include",
        });

      if (authMethods.length === 0) {
        return [];
      }

      const item = {
        id: type,
        label: config.label,
        description: config.helpText,
        authMethods,
      };

      if (
        keyword &&
        !item.label.toLowerCase().includes(keyword) &&
        !item.description.toLowerCase().includes(keyword)
      ) {
        return [];
      }

      return [item];
    });
  });
}
