import { Buffer } from "node:buffer";

import type { SecretConnectorMetadata } from "@vm0/api-contracts/contracts/runners";
import {
  getConnectorOAuthCredentials,
  type ConnectorOAuthCredentials,
} from "@vm0/connectors/connector-utils";
import type { OAuthConnectorType } from "@vm0/connectors/connectors";
import { basicAuthTemplateRe } from "@vm0/connectors/firewall-types";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import {
  getConnectorOAuthSecretMetadata,
  isOAuthConnectorType,
  refreshConnectorOAuthToken,
  type ProviderEnv,
} from "@vm0/connectors/auth-providers";
import {
  getModelProviderOAuthSecretMetadata,
  isModelProviderOAuthRefreshConfigured,
  refreshModelProviderOAuthToken,
  isModelProviderOAuthProviderKey,
  type ModelProviderOAuthProviderKey,
} from "@vm0/connectors/auth-providers/model-provider-auth";
import { isChatgptRefreshError } from "@vm0/connectors/auth-providers/oauth/providers/codex-oauth";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { connectors } from "@vm0/db/schema/connector";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import { and, eq, inArray } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { badRequestMessage, insufficientCredits } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  decryptPersistentSecretsMap,
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveOrgCreditAvailability } from "./zero-run-admission.service";

type OAuthSecretSource = "connector" | "model-provider";
type SecretType = OAuthSecretSource;

const NORMAL_BILLABLE_FIREWALL_LEASE_SECONDS = 30;
const LOW_BILLABLE_FIREWALL_LEASE_SECONDS = 5;
const LOW_BILLABLE_FIREWALL_CREDIT_THRESHOLD = 1000;

interface FirewallAuthBody {
  readonly encryptedSecrets: string;
  readonly authHeaders: Record<string, string>;
  readonly authBase?: string;
  readonly authQuery?: Record<string, string>;
  readonly secretConnectorMap?: Record<string, string>;
  readonly secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
  readonly vars?: Record<string, string>;
  readonly firewallBillable?: boolean;
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

type ResolveFirewallAuthResult =
  | ResolveResult
  | ReturnType<typeof badRequestMessage>
  | {
      readonly status: 402 | 403 | 424 | 502;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: string;
          readonly connectors?: readonly string[];
        };
      };
    };

function mergeExpiresAt(
  expiresAt: number | null,
  additionalExpiresAt: number | undefined,
): number | null {
  if (additionalExpiresAt === undefined) {
    return expiresAt;
  }
  if (expiresAt === null) {
    return additionalExpiresAt;
  }
  return Math.min(expiresAt, additionalExpiresAt);
}

async function resolveBillableFirewallCacheExpiry(params: {
  readonly db: Db;
  readonly auth: SandboxAuth;
  readonly firewallBillable: boolean | undefined;
}): Promise<
  { readonly expiresAt?: number } | ReturnType<typeof insufficientCredits>
> {
  if (params.firewallBillable !== true) {
    return {};
  }

  const availability = await resolveOrgCreditAvailability({
    db: params.db,
    orgId: params.auth.orgId,
  });
  if (!availability) {
    return insufficientCredits();
  }
  if (availability.tier === "pro-suspend") {
    return insufficientCredits();
  }
  if (availability.spendableCredits <= 0) {
    return insufficientCredits();
  }

  const leaseSeconds =
    availability.spendableCredits <= LOW_BILLABLE_FIREWALL_CREDIT_THRESHOLD
      ? LOW_BILLABLE_FIREWALL_LEASE_SECONDS
      : NORMAL_BILLABLE_FIREWALL_LEASE_SECONDS;

  return {
    expiresAt: Math.floor(nowDate().getTime() / 1000) + leaseSeconds,
  };
}

interface SecretTokenLookupArgs {
  readonly db: Db;
  readonly connectorType: string;
  readonly orgId: string;
  readonly userId: string;
  readonly sourceType: OAuthSecretSource;
  readonly sourceUserId?: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface RefreshAccessTokenArgs extends SecretTokenLookupArgs {
  readonly connectorSecrets: Record<string, string>;
  readonly metadataKey?: string;
}

interface RefreshTokenContext {
  readonly refreshTokenSecret: string;
  readonly currentRefreshToken: string;
  readonly accessTokenSecret: string;
  readonly secretUserId: string;
}

type PreparedRefreshTokenContext =
  | {
      readonly sourceType: "connector";
      readonly connectorType: OAuthConnectorType;
      readonly credentials: ConnectorOAuthCredentials;
      readonly context: RefreshTokenContext;
    }
  | {
      readonly sourceType: "model-provider";
      readonly providerKey: ModelProviderOAuthProviderKey;
      readonly currentEnv: ProviderEnv;
      readonly context: RefreshTokenContext;
    };

interface SyncRefreshTokensArgs {
  readonly db: Db;
  readonly connectorTypes: readonly string[];
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
  readonly featureSwitchContext: FeatureSwitchContext;
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
  readonly featureSwitchContext: FeatureSwitchContext;
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
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS = 15 * 60;
const TEMPLATE_RE = /\$\{\{\s*(secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function getOAuthProviderKeySourceType(providerKey: string): OAuthSecretSource {
  return isModelProviderOAuthProviderKey(providerKey)
    ? "model-provider"
    : "connector";
}

function modelProviderTypeForOAuthProviderKey(
  providerKey: string,
): string | undefined {
  return isModelProviderOAuthProviderKey(providerKey) ? providerKey : undefined;
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
    metadata?.sourceType ?? getOAuthProviderKeySourceType(connectorType);
  return {
    sourceType,
    sourceUserId:
      sourceType === "model-provider" ? metadata?.sourceUserId : undefined,
    metadataKey:
      sourceType === "model-provider"
        ? (metadata?.metadataKey ??
          modelProviderTypeForOAuthProviderKey(connectorType))
        : undefined,
  };
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

async function getSecretValue(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly type: SecretType;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<string | null> {
  const [row] = await args.db
    .select({ encryptedValue: secretsTable.encryptedValue })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
        eq(secretsTable.name, args.name),
        eq(secretsTable.type, args.type),
      ),
    )
    .limit(1);
  return row
    ? await decryptStoredSecretValue(
        row.encryptedValue,
        args.featureSwitchContext,
      )
    : null;
}

async function upsertSecretValue(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
    readonly value: string;
    readonly type: SecretType;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Promise<void> {
  const encryptedValue = await encryptStoredSecretValue(
    args.value,
    args.featureSwitchContext,
  );
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

function getRefreshSecretNameForSource(
  connectorType: string,
  sourceType: OAuthSecretSource,
): string | undefined {
  if (sourceType === "model-provider") {
    const metadata = getModelProviderOAuthSecretMetadata(connectorType);
    return metadata?.isRefreshable ? metadata.refreshSecretName : undefined;
  }

  const metadata = getConnectorOAuthSecretMetadata(connectorType);
  return metadata?.isRefreshable ? metadata.refreshSecretName : undefined;
}

function getAccessSecretNameForSource(
  connectorType: string,
  sourceType: OAuthSecretSource,
): string | undefined {
  if (sourceType === "model-provider") {
    return getModelProviderOAuthSecretMetadata(connectorType)?.accessSecretName;
  }

  return getConnectorOAuthSecretMetadata(connectorType)?.accessSecretName;
}

async function getConnectorRefreshToken(
  args: SecretTokenLookupArgs,
): Promise<{ readonly secretName: string; readonly token: string } | null> {
  const secretName = getRefreshSecretNameForSource(
    args.connectorType,
    args.sourceType,
  );
  if (!secretName) {
    return null;
  }

  const token = await getSecretValue({
    db: args.db,
    orgId: args.orgId,
    userId: resolveSecretUserId(
      args.sourceType,
      args.userId,
      args.sourceUserId,
    ),
    name: secretName,
    type: args.sourceType,
    featureSwitchContext: args.featureSwitchContext,
  });
  return token ? { secretName, token } : null;
}

async function getConnectorAccessToken(
  args: SecretTokenLookupArgs,
): Promise<string | null> {
  const secretName = getAccessSecretNameForSource(
    args.connectorType,
    args.sourceType,
  );
  if (!secretName) {
    return null;
  }

  return await getSecretValue({
    db: args.db,
    orgId: args.orgId,
    userId: resolveSecretUserId(
      args.sourceType,
      args.userId,
      args.sourceUserId,
    ),
    name: secretName,
    type: args.sourceType,
    featureSwitchContext: args.featureSwitchContext,
  });
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
        featureSwitchContext: args.featureSwitchContext,
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

async function getExpiryByProviderKey(
  db: Db,
  orgId: string,
  userId: string,
  connectorTypes: readonly string[],
  metadataByConnector: Map<string, SecretConnectorMetadata>,
): Promise<Map<string, number | null>> {
  const connectorOnly = connectorTypes.filter((connectorType) => {
    return getOAuthProviderKeySourceType(connectorType) === "connector";
  });
  const modelProviderOAuthProviderKeys = connectorTypes.filter(
    (connectorType) => {
      return getOAuthProviderKeySourceType(connectorType) === "model-provider";
    },
  );

  const [connectorExpiry, modelProviderEntries] = await Promise.all([
    getConnectorExpiry(db, orgId, userId, connectorOnly),
    Promise.all(
      modelProviderOAuthProviderKeys.map(async (providerKey) => {
        const metadata = resolveRefreshMetadata(
          providerKey,
          metadataByConnector.get(providerKey),
        );
        const metadataKey =
          metadata.metadataKey ??
          modelProviderTypeForOAuthProviderKey(providerKey) ??
          providerKey;
        const expiryMap = await getModelProviderExpiry(
          db,
          orgId,
          userId,
          [metadataKey],
          { sourceUserId: metadata.sourceUserId },
        );
        return [providerKey, expiryMap.get(metadataKey) ?? null] as const;
      }),
    ),
  ]);

  const merged = new Map<string, number | null>(connectorExpiry);
  for (const [providerKey, expiry] of modelProviderEntries) {
    merged.set(providerKey, expiry);
  }
  return merged;
}

function prepareRefreshTokenContext(
  args: RefreshAccessTokenArgs,
): PreparedRefreshTokenContext | null {
  if (args.sourceType === "model-provider") {
    if (!isModelProviderOAuthProviderKey(args.connectorType)) {
      return null;
    }
    const secretMetadata = getModelProviderOAuthSecretMetadata(
      args.connectorType,
    );
    if (!secretMetadata.isRefreshable) {
      return null;
    }
    if (!args.metadataKey) {
      throw new Error(
        `metadataKey required for model-provider source on ${args.connectorType}`,
      );
    }

    const refreshTokenSecret = secretMetadata.refreshSecretName;
    const currentRefreshToken = args.connectorSecrets[refreshTokenSecret];
    if (!currentRefreshToken) {
      L.debug(`No ${args.connectorType} refresh token available, skipping`);
      return null;
    }

    const env = currentProviderEnv();
    if (
      !isModelProviderOAuthRefreshConfigured({
        providerKey: args.connectorType,
        currentEnv: env,
      })
    ) {
      L.debug(
        `${args.connectorType} OAuth client ID not configured, skipping token refresh`,
      );
      return null;
    }

    const context: RefreshTokenContext = {
      refreshTokenSecret,
      currentRefreshToken,
      accessTokenSecret: secretMetadata.accessSecretName,
      secretUserId: resolveSecretUserId(
        args.sourceType,
        args.userId,
        args.sourceUserId,
      ),
    };

    return {
      sourceType: args.sourceType,
      providerKey: args.connectorType,
      currentEnv: env,
      context,
    };
  }

  if (!isOAuthConnectorType(args.connectorType)) {
    L.debug(`${args.connectorType} is not an OAuth connector type, skipping`);
    return null;
  }
  const secretMetadata = getConnectorOAuthSecretMetadata(args.connectorType);
  if (!secretMetadata.isRefreshable) {
    return null;
  }
  const credentials = getConnectorOAuthCredentials(
    args.connectorType,
    (name) => {
      return optionalEnv(name);
    },
  );
  if (!credentials?.configured) {
    L.debug(
      `${args.connectorType} OAuth credentials not configured, skipping token refresh`,
    );
    return null;
  }

  const refreshTokenSecret = secretMetadata.refreshSecretName;
  const currentRefreshToken = args.connectorSecrets[refreshTokenSecret];
  if (!currentRefreshToken) {
    L.debug(`No ${args.connectorType} refresh token available, skipping`);
    return null;
  }

  const context: RefreshTokenContext = {
    refreshTokenSecret,
    currentRefreshToken,
    accessTokenSecret: secretMetadata.accessSecretName,
    secretUserId: resolveSecretUserId(
      args.sourceType,
      args.userId,
      args.sourceUserId,
    ),
  };

  return {
    sourceType: "connector",
    connectorType: args.connectorType,
    credentials,
    context,
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
    featureSwitchContext: args.featureSwitchContext,
  });
  if (result.refreshToken) {
    await upsertSecretValue(args.db, {
      orgId: args.orgId,
      userId: context.secretUserId,
      name: context.refreshTokenSecret,
      value: result.refreshToken,
      type: args.sourceType,
      featureSwitchContext: args.featureSwitchContext,
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

  const refreshPromise =
    prepared.sourceType === "connector"
      ? refreshConnectorOAuthToken({
          type: prepared.connectorType,
          credentials: prepared.credentials,
          refreshToken: prepared.context.currentRefreshToken,
        })
      : refreshModelProviderOAuthToken({
          providerKey: prepared.providerKey,
          currentEnv: prepared.currentEnv,
          refreshToken: prepared.context.currentRefreshToken,
        });
  const refreshResult = await settle(refreshPromise);

  if (!refreshResult.ok) {
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

  const result = refreshResult.value;
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

async function decryptFirewallAuthSecrets(
  db: Db,
  auth: SandboxAuth,
  encryptedSecrets: string,
): Promise<
  | { readonly ok: true; readonly secrets: Record<string, string> | null }
  | {
      readonly ok: false;
      readonly response: ReturnType<typeof badRequestMessage>;
    }
> {
  const orgId = await findRefreshRunOrgId(db, auth);
  if (!orgId) {
    L.warn(`[${auth.runId}] Run not found for firewall auth`);
    return { ok: false, response: badRequestMessage("Run not found") };
  }

  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    orgId,
    auth.userId,
  );
  const decryptedResult = await settle(
    decryptPersistentSecretsMap(encryptedSecrets, featureSwitchContext),
  );
  return {
    ok: true,
    secrets: decryptedResult.ok ? decryptedResult.value : null,
  };
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
        featureSwitchContext: context.featureSwitchContext,
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
          featureSwitchContext: context.featureSwitchContext,
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

  const featureSwitchContext = await loadUserFeatureSwitchContext(
    args.db,
    orgId,
    args.auth.userId,
  );

  const connectorTypes = [...new Set(refreshable.values())];
  const metadataByConnector = buildMetadataByConnector(
    refreshable,
    args.secretConnectorMetadataMap,
  );
  const expiryMap = await getExpiryByProviderKey(
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
    featureSwitchContext,
  });

  const context = {
    db: args.db,
    auth: args.auth,
    orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    metadataByConnector,
    envVarsByConnector,
    featureSwitchContext,
  } satisfies RefreshBatchContext;
  const refreshResults = await refreshSelectedTokens(context, toRefresh);
  const skippedTypes = connectorTypes.filter((connectorType) => {
    return !toRefresh.includes(connectorType);
  });
  await syncSkippedTokens(context, skippedTypes);

  const summary = summarizeRefreshResults(refreshResults, envVarsByConnector);
  const finalExpiryMap =
    summary.refreshedConnectors.length > 0
      ? await getExpiryByProviderKey(
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
): Promise<ResolveFirewallAuthResult> {
  const decrypted = await decryptFirewallAuthSecrets(
    db,
    auth,
    body.encryptedSecrets,
  );
  if (!decrypted.ok) {
    return decrypted.response;
  }
  const decryptedSecrets = decrypted.secrets;

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

  if (
    body.secretConnectorMap &&
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

  const billableCacheExpiry = await resolveBillableFirewallCacheExpiry({
    db,
    auth,
    firewallBillable: body.firewallBillable,
  });
  if ("status" in billableCacheExpiry) {
    return billableCacheExpiry;
  }

  let expiresAt: number | null = null;
  let refreshedConnectors: readonly string[] = [];
  let refreshedSecrets: readonly string[] = [];
  let failedConnectors: readonly string[] = [];

  if (body.secretConnectorMap) {
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
      expiresAt: mergeExpiresAt(expiresAt, billableCacheExpiry.expiresAt),
      resolvedSecrets: resolved.resolvedSecrets,
      refreshedConnectors,
      refreshedSecrets,
    },
  };
}
