import { command, computed, type Computed } from "ccstate";
import type {
  ConnectorListResponse,
  ConnectorResponse,
  ScopeDiffResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import type { ConnectorSearchAuthMethod } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  deriveApiTokenConnectedTypes,
  getApiTokenFieldsByType,
  getAvailableConnectorAuthMethods,
  getConnectorOAuthCredentials,
  getConnectorProvidedSecretNames,
  getConnectorSecretNames,
  getRuntimeAvailableConnectorTypes,
  getScopeDiff,
  isConnectorAuthMethodAvailable,
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
import { db$, type Db, writeDb$ } from "../external/db";
import {
  deleteBotUser,
  deleteCloudEndpoint,
  deleteCredential,
  deleteReservedDomain,
  safeDelete,
} from "../external/ngrok-client";
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
import { invalidateActiveCliAuthSessionsForConnectorType } from "./cli-auth-invalidation.service";

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
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS = 3600;
const COMPUTER_CONNECTOR_SECRET_NAMES = [
  "COMPUTER_CONNECTOR_BRIDGE_TOKEN",
  "COMPUTER_CONNECTOR_DOMAIN_ID",
  "COMPUTER_CONNECTOR_DOMAIN",
] as const;
type FeatureStates = ReturnType<typeof getAllFeatureStates>;

interface ExternalUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
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

function apiTokenConnectorTypes(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly ConnectorType[]>> {
  return computed(async (get): Promise<readonly ConnectorType[]> => {
    const db = get(db$);
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
          and(
            eq(variables.orgId, args.orgId),
            eq(variables.userId, args.userId),
          ),
        ),
    ]);

    return deriveApiTokenConnectedTypes(
      new Set(
        userSecretRows.map((row) => {
          return row.name;
        }),
      ),
      new Set(
        userVariableRows.map((row) => {
          return row.name;
        }),
      ),
    );
  });
}

export function zeroConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<ConnectorListResponse>> {
  return computed(async (get): Promise<ConnectorListResponse> => {
    const db = get(db$);
    const [oauthRows, derivedTypes, overrides] = await Promise.all([
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
      get(apiTokenConnectorTypes(args)),
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
    const derivedConnectors: ConnectorResponse[] = derivedTypes
      .filter((type) => {
        return !dbTypes.has(type);
      })
      .filter((type) => {
        return isConnectorAuthMethodAvailable(type, "api-token", featureStates);
      })
      .map((type) => {
        return {
          id: null,
          type,
          authMethod: "api-token",
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          needsReconnect: false,
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
        };
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

function apiTokenConnectorByType(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorType;
}): Computed<Promise<ConnectorResponse | null>> {
  return computed(async (get): Promise<ConnectorResponse | null> => {
    const db = get(db$);
    const fields = getApiTokenFieldsByType(args.type);
    if (
      !fields ||
      (fields.secrets.length === 0 && fields.variables.length === 0)
    ) {
      return null;
    }

    const [userSecretRows, userVariableRows] = await Promise.all([
      fields.secrets.length > 0
        ? db
            .select({ name: secrets.name })
            .from(secrets)
            .where(
              and(
                eq(secrets.orgId, args.orgId),
                eq(secrets.userId, args.userId),
                eq(secrets.type, "user"),
              ),
            )
        : Promise.resolve([]),
      fields.variables.length > 0
        ? db
            .select({ name: variables.name })
            .from(variables)
            .where(
              and(
                eq(variables.orgId, args.orgId),
                eq(variables.userId, args.userId),
              ),
            )
        : Promise.resolve([]),
    ]);

    const secretNames = new Set(
      userSecretRows.map((row) => {
        return row.name;
      }),
    );
    const variableNames = new Set(
      userVariableRows.map((row) => {
        return row.name;
      }),
    );
    const secretsOk = fields.secrets.every((name) => {
      return secretNames.has(name);
    });
    const variablesOk = fields.variables.every((name) => {
      return variableNames.has(name);
    });
    if (!secretsOk || !variablesOk) {
      return null;
    }

    // Use a fixed timestamp — this connector is inferred, not explicitly created.
    return {
      id: null,
      type: args.type,
      authMethod: "api-token",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      needsReconnect: false,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    };
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
    if (
      !isConnectorAuthMethodAvailable(args.type, "api-token", featureStates)
    ) {
      return null;
    }
    return get(apiTokenConnectorByType(args));
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
  if (!isOAuthConnectorType(args.type)) {
    return;
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
    return;
  }

  const credentials = getConnectorOAuthCredentials(connectorType, optionalEnv);
  if (!credentials) {
    return;
  }

  // Provider revocation is best-effort; local cleanup still owns visible state.
  await bestEffort(
    revokeConnectorOAuthToken({
      type: connectorType,
      credentials,
      loadAccessToken: () => {
        return decryptStoredSecretValue(
          accessTokenSecret.encryptedValue,
          args.featureSwitchContext,
        );
      },
    }),
  );
  args.signal.throwIfAborted();
}

async function hasApiTokenConnectorLocalState(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly fields: {
    readonly secrets: readonly string[];
    readonly variables: readonly string[];
  } | null;
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

async function deleteApiTokenConnectorLocalState(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly fields: {
    readonly secrets: readonly string[];
    readonly variables: readonly string[];
  } | null;
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

    const fields = getApiTokenFieldsByType(args.type);
    const hasApiTokenState = existing
      ? false
      : await hasApiTokenConnectorLocalState({
          db: writeDb,
          orgId: args.orgId,
          userId: args.userId,
          fields,
          signal,
        });
    if (!existing && !hasApiTokenState) {
      return false;
    }

    await invalidateActiveCliAuthSessionsForConnectorType({
      writeDb,
      orgId: args.orgId,
      userId: args.userId,
      connectorType: args.type,
      signal,
    });
    signal.throwIfAborted();

    if (existing) {
      if (existing.authMethod === "oauth") {
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
      (await deleteApiTokenConnectorLocalState({
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
    const apiTokenFields = getApiTokenFieldsByType(args.type);

    await invalidateActiveCliAuthSessionsForConnectorType({
      writeDb,
      orgId: args.orgId,
      userId: args.userId,
      connectorType: args.type,
      signal,
    });
    signal.throwIfAborted();

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

    await deleteApiTokenConnectorLocalState({
      db: writeDb,
      orgId: args.orgId,
      userId: args.userId,
      fields: apiTokenFields,
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

export const deleteComputerConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
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

    const [connector] = await writeDb
      .select({
        id: connectors.id,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.type, "computer"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!connector) {
      return false;
    }

    const apiKey = optionalEnv("NGROK_API_KEY");
    if (apiKey) {
      if (connector.externalUsername) {
        await safeDelete(
          () => {
            return deleteCredential(apiKey, connector.externalUsername!);
          },
          "Credential",
          connector.externalUsername,
        );
        signal.throwIfAborted();
      }

      if (connector.externalEmail) {
        await safeDelete(
          () => {
            return deleteCloudEndpoint(apiKey, connector.externalEmail!);
          },
          "Cloud endpoint",
          connector.externalEmail,
        );
        signal.throwIfAborted();
      }

      const [domainIdSecret] = await writeDb
        .select({ encryptedValue: secrets.encryptedValue })
        .from(secrets)
        .where(
          and(
            eq(secrets.orgId, args.orgId),
            eq(secrets.userId, args.userId),
            eq(secrets.name, "COMPUTER_CONNECTOR_DOMAIN_ID"),
            eq(secrets.type, "connector"),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      if (domainIdSecret) {
        const domainId = await decryptStoredSecretValue(
          domainIdSecret.encryptedValue,
          featureSwitchContext,
        );
        signal.throwIfAborted();
        await safeDelete(
          () => {
            return deleteReservedDomain(apiKey, domainId);
          },
          "Reserved domain",
          domainId,
        );
        signal.throwIfAborted();
      }

      if (connector.externalId) {
        await safeDelete(
          () => {
            return deleteBotUser(apiKey, connector.externalId!);
          },
          "Bot user",
          connector.externalId,
        );
        signal.throwIfAborted();
      }
    }

    await writeDb.delete(connectors).where(eq(connectors.id, connector.id));
    signal.throwIfAborted();

    for (const name of COMPUTER_CONNECTOR_SECRET_NAMES) {
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

    return true;
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
