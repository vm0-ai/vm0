import { command, computed, type Computed } from "ccstate";
import type {
  ConnectorListResponse,
  ConnectorResponse,
  ScopeDiffResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import type { ConnectorSearchAuthMethod } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  connectorAuthMethodHasOAuthGrant,
  deriveConnectedManualGrantMethod,
  deriveConnectedManualGrantMethods,
  getAvailableConnectorAuthMethods,
  getConnectorAuthMethod,
  getConnectorManualGrantFieldNames,
  getConnectorOAuthClient,
  getConnectorProvidedSecretNames,
  getConnectorSecretNames,
  getRuntimeAvailableConnectorTypes,
  getScopeDiff,
  isConnectorAuthMethodAvailable,
  type ConnectedManualGrantMethod,
  type ManualGrantFieldNames,
} from "@vm0/connectors/connector-utils";
import {
  getConnectorOAuthSecretMetadata,
  isOAuthConnectorType,
  revokeConnectorOAuthToken,
} from "@vm0/connectors/auth-providers";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorManualGrantFieldConfig,
  type ConnectorType,
  type OAuthConnectorType,
} from "@vm0/connectors/connectors";
import {
  getAllFeatureStates,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq, inArray } from "drizzle-orm";
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

const oauthScopesSchema = z.array(z.string());
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS = 15 * 60;
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

interface PendingOAuthRevoke {
  readonly type: OAuthConnectorType;
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

function manualGrantConnectorResponse(
  method: ConnectedManualGrantMethod,
): ConnectorResponse {
  return {
    id: null,
    type: method.type,
    authMethod: method.authMethod,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
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

async function loadUserManualGrantFieldNameSets(
  db: Db | ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<{
  readonly secretNames: Set<string>;
  readonly variableNames: Set<string>;
}> {
  const [userSecretRows, userVariableRows] = await Promise.all([
    db
      .select({ name: secrets.name })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.type, "user"),
        ),
      ),
    db
      .select({ name: variables.name })
      .from(variables)
      .where(
        and(eq(variables.orgId, args.orgId), eq(variables.userId, args.userId)),
      ),
  ]);

  return {
    secretNames: new Set(
      userSecretRows.map((row) => {
        return row.name;
      }),
    ),
    variableNames: new Set(
      userVariableRows.map((row) => {
        return row.name;
      }),
    ),
  };
}

function manualGrantConnectorMethods(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly ConnectedManualGrantMethod[]>> {
  return computed(
    async (get): Promise<readonly ConnectedManualGrantMethod[]> => {
      const db = get(db$);
      const { secretNames, variableNames } =
        await loadUserManualGrantFieldNameSets(db, args);
      return deriveConnectedManualGrantMethods(secretNames, variableNames);
    },
  );
}

export function zeroConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<ConnectorListResponse>> {
  return computed(async (get): Promise<ConnectorListResponse> => {
    const db = get(db$);
    const [oauthRows, derivedMethods, overrides] = await Promise.all([
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
      get(manualGrantConnectorMethods(args)),
      get(userFeatureSwitchOverrides(args.orgId, args.userId)),
    ]);
    const featureStates = getAllFeatureStates({
      userId: args.userId,
      orgId: args.orgId,
      overrides,
    });

    const dbConnectors: ConnectorResponse[] = oauthRows.flatMap((row) => {
      const parsed = connectorTypeSchema.safeParse(row.type);
      if (!parsed.success) {
        return [];
      }
      if (!storedConnectorTypeIsVisible(parsed.data, featureStates)) {
        return [];
      }
      return [storedConnectorRowToResponse(row, parsed.data)];
    });

    const dbTypes = new Set(
      dbConnectors.map((connector) => {
        return connector.type;
      }),
    );
    // Use a fixed timestamp for derived connectors — they are inferred from
    // secrets/variables rather than explicitly created, so a stable sentinel
    // value keeps shadow comparisons deterministic.
    const derivedConnectors: ConnectorResponse[] = derivedMethods
      .filter((method) => {
        return !dbTypes.has(method.type);
      })
      .filter((method) => {
        return isConnectorAuthMethodAvailable(
          method.type,
          method.authMethod,
          featureStates,
        );
      })
      .map((method) => {
        return manualGrantConnectorResponse(method);
      });

    const connectorList = [...dbConnectors, ...derivedConnectors];
    return {
      connectors: connectorList,
      configuredTypes: getRuntimeAvailableConnectorTypes((name) => {
        return optionalEnv(name);
      }),
      connectorProvidedSecretNames: [
        ...getConnectorProvidedSecretNames(
          connectorList.map((connector) => {
            return connector.type;
          }),
        ),
      ],
    };
  });
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

function manualGrantMethodByType(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorType;
}): Computed<Promise<ConnectedManualGrantMethod | null>> {
  return computed(async (get): Promise<ConnectedManualGrantMethod | null> => {
    const db = get(db$);
    const { secretNames, variableNames } =
      await loadUserManualGrantFieldNameSets(db, args);
    return deriveConnectedManualGrantMethod(
      args.type,
      secretNames,
      variableNames,
    );
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
    const manualGrantMethod = await get(manualGrantMethodByType(args));
    if (!manualGrantMethod) {
      return null;
    }
    if (
      !isConnectorAuthMethodAvailable(
        args.type,
        manualGrantMethod.authMethod,
        featureStates,
      )
    ) {
      return null;
    }
    return manualGrantConnectorResponse(manualGrantMethod);
  });
}

async function revokeExistingConnectorToken(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorType;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<void> {
  const pending = await loadPendingOAuthRevoke(args);
  if (!pending) {
    return;
  }

  await revokePendingOAuthToken({ pending, signal: args.signal });
}

async function loadPendingOAuthRevoke(args: {
  readonly db: Db | ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorType;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<PendingOAuthRevoke | null> {
  if (!isOAuthConnectorType(args.type)) {
    return null;
  }

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

async function revokePendingOAuthToken(args: {
  readonly pending: PendingOAuthRevoke;
  readonly signal: AbortSignal;
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
  args.signal.throwIfAborted();
}

async function hasManualGrantConnectorLocalState(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly fields: ManualGrantFieldNames | null;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  if (!args.fields) {
    return false;
  }

  if (args.fields.secrets.length > 0) {
    const [secret] = await args.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.type, "user"),
          inArray(secrets.name, [...args.fields.secrets]),
        ),
      )
      .limit(1);
    args.signal.throwIfAborted();
    if (secret) {
      return true;
    }
  }

  if (args.fields.variables.length > 0) {
    const [variable] = await args.db
      .select({ id: variables.id })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, args.orgId),
          eq(variables.userId, args.userId),
          inArray(variables.name, [...args.fields.variables]),
        ),
      )
      .limit(1);
    args.signal.throwIfAborted();
    if (variable) {
      return true;
    }
  }

  return false;
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
    let deleted = false;

    const [existing] = await writeDb
      .select({ id: connectors.id, authMethod: connectors.authMethod })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.type, args.type),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    const fields = getConnectorManualGrantFieldNames(args.type);
    const hasManualGrantState = existing
      ? false
      : await hasManualGrantConnectorLocalState({
          db: writeDb,
          orgId: args.orgId,
          userId: args.userId,
          fields,
          signal,
        });
    if (!existing && !hasManualGrantState) {
      return false;
    }

    if (existing) {
      if (connectorAuthMethodHasOAuthGrant(args.type, existing.authMethod)) {
        await revokeExistingConnectorToken({
          db: writeDb,
          orgId: args.orgId,
          userId: args.userId,
          type: args.type,
          featureSwitchContext,
          signal,
        });
      }

      await writeDb.delete(connectors).where(eq(connectors.id, existing.id));
      signal.throwIfAborted();
      deleted = true;

      const secretNames = getConnectorSecretNames(
        args.type,
        existing.authMethod,
      );

      for (const name of secretNames) {
        await writeDb
          .delete(secrets)
          .where(
            and(
              eq(secrets.orgId, args.orgId),
              eq(secrets.userId, args.userId),
              eq(secrets.name, name),
              eq(secrets.type, "connector"),
            ),
          );
        signal.throwIfAborted();
      }
    }

    deleted =
      (await deleteManualGrantConnectorLocalState({
        db: writeDb,
        orgId: args.orgId,
        userId: args.userId,
        fields,
        signal,
      })) || deleted;

    if (deleted) {
      await publishUserSignal([args.userId], "connector:changed");
      signal.throwIfAborted();
    }

    return deleted;
  },
);

async function upsertApiTokenUserSecret(
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
      type: "user",
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

async function upsertApiTokenVariable(
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
    })
    .onConflictDoUpdate({
      target: [variables.orgId, variables.userId, variables.name],
      set: {
        value: args.value,
        description: null,
        updatedAt: nowDate(),
      },
    });
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
  for (const name of args.names) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.name, name),
          eq(secrets.type, "connector"),
        ),
      );
    args.signal.throwIfAborted();
  }
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

    const encryptedSecrets: EncryptedApiTokenSecret[] = [];
    for (const field of preparedResult.prepared.secretValues) {
      encryptedSecrets.push({
        name: field.name,
        encryptedValue: await encryptStoredSecretValue(
          field.value,
          featureSwitchContext,
        ),
      });
      signal.throwIfAborted();
    }

    const submittedSecretNames = new Set(
      preparedResult.prepared.secretValues.map((field) => {
        return field.name;
      }),
    );
    const submittedVariableNames = new Set(
      preparedResult.prepared.variableValues.map((field) => {
        return field.name;
      }),
    );
    const omittedSecretNames =
      preparedResult.prepared.configuredSecretNames.filter((name) => {
        return !submittedSecretNames.has(name);
      });
    const omittedVariableNames =
      preparedResult.prepared.configuredVariableNames.filter((name) => {
        return !submittedVariableNames.has(name);
      });

    const writeDb = set(writeDb$);
    let pendingOAuthRevoke: PendingOAuthRevoke | null = null;

    await writeDb.transaction(async (tx) => {
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

      if (existing) {
        if (connectorAuthMethodHasOAuthGrant(args.type, existing.authMethod)) {
          pendingOAuthRevoke = await loadPendingOAuthRevoke({
            db: tx,
            orgId: args.orgId,
            userId: args.userId,
            type: args.type,
            featureSwitchContext,
            signal,
          });
        }

        await tx.delete(connectors).where(eq(connectors.id, existing.id));
        signal.throwIfAborted();

        await deleteConnectorScopedSecretNames(tx, {
          orgId: args.orgId,
          userId: args.userId,
          names: getConnectorSecretNames(args.type, existing.authMethod),
          signal,
        });
      }

      await deleteUserSecretNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: omittedSecretNames,
        signal,
      });
      await deleteVariableNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: omittedVariableNames,
        signal,
      });

      for (const field of encryptedSecrets) {
        await upsertApiTokenUserSecret(tx, {
          orgId: args.orgId,
          userId: args.userId,
          name: field.name,
          encryptedValue: field.encryptedValue,
        });
        signal.throwIfAborted();
      }

      for (const field of preparedResult.prepared.variableValues) {
        await upsertApiTokenVariable(tx, {
          orgId: args.orgId,
          userId: args.userId,
          name: field.name,
          value: field.value,
        });
        signal.throwIfAborted();
      }
    });
    signal.throwIfAborted();

    if (pendingOAuthRevoke) {
      await revokePendingOAuthToken({ pending: pendingOAuthRevoke, signal });
    }

    await publishUserSignal([args.userId], "connector:changed");
    signal.throwIfAborted();

    return {
      status: "connected",
      connector: manualGrantConnectorResponse({
        type: args.type,
        authMethod: "api-token",
      }),
    };
  },
);

async function upsertConnectorSecret(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
    readonly value: string;
    readonly description: string;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Promise<void> {
  const encryptedValue = await encryptStoredSecretValue(
    args.value,
    args.featureSwitchContext,
  );
  await db
    .insert(secrets)
    .values({
      userId: args.userId,
      name: args.name,
      encryptedValue,
      type: "connector",
      description: args.description,
      orgId: args.orgId,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue,
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
  type: OAuthConnectorType,
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
  readonly type: OAuthConnectorType;
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

async function upsertExtraOAuthConnectorSecrets(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly type: OAuthConnectorType;
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.extraSecrets.length === 0) {
    return;
  }

  for (const [name, value] of args.extraSecrets) {
    await upsertConnectorSecret(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      name,
      value,
      description: `OAuth connector secret for ${args.type}: ${name}`,
      featureSwitchContext: args.featureSwitchContext,
    });
    args.signal.throwIfAborted();
  }
}

export const upsertOAuthConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: OAuthConnectorType;
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
    const manualGrantFields = getConnectorManualGrantFieldNames(args.type);

    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    await upsertConnectorSecret(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
      name: secretMetadata.accessSecretName,
      value: args.accessToken,
      description: `OAuth token for ${args.type} connector`,
      featureSwitchContext,
    });
    signal.throwIfAborted();

    if (args.refreshToken && args.refreshSecretName) {
      await upsertConnectorSecret(writeDb, {
        orgId: args.orgId,
        userId: args.userId,
        name: args.refreshSecretName,
        value: args.refreshToken,
        description: `OAuth refresh token for ${args.type} connector`,
        featureSwitchContext,
      });
      signal.throwIfAborted();
    }

    await upsertExtraOAuthConnectorSecrets({
      db: writeDb,
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
      extraSecrets,
      featureSwitchContext,
      signal,
    });
    signal.throwIfAborted();

    const [connectorRow] = await writeDb
      .insert(connectors)
      .values({
        userId: args.userId,
        type: args.type,
        authMethod: "oauth",
        externalId: args.userInfo.id,
        externalUsername: args.userInfo.username,
        externalEmail: args.userInfo.email,
        oauthScopes: JSON.stringify(args.oauthScopes),
        tokenExpiresAt,
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
          tokenExpiresAt,
          needsReconnect: false,
          updatedAt: nowDate(),
        },
      })
      .returning();
    signal.throwIfAborted();

    if (!connectorRow) {
      throw new Error("Failed to upsert connector");
    }

    await deleteManualGrantConnectorLocalState({
      db: writeDb,
      orgId: args.orgId,
      userId: args.userId,
      fields: manualGrantFields,
      signal,
    });
    signal.throwIfAborted();

    await publishUserSignal([args.userId], "connector:changed");
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
    return getScopeDiff(args.type, connector.oauthScopes);
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
