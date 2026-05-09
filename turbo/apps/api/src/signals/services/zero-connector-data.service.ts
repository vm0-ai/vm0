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
  getConfiguredConnectorTypes,
  getConnectorProvidedSecretNames,
  getScopeDiff,
} from "@vm0/connectors/connector-utils";
import {
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
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
    const [oauthRows, derivedTypes] = await Promise.all([
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
    ]);

    const dbConnectors: ConnectorResponse[] = oauthRows.flatMap((row) => {
      const parsed = connectorTypeSchema.safeParse(row.type);
      if (!parsed.success) {
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
      configuredTypes: getConfiguredConnectorTypes((name) => {
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
    return (Object.keys(CONNECTOR_TYPES) as ConnectorType[]).flatMap((type) => {
      const config = CONNECTOR_TYPES[type];
      const flag = config.featureFlag;
      const flagEnabled = !flag || featureStates[flag];
      const showOauth = flagEnabled && "oauth" in config.authMethods;
      const showApiToken =
        "api-token" in config.authMethods &&
        (flagEnabled || !config.strictFeatureFlag);

      if (!showOauth && !showApiToken) {
        return [];
      }

      const authMethods: ConnectorSearchAuthMethod[] = [];
      if (showOauth) {
        authMethods.push("oauth");
      }
      if (showApiToken) {
        authMethods.push("api-token");
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
