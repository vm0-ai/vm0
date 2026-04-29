import { computed, type Computed } from "ccstate";
import type {
  ConnectorListResponse,
  ConnectorResponse,
  ScopeDiffResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import type { ConnectorSearchAuthMethod } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  deriveApiTokenConnectedTypes,
  getApiTokenFieldsByType,
  getConnectorDefaultAuthMethod,
  getConnectorProvidedSecretNames,
  getScopeDiff,
} from "@vm0/connectors/connector-utils";
import {
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { userPlatformConnectors } from "@vm0/db/schema/user-platform-connector";
import { variables } from "@vm0/db/schema/variable";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { userFeatureSwitchOverrides } from "./feature-switches.service";

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

function platformRowToResponse(
  row: {
    readonly id: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
  type: ConnectorType,
): ConnectorResponse {
  return {
    id: row.id,
    type,
    authMethod: "platform",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function configuredConnectorTypes(): readonly ConnectorType[] {
  return (Object.keys(CONNECTOR_TYPES) as ConnectorType[]).filter((type) => {
    return getConnectorDefaultAuthMethod(type) === "api-token";
  });
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
    const [oauthRows, platformRows, derivedTypes] = await Promise.all([
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
        .select({
          id: userPlatformConnectors.id,
          type: userPlatformConnectors.type,
          createdAt: userPlatformConnectors.createdAt,
          updatedAt: userPlatformConnectors.updatedAt,
        })
        .from(userPlatformConnectors)
        .where(
          and(
            eq(userPlatformConnectors.orgId, args.orgId),
            eq(userPlatformConnectors.userId, args.userId),
          ),
        ),
      get(apiTokenConnectorTypes(args)),
    ]);

    const dbConnectors: ConnectorResponse[] = [
      ...oauthRows.flatMap((row) => {
        const parsed = connectorTypeSchema.safeParse(row.type);
        if (!parsed.success) {
          return [];
        }
        return [storedConnectorRowToResponse(row, parsed.data)];
      }),
      ...platformRows.flatMap((row) => {
        const parsed = connectorTypeSchema.safeParse(row.type);
        return parsed.success ? [platformRowToResponse(row, parsed.data)] : [];
      }),
    ];

    const dbTypes = new Set(
      dbConnectors.map((connector) => {
        return connector.type;
      }),
    );
    const now = nowDate().toISOString();
    const derivedConnectors: ConnectorResponse[] = derivedTypes
      .filter((type) => {
        return !dbTypes.has(type);
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
          createdAt: now,
          updatedAt: now,
        };
      });

    const connectorList = [...dbConnectors, ...derivedConnectors];
    return {
      connectors: connectorList,
      configuredTypes: [...configuredConnectorTypes()],
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
    const [oauthRows, platformRows] = await Promise.all([
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
            eq(connectors.type, args.type),
          ),
        )
        .limit(1),
      db
        .select({
          id: userPlatformConnectors.id,
          createdAt: userPlatformConnectors.createdAt,
          updatedAt: userPlatformConnectors.updatedAt,
        })
        .from(userPlatformConnectors)
        .where(
          and(
            eq(userPlatformConnectors.orgId, args.orgId),
            eq(userPlatformConnectors.userId, args.userId),
            eq(userPlatformConnectors.type, args.type),
          ),
        )
        .limit(1),
    ]);

    const oauthRow = oauthRows[0];
    if (oauthRow) {
      return storedConnectorRowToResponse(oauthRow, args.type);
    }

    const platformRow = platformRows[0];
    if (platformRow) {
      return platformRowToResponse(platformRow, args.type);
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

    const now = nowDate().toISOString();
    return {
      id: null,
      type: args.type,
      authMethod: "api-token",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      needsReconnect: false,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function zeroConnectorByType(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorType;
}): Computed<Promise<ConnectorResponse | null>> {
  return computed(async (get): Promise<ConnectorResponse | null> => {
    const storedConnector = await get(storedConnectorByType(args));
    if (storedConnector) {
      return storedConnector;
    }
    return get(apiTokenConnectorByType(args));
  });
}

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
    const platformGloballyEnabled =
      featureStates[FeatureSwitchKey.PlatformConnectors];

    return (Object.keys(CONNECTOR_TYPES) as ConnectorType[]).flatMap((type) => {
      const config = CONNECTOR_TYPES[type];
      const flag = config.featureFlag;
      const flagEnabled = !flag || featureStates[flag];
      const showOauth = flagEnabled && "oauth" in config.authMethods;
      const showApiToken = "api-token" in config.authMethods;
      const showPlatform =
        flagEnabled &&
        platformGloballyEnabled &&
        "platform" in config.authMethods;

      if (!showOauth && !showApiToken && !showPlatform) {
        return [];
      }

      const authMethods: ConnectorSearchAuthMethod[] = [];
      if (showOauth) {
        authMethods.push("oauth");
      }
      if (showApiToken) {
        authMethods.push("api-token");
      }
      if (showPlatform) {
        authMethods.push("platform");
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
