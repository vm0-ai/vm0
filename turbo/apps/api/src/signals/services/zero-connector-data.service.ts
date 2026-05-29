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
  getConnectorAuthMethodScopeDiff,
  getConnectorAuthMethodEnvBindings,
  getConnectorAuthMethod,
  getConnectorManualGrantFieldNames,
  getConnectorOAuthClient,
  getConnectorSecretNames,
  getConnectorVariableNames,
  getRuntimeAvailableConnectorTypes,
  type ManualGrantFieldNames,
} from "@vm0/connectors/connector-utils";
import {
  getConnectorOAuthSecretMetadata,
  revokeConnectorOAuthToken,
} from "@vm0/connectors/auth-providers";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorManualGrantFieldConfig,
  type ConnectorType,
  type OAuthGrantConnectorType,
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
const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";
type FeatureStates = ReturnType<typeof getAllFeatureStates>;

interface ExternalUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

interface PreparedApiTokenField {
  readonly name: string;
  readonly value: string;
}

interface PreparedApiTokenConnect {
  readonly secretValues: readonly PreparedApiTokenField[];
  readonly variableValues: readonly PreparedApiTokenField[];
  readonly configuredSecretNames: readonly string[];
  readonly configuredVariableNames: readonly string[];
}

type PreparedApiTokenConnectResult =
  | { readonly ok: true; readonly prepared: PreparedApiTokenConnect }
  | { readonly ok: false; readonly message: string };

type ConnectApiTokenConnectorResult =
  | { readonly status: "connected"; readonly connector: ConnectorResponse }
  | { readonly status: "invalid"; readonly message: string };

interface EncryptedApiTokenSecret {
  readonly name: string;
  readonly encryptedValue: string;
}

interface OmittedApiTokenFieldNames {
  readonly omittedSecretNames: readonly string[];
  readonly omittedVariableNames: readonly string[];
}

interface EncryptedOAuthConnectorSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly description: string;
}

interface PendingConnectorTokenRevoke {
  readonly type: TokenRevokeConnectorType;
  readonly encryptedAccessToken: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}

async function lockConnectorState(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ConnectorType;
  },
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('connector_state:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.type}))`,
  );
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

function apiTokenManualGrantFields(
  type: ConnectorType,
): Record<string, ConnectorManualGrantFieldConfig> | null {
  const method = getConnectorAuthMethod(type, "api-token");
  return method?.grant.kind === "manual" ? method.grant.fields : null;
}

export function connectorSupportsApiTokenAuth(type: ConnectorType): boolean {
  return apiTokenManualGrantFields(type) !== null;
}

function sanitizeApiTokenValue(value: string): string {
  return value.replace(/\s+/gu, "");
}

function formatApiTokenFieldList(names: readonly string[]): string {
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

function prepareApiTokenConnect(
  type: ConnectorType,
  values: Readonly<Record<string, string>>,
): PreparedApiTokenConnectResult {
  const fields = apiTokenManualGrantFields(type);
  if (!fields) {
    return {
      ok: false,
      message: `${type} connector does not support API-token auth`,
    };
  }

  const configuredFieldNames = new Set(Object.keys(fields));
  const unknownFieldNames = Object.keys(values).filter((name) => {
    return !configuredFieldNames.has(name);
  });
  if (unknownFieldNames.length > 0) {
    return {
      ok: false,
      message: `Unknown API-token field(s): ${formatApiTokenFieldList(
        unknownFieldNames,
      )}`,
    };
  }

  const sanitizedValues = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    sanitizedValues.set(name, sanitizeApiTokenValue(value));
  }

  const secretValues: PreparedApiTokenField[] = [];
  const variableValues: PreparedApiTokenField[] = [];
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
      message: `Missing required API-token field(s): ${formatApiTokenFieldList(
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

async function encryptApiTokenSecrets(args: {
  readonly secretValues: readonly PreparedApiTokenField[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<readonly EncryptedApiTokenSecret[]> {
  const encryptedSecrets: EncryptedApiTokenSecret[] = [];
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

function omittedApiTokenFieldNames(
  prepared: PreparedApiTokenConnect,
): OmittedApiTokenFieldNames {
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
    const envBindings = getConnectorAuthMethodEnvBindings(
      connector.type,
      connector.authMethod,
    );
    for (const [envName, valueRef] of Object.entries(envBindings)) {
      if (!valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
        continue;
      }
      const secretName = valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length);
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
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<PendingConnectorTokenRevoke | null> {
  const connectorType = args.type;
  const secretMetadata = getConnectorOAuthSecretMetadata(connectorType);
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
    encryptedAccessToken: accessTokenSecret.encryptedValue,
    featureSwitchContext: args.featureSwitchContext,
  };
}

async function revokePendingConnectorToken(args: {
  readonly pending: PendingConnectorTokenRevoke;
}): Promise<void> {
  const oauthClient = getConnectorOAuthClient(args.pending.type, optionalEnv);
  if (!oauthClient) {
    return;
  }

  // Provider revocation is best-effort; local cleanup still owns visible state.
  await bestEffort(
    revokeConnectorOAuthToken({
      type: args.pending.type,
      oauthClient,
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
        names: getConnectorSecretNames(args.type, existing.authMethod),
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

async function upsertApiTokenConnectorSecret(
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

async function upsertApiTokenConnectorVariable(
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

async function upsertApiTokenConnectorRow(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ConnectorType;
  },
): Promise<StoredConnectorRow> {
  const updatedAt = nowDate();
  const [row] = await db
    .insert(connectors)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
      authMethod: "api-token",
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
        authMethod: "api-token",
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        tokenExpiresAt: null,
        needsReconnect: false,
        updatedAt,
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
    throw new Error("Failed to upsert API-token connector");
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

async function cleanupExistingStoredConnectorForApiTokenConnect(
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
      featureSwitchContext: args.featureSwitchContext,
      signal: args.signal,
    });
  }

  await deleteConnectorScopedSecretNames(db, {
    orgId: args.orgId,
    userId: args.userId,
    names: getConnectorSecretNames(args.type, existing.authMethod),
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

export const connectApiTokenConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ConnectorType;
      readonly values: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ): Promise<ConnectApiTokenConnectorResult> => {
    const preparedResult = prepareApiTokenConnect(args.type, args.values);
    if (!preparedResult.ok) {
      return { status: "invalid", message: preparedResult.message };
    }

    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const encryptedSecrets = await encryptApiTokenSecrets({
      secretValues: preparedResult.prepared.secretValues,
      featureSwitchContext,
      signal,
    });
    signal.throwIfAborted();
    const { omittedSecretNames, omittedVariableNames } =
      omittedApiTokenFieldNames(preparedResult.prepared);

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
        await cleanupExistingStoredConnectorForApiTokenConnect(tx, {
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
        await upsertApiTokenConnectorSecret(tx, {
          orgId: args.orgId,
          userId: args.userId,
          name: field.name,
          encryptedValue: field.encryptedValue,
        });
        signal.throwIfAborted();
      }

      for (const field of preparedResult.prepared.variableValues) {
        await upsertApiTokenConnectorVariable(tx, {
          orgId: args.orgId,
          userId: args.userId,
          name: field.name,
          value: field.value,
        });
        signal.throwIfAborted();
      }

      connectorRow = await upsertApiTokenConnectorRow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
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
      throw new Error("Expected API-token connector upsert to return a row");
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

async function encryptedOAuthConnectorSecret(args: {
  readonly name: string;
  readonly value: string;
  readonly description: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<EncryptedOAuthConnectorSecret> {
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

function allowedOAuthConnectorSecretNames(
  type: OAuthGrantConnectorType,
): Set<string> {
  return new Set(getConnectorSecretNames(type, "oauth"));
}

function isOAuthPrimaryTokenSecret(args: {
  readonly name: string;
  readonly accessSecretName: string;
  readonly refreshSecretName: string | undefined;
}): boolean {
  return (
    args.name === args.accessSecretName || args.name === args.refreshSecretName
  );
}

function validateExtraOAuthConnectorSecrets(args: {
  readonly type: OAuthGrantConnectorType;
  readonly extraConnectorSecrets: Readonly<Record<string, string>> | undefined;
  readonly accessSecretName: string;
  readonly refreshSecretName: string | undefined;
}): readonly (readonly [string, string])[] {
  const extraSecrets = Object.entries(args.extraConnectorSecrets ?? {});
  if (extraSecrets.length === 0) {
    return [];
  }

  const allowedSecretNames = allowedOAuthConnectorSecretNames(args.type);
  for (const [name] of extraSecrets) {
    if (
      isOAuthPrimaryTokenSecret({
        name,
        accessSecretName: args.accessSecretName,
        refreshSecretName: args.refreshSecretName,
      })
    ) {
      throw new Error(
        `${args.type} OAuth provider returned primary token ${name} in extra connector secrets`,
      );
    }
    if (!allowedSecretNames.has(name)) {
      throw new Error(
        `${args.type} OAuth provider returned unsupported connector secret ${name}`,
      );
    }
  }

  return extraSecrets;
}

async function encryptExtraOAuthConnectorSecrets(args: {
  readonly type: OAuthGrantConnectorType;
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<readonly EncryptedOAuthConnectorSecret[]> {
  const encryptedSecrets: EncryptedOAuthConnectorSecret[] = [];
  for (const [name, value] of args.extraSecrets) {
    encryptedSecrets.push(
      await encryptedOAuthConnectorSecret({
        name,
        value,
        description: `OAuth connector secret for ${args.type}: ${name}`,
        featureSwitchContext: args.featureSwitchContext,
      }),
    );
    args.signal.throwIfAborted();
  }
  return encryptedSecrets;
}

async function encryptOAuthConnectorSecretSet(args: {
  readonly type: OAuthGrantConnectorType;
  readonly accessSecretName: string;
  readonly accessToken: string;
  readonly refreshSecretName: string | undefined;
  readonly refreshToken: string | null | undefined;
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<readonly EncryptedOAuthConnectorSecret[]> {
  const encryptedOAuthSecrets: EncryptedOAuthConnectorSecret[] = [
    await encryptedOAuthConnectorSecret({
      name: args.accessSecretName,
      value: args.accessToken,
      description: `OAuth token for ${args.type} connector`,
      featureSwitchContext: args.featureSwitchContext,
    }),
  ];
  args.signal.throwIfAborted();

  if (args.refreshToken && args.refreshSecretName) {
    encryptedOAuthSecrets.push(
      await encryptedOAuthConnectorSecret({
        name: args.refreshSecretName,
        value: args.refreshToken,
        description: `OAuth refresh token for ${args.type} connector`,
        featureSwitchContext: args.featureSwitchContext,
      }),
    );
    args.signal.throwIfAborted();
  }

  encryptedOAuthSecrets.push(
    ...(await encryptExtraOAuthConnectorSecrets({
      type: args.type,
      extraSecrets: args.extraSecrets,
      featureSwitchContext: args.featureSwitchContext,
      signal: args.signal,
    })),
  );
  return encryptedOAuthSecrets;
}

async function upsertOAuthConnectorSecrets(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: readonly EncryptedOAuthConnectorSecret[];
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

async function upsertOAuthConnectorRow(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: OAuthGrantConnectorType;
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
      authMethod: "oauth",
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
        authMethod: "oauth",
        externalId: args.userInfo.id,
        externalUsername: args.userInfo.username,
        externalEmail: args.userInfo.email,
        oauthScopes: JSON.stringify(args.oauthScopes),
        tokenExpiresAt: args.tokenExpiresAt,
        needsReconnect: false,
        updatedAt: nowDate(),
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

async function deleteObsoleteConnectorScopedStateForOAuthConnect(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: OAuthGrantConnectorType;
    readonly existingAuthMethod: string | null;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  if (!args.existingAuthMethod || args.existingAuthMethod === "oauth") {
    return;
  }

  const oauthSecretNames = new Set(getConnectorSecretNames(args.type, "oauth"));
  const obsoleteSecretNames = getConnectorSecretNames(
    args.type,
    args.existingAuthMethod,
  ).filter((name) => {
    return !oauthSecretNames.has(name);
  });
  const oauthVariableNames = new Set(
    getConnectorVariableNames(args.type, "oauth"),
  );
  const obsoleteVariableNames = getConnectorVariableNames(
    args.type,
    args.existingAuthMethod,
  ).filter((name) => {
    return !oauthVariableNames.has(name);
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

export const upsertOAuthConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: OAuthGrantConnectorType;
      readonly accessToken: string;
      readonly userInfo: ExternalUserInfo;
      readonly oauthScopes: readonly string[];
      readonly refreshToken?: string | null;
      readonly refreshSecretName?: string;
      readonly expiresIn?: number;
      readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly connector: ConnectorResponse;
    readonly created: boolean;
  }> => {
    const writeDb = set(writeDb$);
    const secretMetadata = getConnectorOAuthSecretMetadata(args.type);
    const tokenExpiresAt = connectorTokenExpiresAt({
      isRefreshable: secretMetadata.isRefreshable,
      expiresIn: args.expiresIn,
    });
    const extraSecrets = validateExtraOAuthConnectorSecrets({
      type: args.type,
      extraConnectorSecrets: args.extraConnectorSecrets,
      accessSecretName: secretMetadata.accessSecretName,
      refreshSecretName: secretMetadata.isRefreshable
        ? secretMetadata.refreshSecretName
        : undefined,
    });
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const encryptedOAuthSecrets = await encryptOAuthConnectorSecretSet({
      type: args.type,
      accessSecretName: secretMetadata.accessSecretName,
      accessToken: args.accessToken,
      refreshSecretName: args.refreshSecretName,
      refreshToken: args.refreshToken,
      extraSecrets,
      featureSwitchContext,
      signal,
    });
    signal.throwIfAborted();

    const manualGrantFields = getConnectorManualGrantFieldNames(args.type);
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

      await upsertOAuthConnectorSecrets({
        db: tx,
        orgId: args.orgId,
        userId: args.userId,
        secrets: encryptedOAuthSecrets,
        signal,
      });
      signal.throwIfAborted();

      const row = await upsertOAuthConnectorRow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        userInfo: args.userInfo,
        oauthScopes: args.oauthScopes,
        tokenExpiresAt,
        signal,
      });

      await deleteObsoleteConnectorScopedStateForOAuthConnect(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        existingAuthMethod,
        signal,
      });

      await deleteManualGrantConnectorLocalState({
        db: tx,
        orgId: args.orgId,
        userId: args.userId,
        fields: manualGrantFields,
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
