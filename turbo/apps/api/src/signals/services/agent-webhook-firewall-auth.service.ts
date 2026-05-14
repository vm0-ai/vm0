import { Buffer } from "node:buffer";

import type { SecretConnectorMetadata } from "@vm0/api-contracts/contracts/runners";
import { basicAuthTemplateRe } from "@vm0/connectors/firewall-types";
import {
  PROVIDER_HANDLERS,
  type ProviderEnv,
} from "@vm0/connectors/oauth-providers";
import { isChatgptRefreshError } from "@vm0/connectors/oauth-providers/providers/codex-oauth";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { connectors } from "@vm0/db/schema/connector";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import { and, eq, inArray } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { badRequestMessage } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import type { Db } from "../external/db";
import { safeAsync } from "../utils";
import {
  decryptSecretValue,
  decryptSecretsMap,
  encryptSecretValue,
} from "./crypto.utils";

type OAuthSecretSource = "connector" | "model-provider";
type SecretType = OAuthSecretSource;
type ProviderHandler =
  (typeof PROVIDER_HANDLERS)[keyof typeof PROVIDER_HANDLERS];

interface FirewallAuthBody {
  readonly encryptedSecrets: string;
  readonly authHeaders: Record<string, string>;
  readonly authBase?: string;
  readonly authQuery?: Record<string, string>;
  readonly secretConnectorMap?: Record<string, string>;
  readonly secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
  readonly vars?: Record<string, string>;
  readonly forceRefresh?: boolean;
}

interface RefreshResult {
  readonly expiresAt: number | null;
  readonly refreshedConnectors: readonly string[];
  readonly refreshedSecrets: readonly string[];
  readonly failedConnectors: readonly string[];
}

interface RefreshExecutionResult {
  readonly connectorType: string;
  readonly ok: boolean;
}

interface ResolveResult {
  readonly status: 200;
  readonly body: {
    readonly headers: Record<string, string>;
    readonly base?: string;
    readonly query?: Record<string, string>;
    readonly expiresAt: number | null;
    readonly resolvedSecrets: readonly string[];
    readonly refreshedConnectors: readonly string[];
    readonly refreshedSecrets: readonly string[];
  };
}

interface SecretTokenLookupArgs {
  readonly db: Db;
  readonly connectorType: string;
  readonly orgId: string;
  readonly userId: string;
  readonly sourceType: OAuthSecretSource;
  readonly sourceUserId?: string;
}

interface RefreshAccessTokenArgs extends SecretTokenLookupArgs {
  readonly connectorSecrets: Record<string, string>;
  readonly metadataKey?: string;
}

interface RefreshTokenContext {
  readonly refreshTokenSecret: string;
  readonly currentRefreshToken: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly accessTokenSecret: string;
  readonly secretUserId: string;
}

type RefreshableProviderHandler = ProviderHandler & {
  readonly refreshToken: NonNullable<ProviderHandler["refreshToken"]>;
  readonly getRefreshSecretName: NonNullable<
    ProviderHandler["getRefreshSecretName"]
  >;
};

interface SyncRefreshTokensArgs {
  readonly db: Db;
  readonly connectorTypes: readonly string[];
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
}

interface RefreshExpiredTokensArgs {
  readonly db: Db;
  readonly auth: SandboxAuth;
  readonly secrets: Record<string, string>;
  readonly secretConnectorMap: Record<string, string>;
  readonly secretConnectorMetadataMap?:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly forceRefresh: boolean;
}

interface RefreshBatchContext {
  readonly db: Db;
  readonly auth: SandboxAuth;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
  readonly envVarsByConnector: Map<string, readonly string[]>;
}

interface BasicArgContext {
  readonly namespace?: string;
  readonly key?: string;
  readonly literal?: string;
  readonly secrets: Record<string, string>;
  readonly vars: Record<string, string>;
  readonly resolvedKeys: Set<string>;
}

const L = logger("webhook:firewall-auth");
const ORG_SENTINEL_USER_ID = "__org__";
const REFRESH_BUFFER_SECS = 60;
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS = 3600;
const TEMPLATE_RE = /\$\{\{\s*(secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function getRefreshSourceType(handlerKey: string): OAuthSecretSource {
  return handlerKey === "codex-oauth" ? "model-provider" : "connector";
}

function sourceHandlerToProviderType(handlerKey: string): string | undefined {
  return handlerKey === "codex-oauth" ? "codex-oauth-token" : undefined;
}

function resolveSecretUserId(
  sourceType: OAuthSecretSource,
  userId: string,
  sourceUserId?: string,
): string {
  return sourceType === "model-provider"
    ? (sourceUserId ?? ORG_SENTINEL_USER_ID)
    : userId;
}

function resolveRefreshMetadata(
  connectorType: string,
  metadata: SecretConnectorMetadata | undefined,
): SecretConnectorMetadata {
  const sourceType =
    metadata?.sourceType ?? getRefreshSourceType(connectorType);
  return {
    sourceType,
    sourceUserId:
      sourceType === "model-provider" ? metadata?.sourceUserId : undefined,
    metadataKey:
      sourceType === "model-provider"
        ? (metadata?.metadataKey ?? sourceHandlerToProviderType(connectorType))
        : undefined,
  };
}

function providerHandler(connectorType: string) {
  if (!Object.hasOwn(PROVIDER_HANDLERS, connectorType)) {
    return null;
  }
  return PROVIDER_HANDLERS[connectorType as keyof typeof PROVIDER_HANDLERS];
}

function currentProviderEnv(): ProviderEnv {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        return typeof property === "string" ? optionalEnv(property) : undefined;
      },
    },
  ) as ProviderEnv;
}

async function getSecretValue(
  db: Db,
  orgId: string,
  userId: string,
  name: string,
  type: SecretType,
): Promise<string | null> {
  const [row] = await db
    .select({ encryptedValue: secretsTable.encryptedValue })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.orgId, orgId),
        eq(secretsTable.userId, userId),
        eq(secretsTable.name, name),
        eq(secretsTable.type, type),
      ),
    )
    .limit(1);
  return row ? decryptSecretValue(row.encryptedValue) : null;
}

async function upsertSecretValue(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
    readonly value: string;
    readonly type: SecretType;
  },
): Promise<void> {
  const encryptedValue = encryptSecretValue(args.value);
  await db
    .insert(secretsTable)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      encryptedValue,
      type: args.type,
      description:
        args.type === "model-provider"
          ? `Model provider OAuth secret: ${args.name}`
          : `Connector secret: ${args.name}`,
    })
    .onConflictDoUpdate({
      target: [
        secretsTable.orgId,
        secretsTable.userId,
        secretsTable.name,
        secretsTable.type,
      ],
      set: {
        encryptedValue,
        updatedAt: nowDate(),
      },
    });
}

async function getConnectorRefreshToken(
  args: SecretTokenLookupArgs,
): Promise<{ readonly secretName: string; readonly token: string } | null> {
  const handler = providerHandler(args.connectorType);
  if (!handler?.getRefreshSecretName) {
    return null;
  }

  const secretName = handler.getRefreshSecretName();
  const token = await getSecretValue(
    args.db,
    args.orgId,
    resolveSecretUserId(args.sourceType, args.userId, args.sourceUserId),
    secretName,
    args.sourceType,
  );
  return token ? { secretName, token } : null;
}

async function getConnectorAccessToken(
  args: SecretTokenLookupArgs,
): Promise<string | null> {
  const handler = providerHandler(args.connectorType);
  if (!handler) {
    return null;
  }

  return await getSecretValue(
    args.db,
    args.orgId,
    resolveSecretUserId(args.sourceType, args.userId, args.sourceUserId),
    handler.getSecretName(),
    args.sourceType,
  );
}

async function syncRefreshTokensFromDb(
  args: SyncRefreshTokensArgs,
): Promise<void> {
  const results = await Promise.all(
    args.connectorTypes.map((connectorType) => {
      const metadata = resolveRefreshMetadata(
        connectorType,
        args.metadataByConnector.get(connectorType),
      );
      return getConnectorRefreshToken({
        db: args.db,
        connectorType,
        orgId: args.orgId,
        userId: args.userId,
        sourceType: metadata.sourceType,
        sourceUserId: metadata.sourceUserId,
      });
    }),
  );

  for (const result of results) {
    if (result) {
      args.secrets[result.secretName] = result.token;
    }
  }
}

async function getConnectorExpiry(
  db: Db,
  orgId: string,
  userId: string,
  connectorTypes: readonly string[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (connectorTypes.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      type: connectors.type,
      tokenExpiresAt: connectors.tokenExpiresAt,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        inArray(connectors.type, [...connectorTypes]),
      ),
    );

  for (const row of rows) {
    result.set(
      row.type,
      row.tokenExpiresAt
        ? Math.floor(row.tokenExpiresAt.getTime() / 1000)
        : null,
    );
  }
  return result;
}

async function getModelProviderExpiry(
  db: Db,
  orgId: string,
  userId: string,
  modelProviderTypes: readonly string[],
  options: { readonly sourceUserId?: string } = {},
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (modelProviderTypes.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      type: modelProviders.type,
      tokenExpiresAt: modelProviders.tokenExpiresAt,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(
          modelProviders.userId,
          resolveSecretUserId("model-provider", userId, options.sourceUserId),
        ),
        inArray(modelProviders.type, [...modelProviderTypes]),
      ),
    );

  for (const row of rows) {
    result.set(
      row.type,
      row.tokenExpiresAt
        ? Math.floor(row.tokenExpiresAt.getTime() / 1000)
        : null,
    );
  }
  return result;
}

async function getExpiryByHandlerKey(
  db: Db,
  orgId: string,
  userId: string,
  connectorTypes: readonly string[],
  metadataByConnector: Map<string, SecretConnectorMetadata>,
): Promise<Map<string, number | null>> {
  const connectorOnly = connectorTypes.filter((connectorType) => {
    return getRefreshSourceType(connectorType) === "connector";
  });
  const modelProviderHandlerKeys = connectorTypes.filter((connectorType) => {
    return getRefreshSourceType(connectorType) === "model-provider";
  });

  const [connectorExpiry, modelProviderEntries] = await Promise.all([
    getConnectorExpiry(db, orgId, userId, connectorOnly),
    Promise.all(
      modelProviderHandlerKeys.map(async (handlerKey) => {
        const metadata = resolveRefreshMetadata(
          handlerKey,
          metadataByConnector.get(handlerKey),
        );
        const metadataKey =
          metadata.metadataKey ??
          sourceHandlerToProviderType(handlerKey) ??
          handlerKey;
        const expiryMap = await getModelProviderExpiry(
          db,
          orgId,
          userId,
          [metadataKey],
          { sourceUserId: metadata.sourceUserId },
        );
        return [handlerKey, expiryMap.get(metadataKey) ?? null] as const;
      }),
    ),
  ]);

  const merged = new Map<string, number | null>(connectorExpiry);
  for (const [handlerKey, expiry] of modelProviderEntries) {
    merged.set(handlerKey, expiry);
  }
  return merged;
}

function prepareRefreshTokenContext(args: RefreshAccessTokenArgs): {
  readonly handler: RefreshableProviderHandler;
  readonly context: RefreshTokenContext;
} | null {
  const handler = providerHandler(args.connectorType);
  if (!handler?.refreshToken || !handler.getRefreshSecretName) {
    return null;
  }
  const refreshableHandler: RefreshableProviderHandler = {
    ...handler,
    refreshToken: handler.refreshToken,
    getRefreshSecretName: handler.getRefreshSecretName,
  };
  if (args.sourceType === "model-provider" && !args.metadataKey) {
    throw new Error(
      `metadataKey required for model-provider source on ${args.connectorType}`,
    );
  }

  const refreshTokenSecret = refreshableHandler.getRefreshSecretName();
  const currentRefreshToken = args.connectorSecrets[refreshTokenSecret];
  if (!currentRefreshToken) {
    L.debug(`No ${args.connectorType} refresh token available, skipping`);
    return null;
  }

  const env = currentProviderEnv();
  const clientId = handler.getClientId(env);
  if (!clientId) {
    L.debug(
      `${args.connectorType} OAuth client ID not configured, skipping token refresh`,
    );
    return null;
  }

  return {
    handler: refreshableHandler,
    context: {
      refreshTokenSecret,
      currentRefreshToken,
      clientId,
      clientSecret: refreshableHandler.getClientSecret(env),
      accessTokenSecret: refreshableHandler.getSecretName(),
      secretUserId: resolveSecretUserId(
        args.sourceType,
        args.userId,
        args.sourceUserId,
      ),
    },
  };
}

async function markRefreshSuccess(
  args: RefreshAccessTokenArgs,
  context: RefreshTokenContext,
  result: {
    readonly accessToken: string;
    readonly refreshToken: string | null;
    readonly expiresIn?: number;
  },
): Promise<void> {
  await upsertSecretValue(args.db, {
    orgId: args.orgId,
    userId: context.secretUserId,
    name: context.accessTokenSecret,
    value: result.accessToken,
    type: args.sourceType,
  });
  if (result.refreshToken) {
    await upsertSecretValue(args.db, {
      orgId: args.orgId,
      userId: context.secretUserId,
      name: context.refreshTokenSecret,
      value: result.refreshToken,
      type: args.sourceType,
    });
  }

  const expiresAt = new Date(
    nowDate().getTime() +
      (result.expiresIn ?? DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS) * 1000,
  );
  if (args.sourceType === "model-provider") {
    await args.db
      .update(modelProviders)
      .set({
        tokenExpiresAt: expiresAt,
        needsReconnect: false,
        lastRefreshErrorCode: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, context.secretUserId),
          eq(modelProviders.type, args.metadataKey ?? ""),
        ),
      );
    return;
  }

  await args.db
    .update(connectors)
    .set({
      tokenExpiresAt: expiresAt,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.type, args.connectorType),
      ),
    );
}

async function markRefreshFailure(
  args: RefreshAccessTokenArgs,
  context: RefreshTokenContext,
  errorCode: string | null,
): Promise<void> {
  if (args.sourceType === "model-provider") {
    await args.db
      .update(modelProviders)
      .set({
        needsReconnect: true,
        lastRefreshErrorCode: errorCode,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, context.secretUserId),
          eq(modelProviders.type, args.metadataKey ?? ""),
        ),
      );
    return;
  }

  await args.db
    .update(connectors)
    .set({
      needsReconnect: true,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.type, args.connectorType),
      ),
    );
}

async function refreshConnectorAccessToken(
  args: RefreshAccessTokenArgs,
): Promise<string | null> {
  const prepared = prepareRefreshTokenContext(args);
  if (!prepared) {
    return null;
  }

  const refreshResult = await safeAsync(() => {
    return prepared.handler.refreshToken(
      prepared.context.clientId,
      prepared.context.clientSecret ?? "",
      prepared.context.currentRefreshToken,
    );
  });

  if ("error" in refreshResult) {
    const error = refreshResult.error;
    const message = error instanceof Error ? error.message : "Unknown error";
    const errorCode = isChatgptRefreshError(error) ? error.code : null;
    L.warn(`${args.connectorType} token refresh failed: ${message}`, {
      connectorType: args.connectorType,
      orgId: args.orgId,
      userId: args.userId,
      errorCode,
    });

    await markRefreshFailure(args, prepared.context, errorCode);
    return null;
  }

  const result = refreshResult.ok;
  await markRefreshSuccess(args, prepared.context, result);
  args.connectorSecrets[prepared.context.accessTokenSecret] =
    result.accessToken;
  if (result.refreshToken) {
    args.connectorSecrets[prepared.context.refreshTokenSecret] =
      result.refreshToken;
  }
  L.debug(`${args.connectorType} access token refreshed successfully`);
  return result.accessToken;
}

function buildMetadataByConnector(
  refreshable: Map<string, string>,
  secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined,
): Map<string, SecretConnectorMetadata> {
  const metadataByConnector = new Map<string, SecretConnectorMetadata>();
  for (const [key, connectorType] of refreshable) {
    const metadata = secretConnectorMetadataMap?.[key];
    if (metadata && !metadataByConnector.has(connectorType)) {
      metadataByConnector.set(connectorType, metadata);
    }
  }
  return metadataByConnector;
}

function hasForbiddenModelProviderOwner(
  auth: SandboxAuth,
  secretConnectorMap: Record<string, string>,
  secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined,
  referencedKeys: Set<string>,
): boolean {
  for (const key of referencedKeys) {
    const connectorType = secretConnectorMap[key];
    if (!connectorType) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      connectorType,
      secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "model-provider") {
      continue;
    }

    const ownerUserId = metadata.sourceUserId ?? ORG_SENTINEL_USER_ID;
    if (ownerUserId !== auth.userId && ownerUserId !== ORG_SENTINEL_USER_ID) {
      L.warn(`[${auth.runId}] Rejected forbidden model-provider owner`, {
        ownerUserId,
        connectorType,
        secretKey: key,
      });
      return true;
    }
  }
  return false;
}

const emptyRefreshResult = Object.freeze({
  expiresAt: null,
  refreshedConnectors: [],
  refreshedSecrets: [],
  failedConnectors: [],
}) satisfies RefreshResult;

function buildRefreshableMap(
  secretConnectorMap: Record<string, string>,
  referencedKeys: Set<string>,
): Map<string, string> {
  const refreshable = new Map<string, string>();
  for (const key of referencedKeys) {
    const connectorType = secretConnectorMap[key];
    if (connectorType) {
      refreshable.set(key, connectorType);
    }
  }
  return refreshable;
}

async function findRefreshRunOrgId(
  db: Db,
  auth: SandboxAuth,
): Promise<string | null> {
  const [run] = await db
    .select({ orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, auth.runId), eq(agentRuns.userId, auth.userId)))
    .limit(1);
  return run?.orgId ?? null;
}

function connectorTypesNeedingRefresh(args: {
  readonly connectorTypes: readonly string[];
  readonly expiryMap: Map<string, number | null>;
  readonly forceRefresh: boolean;
}): readonly string[] {
  const nowSeconds = Math.floor(nowDate().getTime() / 1000);
  return args.connectorTypes.filter((connectorType) => {
    if (args.forceRefresh) {
      return true;
    }
    const tokenExpiry = args.expiryMap.get(connectorType);
    if (tokenExpiry === undefined || tokenExpiry === null) {
      return true;
    }
    return tokenExpiry <= nowSeconds + REFRESH_BUFFER_SECS;
  });
}

function buildEnvVarsByConnector(
  refreshable: Map<string, string>,
): Map<string, readonly string[]> {
  const envVarsByConnector = new Map<string, string[]>();
  for (const [envVar, connectorType] of refreshable) {
    const envVars = envVarsByConnector.get(connectorType) ?? [];
    envVars.push(envVar);
    envVarsByConnector.set(connectorType, envVars);
  }
  return envVarsByConnector;
}

async function refreshSelectedTokens(
  context: RefreshBatchContext,
  connectorTypes: readonly string[],
): Promise<readonly RefreshExecutionResult[]> {
  return await Promise.all(
    connectorTypes.map(async (connectorType) => {
      L.debug(
        `[${context.auth.runId}] Refreshing expired ${connectorType} token`,
      );
      const metadata = resolveRefreshMetadata(
        connectorType,
        context.metadataByConnector.get(connectorType),
      );
      const freshToken = await refreshConnectorAccessToken({
        db: context.db,
        connectorType,
        orgId: context.orgId,
        userId: context.userId,
        sourceType: metadata.sourceType,
        sourceUserId: metadata.sourceUserId,
        metadataKey: metadata.metadataKey,
        connectorSecrets: context.secrets,
      });
      if (!freshToken) {
        L.warn(
          `[${context.auth.runId}] Failed to refresh ${connectorType} token`,
          {
            sourceType: metadata.sourceType,
            sourceUserId: metadata.sourceUserId,
            metadataKey: metadata.metadataKey,
          },
        );
        return { connectorType, ok: false };
      }

      for (const envVar of context.envVarsByConnector.get(connectorType) ??
        []) {
        context.secrets[envVar] = freshToken;
      }
      return { connectorType, ok: true };
    }),
  );
}

async function syncSkippedTokens(
  context: RefreshBatchContext,
  skippedTypes: readonly string[],
): Promise<void> {
  const currentTokens = await Promise.all(
    skippedTypes.map(async (connectorType) => {
      const metadata = resolveRefreshMetadata(
        connectorType,
        context.metadataByConnector.get(connectorType),
      );
      return {
        connectorType,
        token: await getConnectorAccessToken({
          db: context.db,
          connectorType,
          orgId: context.orgId,
          userId: context.userId,
          sourceType: metadata.sourceType,
          sourceUserId: metadata.sourceUserId,
        }),
      };
    }),
  );
  for (const { connectorType, token } of currentTokens) {
    if (!token) {
      L.warn(
        `[${context.auth.runId}] No DB token for skipped connector ${connectorType}, using encryptedSecrets value`,
      );
      continue;
    }
    for (const envVar of context.envVarsByConnector.get(connectorType) ?? []) {
      context.secrets[envVar] = token;
    }
  }
}

function summarizeRefreshResults(
  refreshResults: readonly RefreshExecutionResult[],
  envVarsByConnector: Map<string, readonly string[]>,
): Pick<
  RefreshResult,
  "refreshedConnectors" | "refreshedSecrets" | "failedConnectors"
> {
  const refreshedConnectors = refreshResults
    .filter((result) => {
      return result.ok;
    })
    .map((result) => {
      return result.connectorType;
    });
  const refreshedSecrets = refreshedConnectors
    .flatMap((connectorType) => {
      return envVarsByConnector.get(connectorType) ?? [];
    })
    .sort();
  const failedConnectors = refreshResults
    .filter((result) => {
      return !result.ok;
    })
    .map((result) => {
      return result.connectorType;
    });

  return { refreshedConnectors, refreshedSecrets, failedConnectors };
}

function earliestConnectorExpiry(
  connectorTypes: readonly string[],
  finalExpiryMap: Map<string, number | null>,
): number | null {
  let earliestExpiry: number | null = null;
  for (const connectorType of connectorTypes) {
    const expiry = finalExpiryMap.get(connectorType);
    if (expiry !== undefined && expiry !== null) {
      earliestExpiry =
        earliestExpiry === null ? expiry : Math.min(earliestExpiry, expiry);
    }
  }
  return earliestExpiry;
}

async function refreshExpiredTokens(
  args: RefreshExpiredTokensArgs,
): Promise<RefreshResult> {
  const refreshable = buildRefreshableMap(
    args.secretConnectorMap,
    args.referencedKeys,
  );
  if (refreshable.size === 0) {
    return emptyRefreshResult;
  }

  const orgId = await findRefreshRunOrgId(args.db, args.auth);
  if (!orgId) {
    L.warn(`[${args.auth.runId}] Run not found for token refresh`);
    return emptyRefreshResult;
  }

  const connectorTypes = [...new Set(refreshable.values())];
  const metadataByConnector = buildMetadataByConnector(
    refreshable,
    args.secretConnectorMetadataMap,
  );
  const expiryMap = await getExpiryByHandlerKey(
    args.db,
    orgId,
    args.auth.userId,
    connectorTypes,
    metadataByConnector,
  );
  const toRefresh = connectorTypesNeedingRefresh({
    connectorTypes,
    expiryMap,
    forceRefresh: args.forceRefresh,
  });
  const envVarsByConnector = buildEnvVarsByConnector(refreshable);

  await syncRefreshTokensFromDb({
    db: args.db,
    connectorTypes: toRefresh,
    orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    metadataByConnector,
  });

  const context = {
    db: args.db,
    auth: args.auth,
    orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    metadataByConnector,
    envVarsByConnector,
  } satisfies RefreshBatchContext;
  const refreshResults = await refreshSelectedTokens(context, toRefresh);
  const skippedTypes = connectorTypes.filter((connectorType) => {
    return !toRefresh.includes(connectorType);
  });
  await syncSkippedTokens(context, skippedTypes);

  const summary = summarizeRefreshResults(refreshResults, envVarsByConnector);
  const finalExpiryMap =
    summary.refreshedConnectors.length > 0
      ? await getExpiryByHandlerKey(
          args.db,
          orgId,
          args.auth.userId,
          connectorTypes,
          metadataByConnector,
        )
      : expiryMap;

  return {
    expiresAt: earliestConnectorExpiry(connectorTypes, finalExpiryMap),
    ...summary,
  };
}

function collectReferencedKeys(
  authHeaders: Record<string, string>,
  authBase?: string,
  authQuery?: Record<string, string>,
): { readonly secrets: Set<string>; readonly vars: Set<string> } {
  const secretKeys = new Set<string>();
  const varKeys = new Set<string>();
  const addKey = (namespace: string, key: string): void => {
    if (namespace === "secrets") {
      secretKeys.add(key);
    } else if (namespace === "vars") {
      varKeys.add(key);
    }
  };

  for (const template of Object.values(authHeaders)) {
    for (const match of template.matchAll(TEMPLATE_RE)) {
      if (match[1] && match[2]) {
        addKey(match[1], match[2]);
      }
    }
    for (const match of template.matchAll(basicAuthTemplateRe())) {
      if (match[1] && match[2]) {
        addKey(match[1], match[2]);
      }
      if (match[4] && match[5]) {
        addKey(match[4], match[5]);
      }
    }
  }

  if (authBase) {
    for (const match of authBase.matchAll(TEMPLATE_RE)) {
      if (match[1] && match[2]) {
        addKey(match[1], match[2]);
      }
    }
  }

  if (authQuery) {
    for (const template of Object.values(authQuery)) {
      for (const match of template.matchAll(TEMPLATE_RE)) {
        if (match[1] && match[2]) {
          addKey(match[1], match[2]);
        }
      }
    }
  }

  return { secrets: secretKeys, vars: varKeys };
}

function stringMatchGroup(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveBasicArg(context: BasicArgContext): string {
  if (context.literal !== undefined) {
    return context.literal;
  }
  if (!context.namespace || !context.key) {
    return "";
  }
  if (context.namespace === "secrets") {
    context.resolvedKeys.add(context.key);
    return context.secrets[context.key] ?? "";
  }
  return context.vars[context.key] ?? "";
}

function resolveTemplates(
  authHeaders: Record<string, string>,
  secrets: Record<string, string>,
  vars: Record<string, string>,
  authBase?: string,
  authQuery?: Record<string, string>,
): {
  readonly headers: Record<string, string>;
  readonly resolvedSecrets: readonly string[];
  readonly base?: string;
  readonly query?: Record<string, string>;
} {
  const resolvedKeys = new Set<string>();

  const resolveSimple = (template: string): string => {
    return template.replace(
      TEMPLATE_RE,
      (_match, namespace: string, key: string) => {
        if (namespace === "secrets") {
          resolvedKeys.add(key);
          return secrets[key] ?? "";
        }
        return vars[key] ?? "";
      },
    );
  };

  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(authHeaders)) {
    let resolved = template.replace(
      basicAuthTemplateRe(),
      (...matches: readonly unknown[]) => {
        const user = resolveBasicArg({
          namespace: stringMatchGroup(matches[1]),
          key: stringMatchGroup(matches[2]),
          literal: stringMatchGroup(matches[3]),
          secrets,
          vars,
          resolvedKeys,
        });
        const pass = resolveBasicArg({
          namespace: stringMatchGroup(matches[4]),
          key: stringMatchGroup(matches[5]),
          literal: stringMatchGroup(matches[6]),
          secrets,
          vars,
          resolvedKeys,
        });
        return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      },
    );
    resolved = resolveSimple(resolved);
    headers[name] = resolved;
  }

  return {
    headers,
    resolvedSecrets: [...resolvedKeys].sort(),
    base: authBase ? resolveSimple(authBase) : undefined,
    query: authQuery
      ? Object.fromEntries(
          Object.entries(authQuery).map(([key, value]) => {
            return [key, resolveSimple(value)];
          }),
        )
      : undefined,
  };
}

export async function resolveFirewallAuth(
  db: Db,
  auth: SandboxAuth,
  body: FirewallAuthBody,
): Promise<
  | ResolveResult
  | ReturnType<typeof badRequestMessage>
  | {
      readonly status: 403 | 424 | 502;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: string;
          readonly connectors?: readonly string[];
        };
      };
    }
> {
  const decryptedResult = await safeAsync(() => {
    return Promise.resolve(decryptSecretsMap(body.encryptedSecrets));
  });
  const decryptedSecrets =
    "error" in decryptedResult ? null : decryptedResult.ok;

  if (!decryptedSecrets) {
    return badRequestMessage("Failed to decrypt secrets");
  }

  const referenced = collectReferencedKeys(
    body.authHeaders,
    body.authBase,
    body.authQuery,
  );

  const hasMissingSecrets = [...referenced.secrets].some((key) => {
    return !(key in decryptedSecrets);
  });
  const hasMissingVars = [...referenced.vars].some((key) => {
    return !(key in (body.vars ?? {}));
  });
  if (hasMissingSecrets || hasMissingVars) {
    return {
      status: 424,
      body: {
        error: {
          message: "Connector not configured",
          code: "CONNECTOR_NOT_CONFIGURED",
        },
      },
    };
  }

  let expiresAt: number | null = null;
  let refreshedConnectors: readonly string[] = [];
  let refreshedSecrets: readonly string[] = [];
  let failedConnectors: readonly string[] = [];

  if (body.secretConnectorMap) {
    if (
      hasForbiddenModelProviderOwner(
        auth,
        body.secretConnectorMap,
        body.secretConnectorMetadataMap,
        referenced.secrets,
      )
    ) {
      return {
        status: 403,
        body: {
          error: {
            message: "Invalid model-provider secret owner",
            code: "FORBIDDEN",
          },
        },
      };
    }

    const result = await refreshExpiredTokens({
      db,
      auth,
      secrets: decryptedSecrets,
      secretConnectorMap: body.secretConnectorMap,
      secretConnectorMetadataMap: body.secretConnectorMetadataMap,
      referencedKeys: referenced.secrets,
      forceRefresh: body.forceRefresh ?? false,
    });
    expiresAt = result.expiresAt;
    refreshedConnectors = result.refreshedConnectors;
    refreshedSecrets = result.refreshedSecrets;
    failedConnectors = result.failedConnectors;
  }

  if (failedConnectors.length > 0) {
    return {
      status: 502,
      body: {
        error: {
          message: `OAuth token expired and refresh failed for: ${failedConnectors.join(", ")}. The connector may need to be reconnected.`,
          code: "TOKEN_REFRESH_FAILED",
          connectors: failedConnectors,
        },
      },
    };
  }

  const resolved = resolveTemplates(
    body.authHeaders,
    decryptedSecrets,
    body.vars ?? {},
    body.authBase,
    body.authQuery,
  );

  return {
    status: 200,
    body: {
      headers: resolved.headers,
      base: resolved.base,
      query: resolved.query,
      expiresAt,
      resolvedSecrets: resolved.resolvedSecrets,
      refreshedConnectors,
      refreshedSecrets,
    },
  };
}
