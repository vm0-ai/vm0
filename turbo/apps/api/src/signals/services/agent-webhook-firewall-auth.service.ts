import { Buffer } from "node:buffer";

import {
  getModelProviderEnvBindings,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import type { SecretConnectorMetadata } from "@vm0/api-contracts/contracts/runners";
import {
  resolveConnectorAuthClientForMethod,
  getConnectorAuthMethodAccessMetadata,
  type ConnectorAuthMethodAccessMetadata,
} from "@vm0/connectors/connector-utils";
import {
  connectorTypeSchema,
  type ConnectorAuthProviderType,
} from "@vm0/connectors/connectors";
import {
  parseBasicAuthTemplates,
  replaceBasicAuthTemplates,
  type BasicAuthTemplateArg,
  type BasicAuthTemplateMatch,
} from "@vm0/connectors/firewall-types";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import {
  getConnectorAuthProviderClientArgs,
  hasConnectorAuthProvider,
  refreshConnectorAuthProviderAccessToken,
  type ConnectorAuthProviderClientArgs,
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

type AccessSecretSource = "connector" | "model-provider";
type SecretType = AccessSecretSource;
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
  readonly status: "refreshed" | "failed";
}

interface ReferencedAuthKeys {
  readonly secrets: Set<string>;
  readonly vars: Set<string>;
}

interface FirewallAuthResolutionContext {
  readonly referenced: ReferencedAuthKeys;
  readonly vars: Record<string, string>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
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

function connectorNotConfigured(): ResolveFirewallAuthResult {
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

function forbiddenModelProviderOwner(): ResolveFirewallAuthResult {
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

function tokenRefreshFailed(
  failedConnectors: readonly string[],
): ResolveFirewallAuthResult {
  return {
    status: 502,
    body: {
      error: {
        message: `Access token expired and refresh failed for: ${failedConnectors.join(", ")}. The connector may need to be reconnected.`,
        code: "TOKEN_REFRESH_FAILED",
        connectors: failedConnectors,
      },
    },
  };
}

function tokenAccessResolutionFailed(
  failedConnectors: readonly string[],
): ResolveFirewallAuthResult {
  return {
    status: 502,
    body: {
      error: {
        message: `Token access resolution failed for: ${failedConnectors.join(", ")}. The connector may need to be reconnected.`,
        code: "TOKEN_ACCESS_RESOLUTION_FAILED",
        connectors: failedConnectors,
      },
    },
  };
}

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
  readonly sourceType: AccessSecretSource;
  readonly sourceUserId?: string;
  readonly metadataKey?: string;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface RefreshAccessTokenArgs extends SecretTokenLookupArgs {
  readonly connectorSecrets: Record<string, string>;
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
      readonly connectorType: ConnectorAuthProviderType;
      readonly clientArgs: ConnectorAuthProviderClientArgs;
      readonly context: RefreshTokenContext;
    }
  | {
      readonly sourceType: "model-provider";
      readonly providerKey: ModelProviderOAuthProviderKey;
      readonly currentEnv: ProviderEnv;
      readonly context: RefreshTokenContext;
    };

type PrepareRefreshTokenContextResult =
  | {
      readonly ok: true;
      readonly prepared: PreparedRefreshTokenContext;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "client-unconfigured"
        | "not-refreshable"
        | "refresh-token-missing";
    };

type RefreshAccessTokenResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "client-unconfigured"
        | "not-refreshable"
        | "refresh-failed"
        | "refresh-token-missing";
    };

interface SyncRefreshTokensArgs {
  readonly db: Db;
  readonly connectorTypes: readonly string[];
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface RefreshExpiredTokensArgs {
  readonly db: Db;
  readonly auth: SandboxAuth;
  readonly orgId: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly secrets: Record<string, string>;
  readonly secretConnectorMap: Record<string, string>;
  readonly secretConnectorMetadataMap?:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
  readonly forceRefresh: boolean;
}

interface RefreshBatchContext {
  readonly db: Db;
  readonly auth: SandboxAuth;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
  readonly envVarsByConnector: Map<string, readonly string[]>;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface ConnectorAccessState {
  readonly authMethod: string;
  readonly accessMetadata: ConnectorAuthMethodAccessMetadata;
  readonly tokenExpiresAt: number | null;
}

interface BasicArgContext extends BasicAuthTemplateArg {
  readonly secrets: Record<string, string>;
  readonly vars: Record<string, string>;
  readonly resolvedKeys: Set<string>;
}

const L = logger("webhook:firewall-auth");
const ORG_SENTINEL_USER_ID = "__org__";
const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";
const REFRESH_BUFFER_SECS = 60;
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS = 15 * 60;
const TEMPLATE_RE = /\$\{\{\s*(secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function getOAuthProviderKeySourceType(
  providerKey: string,
): AccessSecretSource {
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
  sourceType: AccessSecretSource,
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

function getRefreshSecretNameForSource(args: {
  readonly connectorType: string;
  readonly sourceType: AccessSecretSource;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): string | undefined {
  if (args.sourceType === "model-provider") {
    const metadata = getModelProviderOAuthSecretMetadata(args.connectorType);
    return metadata?.isRefreshable ? metadata.refreshSecretName : undefined;
  }

  const accessMetadata = args.connectorAccessByType.get(
    args.connectorType,
  )?.accessMetadata;
  return accessMetadata?.kind === "refresh-token"
    ? accessMetadata.refreshToken
    : undefined;
}

function getAccessSecretNameForSource(args: {
  readonly connectorType: string;
  readonly sourceType: AccessSecretSource;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): string | undefined {
  if (args.sourceType === "model-provider") {
    return getModelProviderOAuthSecretMetadata(args.connectorType)
      ?.accessSecretName;
  }

  const accessMetadata = args.connectorAccessByType.get(
    args.connectorType,
  )?.accessMetadata;
  return accessMetadata?.kind === "refresh-token"
    ? accessMetadata.accessToken
    : undefined;
}

async function getConnectorRefreshToken(
  args: SecretTokenLookupArgs,
): Promise<{ readonly secretName: string; readonly token: string } | null> {
  const secretName = getRefreshSecretNameForSource(args);
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
  const secretName = getAccessSecretNameForSource(args);
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
        metadataKey: metadata.metadataKey,
        connectorAccessByType: args.connectorAccessByType,
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

async function loadConnectorAccessStates(
  db: Db,
  orgId: string,
  userId: string,
  connectorTypes: readonly string[],
): Promise<Map<string, ConnectorAccessState>> {
  const result = new Map<string, ConnectorAccessState>();
  if (connectorTypes.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      type: connectors.type,
      authMethod: connectors.authMethod,
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
    const parsed = connectorTypeSchema.safeParse(row.type);
    if (!parsed.success) {
      continue;
    }
    const accessMetadata = getConnectorAuthMethodAccessMetadata(
      parsed.data,
      row.authMethod,
    );
    if (!accessMetadata) {
      continue;
    }
    result.set(row.type, {
      authMethod: row.authMethod,
      accessMetadata,
      tokenExpiresAt: row.tokenExpiresAt
        ? Math.floor(row.tokenExpiresAt.getTime() / 1000)
        : null,
    });
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

async function getExpiryByProviderKey(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorTypes: readonly string[];
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): Promise<Map<string, number | null>> {
  const connectorOnly = args.connectorTypes.filter((connectorType) => {
    return (
      resolveRefreshMetadata(
        connectorType,
        args.metadataByConnector.get(connectorType),
      ).sourceType === "connector"
    );
  });
  const modelProviderOAuthProviderKeys = args.connectorTypes.filter(
    (connectorType) => {
      return (
        resolveRefreshMetadata(
          connectorType,
          args.metadataByConnector.get(connectorType),
        ).sourceType === "model-provider"
      );
    },
  );

  const modelProviderEntries = await Promise.all(
    modelProviderOAuthProviderKeys.map(async (providerKey) => {
      const metadata = resolveRefreshMetadata(
        providerKey,
        args.metadataByConnector.get(providerKey),
      );
      const metadataKey =
        metadata.metadataKey ??
        modelProviderTypeForOAuthProviderKey(providerKey) ??
        providerKey;
      const expiryMap = await getModelProviderExpiry(
        args.db,
        args.orgId,
        args.userId,
        [metadataKey],
        { sourceUserId: metadata.sourceUserId },
      );
      return [providerKey, expiryMap.get(metadataKey) ?? null] as const;
    }),
  );

  const merged = new Map<string, number | null>();
  for (const connectorType of connectorOnly) {
    const state = args.connectorAccessByType.get(connectorType);
    if (state) {
      merged.set(connectorType, state.tokenExpiresAt);
    }
  }
  for (const [providerKey, expiry] of modelProviderEntries) {
    merged.set(providerKey, expiry);
  }
  return merged;
}

function prepareRefreshTokenContext(
  args: RefreshAccessTokenArgs,
): PrepareRefreshTokenContextResult {
  if (args.sourceType === "model-provider") {
    if (!isModelProviderOAuthProviderKey(args.connectorType)) {
      return { ok: false, reason: "not-refreshable" };
    }
    const secretMetadata = getModelProviderOAuthSecretMetadata(
      args.connectorType,
    );
    if (!secretMetadata.isRefreshable) {
      return { ok: false, reason: "not-refreshable" };
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
      return { ok: false, reason: "refresh-token-missing" };
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
      return { ok: false, reason: "client-unconfigured" };
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
      ok: true,
      prepared: {
        sourceType: args.sourceType,
        providerKey: args.connectorType,
        currentEnv: env,
        context,
      },
    };
  }

  const connectorAccess = args.connectorAccessByType.get(args.connectorType);
  if (connectorAccess?.accessMetadata.kind !== "refresh-token") {
    L.debug(
      `${args.connectorType} does not use refresh-token access, skipping`,
    );
    return { ok: false, reason: "not-refreshable" };
  }
  const accessMetadata = connectorAccess.accessMetadata;
  const parsedConnectorType = connectorTypeSchema.safeParse(args.connectorType);
  if (!parsedConnectorType.success) {
    return { ok: false, reason: "not-refreshable" };
  }
  if (!hasConnectorAuthProvider(parsedConnectorType.data)) {
    return { ok: false, reason: "not-refreshable" };
  }
  const authClient = resolveConnectorAuthClientForMethod(
    parsedConnectorType.data,
    connectorAccess.authMethod,
    (name) => {
      return optionalEnv(name);
    },
  );
  if (!authClient) {
    L.debug(
      `${args.connectorType} connector client not configured, skipping token refresh`,
    );
    return { ok: false, reason: "client-unconfigured" };
  }

  const refreshTokenSecret = accessMetadata.refreshToken;
  const currentRefreshToken = args.connectorSecrets[refreshTokenSecret];
  if (!currentRefreshToken) {
    L.debug(`No ${args.connectorType} refresh token available, skipping`);
    return { ok: false, reason: "refresh-token-missing" };
  }

  const context: RefreshTokenContext = {
    refreshTokenSecret,
    currentRefreshToken,
    accessTokenSecret: accessMetadata.accessToken,
    secretUserId: resolveSecretUserId(
      args.sourceType,
      args.userId,
      args.sourceUserId,
    ),
  };

  return {
    ok: true,
    prepared: {
      sourceType: "connector",
      connectorType: parsedConnectorType.data,
      clientArgs: getConnectorAuthProviderClientArgs(authClient),
      context,
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

async function refreshAccessTokenForSource(
  args: RefreshAccessTokenArgs,
): Promise<RefreshAccessTokenResult> {
  const preparation = prepareRefreshTokenContext(args);
  if (!preparation.ok) {
    return { ok: false, reason: preparation.reason };
  }
  const { prepared } = preparation;

  const refreshPromise =
    prepared.sourceType === "connector"
      ? refreshConnectorAuthProviderAccessToken({
          type: prepared.connectorType,
          clientArgs: prepared.clientArgs,
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
    return { ok: false, reason: "refresh-failed" };
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
  return { ok: true, accessToken: result.accessToken };
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
  secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined,
  connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>,
  referencedKeys: Set<string>,
): Map<string, string> {
  const refreshable = new Map<string, string>();
  for (const key of referencedKeys) {
    const connectorType = secretConnectorMap[key];
    if (!connectorType) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      connectorType,
      secretConnectorMetadataMap?.[key],
    );
    const refreshSecretName = getRefreshSecretNameForSource({
      connectorType,
      sourceType: metadata.sourceType,
      connectorAccessByType,
    });
    if (refreshSecretName) {
      refreshable.set(key, connectorType);
    }
  }
  return refreshable;
}

function getOwnConnectorOwner(
  secretConnectorMap: Record<string, string> | undefined,
  key: string,
): string | undefined {
  return secretConnectorMap && Object.hasOwn(secretConnectorMap, key)
    ? secretConnectorMap[key]
    : undefined;
}

function isSelectedAccessSecretKey(
  key: string,
  accessMetadata: ConnectorAuthMethodAccessMetadata,
): boolean {
  return connectorAccessSecretName(key, accessMetadata) !== undefined;
}

function connectorAccessSecretName(
  key: string,
  accessMetadata: ConnectorAuthMethodAccessMetadata,
): string | undefined {
  switch (accessMetadata.kind) {
    case "refresh-token": {
      if (
        accessMetadata.envBindings[key] ===
        `${CONNECTOR_SECRET_REF_PREFIX}${accessMetadata.accessToken}`
      ) {
        return accessMetadata.accessToken;
      }
      return undefined;
    }
    case "static": {
      const valueRef = accessMetadata.envBindings[key];
      return valueRef?.startsWith(CONNECTOR_SECRET_REF_PREFIX) === true
        ? valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length)
        : undefined;
    }
    case "none": {
      return undefined;
    }
  }
}

function modelProviderAccessSecretName(args: {
  readonly key: string;
  readonly connectorType: string;
  readonly metadata: SecretConnectorMetadata;
}): string | undefined {
  const secretMetadata = getModelProviderOAuthSecretMetadata(
    args.connectorType,
  );
  if (!secretMetadata?.isRefreshable) {
    return undefined;
  }

  const providerType =
    args.metadata.metadataKey ??
    modelProviderTypeForOAuthProviderKey(args.connectorType);
  const parsedProviderType = providerType
    ? modelProviderTypeSchema.safeParse(providerType)
    : undefined;
  if (!parsedProviderType?.success) {
    return undefined;
  }

  const envBindings = getModelProviderEnvBindings(parsedProviderType.data);
  return envBindings?.[args.key] ===
    `${CONNECTOR_SECRET_REF_PREFIX}${secretMetadata.accessSecretName}`
    ? secretMetadata.accessSecretName
    : undefined;
}

async function syncStaticConnectorAccessSecrets(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<void> {
  if (!args.secretConnectorMap) {
    return;
  }

  const lookups = [...args.referencedKeys].flatMap((key) => {
    const connectorType = getOwnConnectorOwner(args.secretConnectorMap, key);
    if (!connectorType) {
      return [];
    }
    const metadata = resolveRefreshMetadata(
      connectorType,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "connector") {
      return [];
    }
    const accessMetadata =
      args.connectorAccessByType.get(connectorType)?.accessMetadata;
    if (accessMetadata?.kind !== "static") {
      return [];
    }
    const secretName = connectorAccessSecretName(key, accessMetadata);
    return secretName ? [{ key, secretName }] : [];
  });
  if (lookups.length === 0) {
    return;
  }

  const rows = await args.db
    .select({
      name: secretsTable.name,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
        eq(secretsTable.type, "connector"),
        inArray(secretsTable.name, [
          ...new Set(
            lookups.map((lookup) => {
              return lookup.secretName;
            }),
          ),
        ]),
      ),
    );

  const valuesByName = new Map<string, string>();
  for (const row of rows) {
    valuesByName.set(
      row.name,
      await decryptStoredSecretValue(
        row.encryptedValue,
        args.featureSwitchContext,
      ),
    );
  }

  for (const { key, secretName } of lookups) {
    const value = valuesByName.get(secretName);
    if (value === undefined) {
      delete args.secrets[key];
    } else {
      args.secrets[key] = value;
    }
  }
}

function canResolveMissingAccessSecret(args: {
  readonly key: string;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): boolean {
  const connectorType = getOwnConnectorOwner(args.secretConnectorMap, args.key);
  const metadata = args.secretConnectorMetadataMap?.[args.key];
  if (!connectorType) {
    return false;
  }
  const refreshMetadata = resolveRefreshMetadata(connectorType, metadata);
  if (refreshMetadata.sourceType === "model-provider") {
    return (
      modelProviderAccessSecretName({
        key: args.key,
        connectorType,
        metadata: refreshMetadata,
      }) !== undefined
    );
  }

  const accessMetadata =
    args.connectorAccessByType.get(connectorType)?.accessMetadata;
  if (accessMetadata?.kind !== "refresh-token") {
    return false;
  }
  return isSelectedAccessSecretKey(args.key, accessMetadata);
}

function referencedConnectorTypes(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
}): readonly string[] {
  if (!args.secretConnectorMap) {
    return [];
  }
  const connectorTypes = new Set<string>();
  for (const key of args.referencedKeys) {
    const connectorType = args.secretConnectorMap[key];
    if (!connectorType) {
      continue;
    }
    const sourceType = resolveRefreshMetadata(
      connectorType,
      args.secretConnectorMetadataMap?.[key],
    ).sourceType;
    if (sourceType === "connector") {
      connectorTypes.add(connectorType);
    }
  }
  return [...connectorTypes];
}

function hasUnavailableAccessSource(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): boolean {
  if (!args.secretConnectorMap) {
    return false;
  }
  return [...args.referencedKeys].some((key) => {
    const connectorType = args.secretConnectorMap?.[key];
    if (!connectorType) {
      return false;
    }
    const metadata = resolveRefreshMetadata(
      connectorType,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType === "model-provider") {
      return (
        modelProviderAccessSecretName({
          key,
          connectorType,
          metadata,
        }) === undefined
      );
    }

    const accessMetadata =
      args.connectorAccessByType.get(connectorType)?.accessMetadata;
    return !accessMetadata || !isSelectedAccessSecretKey(key, accessMetadata);
  });
}

function hasMissingUnresolvableSecrets(args: {
  readonly secrets: Record<string, string>;
  readonly referencedKeys: Set<string>;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): boolean {
  return [...args.referencedKeys].some((key) => {
    return (
      !Object.hasOwn(args.secrets, key) &&
      !canResolveMissingAccessSecret({
        key,
        secretConnectorMap: args.secretConnectorMap,
        secretConnectorMetadataMap: args.secretConnectorMetadataMap,
        connectorAccessByType: args.connectorAccessByType,
      })
    );
  });
}

async function prepareFirewallAuthResolutionContext(args: {
  readonly db: Db;
  readonly auth: SandboxAuth;
  readonly body: FirewallAuthBody;
  readonly orgId: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly secrets: Record<string, string>;
}): Promise<
  | { readonly ok: true; readonly context: FirewallAuthResolutionContext }
  | { readonly ok: false; readonly response: ResolveFirewallAuthResult }
> {
  const referenced = collectReferencedKeys(
    args.body.authHeaders,
    args.body.authBase,
    args.body.authQuery,
  );
  const vars = args.body.vars ?? {};
  const connectorAccessByType = await loadConnectorAccessStates(
    args.db,
    args.orgId,
    args.auth.userId,
    referencedConnectorTypes({
      secretConnectorMap: args.body.secretConnectorMap,
      secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
      referencedKeys: referenced.secrets,
    }),
  );
  await syncStaticConnectorAccessSecrets({
    db: args.db,
    orgId: args.orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    secretConnectorMap: args.body.secretConnectorMap,
    secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
    referencedKeys: referenced.secrets,
    connectorAccessByType,
    featureSwitchContext: args.featureSwitchContext,
  });
  if (
    hasUnavailableAccessSource({
      secretConnectorMap: args.body.secretConnectorMap,
      secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
      referencedKeys: referenced.secrets,
      connectorAccessByType,
    })
  ) {
    return { ok: false, response: connectorNotConfigured() };
  }

  const hasMissingSecrets = hasMissingUnresolvableSecrets({
    secrets: args.secrets,
    referencedKeys: referenced.secrets,
    secretConnectorMap: args.body.secretConnectorMap,
    secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
    connectorAccessByType,
  });
  const hasMissingVars = [...referenced.vars].some((key) => {
    return !Object.hasOwn(vars, key);
  });
  if (hasMissingSecrets || hasMissingVars) {
    return { ok: false, response: connectorNotConfigured() };
  }

  return {
    ok: true,
    context: { referenced, vars, connectorAccessByType },
  };
}

function hasMissingResolvedSecrets(
  secrets: Record<string, string>,
  referencedKeys: Set<string>,
): boolean {
  return [...referencedKeys].some((key) => {
    return !Object.hasOwn(secrets, key);
  });
}

function missingResolvedConnectorOwners(args: {
  readonly secrets: Record<string, string>;
  readonly referencedKeys: Set<string>;
  readonly secretConnectorMap: Record<string, string> | undefined;
}): readonly string[] {
  const owners = new Set<string>();
  for (const key of args.referencedKeys) {
    if (Object.hasOwn(args.secrets, key)) {
      continue;
    }
    owners.add(args.secretConnectorMap?.[key] ?? key);
  }
  return [...owners].sort();
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
  | {
      readonly ok: true;
      readonly orgId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
      readonly secrets: Record<string, string> | null;
    }
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
    orgId,
    featureSwitchContext,
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
      const refreshResult = await refreshAccessTokenForSource({
        db: context.db,
        connectorType,
        orgId: context.orgId,
        userId: context.userId,
        sourceType: metadata.sourceType,
        sourceUserId: metadata.sourceUserId,
        metadataKey: metadata.metadataKey,
        connectorSecrets: context.secrets,
        connectorAccessByType: context.connectorAccessByType,
        featureSwitchContext: context.featureSwitchContext,
      });
      if (!refreshResult.ok) {
        L.warn(
          `[${context.auth.runId}] Failed to refresh ${connectorType} token`,
          {
            sourceType: metadata.sourceType,
            sourceUserId: metadata.sourceUserId,
            metadataKey: metadata.metadataKey,
            reason: refreshResult.reason,
          },
        );
        return { connectorType, status: "failed" };
      }

      for (const envVar of context.envVarsByConnector.get(connectorType) ??
        []) {
        context.secrets[envVar] = refreshResult.accessToken;
      }
      return { connectorType, status: "refreshed" };
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
          metadataKey: metadata.metadataKey,
          connectorAccessByType: context.connectorAccessByType,
          featureSwitchContext: context.featureSwitchContext,
        }),
      };
    }),
  );
  for (const { connectorType, token } of currentTokens) {
    if (!token) {
      L.warn(
        `[${context.auth.runId}] No DB token for skipped connector ${connectorType}, marking access unresolved`,
      );
      for (const envVar of context.envVarsByConnector.get(connectorType) ??
        []) {
        delete context.secrets[envVar];
      }
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
  "failedConnectors" | "refreshedConnectors" | "refreshedSecrets"
> {
  const refreshedConnectors = refreshResults
    .filter((result) => {
      return result.status === "refreshed";
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
      return result.status === "failed";
    })
    .map((result) => {
      return result.connectorType;
    });

  return {
    refreshedConnectors,
    refreshedSecrets,
    failedConnectors,
  };
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
    args.secretConnectorMetadataMap,
    args.connectorAccessByType,
    args.referencedKeys,
  );
  if (refreshable.size === 0) {
    return emptyRefreshResult;
  }

  const connectorTypes = [...new Set(refreshable.values())];
  const metadataByConnector = buildMetadataByConnector(
    refreshable,
    args.secretConnectorMetadataMap,
  );
  const expiryMap = await getExpiryByProviderKey({
    db: args.db,
    orgId: args.orgId,
    userId: args.auth.userId,
    connectorTypes,
    metadataByConnector,
    connectorAccessByType: args.connectorAccessByType,
  });
  const toRefresh = connectorTypesNeedingRefresh({
    connectorTypes,
    expiryMap,
    forceRefresh: args.forceRefresh,
  });
  const envVarsByConnector = buildEnvVarsByConnector(refreshable);

  await syncRefreshTokensFromDb({
    db: args.db,
    connectorTypes: toRefresh,
    orgId: args.orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    metadataByConnector,
    connectorAccessByType: args.connectorAccessByType,
    featureSwitchContext: args.featureSwitchContext,
  });

  const context = {
    db: args.db,
    auth: args.auth,
    orgId: args.orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    metadataByConnector,
    connectorAccessByType: args.connectorAccessByType,
    envVarsByConnector,
    featureSwitchContext: args.featureSwitchContext,
  } satisfies RefreshBatchContext;
  const refreshResults = await refreshSelectedTokens(context, toRefresh);
  const skippedTypes = connectorTypes.filter((connectorType) => {
    return !toRefresh.includes(connectorType);
  });
  await syncSkippedTokens(context, skippedTypes);

  const summary = summarizeRefreshResults(refreshResults, envVarsByConnector);
  const finalConnectorAccessByType =
    summary.refreshedConnectors.length > 0
      ? new Map([
          ...args.connectorAccessByType,
          ...(await loadConnectorAccessStates(
            args.db,
            args.orgId,
            args.auth.userId,
            connectorTypes,
          )),
        ])
      : args.connectorAccessByType;
  const finalExpiryMap =
    summary.refreshedConnectors.length > 0
      ? await getExpiryByProviderKey({
          db: args.db,
          orgId: args.orgId,
          userId: args.auth.userId,
          connectorTypes,
          metadataByConnector,
          connectorAccessByType: finalConnectorAccessByType,
        })
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
): ReferencedAuthKeys {
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
    collectHeaderReferencedKeys(template, addKey);
  }

  if (authBase) {
    collectSimpleReferencedKeys(authBase, addKey);
  }

  if (authQuery) {
    for (const template of Object.values(authQuery)) {
      collectSimpleReferencedKeys(template, addKey);
    }
  }

  return { secrets: secretKeys, vars: varKeys };
}

function collectHeaderReferencedKeys(
  template: string,
  addKey: (namespace: string, key: string) => void,
): void {
  const basicMatches = parseBasicAuthTemplates(template);
  collectSimpleReferencesOutsideBasicTemplates(template, basicMatches, addKey);

  for (const match of basicMatches) {
    if (match.first.namespace && match.first.key) {
      addKey(match.first.namespace, match.first.key);
    }
    if (match.second.namespace && match.second.key) {
      addKey(match.second.namespace, match.second.key);
    }
  }
}

function collectSimpleReferencesOutsideBasicTemplates(
  template: string,
  basicMatches: readonly BasicAuthTemplateMatch[],
  addKey: (namespace: string, key: string) => void,
): void {
  let basicMatchIndex = 0;
  for (const match of template.matchAll(TEMPLATE_RE)) {
    if (!match[1] || !match[2] || match.index === undefined) {
      continue;
    }
    while (
      basicMatchIndex < basicMatches.length &&
      basicMatches[basicMatchIndex]!.end <= match.index
    ) {
      basicMatchIndex += 1;
    }
    const basicMatch = basicMatches[basicMatchIndex];
    if (
      basicMatch &&
      match.index >= basicMatch.start &&
      match.index < basicMatch.end
    ) {
      continue;
    }
    addKey(match[1], match[2]);
  }
}

function collectSimpleReferencedKeys(
  template: string,
  addKey: (namespace: string, key: string) => void,
): void {
  for (const match of template.matchAll(TEMPLATE_RE)) {
    if (match[1] && match[2]) {
      addKey(match[1], match[2]);
    }
  }
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
    return getOwnValue(context.secrets, context.key) ?? "";
  }
  return getOwnValue(context.vars, context.key) ?? "";
}

function getOwnValue(
  values: Record<string, string>,
  key: string,
): string | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
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
          return getOwnValue(secrets, key) ?? "";
        }
        return getOwnValue(vars, key) ?? "";
      },
    );
  };

  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(authHeaders)) {
    let resolved = replaceBasicAuthTemplates(template, (match) => {
      const user = resolveBasicArg({
        ...match.first,
        secrets,
        vars,
        resolvedKeys,
      });
      const pass = resolveBasicArg({
        ...match.second,
        secrets,
        vars,
        resolvedKeys,
      });
      return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    });
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

  const prepared = await prepareFirewallAuthResolutionContext({
    db,
    auth,
    body,
    orgId: decrypted.orgId,
    featureSwitchContext: decrypted.featureSwitchContext,
    secrets: decryptedSecrets,
  });
  if (!prepared.ok) {
    return prepared.response;
  }
  const { connectorAccessByType, referenced, vars } = prepared.context;

  if (
    body.secretConnectorMap &&
    hasForbiddenModelProviderOwner(
      auth,
      body.secretConnectorMap,
      body.secretConnectorMetadataMap,
      referenced.secrets,
    )
  ) {
    return forbiddenModelProviderOwner();
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
      connectorAccessByType,
      orgId: decrypted.orgId,
      featureSwitchContext: decrypted.featureSwitchContext,
      forceRefresh: body.forceRefresh ?? false,
    });
    expiresAt = result.expiresAt;
    refreshedConnectors = result.refreshedConnectors;
    refreshedSecrets = result.refreshedSecrets;
    failedConnectors = result.failedConnectors;
  }

  if (failedConnectors.length > 0) {
    return tokenRefreshFailed(failedConnectors);
  }

  if (hasMissingResolvedSecrets(decryptedSecrets, referenced.secrets)) {
    return tokenAccessResolutionFailed(
      missingResolvedConnectorOwners({
        secrets: decryptedSecrets,
        referencedKeys: referenced.secrets,
        secretConnectorMap: body.secretConnectorMap,
      }),
    );
  }

  const resolved = resolveTemplates(
    body.authHeaders,
    decryptedSecrets,
    vars,
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
