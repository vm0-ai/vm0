import { Buffer } from "node:buffer";

import {
  getSecretNameForType,
  getModelProviderEnvBindings,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import type { ConnectorReconnectReason } from "@vm0/api-contracts/contracts/connector-schemas";
import type { SecretConnectorMetadata } from "@vm0/api-contracts/contracts/runners";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  connectorAuthMethodAccessMetadata,
  connectorAuthMethodRuntimeMetadata,
  connectorRefreshMetadataHasRefreshableSecret,
  getConnectorRuntimeBindingPlatformSecretName,
  getConnectorRuntimeBindingSecretName,
  resolveConnectorAuthClient,
  type ConnectorAuthMethodAccessMetadata,
  type ConnectorAuthClient,
  type ConnectorRefreshTokenInputMetadata,
  type ConnectorAuthMethodRuntimeMetadata,
  type ConnectorOutputTarget,
} from "@vm0/connectors/connector-auth-method";
import {
  parseBasicAuthTemplates,
  replaceBasicAuthTemplates,
  type BasicAuthTemplateArg,
  type BasicAuthTemplateMatch,
} from "@vm0/connectors/firewall-types";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import {
  refreshConnectorAuthProviderAccessTokenWithMethod,
  type ProviderEnv,
} from "@vm0/connectors/auth-providers";
import {
  isProviderHttpError,
  isProviderResponseError,
} from "@vm0/connectors/auth-providers/provider-error";
import { isOAuthProviderHttpError } from "@vm0/connectors/auth-providers/oauth/error";
import {
  getModelProviderRefreshMetadata,
  isModelProviderRefreshConfigured,
  refreshPreparedModelProviderAccess,
  isModelProviderRefreshProviderKey,
  type ModelProviderRefreshProviderKey,
} from "@vm0/connectors/auth-providers/model-provider-auth";
import { isChatgptRefreshError } from "@vm0/connectors/auth-providers/model-providers/codex-oauth/oauth";
import { agentRunCustomConnectorAuthRefs } from "@vm0/db/schema/agent-run-custom-connector-auth-ref";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { connectors } from "@vm0/db/schema/connector";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import { variables as variablesTable } from "@vm0/db/schema/variable";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows, pgInt8ToBigIntSchema } from "../../lib/db-raw-rows";
import {
  pgInt8ToBigIntDecoder,
  pgNullDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { optionalEnv } from "../../lib/env";
import { badRequestMessage, insufficientCredits } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import type { Db } from "../external/db";
import { settle, tapError } from "../utils";
import {
  decryptPersistentSecretsMap,
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  lockConnectorState,
  lockModelProviderState,
} from "./auth-state-lock.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveOrgCreditAvailability } from "./zero-run-admission.service";
import { resolveUsageAllowanceAvailabilityForRun } from "./usage-allowance.service";
import {
  connectorRuntimeCredentialStatusForAccess,
  type ConnectorCredentialStatus,
} from "./connector-credential-status.service";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  upsertConnectorOwnedSecret,
  upsertConnectorOwnedVariable,
} from "./connector-credential-storage-write.service";
import {
  connectorCredentialSecretReadCondition,
  connectorCredentialVariableReadCondition,
  resolveConnectorCredentialAccess,
  type ConnectorCredentialAccess,
} from "./connector-credential-access.service";
import { resolveLiveCustomConnectorOAuth2AccessToken } from "./custom-connector-oauth2.service";
import { CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY } from "./zero-custom-connector.service";

type AccessSecretSource = SecretConnectorMetadata["sourceType"];
type StorageSecretSource = Exclude<AccessSecretSource, "platform-secret">;
type FirewallAuthFailureReason = "upstream_provider" | "reconnect_required";
type SecretType = StorageSecretSource;
const NORMAL_BILLABLE_FIREWALL_LEASE_SECONDS = 30;
const LOW_BILLABLE_FIREWALL_LEASE_SECONDS = 5;
const LOW_BILLABLE_FIREWALL_CREDIT_THRESHOLD = 1000;
const FIREWALL_AUTH_REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_ERROR_CODE = "oauth_refresh_timeout";
const MAX_OAUTH_REFRESH_LOG_FIELD_LENGTH = 128;
const databaseTimestampMicrosRowSchema = z.object({
  now: pgInt8ToBigIntSchema,
});

function firewallAuthRefreshTimeoutMs(): number {
  const configured = optionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS");
  if (configured === undefined) {
    return FIREWALL_AUTH_REFRESH_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : FIREWALL_AUTH_REFRESH_TIMEOUT_MS;
}

interface FirewallAuthBody {
  readonly encryptedSecrets: string;
  readonly authHeaders: Record<string, string>;
  readonly authBase?: string;
  readonly authQuery?: Record<string, string>;
  readonly authAwsSigv4?: FirewallAwsSigv4AuthConfig;
  readonly secretConnectorMap?: Record<string, string>;
  readonly secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
  readonly vars?: Record<string, string>;
  readonly firewallBillable?: boolean;
  readonly forceRefresh?: boolean;
}

interface FirewallAwsSigv4AuthConfig {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

interface RefreshResult {
  readonly expiresAt: number | null;
  readonly refreshedConnectors: readonly string[];
  readonly refreshedSecrets: readonly string[];
  readonly failedConnectors: readonly string[];
  readonly unavailableConnectors: readonly string[];
  readonly failureReason?: FirewallAuthFailureReason;
}

interface RefreshExecutionResult {
  readonly accessSourceKey: string;
  readonly status: "current" | "refreshed" | "failed" | "source-missing";
  readonly failureReason?: FirewallAuthFailureReason;
}

interface ReferencedAuthKeys {
  readonly secrets: Set<string>;
  readonly vars: Set<string>;
}

interface FirewallAuthResolutionContext {
  readonly referenced: ReferencedAuthKeys;
  readonly vars: Record<string, string>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
}

interface ResolveResult {
  readonly status: 200;
  readonly body: {
    readonly headers: Record<string, string>;
    readonly base?: string;
    readonly query?: Record<string, string>;
    readonly awsSigv4?: FirewallAwsSigv4AuthConfig;
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
          readonly failureReason?: FirewallAuthFailureReason;
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
  failedAccessSourceKeys: readonly string[],
  failureReason?: FirewallAuthFailureReason,
): ResolveFirewallAuthResult {
  const accessSourceList = failedAccessSourceKeys.join(", ");
  const message =
    failureReason === "upstream_provider"
      ? `Access token refresh failed for: ${accessSourceList}. The upstream provider may be temporarily unavailable.`
      : `Access token expired and refresh failed for: ${accessSourceList}. The connector may need to be reconnected.`;
  const error = {
    message,
    code: "TOKEN_REFRESH_FAILED",
    connectors: failedAccessSourceKeys,
    ...(failureReason ? { failureReason } : {}),
  };
  return {
    status: 502,
    body: {
      error,
    },
  };
}

function connectorReconnectRequired(
  failedConnectorSlugs: readonly string[],
): ResolveFirewallAuthResult {
  const connectorList = failedConnectorSlugs.join(", ");
  return {
    status: 502,
    body: {
      error: {
        message: `Connector credential requires reconnect for: ${connectorList}.`,
        code: "TOKEN_REFRESH_FAILED",
        connectors: failedConnectorSlugs,
        failureReason: "reconnect_required",
      },
    },
  };
}

function tokenAccessResolutionFailed(
  failedAccessSourceKeys: readonly string[],
): ResolveFirewallAuthResult {
  return {
    status: 502,
    body: {
      error: {
        message: `Token access resolution failed for: ${failedAccessSourceKeys.join(", ")}. The connector may need to be reconnected.`,
        code: "TOKEN_ACCESS_RESOLUTION_FAILED",
        connectors: failedAccessSourceKeys,
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
  if (availability.status !== "active") {
    return insufficientCredits();
  }
  const allowance =
    availability.spendableCredits > 0
      ? null
      : await resolveUsageAllowanceAvailabilityForRun(params.db, {
          orgId: params.auth.orgId,
          runId: params.auth.runId,
        });
  const spendableUnits =
    Math.max(availability.spendableCredits, 0) +
    (allowance?.remainingUnits ?? 0);
  if (spendableUnits <= 0) {
    return insufficientCredits();
  }

  const leaseSeconds =
    spendableUnits <= LOW_BILLABLE_FIREWALL_CREDIT_THRESHOLD
      ? LOW_BILLABLE_FIREWALL_LEASE_SECONDS
      : NORMAL_BILLABLE_FIREWALL_LEASE_SECONDS;

  return {
    expiresAt: Math.floor(nowDate().getTime() / 1000) + leaseSeconds,
  };
}

interface SecretTokenLookupArgs {
  readonly db: Db;
  readonly accessSourceKey: string;
  readonly orgId: string;
  readonly userId: string;
  readonly sourceType: StorageSecretSource;
  readonly sourceUserId?: string;
  readonly metadataKey?: string;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface RefreshAccessTokenArgs extends SecretTokenLookupArgs {
  readonly connectorSecrets: Record<string, string>;
  readonly accessEnvVars: readonly string[];
  readonly forceRefresh: boolean;
  readonly forceRefreshStartedAtMicros: bigint | null;
}

function requiredModelProviderMetadataKey(args: {
  readonly providerKey: string;
  readonly metadataKey: string | undefined;
}): string {
  if (!args.metadataKey) {
    throw new Error(
      `metadataKey required for model-provider source on ${args.providerKey}`,
    );
  }
  return args.metadataKey;
}

type RefreshInputSource =
  | {
      readonly kind: "secret";
      readonly name: string;
    }
  | {
      readonly kind: "variable";
      readonly name: string;
    };

interface RefreshTokenContext {
  readonly inputSources: Readonly<Record<string, RefreshInputSource>>;
  readonly outputTargets: Readonly<Record<string, RefreshOutputTarget>>;
  readonly runtimeOutputSecrets: Readonly<Record<string, string>>;
  readonly secretUserId: string;
}

interface RefreshState {
  readonly authMethod: string | null;
  readonly connectorId: string | null;
  readonly storageVersion: number | null;
  readonly outputValues: Readonly<Record<string, string | null>>;
  readonly inputValues: Readonly<Record<string, string | null>>;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
  readonly lastRefreshErrorCode: string | null;
  readonly updatedAtMicros: bigint;
}

interface RefreshStateRow {
  readonly authMethod: string | null;
  readonly connectorId: string | null;
  readonly storageVersion: number | null;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
  readonly lastRefreshErrorCode: string | null;
  readonly updatedAtMicros: bigint;
}

interface ValidatedRefreshOutput {
  readonly target: RefreshOutputTarget;
  readonly value: string;
}

type RefreshOutputTarget =
  | {
      readonly kind: "secret";
      readonly name: string;
    }
  | {
      readonly kind: "connector-variable";
      readonly name: string;
    };

type PreparedRefreshTokenContext =
  | ConnectorPreparedRefreshTokenContext
  | ModelProviderPreparedRefreshTokenContext;

type ConnectorPreparedRefreshTokenContext = {
  readonly sourceType: "connector";
  readonly connectorId: string;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly authClient?: ConnectorAuthClient;
  readonly context: RefreshTokenContext;
};

type ModelProviderPreparedRefreshTokenContext = {
  readonly sourceType: "model-provider";
  readonly providerKey: ModelProviderRefreshProviderKey;
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
        | "refresh-token-missing"
        | "source-missing";
    };

type RefreshAccessTokenResult =
  | {
      readonly ok: true;
      readonly status: "current" | "refreshed";
      readonly secrets: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "client-unconfigured"
        | "not-refreshable"
        | "refresh-failed"
        | "refresh-token-missing"
        | "source-missing";
      readonly failureReason?: FirewallAuthFailureReason;
    };

function refreshTokenMissingResult(): RefreshAccessTokenResult {
  return {
    ok: false,
    reason: "refresh-token-missing",
    failureReason: "reconnect_required",
  };
}

function sourceMissingResult(): RefreshAccessTokenResult {
  return {
    ok: false,
    reason: "source-missing",
  };
}

function refreshFailedResult(
  failureReason?: FirewallAuthFailureReason,
): RefreshAccessTokenResult {
  return {
    ok: false,
    reason: "refresh-failed",
    ...(failureReason ? { failureReason } : {}),
  };
}

interface RefreshExpiredTokensArgs {
  readonly db: Db;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  readonly auth: SandboxAuth;
  readonly orgId: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly secrets: Record<string, string>;
  readonly secretConnectorMap: Record<string, string>;
  readonly secretConnectorMetadataMap?:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
  readonly forceRefresh: boolean;
  readonly forceRefreshStartedAtMicros: bigint | null;
}

interface RefreshBatchContext {
  readonly db: Db;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  readonly auth: SandboxAuth;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly forceRefresh: boolean;
  readonly forceRefreshStartedAtMicros: bigint | null;
  readonly metadataByAccessSource: Map<string, SecretConnectorMetadata>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
  readonly envVarsByAccessSource: Map<string, readonly string[]>;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface RefreshSourceState {
  readonly tokenExpiresAt: number | null;
  readonly needsReconnect: boolean;
}

interface ConnectorAccessState extends RefreshSourceState {
  readonly access: ConnectorCredentialAccess;
  readonly connectorId: string;
  readonly authMethod: ConnectorAuthMethodId;
  readonly storageVersion: number;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly accessMetadata: ConnectorAuthMethodAccessMetadata;
  readonly runtimeMetadata: ConnectorAuthMethodRuntimeMetadata;
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

function inferAccessSourceType(accessSourceKey: string): AccessSecretSource {
  return modelProviderTypeForProviderKey(accessSourceKey)
    ? "model-provider"
    : "connector";
}

function modelProviderTypeForProviderKey(
  providerKey: string,
): ModelProviderType | undefined {
  const parsedProviderType = modelProviderTypeSchema.safeParse(providerKey);
  return parsedProviderType.success ? parsedProviderType.data : undefined;
}

function resolveSecretUserId(
  sourceType: StorageSecretSource,
  userId: string,
  sourceUserId?: string,
): string {
  return sourceType === "model-provider"
    ? (sourceUserId ?? ORG_SENTINEL_USER_ID)
    : userId;
}

function resolveRefreshMetadata(
  accessSourceKey: string,
  metadata: SecretConnectorMetadata | undefined,
): SecretConnectorMetadata {
  const sourceType =
    metadata?.sourceType ?? inferAccessSourceType(accessSourceKey);
  return {
    sourceType,
    sourceUserId:
      sourceType === "model-provider" ? metadata?.sourceUserId : undefined,
    metadataKey:
      sourceType === "model-provider"
        ? (metadata?.metadataKey ??
          modelProviderTypeForProviderKey(accessSourceKey))
        : undefined,
  };
}

function modelProviderTypeForMetadata(
  providerKey: string,
  metadata: SecretConnectorMetadata,
): ModelProviderType | undefined {
  const providerType =
    metadata.metadataKey ?? modelProviderTypeForProviderKey(providerKey);
  const parsedProviderType = providerType
    ? modelProviderTypeSchema.safeParse(providerType)
    : undefined;
  return parsedProviderType?.success ? parsedProviderType.data : undefined;
}

function currentProviderEnv(): ProviderEnv {
  const env: ProviderEnv = {};
  return new Proxy(env, {
    get: (_target, property) => {
      return typeof property === "string" ? optionalEnv(property) : undefined;
    },
  });
}

function refreshFailureReasonFromError(
  error: unknown,
  refreshTimedOut: boolean,
): FirewallAuthFailureReason | undefined {
  if (refreshTimedOut) {
    return "upstream_provider";
  }
  if (isChatgptRefreshError(error)) {
    return isReconnectRequiredRefreshErrorCode(error.code)
      ? "reconnect_required"
      : undefined;
  }
  if (isOAuthProviderHttpError(error)) {
    if (error.oauthError === "invalid_grant") {
      return "reconnect_required";
    }
    if (
      error.oauthError === "server_error" ||
      error.oauthError === "temporarily_unavailable" ||
      error.status >= 500 ||
      error.status === 429
    ) {
      return "upstream_provider";
    }
  }
  if (
    isProviderHttpError(error) &&
    (error.status >= 500 || error.status === 429)
  ) {
    return "upstream_provider";
  }
  if (isProviderResponseError(error)) {
    return "upstream_provider";
  }
  if (isFetchNetworkError(error)) {
    return "upstream_provider";
  }
  return undefined;
}

function refreshErrorCodeFromError(
  error: unknown,
  refreshTimedOut: boolean,
): string | null {
  if (refreshTimedOut) {
    return REFRESH_TIMEOUT_ERROR_CODE;
  }
  if (isChatgptRefreshError(error)) {
    return error.code;
  }
  if (
    isOAuthProviderHttpError(error) &&
    isReconnectRequiredRefreshErrorCode(error.oauthError)
  ) {
    return error.oauthError ?? null;
  }
  return null;
}

function classifyRefreshFailure(
  error: unknown,
  signal: AbortSignal,
): {
  readonly errorCode: string | null;
  readonly failureReason: FirewallAuthFailureReason | undefined;
} {
  const refreshTimedOut = isRefreshTimeoutError(error, signal);
  return {
    errorCode: refreshErrorCodeFromError(error, refreshTimedOut),
    failureReason: refreshFailureReasonFromError(error, refreshTimedOut),
  };
}

function connectorReconnectReasonFromRefreshFailure(
  error: unknown,
  failureReason: FirewallAuthFailureReason | undefined,
): ConnectorReconnectReason | null {
  if (
    failureReason !== "reconnect_required" ||
    !isOAuthProviderHttpError(error) ||
    error.oauthError !== "invalid_grant"
  ) {
    return null;
  }
  if (error.oauthErrorSubtype === "invalid_rapt") {
    return "provider_session_expired";
  }
  if (!error.oauthErrorSubtype) {
    return "authorization_expired_or_revoked";
  }
  return null;
}

function oauthRefreshFailureLogFields(error: unknown): {
  readonly oauthError?: string;
  readonly oauthErrorSubtype?: string;
  readonly oauthStatus?: number;
} {
  if (!isOAuthProviderHttpError(error)) {
    return {};
  }
  return {
    ...(error.oauthError
      ? { oauthError: oauthRefreshFailureLogField(error.oauthError) }
      : {}),
    ...(error.oauthErrorSubtype
      ? {
          oauthErrorSubtype: oauthRefreshFailureLogField(
            error.oauthErrorSubtype,
          ),
        }
      : {}),
    oauthStatus: error.status,
  };
}

function oauthRefreshFailureLogField(value: string): string {
  if (value.length <= MAX_OAUTH_REFRESH_LOG_FIELD_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_OAUTH_REFRESH_LOG_FIELD_LENGTH - 3)}...`;
}

function isFetchNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError && error.message.toLowerCase().includes("fetch")
  );
}

function isRefreshTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted || !(error instanceof Error)) {
    return false;
  }
  if (error === signal.reason) {
    return true;
  }
  return (
    signal.reason instanceof Error &&
    signal.reason.name === "TimeoutError" &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function firewallAuthRefreshTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(firewallAuthRefreshTimeoutMs());
}

function isReconnectRequiredRefreshErrorCode(
  errorCode: string | null | undefined,
): boolean {
  return (
    errorCode === "refresh_token_expired" ||
    errorCode === "refresh_token_reused" ||
    errorCode === "refresh_token_invalidated" ||
    errorCode === "invalid_grant"
  );
}

async function getConnectorSecretValues(args: {
  readonly access: ConnectorCredentialAccess;
  readonly db: Db;
  readonly names: readonly string[];
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<ReadonlyMap<string, string>> {
  if (args.names.length === 0) {
    return new Map();
  }
  // Keep multi-secret credentials (for example AWS SigV4) on one statement
  // snapshot so a same-method replacement cannot combine two stored states.
  const rows = await args.db
    .select({
      name: secretsTable.name,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      connectorCredentialSecretReadCondition({
        db: args.db,
        groups: [{ access: args.access, names: args.names }],
      }),
    );
  const values = new Map<string, string>();
  for (const row of rows) {
    values.set(
      row.name,
      await decryptStoredSecretValue(
        row.encryptedValue,
        args.featureSwitchContext,
      ),
    );
  }
  return values;
}

async function getSecretValue(args: {
  readonly connectorAccess?: ConnectorCredentialAccess;
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly type: SecretType;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<string | null> {
  if (args.type === "connector") {
    if (args.connectorAccess === undefined) {
      return null;
    }
    const values = await getConnectorSecretValues({
      access: args.connectorAccess,
      db: args.db,
      names: [args.name],
      featureSwitchContext: args.featureSwitchContext,
    });
    return values.get(args.name) ?? null;
  }
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

async function getVariableValue(args: {
  readonly connectorAccess?: ConnectorCredentialAccess;
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}): Promise<string | null> {
  if (args.connectorAccess === undefined) {
    return null;
  }
  const [row] = await args.db
    .select({ value: variablesTable.value })
    .from(variablesTable)
    .where(
      connectorCredentialVariableReadCondition({
        db: args.db,
        groups: [
          {
            access: args.connectorAccess,
            names: [args.name],
          },
        ],
      }),
    )
    .limit(1);
  return row?.value ?? null;
}

async function upsertModelProviderSecretValue(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
    readonly value: string;
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
      type: "model-provider",
      description: `Model provider secret: ${args.name}`,
    })
    .onConflictDoUpdate({
      target: [
        secretsTable.orgId,
        secretsTable.userId,
        secretsTable.name,
        secretsTable.type,
      ],
      targetWhere: isNull(secretsTable.connectorId),
      set: {
        encryptedValue,
        updatedAt: nowDate(),
      },
    });
}

function modelProviderRuntimeSecretName(args: {
  readonly key: string;
  readonly providerKey: string;
  readonly metadata: SecretConnectorMetadata;
}): string | undefined {
  const providerType = modelProviderTypeForMetadata(
    args.providerKey,
    args.metadata,
  );
  if (!providerType) {
    return undefined;
  }

  const providerSecretName = getSecretNameForType(providerType);
  if (providerSecretName && args.key === providerSecretName) {
    return providerSecretName;
  }

  const valueRef = getModelProviderEnvBindings(providerType)?.[args.key];
  if (valueRef === "$secret") {
    return providerSecretName;
  }
  if (valueRef?.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
    return valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length);
  }
  return undefined;
}

function refreshableRuntimeSecretNameForSource(args: {
  readonly key: string;
  readonly accessSourceKey: string;
  readonly metadata: SecretConnectorMetadata;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
}): string | undefined {
  if (args.metadata.sourceType === "model-provider") {
    const providerKey = args.accessSourceKey;
    const secretName = modelProviderRuntimeSecretName({
      key: args.key,
      providerKey,
      metadata: args.metadata,
    });
    const secretMetadata = getModelProviderRefreshMetadata(providerKey);
    return secretName && secretMetadata?.refreshableSecrets.includes(secretName)
      ? secretName
      : undefined;
  }
  if (args.metadata.sourceType === "platform-secret") {
    return undefined;
  }

  const connectorSlug = args.accessSourceKey;
  const connectorAccess = args.connectorAccessBySlug.get(connectorSlug);
  if (!connectorAccess) {
    return undefined;
  }
  const secretName = getConnectorRuntimeBindingSecretName(
    connectorAccess.runtimeMetadata,
    args.key,
  );
  return secretName &&
    connectorRefreshMetadataHasRefreshableSecret(
      connectorAccess.accessMetadata,
      secretName,
    )
    ? secretName
    : undefined;
}

function runtimeOutputSecretsForSource(args: {
  readonly accessSourceKey: string;
  readonly metadata: SecretConnectorMetadata;
  readonly accessEnvVars: readonly string[];
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
}): Record<string, string> {
  return Object.fromEntries(
    args.accessEnvVars.flatMap((key) => {
      const secretName = refreshableRuntimeSecretNameForSource({
        key,
        accessSourceKey: args.accessSourceKey,
        metadata: args.metadata,
        connectorAccessBySlug: args.connectorAccessBySlug,
      });
      return secretName ? [[key, secretName]] : [];
    }),
  );
}

async function getCurrentAccessSecrets(
  args: SecretTokenLookupArgs & {
    readonly accessEnvVars: readonly string[];
    readonly metadata: SecretConnectorMetadata;
  },
): Promise<Record<string, string | null>> {
  const runtimeOutputSecrets = runtimeOutputSecretsForSource({
    accessSourceKey: args.accessSourceKey,
    metadata: args.metadata,
    accessEnvVars: args.accessEnvVars,
    connectorAccessBySlug: args.connectorAccessBySlug,
  });
  const secretUserId = resolveSecretUserId(
    args.sourceType,
    args.userId,
    args.sourceUserId,
  );
  const secretNames = [...new Set(Object.values(runtimeOutputSecrets))];
  let values: ReadonlyMap<string, string>;
  if (args.sourceType === "connector") {
    const connectorSlug = args.accessSourceKey;
    const access = args.connectorAccessBySlug.get(connectorSlug)?.access;
    values = access
      ? await getConnectorSecretValues({
          access,
          db: args.db,
          names: secretNames,
          featureSwitchContext: args.featureSwitchContext,
        })
      : new Map();
  } else {
    const modelProviderValues = new Map<string, string>();
    for (const secretName of secretNames) {
      const value = await getSecretValue({
        db: args.db,
        orgId: args.orgId,
        userId: secretUserId,
        name: secretName,
        type: args.sourceType,
        featureSwitchContext: args.featureSwitchContext,
      });
      if (value !== null) {
        modelProviderValues.set(secretName, value);
      }
    }
    values = modelProviderValues;
  }
  return Object.fromEntries(
    Object.entries(runtimeOutputSecrets).map(([envName, secretName]) => {
      return [envName, values.get(secretName) ?? null];
    }),
  );
}

async function loadConnectorAccessStates(
  db: Db,
  orgId: string,
  userId: string,
  connectorSlugs: readonly string[],
  snapshot: ConnectorRuntimeSnapshot,
): Promise<Map<string, ConnectorAccessState>> {
  const result = new Map<string, ConnectorAccessState>();
  if (connectorSlugs.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      connectorId: connectors.id,
      connectorSlug: sql`${connectors.connectorSlug}`
        .mapWith(pgTextDecoder)
        .as("connector_slug"),
      authMethod: connectors.authMethod,
      storageVersion: connectors.storageVersion,
      tokenExpiresAt: connectors.tokenExpiresAt,
      needsReconnect: connectors.needsReconnect,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        isNotNull(connectors.connectorSlug),
        inArray(connectors.connectorSlug, [...connectorSlugs]),
      ),
    );

  for (const row of rows) {
    const accessResult = resolveConnectorCredentialAccess({
      snapshot,
      stored: {
        authMethodId: row.authMethod,
        connectorId: row.connectorId,
        connectorSlug: row.connectorSlug,
        orgId,
        storageVersion: row.storageVersion,
        userId,
      },
    });
    if (accessResult.kind !== "ok") {
      continue;
    }
    const { access } = accessResult;
    const runtimeMethod = access.runtimeMethod;
    result.set(row.connectorSlug, {
      access,
      connectorId: row.connectorId,
      authMethod: runtimeMethod.authMethodId,
      storageVersion: access.storageVersion,
      runtimeMethod,
      accessMetadata: connectorAuthMethodAccessMetadata(runtimeMethod.method),
      runtimeMetadata: connectorAuthMethodRuntimeMetadata(runtimeMethod.method),
      ...refreshSourceStateFromRow(row),
    });
  }
  return result;
}

interface ModelProviderSourceLookup {
  readonly providerKey: string;
  readonly providerType: string;
  readonly userId: string;
}

interface SourceStateSnapshot {
  readonly sourceStateMap: Map<string, RefreshSourceState>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
}

function modelProviderSourceLookup(args: {
  readonly providerKey: string;
  readonly userId: string;
  readonly metadataByAccessSource: Map<string, SecretConnectorMetadata>;
}): ModelProviderSourceLookup {
  const metadata = resolveRefreshMetadata(
    args.providerKey,
    args.metadataByAccessSource.get(args.providerKey),
  );
  return {
    providerKey: args.providerKey,
    providerType:
      metadata.metadataKey ??
      modelProviderTypeForProviderKey(args.providerKey) ??
      args.providerKey,
    userId: resolveSecretUserId(
      "model-provider",
      args.userId,
      metadata.sourceUserId,
    ),
  };
}

function refreshInputSourceFromConnectorMetadata(
  metadata: ConnectorRefreshTokenInputMetadata,
): RefreshInputSource {
  switch (metadata.source.kind) {
    case "connector-secret": {
      return { kind: "secret", name: metadata.source.name };
    }
    case "connector-variable": {
      return { kind: "variable", name: metadata.source.name };
    }
  }
}

function connectorRefreshInputSources(
  accessMetadata: Extract<
    ConnectorAuthMethodAccessMetadata,
    { readonly kind: "refresh-token" }
  >,
): Record<string, RefreshInputSource> {
  return Object.fromEntries(
    Object.entries(accessMetadata.inputs).map(([inputName, metadata]) => {
      return [inputName, refreshInputSourceFromConnectorMetadata(metadata)];
    }),
  );
}

function connectorRefreshOutputTargets(
  accessMetadata: Extract<
    ConnectorAuthMethodAccessMetadata,
    { readonly kind: "refresh-token" }
  >,
): Record<string, RefreshOutputTarget> {
  return Object.fromEntries(
    Object.entries(accessMetadata.outputs).map(([outputName, metadata]) => {
      return [
        outputName,
        refreshOutputTargetFromConnectorTarget(metadata.target),
      ];
    }),
  );
}

function refreshOutputTargetFromConnectorTarget(
  target: ConnectorOutputTarget,
): RefreshOutputTarget {
  return target.kind === "connector-secret"
    ? { kind: "secret", name: target.name }
    : target;
}

function modelProviderRefreshOutputTargets(
  outputs: Readonly<Record<string, string>>,
): Record<string, RefreshOutputTarget> {
  return Object.fromEntries(
    Object.entries(outputs).map(([outputName, secretName]) => {
      return [outputName, { kind: "secret" as const, name: secretName }];
    }),
  );
}

async function loadModelProviderSourceStates(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly providerKeys: readonly string[];
  readonly metadataByAccessSource: Map<string, SecretConnectorMetadata>;
}): Promise<Map<string, RefreshSourceState>> {
  const result = new Map<string, RefreshSourceState>();
  if (args.providerKeys.length === 0) {
    return result;
  }

  const lookupsByUserId = new Map<string, ModelProviderSourceLookup[]>();
  for (const providerKey of args.providerKeys) {
    const lookup = modelProviderSourceLookup({
      providerKey,
      userId: args.userId,
      metadataByAccessSource: args.metadataByAccessSource,
    });
    const lookups = lookupsByUserId.get(lookup.userId) ?? [];
    lookups.push(lookup);
    lookupsByUserId.set(lookup.userId, lookups);
  }

  const stateEntries = await Promise.all(
    [...lookupsByUserId].map(async ([sourceUserId, lookups]) => {
      const providerTypes = [
        ...new Set(
          lookups.map((lookup) => {
            return lookup.providerType;
          }),
        ),
      ];
      const rows = await args.db
        .select({
          type: modelProviders.type,
          tokenExpiresAt: modelProviders.tokenExpiresAt,
          needsReconnect: modelProviders.needsReconnect,
        })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, args.orgId),
            eq(modelProviders.userId, sourceUserId),
            inArray(modelProviders.type, providerTypes),
          ),
        );

      const stateByType = new Map<string, RefreshSourceState>();
      for (const row of rows) {
        stateByType.set(row.type, refreshSourceStateFromRow(row));
      }

      return lookups.flatMap((lookup) => {
        const state = stateByType.get(lookup.providerType);
        return state ? [[lookup.providerKey, state] as const] : [];
      });
    }),
  );

  for (const entries of stateEntries) {
    for (const [providerKey, state] of entries) {
      result.set(providerKey, state);
    }
  }
  return result;
}

function connectorSlugsForAccessSources(args: {
  readonly accessSourceKeys: readonly string[];
  readonly metadataByAccessSource: ReadonlyMap<string, SecretConnectorMetadata>;
}): readonly string[] {
  return args.accessSourceKeys.filter((accessSourceKey) => {
    return (
      resolveRefreshMetadata(
        accessSourceKey,
        args.metadataByAccessSource.get(accessSourceKey),
      ).sourceType === "connector"
    );
  });
}

async function loadAccessSourceStates(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly accessSourceKeys: readonly string[];
  readonly metadataByAccessSource: Map<string, SecretConnectorMetadata>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
}): Promise<Map<string, RefreshSourceState>> {
  const connectorSlugs = connectorSlugsForAccessSources({
    accessSourceKeys: args.accessSourceKeys,
    metadataByAccessSource: args.metadataByAccessSource,
  });
  const providerKeys = args.accessSourceKeys.filter((accessSourceKey) => {
    return (
      resolveRefreshMetadata(
        accessSourceKey,
        args.metadataByAccessSource.get(accessSourceKey),
      ).sourceType === "model-provider"
    );
  });

  const merged = new Map<string, RefreshSourceState>();
  for (const connectorSlug of connectorSlugs) {
    const state = args.connectorAccessBySlug.get(connectorSlug);
    if (state) {
      merged.set(connectorSlug, state);
    }
  }

  const modelProviderStates = await loadModelProviderSourceStates({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    providerKeys,
    metadataByAccessSource: args.metadataByAccessSource,
  });
  for (const [providerKey, state] of modelProviderStates) {
    merged.set(providerKey, state);
  }
  return merged;
}

async function loadCurrentSourceStateSnapshot(args: {
  readonly db: Db;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  readonly orgId: string;
  readonly userId: string;
  readonly accessSourceKeys: readonly string[];
  readonly metadataByAccessSource: Map<string, SecretConnectorMetadata>;
}): Promise<SourceStateSnapshot> {
  const connectorSlugs = connectorSlugsForAccessSources({
    accessSourceKeys: args.accessSourceKeys,
    metadataByAccessSource: args.metadataByAccessSource,
  });
  const connectorAccessBySlug = await loadConnectorAccessStates(
    args.db,
    args.orgId,
    args.userId,
    connectorSlugs,
    args.connectorCatalogSnapshot,
  );
  return {
    connectorAccessBySlug,
    sourceStateMap: await loadAccessSourceStates({
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      accessSourceKeys: args.accessSourceKeys,
      metadataByAccessSource: args.metadataByAccessSource,
      connectorAccessBySlug,
    }),
  };
}

function prepareRefreshTokenContext(
  args: RefreshAccessTokenArgs,
): PrepareRefreshTokenContextResult {
  const metadata = resolveRefreshMetadata(args.accessSourceKey, {
    sourceType: args.sourceType,
    ...(args.sourceUserId ? { sourceUserId: args.sourceUserId } : {}),
    ...(args.metadataKey ? { metadataKey: args.metadataKey } : {}),
  });
  const runtimeOutputSecrets = runtimeOutputSecretsForSource({
    accessSourceKey: args.accessSourceKey,
    metadata,
    accessEnvVars: args.accessEnvVars,
    connectorAccessBySlug: args.connectorAccessBySlug,
  });
  if (Object.keys(runtimeOutputSecrets).length === 0) {
    return { ok: false, reason: "not-refreshable" };
  }

  if (args.sourceType === "model-provider") {
    const providerKey = args.accessSourceKey;
    if (!isModelProviderRefreshProviderKey(providerKey)) {
      return { ok: false, reason: "not-refreshable" };
    }
    const secretMetadata = getModelProviderRefreshMetadata(providerKey);
    if (!secretMetadata.isRefreshable) {
      return { ok: false, reason: "not-refreshable" };
    }
    if (!args.metadataKey) {
      throw new Error(
        `metadataKey required for model-provider source on ${providerKey}`,
      );
    }

    const env = currentProviderEnv();
    if (
      !isModelProviderRefreshConfigured({
        providerKey,
        currentEnv: env,
      })
    ) {
      L.debug(
        `${providerKey} auth client not configured, skipping token refresh`,
      );
      return { ok: false, reason: "client-unconfigured" };
    }

    const context: RefreshTokenContext = {
      inputSources: Object.fromEntries(
        Object.entries(secretMetadata.inputs).map(([inputName, secretName]) => {
          return [inputName, { kind: "secret" as const, name: secretName }];
        }),
      ),
      outputTargets: modelProviderRefreshOutputTargets(secretMetadata.outputs),
      runtimeOutputSecrets,
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
        providerKey,
        currentEnv: env,
        context,
      },
    };
  }

  const connectorSlug = args.accessSourceKey;
  const connectorAccess = args.connectorAccessBySlug.get(connectorSlug);
  if (connectorAccess?.accessMetadata.kind !== "refresh-token") {
    L.debug(`${connectorSlug} does not use refresh-token access, skipping`);
    return { ok: false, reason: "not-refreshable" };
  }
  const accessMetadata = connectorAccess.accessMetadata;
  if (connectorAccess.runtimeMethod.method.access.kind !== "refresh-token") {
    return { ok: false, reason: "not-refreshable" };
  }
  const context: RefreshTokenContext = {
    inputSources: connectorRefreshInputSources(accessMetadata),
    outputTargets: connectorRefreshOutputTargets(accessMetadata),
    runtimeOutputSecrets,
    secretUserId: resolveSecretUserId(
      args.sourceType,
      args.userId,
      args.sourceUserId,
    ),
  };

  const clientConfig = connectorAccess.runtimeMethod.method.client;
  const authClient = clientConfig
    ? resolveConnectorAuthClient(clientConfig, optionalEnv)
    : undefined;
  if (clientConfig && !authClient) {
    L.debug(
      `${connectorSlug} connector client not configured, skipping token refresh`,
    );
    return { ok: false, reason: "client-unconfigured" };
  }

  return {
    ok: true,
    prepared: {
      sourceType: "connector",
      connectorId: connectorAccess.connectorId,
      connectorSlug: connectorAccess.runtimeMethod.connectorSlug,
      authMethodId: connectorAccess.runtimeMethod.authMethodId,
      runtimeMethod: connectorAccess.runtimeMethod,
      ...(authClient ? { authClient } : {}),
      context,
    },
  };
}

function tokenExpiresAtNeedsRefresh(tokenExpiresAt: Date | null): boolean {
  if (tokenExpiresAt === null) {
    return true;
  }
  const expiresAtSeconds = Math.floor(tokenExpiresAt.getTime() / 1000);
  return expiresAtSeconds <= currentSecond() + REFRESH_BUFFER_SECS;
}

function currentSecond(): number {
  return Math.floor(nowDate().getTime() / 1000);
}

function missingRefreshInputNames(state: RefreshState): readonly string[] {
  return Object.entries(state.inputValues).flatMap(([name, value]) => {
    return value ? [] : [name];
  });
}

function requiredRuntimeOutputSecretNames(
  context: RefreshTokenContext,
): readonly string[] {
  return [...new Set(Object.values(context.runtimeOutputSecrets))];
}

function runtimeOutputValues(args: {
  readonly context: RefreshTokenContext;
  readonly state: RefreshState;
}): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(args.context.runtimeOutputSecrets).map(
      ([envName, secretName]) => {
        return [envName, args.state.outputValues[secretName] ?? null];
      },
    ),
  );
}

function allRuntimeOutputsAvailable(args: {
  readonly context: RefreshTokenContext;
  readonly state: RefreshState;
}): boolean {
  return Object.values(runtimeOutputValues(args)).every((value) => {
    return value !== null;
  });
}

function nonNullRuntimeOutputValues(args: {
  readonly context: RefreshTokenContext;
  readonly state: RefreshState;
}): Record<string, string> | null {
  const values = runtimeOutputValues(args);
  const nonNullValues: Record<string, string> = {};
  for (const [envName, value] of Object.entries(values)) {
    if (value === null) {
      return null;
    }
    nonNullValues[envName] = value;
  }
  return nonNullValues;
}

function sameStringRecord(
  left: Readonly<Record<string, string | null>>,
  right: Readonly<Record<string, string | null>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (stringRecordValue(left, key) !== stringRecordValue(right, key)) {
      return false;
    }
  }
  return true;
}

function stringRecordValue(
  record: Readonly<Record<string, string | null>>,
  key: string,
): string | null {
  if (!Object.hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  return value === undefined ? null : value;
}

function refreshSourceStateFromRow(args: {
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
}): RefreshSourceState {
  return {
    tokenExpiresAt: args.tokenExpiresAt
      ? Math.floor(args.tokenExpiresAt.getTime() / 1000)
      : null,
    needsReconnect: args.needsReconnect,
  };
}

async function currentDatabaseTimestampMicros(db: Db): Promise<bigint> {
  const rows = await executeRawRows(
    db,
    sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint AS now`,
    databaseTimestampMicrosRowSchema,
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Failed to read database timestamp");
  }
  return row.now;
}

function shouldUseLockedCurrentAccess(args: {
  readonly refreshArgs: RefreshAccessTokenArgs;
  readonly context: RefreshTokenContext;
  readonly initialState: RefreshState | null;
  readonly requestStartedAtMicros: bigint | null;
  readonly state: RefreshState;
}): boolean {
  if (
    !allRuntimeOutputsAvailable({ context: args.context, state: args.state })
  ) {
    return false;
  }
  if (tokenExpiresAtNeedsRefresh(args.state.tokenExpiresAt)) {
    return false;
  }
  if (args.state.needsReconnect) {
    return false;
  }
  if (!args.refreshArgs.forceRefresh) {
    return true;
  }

  const outputValues = runtimeOutputValues({
    context: args.context,
    state: args.state,
  });
  for (const [envName, outputValue] of Object.entries(outputValues)) {
    const snapshotValue = args.refreshArgs.connectorSecrets[envName];
    if (snapshotValue !== undefined && snapshotValue !== outputValue) {
      return true;
    }
  }

  if (
    args.requestStartedAtMicros !== null &&
    args.state.updatedAtMicros > args.requestStartedAtMicros
  ) {
    return true;
  }

  if (!args.initialState) {
    return true;
  }

  if (
    !sameStringRecord(
      args.initialState.outputValues,
      args.state.outputValues,
    ) ||
    !sameStringRecord(args.initialState.inputValues, args.state.inputValues)
  ) {
    return true;
  }

  const initialExpiresAt = args.initialState.tokenExpiresAt
    ? Math.floor(args.initialState.tokenExpiresAt.getTime() / 1000)
    : null;
  const lockedExpiresAt = args.state.tokenExpiresAt
    ? Math.floor(args.state.tokenExpiresAt.getTime() / 1000)
    : null;
  return (
    initialExpiresAt !== lockedExpiresAt ||
    args.initialState.updatedAtMicros !== args.state.updatedAtMicros
  );
}

function didLockedRefreshFailDuringRequest(args: {
  readonly initialState: RefreshState | null;
  readonly requestStartedAtMicros: bigint | null;
  readonly state: RefreshState;
}): boolean {
  if (!args.state.needsReconnect) {
    return lockedRefreshFailureReasonDuringRequest(args) !== undefined;
  }
  if (args.initialState) {
    return (
      !args.initialState.needsReconnect ||
      args.initialState.updatedAtMicros !== args.state.updatedAtMicros
    );
  }
  return (
    args.requestStartedAtMicros !== null &&
    args.state.updatedAtMicros > args.requestStartedAtMicros
  );
}

function lockedRefreshFailureReasonDuringRequest(args: {
  readonly initialState: RefreshState | null;
  readonly requestStartedAtMicros: bigint | null;
  readonly state: RefreshState;
}): FirewallAuthFailureReason | undefined {
  if (
    args.requestStartedAtMicros === null ||
    args.state.updatedAtMicros <= args.requestStartedAtMicros
  ) {
    return undefined;
  }
  if (
    args.initialState &&
    args.initialState.updatedAtMicros === args.state.updatedAtMicros
  ) {
    return undefined;
  }

  if (args.state.needsReconnect) {
    return missingRefreshInputNames(args.state).length > 0 ||
      isReconnectRequiredRefreshErrorCode(args.state.lastRefreshErrorCode)
      ? "reconnect_required"
      : undefined;
  }

  const tokenStateUnchanged = sameRefreshTokenState(
    args.initialState,
    args.state,
  );
  if (tokenExpiresAtNeedsRefresh(args.state.tokenExpiresAt)) {
    return !args.initialState || tokenStateUnchanged
      ? "upstream_provider"
      : undefined;
  }

  if (tokenStateUnchanged) {
    return "upstream_provider";
  }
  return undefined;
}

function sameRefreshTokenState(
  initialState: RefreshState | null,
  state: RefreshState,
): boolean {
  return (
    initialState !== null &&
    sameStringRecord(initialState.outputValues, state.outputValues) &&
    sameStringRecord(initialState.inputValues, state.inputValues) &&
    sameTokenExpiresAt(initialState.tokenExpiresAt, state.tokenExpiresAt)
  );
}

function sameTokenExpiresAt(left: Date | null, right: Date | null): boolean {
  return timestampMillisOrNull(left) === timestampMillisOrNull(right);
}

function timestampMillisOrNull(value: Date | null): number | null {
  if (value === null) {
    return null;
  }
  return value.getTime();
}

async function loadModelProviderRefreshStateRow(
  db: Db,
  args: RefreshAccessTokenArgs,
  context: RefreshTokenContext,
  lockRow: boolean,
): Promise<RefreshStateRow | null> {
  const query = db
    .select({
      authMethod: sql`NULL`.mapWith(pgNullDecoder),
      connectorId: sql`NULL`.mapWith(pgNullDecoder),
      storageVersion: sql`NULL`.mapWith(pgNullDecoder),
      tokenExpiresAt: modelProviders.tokenExpiresAt,
      needsReconnect: modelProviders.needsReconnect,
      lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
      updatedAtMicros:
        sql`(EXTRACT(EPOCH FROM ${modelProviders.updatedAt}) * 1000000)::bigint`.mapWith(
          pgInt8ToBigIntDecoder,
        ),
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, args.orgId),
        eq(modelProviders.userId, context.secretUserId),
        eq(
          modelProviders.type,
          requiredModelProviderMetadataKey({
            providerKey: args.accessSourceKey,
            metadataKey: args.metadataKey,
          }),
        ),
      ),
    );
  const rows = lockRow
    ? await query.for("update").limit(1)
    : await query.limit(1);
  return rows[0] ?? null;
}

async function loadConnectorRefreshStateRow(
  db: Db,
  args: RefreshAccessTokenArgs,
  lockRow: boolean,
): Promise<RefreshStateRow | null> {
  const connectorSlug = args.accessSourceKey;
  const query = db
    .select({
      authMethod: connectors.authMethod,
      connectorId: connectors.id,
      storageVersion: connectors.storageVersion,
      tokenExpiresAt: connectors.tokenExpiresAt,
      needsReconnect: connectors.needsReconnect,
      lastRefreshErrorCode: sql`NULL`.mapWith(pgNullDecoder),
      updatedAtMicros:
        sql`(EXTRACT(EPOCH FROM ${connectors.updatedAt}) * 1000000)::bigint`.mapWith(
          pgInt8ToBigIntDecoder,
        ),
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.connectorSlug, connectorSlug),
      ),
    );
  const rows = lockRow
    ? await query.for("update").limit(1)
    : await query.limit(1);
  return rows[0] ?? null;
}

async function loadRefreshState(
  db: Db,
  args: RefreshAccessTokenArgs,
  context: RefreshTokenContext,
  options: { readonly lockRow?: boolean } = {},
): Promise<RefreshState | null> {
  const row =
    args.sourceType === "model-provider"
      ? await loadModelProviderRefreshStateRow(
          db,
          args,
          context,
          options.lockRow === true,
        )
      : await loadConnectorRefreshStateRow(db, args, options.lockRow === true);

  if (!row) {
    return null;
  }

  const connectorSlug =
    args.sourceType === "connector" ? args.accessSourceKey : undefined;
  const connectorAccess = connectorSlug
    ? args.connectorAccessBySlug.get(connectorSlug)?.access
    : undefined;
  const outputValues: Record<string, string | null> = {};
  for (const secretName of requiredRuntimeOutputSecretNames(context)) {
    outputValues[secretName] = await getSecretValue({
      connectorAccess,
      db,
      orgId: args.orgId,
      userId: context.secretUserId,
      name: secretName,
      type: args.sourceType,
      featureSwitchContext: args.featureSwitchContext,
    });
  }

  const inputValues: Record<string, string | null> = {};
  for (const [inputName, inputSource] of Object.entries(context.inputSources)) {
    inputValues[inputName] =
      inputSource.kind === "secret"
        ? await getSecretValue({
            connectorAccess,
            db,
            orgId: args.orgId,
            userId: context.secretUserId,
            name: inputSource.name,
            type: args.sourceType,
            featureSwitchContext: args.featureSwitchContext,
          })
        : await getVariableValue({
            connectorAccess,
            db,
            orgId: args.orgId,
            userId: context.secretUserId,
            name: inputSource.name,
          });
  }

  return {
    authMethod: row.authMethod,
    connectorId: row.connectorId,
    storageVersion: row.storageVersion,
    outputValues,
    inputValues,
    tokenExpiresAt: row.tokenExpiresAt,
    needsReconnect: row.needsReconnect,
    lastRefreshErrorCode: row.lastRefreshErrorCode,
    updatedAtMicros: row.updatedAtMicros,
  };
}

async function markRefreshSuccess(
  args: RefreshAccessTokenArgs,
  prepared: PreparedRefreshTokenContext,
  context: RefreshTokenContext,
  outputs: readonly ValidatedRefreshOutput[],
  expiresIn: number | undefined,
): Promise<Record<string, string>> {
  const returnedSecretValues = new Map<string, string>();
  for (const { target, value } of outputs) {
    switch (target.kind) {
      case "secret": {
        if (prepared.sourceType === "model-provider") {
          await upsertModelProviderSecretValue(args.db, {
            orgId: args.orgId,
            userId: context.secretUserId,
            name: target.name,
            value,
            featureSwitchContext: args.featureSwitchContext,
          });
        } else {
          const encryptedValue = await encryptStoredSecretValue(
            value,
            args.featureSwitchContext,
          );
          await upsertConnectorOwnedSecret(args.db, {
            connectorId: prepared.connectorId,
            method: prepared.runtimeMethod.method,
            orgId: args.orgId,
            userId: context.secretUserId,
            name: target.name,
            encryptedValue,
            description: `Connector secret: ${target.name}`,
          });
        }
        returnedSecretValues.set(target.name, value);
        break;
      }
      case "connector-variable": {
        if (prepared.sourceType !== "connector") {
          throw new Error(
            "Model provider refresh cannot write connector variables",
          );
        }
        await upsertConnectorOwnedVariable(args.db, {
          connectorId: prepared.connectorId,
          method: prepared.runtimeMethod.method,
          orgId: args.orgId,
          userId: context.secretUserId,
          name: target.name,
          value,
          description: null,
          updatedDescription: null,
        });
        break;
      }
    }
  }

  const expiresAt = new Date(
    nowDate().getTime() +
      (expiresIn ?? DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS) * 1000,
  );
  if (prepared.sourceType === "model-provider") {
    await args.db
      .update(modelProviders)
      .set({
        tokenExpiresAt: expiresAt,
        needsReconnect: false,
        lastRefreshErrorCode: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, context.secretUserId),
          eq(
            modelProviders.type,
            requiredModelProviderMetadataKey({
              providerKey: args.accessSourceKey,
              metadataKey: args.metadataKey,
            }),
          ),
        ),
      );
    return Object.fromEntries(returnedSecretValues);
  }

  await args.db
    .update(connectors)
    .set({
      tokenExpiresAt: expiresAt,
      storageVersion: prepared.runtimeMethod.method.storage.version,
      needsReconnect: false,
      reconnectReason: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(connectors.id, prepared.connectorId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.connectorSlug, prepared.connectorSlug),
      ),
    );
  return Object.fromEntries(returnedSecretValues);
}

async function markRefreshFailure(
  args: RefreshAccessTokenArgs,
  context: RefreshTokenContext,
  errorCode: string | null,
  failureReason: FirewallAuthFailureReason | undefined,
  connectorReconnectReason: ConnectorReconnectReason | null,
): Promise<void> {
  if (args.sourceType === "model-provider") {
    await args.db
      .update(modelProviders)
      .set(
        failureReason === "upstream_provider"
          ? { updatedAt: sql`clock_timestamp()` }
          : {
              needsReconnect: true,
              lastRefreshErrorCode: errorCode,
              updatedAt: sql`clock_timestamp()`,
            },
      )
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, context.secretUserId),
          eq(
            modelProviders.type,
            requiredModelProviderMetadataKey({
              providerKey: args.accessSourceKey,
              metadataKey: args.metadataKey,
            }),
          ),
        ),
      );
    return;
  }

  const connectorSlug = args.accessSourceKey;
  await args.db
    .update(connectors)
    .set(
      failureReason === "upstream_provider"
        ? { updatedAt: sql`clock_timestamp()` }
        : {
            needsReconnect: true,
            reconnectReason: connectorReconnectReason,
            updatedAt: sql`clock_timestamp()`,
          },
    )
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.connectorSlug, connectorSlug),
      ),
    );
}

async function markRefreshTokenMissing(
  args: RefreshAccessTokenArgs,
  context: RefreshTokenContext,
): Promise<RefreshAccessTokenResult> {
  await markRefreshFailure(args, context, null, "reconnect_required", null);
  return refreshTokenMissingResult();
}

async function markAndReturnRefreshFailure(
  args: RefreshAccessTokenArgs,
  context: RefreshTokenContext,
  error: unknown,
  signal: AbortSignal,
): Promise<RefreshAccessTokenResult> {
  const message = error instanceof Error ? error.message : "Unknown error";
  const { errorCode, failureReason } = classifyRefreshFailure(error, signal);
  L.warn(`${args.accessSourceKey} token refresh failed: ${message}`, {
    accessSourceKey: args.accessSourceKey,
    orgId: args.orgId,
    userId: args.userId,
    errorCode,
    failureReason,
    ...oauthRefreshFailureLogFields(error),
  });
  await markRefreshFailure(
    args,
    context,
    errorCode,
    failureReason,
    connectorReconnectReasonFromRefreshFailure(error, failureReason),
  );
  return refreshFailedResult(failureReason);
}

function refreshPreparedAccessToken(args: {
  readonly prepared: PreparedRefreshTokenContext;
  readonly inputs: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}) {
  if (args.prepared.sourceType === "connector") {
    return refreshPreparedConnectorAccessToken({
      prepared: args.prepared,
      inputs: args.inputs,
      signal: args.signal,
    });
  }

  return refreshPreparedModelProviderAccessToken({
    prepared: args.prepared,
    inputs: args.inputs,
    signal: args.signal,
  });
}

function refreshPreparedModelProviderAccessToken(args: {
  readonly prepared: ModelProviderPreparedRefreshTokenContext;
  readonly inputs: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}) {
  return refreshPreparedModelProviderAccess({
    providerKey: args.prepared.providerKey,
    currentEnv: args.prepared.currentEnv,
    inputs: args.inputs,
    signal: args.signal,
  });
}

function refreshPreparedConnectorAccessToken(args: {
  readonly prepared: ConnectorPreparedRefreshTokenContext;
  readonly inputs: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}) {
  return refreshConnectorAuthProviderAccessTokenWithMethod({
    connectorSlug: args.prepared.connectorSlug,
    authMethodId: args.prepared.authMethodId,
    method: args.prepared.runtimeMethod.method,
    ...(args.prepared.authClient
      ? { authClient: args.prepared.authClient }
      : {}),
    inputs: args.inputs,
    signal: args.signal,
  });
}

async function lockPreparedRefreshSource(
  db: Db,
  args: RefreshAccessTokenArgs,
  prepared: PreparedRefreshTokenContext,
): Promise<void> {
  if (prepared.sourceType === "connector") {
    await lockConnectorState(db, {
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: prepared.connectorSlug,
    });
    return;
  }

  await lockModelProviderState(db, {
    orgId: args.orgId,
    userId: prepared.context.secretUserId,
    type: args.metadataKey ?? prepared.providerKey,
  });
}

function preparedRefreshSourceMatchesState(
  args: RefreshAccessTokenArgs,
  prepared: PreparedRefreshTokenContext,
  state: RefreshState,
): boolean {
  if (prepared.sourceType === "model-provider") {
    return true;
  }
  return (
    args.accessSourceKey === prepared.connectorSlug &&
    state.connectorId === prepared.connectorId &&
    state.authMethod === prepared.authMethodId &&
    state.storageVersion === prepared.runtimeMethod.method.storage.version
  );
}

function currentPreparedRefreshState(args: {
  readonly refreshArgs: RefreshAccessTokenArgs;
  readonly prepared: PreparedRefreshTokenContext;
  readonly state: RefreshState | null;
}): RefreshState | null {
  if (!args.state) {
    L.warn(`${args.refreshArgs.accessSourceKey} token refresh source missing`, {
      accessSourceKey: args.refreshArgs.accessSourceKey,
      orgId: args.refreshArgs.orgId,
      userId: args.refreshArgs.userId,
      sourceType: args.refreshArgs.sourceType,
    });
    return null;
  }
  return preparedRefreshSourceMatchesState(
    args.refreshArgs,
    args.prepared,
    args.state,
  )
    ? args.state
    : null;
}

function currentRefreshAccessResult(args: {
  readonly accessSourceKey: string;
  readonly context: RefreshTokenContext;
  readonly state: RefreshState;
}): RefreshAccessTokenResult {
  const currentSecrets = nonNullRuntimeOutputValues({
    context: args.context,
    state: args.state,
  });
  if (!currentSecrets) {
    throw new Error(
      `${args.accessSourceKey} current refresh outputs disappeared unexpectedly`,
    );
  }
  return {
    ok: true,
    status: "current",
    secrets: currentSecrets,
  };
}

function refreshInputsFromLockedState(args: {
  readonly accessSourceKey: string;
  readonly state: RefreshState;
}): Record<string, string> {
  const refreshInputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(args.state.inputValues)) {
    if (value === null) {
      throw new Error(`${args.accessSourceKey} refresh input ${name} missing`);
    }
    refreshInputs[name] = value;
  }
  return refreshInputs;
}

function runtimeSecretsFromRefreshResult(args: {
  readonly accessSourceKey: string;
  readonly context: RefreshTokenContext;
  readonly returnedSecretValues: Readonly<Record<string, string>>;
}): Record<string, string> {
  const refreshedSecrets: Record<string, string> = {};
  for (const [envName, secretName] of Object.entries(
    args.context.runtimeOutputSecrets,
  )) {
    const value = args.returnedSecretValues[secretName];
    if (value === undefined) {
      throw new Error(
        `${args.accessSourceKey} token refresh did not return runtime secret ${secretName}`,
      );
    }
    refreshedSecrets[envName] = value;
  }
  return refreshedSecrets;
}

function validateRefreshResultOutputs(args: {
  readonly accessSourceKey: string;
  readonly context: RefreshTokenContext;
  readonly result: {
    readonly outputs: Readonly<Record<string, string | undefined>>;
  };
}):
  | {
      readonly ok: true;
      readonly outputs: readonly ValidatedRefreshOutput[];
    }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  const returnedSecretValues = new Set<string>();
  const outputs: ValidatedRefreshOutput[] = [];
  for (const [outputName, value] of Object.entries(args.result.outputs)) {
    if (value === undefined) {
      continue;
    }
    const target = args.context.outputTargets[outputName];
    if (!target) {
      return {
        ok: false,
        message: `${args.accessSourceKey} token refresh returned undeclared output ${outputName}`,
      };
    }
    if (target.kind === "secret") {
      returnedSecretValues.add(target.name);
    }
    outputs.push({ target, value });
  }

  for (const secretName of requiredRuntimeOutputSecretNames(args.context)) {
    if (!returnedSecretValues.has(secretName)) {
      return {
        ok: false,
        message: `${args.accessSourceKey} token refresh did not return required output for ${secretName}`,
      };
    }
  }
  return { ok: true, outputs };
}

async function refreshLockedAccessToken(args: {
  readonly refreshArgs: RefreshAccessTokenArgs;
  readonly prepared: PreparedRefreshTokenContext;
  readonly initialState: RefreshState | null;
  readonly requestStartedAtMicros: bigint | null;
}): Promise<RefreshAccessTokenResult> {
  const lockedState = currentPreparedRefreshState({
    refreshArgs: args.refreshArgs,
    prepared: args.prepared,
    state: await loadRefreshState(
      args.refreshArgs.db,
      args.refreshArgs,
      args.prepared.context,
      { lockRow: true },
    ),
  });
  if (!lockedState) {
    return sourceMissingResult();
  }

  if (
    didLockedRefreshFailDuringRequest({
      initialState: args.initialState,
      requestStartedAtMicros: args.requestStartedAtMicros,
      state: lockedState,
    })
  ) {
    return refreshFailedResult(
      lockedRefreshFailureReasonDuringRequest({
        initialState: args.initialState,
        requestStartedAtMicros: args.requestStartedAtMicros,
        state: lockedState,
      }),
    );
  }

  if (
    shouldUseLockedCurrentAccess({
      refreshArgs: args.refreshArgs,
      context: args.prepared.context,
      initialState: args.initialState,
      requestStartedAtMicros: args.requestStartedAtMicros,
      state: lockedState,
    })
  ) {
    return currentRefreshAccessResult({
      accessSourceKey: args.refreshArgs.accessSourceKey,
      context: args.prepared.context,
      state: lockedState,
    });
  }

  const missingInputNames = missingRefreshInputNames(lockedState);
  if (missingInputNames.length > 0) {
    L.debug(
      `No ${args.refreshArgs.accessSourceKey} refresh inputs available, skipping`,
      { missingInputNames },
    );
    return markRefreshTokenMissing(args.refreshArgs, args.prepared.context);
  }

  const refreshSignal = firewallAuthRefreshTimeoutSignal();
  const refreshResult = await settle(
    refreshPreparedAccessToken({
      prepared: args.prepared,
      inputs: refreshInputsFromLockedState({
        accessSourceKey: args.refreshArgs.accessSourceKey,
        state: lockedState,
      }),
      signal: refreshSignal,
    }),
  );
  if (!refreshResult.ok) {
    return markAndReturnRefreshFailure(
      args.refreshArgs,
      args.prepared.context,
      refreshResult.error,
      refreshSignal,
    );
  }

  const outputValidation = validateRefreshResultOutputs({
    accessSourceKey: args.refreshArgs.accessSourceKey,
    context: args.prepared.context,
    result: refreshResult.value,
  });
  if (!outputValidation.ok) {
    L.warn(outputValidation.message, {
      accessSourceKey: args.refreshArgs.accessSourceKey,
      orgId: args.refreshArgs.orgId,
      userId: args.refreshArgs.userId,
      sourceType: args.refreshArgs.sourceType,
    });
    await markRefreshFailure(
      args.refreshArgs,
      args.prepared.context,
      null,
      "upstream_provider",
      null,
    );
    return refreshFailedResult("upstream_provider");
  }

  const returnedSecretValues = await markRefreshSuccess(
    args.refreshArgs,
    args.prepared,
    args.prepared.context,
    outputValidation.outputs,
    refreshResult.value.expiresIn,
  );
  const refreshedSecrets = runtimeSecretsFromRefreshResult({
    accessSourceKey: args.refreshArgs.accessSourceKey,
    context: args.prepared.context,
    returnedSecretValues,
  });
  Object.assign(
    args.refreshArgs.connectorSecrets,
    returnedSecretValues,
    refreshedSecrets,
  );
  L.debug(
    `${args.refreshArgs.accessSourceKey} access token refreshed successfully`,
  );
  return {
    ok: true,
    status: "refreshed",
    secrets: refreshedSecrets,
  };
}

async function refreshAccessTokenForSource(
  args: RefreshAccessTokenArgs,
): Promise<RefreshAccessTokenResult> {
  const preparation = prepareRefreshTokenContext(args);
  if (!preparation.ok) {
    return preparation.reason === "refresh-token-missing"
      ? refreshTokenMissingResult()
      : { ok: false, reason: preparation.reason };
  }
  const { prepared } = preparation;
  const requestStartedAtMicros = args.forceRefresh
    ? args.forceRefreshStartedAtMicros
    : await currentDatabaseTimestampMicros(args.db);
  const initialState = await loadRefreshState(args.db, args, prepared.context);
  return await args.db.transaction(async (tx) => {
    await lockPreparedRefreshSource(tx, args, prepared);
    return await refreshLockedAccessToken({
      refreshArgs: { ...args, db: tx },
      prepared,
      initialState,
      requestStartedAtMicros,
    });
  });
}

function buildMetadataByAccessSource(
  refreshable: Map<string, string>,
  secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined,
): Map<string, SecretConnectorMetadata> {
  const metadataByAccessSource = new Map<string, SecretConnectorMetadata>();
  for (const [key, accessSourceKey] of refreshable) {
    const metadata = secretConnectorMetadataMap?.[key];
    if (metadata && !metadataByAccessSource.has(accessSourceKey)) {
      metadataByAccessSource.set(accessSourceKey, metadata);
    }
  }
  return metadataByAccessSource;
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
    const accessSourceKey = secretConnectorMap[key];
    if (!accessSourceKey) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      accessSourceKey,
      secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "model-provider") {
      continue;
    }
    const providerKey = accessSourceKey;

    const ownerUserId = metadata.sourceUserId ?? ORG_SENTINEL_USER_ID;
    if (ownerUserId !== auth.userId && ownerUserId !== ORG_SENTINEL_USER_ID) {
      L.warn(`[${auth.runId}] Rejected forbidden model-provider owner`, {
        ownerUserId,
        providerKey,
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
  unavailableConnectors: [],
}) satisfies RefreshResult;

function buildRefreshableMap(
  secretConnectorMap: Record<string, string>,
  secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined,
  connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>,
  referencedKeys: Set<string>,
): Map<string, string> {
  const refreshable = new Map<string, string>();
  for (const key of referencedKeys) {
    const accessSourceKey = secretConnectorMap[key];
    if (!accessSourceKey) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      accessSourceKey,
      secretConnectorMetadataMap?.[key],
    );
    const refreshableSecretName = refreshableRuntimeSecretNameForSource({
      key,
      accessSourceKey,
      metadata,
      connectorAccessBySlug,
    });
    if (refreshableSecretName) {
      refreshable.set(key, accessSourceKey);
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

function isConnectorRuntimeSecretKey(
  key: string,
  connectorAccess: ConnectorAccessState,
): boolean {
  return connectorRuntimeSecretName(key, connectorAccess) !== undefined;
}

function isConnectorRuntimePlatformSecretKey(
  key: string,
  connectorAccess: ConnectorAccessState,
): boolean {
  return connectorRuntimePlatformSecretName(key, connectorAccess) !== undefined;
}

function isRefreshableConnectorRuntimeSecretKey(
  key: string,
  connectorAccess: ConnectorAccessState,
): boolean {
  const secretName = connectorRuntimeSecretName(key, connectorAccess);
  if (!secretName) {
    return false;
  }
  return connectorAccess.accessMetadata.kind === "refresh-token"
    ? connectorRefreshMetadataHasRefreshableSecret(
        connectorAccess.accessMetadata,
        secretName,
      )
    : true;
}

function connectorRuntimeSecretName(
  key: string,
  connectorAccess: ConnectorAccessState,
): string | undefined {
  switch (connectorAccess.accessMetadata.kind) {
    case "refresh-token": {
      return getConnectorRuntimeBindingSecretName(
        connectorAccess.runtimeMetadata,
        key,
      );
    }
    case "static": {
      return getConnectorRuntimeBindingSecretName(
        connectorAccess.runtimeMetadata,
        key,
      );
    }
    case "none": {
      return undefined;
    }
  }
}

function connectorRuntimePlatformSecretName(
  key: string,
  connectorAccess: ConnectorAccessState,
): string | undefined {
  switch (connectorAccess.accessMetadata.kind) {
    case "refresh-token":
    case "static": {
      return getConnectorRuntimeBindingPlatformSecretName(
        connectorAccess.runtimeMetadata,
        key,
      );
    }
    case "none": {
      return undefined;
    }
  }
}

function modelProviderAccessSecretName(args: {
  readonly key: string;
  readonly providerKey: string;
  readonly metadata: SecretConnectorMetadata;
}): string | undefined {
  const secretMetadata = getModelProviderRefreshMetadata(args.providerKey);
  if (!secretMetadata?.isRefreshable) {
    return undefined;
  }

  const secretName = modelProviderRuntimeSecretName(args);
  return secretName && secretMetadata.refreshableSecrets.includes(secretName)
    ? secretName
    : undefined;
}

function referencedModelProviderAccessMap(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
}): Map<string, string> {
  const refreshable = new Map<string, string>();
  if (!args.secretConnectorMap) {
    return refreshable;
  }

  for (const key of args.referencedKeys) {
    const accessSourceKey = args.secretConnectorMap[key];
    if (!accessSourceKey) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      accessSourceKey,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "model-provider") {
      continue;
    }
    const providerKey = accessSourceKey;
    if (
      modelProviderAccessSecretName({
        key,
        providerKey,
        metadata,
      }) === undefined
    ) {
      continue;
    }
    refreshable.set(key, providerKey);
  }
  return refreshable;
}

async function syncStoredConnectorRuntimeSecrets(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<void> {
  if (!args.secretConnectorMap) {
    return;
  }

  const lookups = [...args.referencedKeys].flatMap((key) => {
    const accessSourceKey = getOwnConnectorOwner(args.secretConnectorMap, key);
    if (!accessSourceKey) {
      return [];
    }
    const metadata = resolveRefreshMetadata(
      accessSourceKey,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "connector") {
      return [];
    }
    const connectorSlug = accessSourceKey;
    const connectorAccess = args.connectorAccessBySlug.get(connectorSlug);
    if (!connectorAccess) {
      return [];
    }
    const secretName = connectorRuntimeSecretName(key, connectorAccess);
    if (
      secretName &&
      connectorAccess.accessMetadata.kind === "refresh-token" &&
      connectorRefreshMetadataHasRefreshableSecret(
        connectorAccess.accessMetadata,
        secretName,
      )
    ) {
      return [];
    }
    return secretName
      ? [{ access: connectorAccess.access, key, secretName }]
      : [];
  });
  if (lookups.length === 0) {
    return;
  }

  const namesByConnectorId = new Map<
    string,
    {
      readonly access: ConnectorCredentialAccess;
      readonly names: Set<string>;
    }
  >();
  for (const lookup of lookups) {
    const existing = namesByConnectorId.get(lookup.access.connectorId);
    if (existing) {
      existing.names.add(lookup.secretName);
    } else {
      namesByConnectorId.set(lookup.access.connectorId, {
        access: lookup.access,
        names: new Set([lookup.secretName]),
      });
    }
  }
  const rows = await args.db
    .select({
      name: secretsTable.name,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      connectorCredentialSecretReadCondition({
        db: args.db,
        groups: [...namesByConnectorId.values()].map((group) => {
          return { access: group.access, names: [...group.names] };
        }),
      }),
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

async function getModelProviderRuntimeSecretValue(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly providerType: ModelProviderType;
  readonly secretName: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<string | null> {
  const singleSecretName = getSecretNameForType(args.providerType);
  if (singleSecretName && args.secretName === singleSecretName) {
    const [row] = await args.db
      .select({ encryptedValue: secretsTable.encryptedValue })
      .from(modelProviders)
      .leftJoin(secretsTable, eq(modelProviders.secretId, secretsTable.id))
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, args.userId),
          eq(modelProviders.type, args.providerType),
          eq(secretsTable.orgId, args.orgId),
          eq(secretsTable.userId, args.userId),
          eq(secretsTable.name, args.secretName),
          eq(secretsTable.type, "model-provider"),
        ),
      )
      .limit(1);
    return row?.encryptedValue
      ? await decryptStoredSecretValue(
          row.encryptedValue,
          args.featureSwitchContext,
        )
      : null;
  }

  const [provider] = await args.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, args.orgId),
        eq(modelProviders.userId, args.userId),
        eq(modelProviders.type, args.providerType),
      ),
    )
    .limit(1);
  if (!provider) {
    return null;
  }

  return await getSecretValue({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    name: args.secretName,
    type: "model-provider",
    featureSwitchContext: args.featureSwitchContext,
  });
}

async function syncModelProviderRuntimeSecrets(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<void> {
  if (!args.secretConnectorMap) {
    return;
  }

  const lookups = [...args.referencedKeys].flatMap((key) => {
    const accessSourceKey = getOwnConnectorOwner(args.secretConnectorMap, key);
    if (!accessSourceKey) {
      return [];
    }
    const metadata = resolveRefreshMetadata(
      accessSourceKey,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "model-provider") {
      return [];
    }
    const providerKey = accessSourceKey;
    if (
      modelProviderAccessSecretName({
        key,
        providerKey,
        metadata,
      }) !== undefined
    ) {
      return [];
    }
    const providerType = modelProviderTypeForMetadata(providerKey, metadata);
    const secretName = modelProviderRuntimeSecretName({
      key,
      providerKey,
      metadata,
    });
    return providerType && secretName
      ? [
          {
            key,
            providerType,
            secretName,
            userId: resolveSecretUserId(
              "model-provider",
              args.userId,
              metadata.sourceUserId,
            ),
          },
        ]
      : [];
  });
  if (lookups.length === 0) {
    return;
  }

  await Promise.all(
    lookups.map(async (lookup) => {
      const value = await getModelProviderRuntimeSecretValue({
        db: args.db,
        orgId: args.orgId,
        userId: lookup.userId,
        providerType: lookup.providerType,
        secretName: lookup.secretName,
        featureSwitchContext: args.featureSwitchContext,
      });
      if (value === null || value.trim().length === 0) {
        delete args.secrets[lookup.key];
      } else {
        args.secrets[lookup.key] = value;
      }
    }),
  );
}

function syncPlatformRuntimeSecrets(args: {
  readonly secrets: Record<string, string>;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
}): void {
  if (!args.secretConnectorMap) {
    return;
  }

  for (const key of args.referencedKeys) {
    const accessSourceKey = getOwnConnectorOwner(args.secretConnectorMap, key);
    if (!accessSourceKey) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      accessSourceKey,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "platform-secret") {
      continue;
    }
    const connectorSlug = accessSourceKey;
    const connectorAccess = args.connectorAccessBySlug.get(connectorSlug);
    const platformSecretName =
      connectorAccess &&
      connectorRuntimePlatformSecretName(key, connectorAccess);
    const value = platformSecretName
      ? optionalEnv(platformSecretName)
      : undefined;
    if (value === undefined || value.trim().length === 0) {
      delete args.secrets[key];
    } else {
      args.secrets[key] = value;
    }
  }
}

async function syncCustomConnectorRuntimeSecrets(args: {
  readonly db: Db;
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: Record<string, string>;
  readonly referencedKeys: Set<string>;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<void> {
  const missingKeys = [...args.referencedKeys].filter((key) => {
    return !Object.hasOwn(args.secrets, key);
  });
  if (missingKeys.length === 0) {
    return;
  }

  const rows = await args.db
    .select({
      secretName: agentRunCustomConnectorAuthRefs.secretName,
      connectorId: agentRunCustomConnectorAuthRefs.connectorId,
      connectorRevision: agentRunCustomConnectorAuthRefs.connectorRevision,
      key: agentRunCustomConnectorAuthRefs.key,
      encryptedValue: agentRunCustomConnectorAuthRefs.encryptedValue,
    })
    .from(agentRunCustomConnectorAuthRefs)
    .where(
      and(
        eq(agentRunCustomConnectorAuthRefs.runId, args.runId),
        inArray(agentRunCustomConnectorAuthRefs.secretName, missingKeys),
        gt(agentRunCustomConnectorAuthRefs.expiresAt, sql`now()`),
      ),
    );

  for (const row of rows) {
    if (Object.hasOwn(args.secrets, row.secretName)) {
      continue;
    }
    const encryptedValue =
      row.key === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY
        ? await tapError(
            resolveLiveCustomConnectorOAuth2AccessToken({
              db: args.db,
              orgId: args.orgId,
              userId: args.userId,
              connectorId: row.connectorId,
              connectorRevision: row.connectorRevision,
              featureContext: args.featureSwitchContext,
              signal: AbortSignal.timeout(firewallAuthRefreshTimeoutMs()),
            }),
            (error) => {
              L.warn("Failed to resolve live custom connector OAuth token", {
                runId: args.runId,
                connectorId: row.connectorId,
                error,
              });
            },
          )
        : row.encryptedValue;
    if (!encryptedValue) {
      continue;
    }
    const decrypted = await tapError(
      decryptStoredSecretValue(encryptedValue, args.featureSwitchContext),
      (error) => {
        L.warn("Failed to decrypt custom connector auth ref", {
          runId: args.runId,
          secretName: row.secretName,
          error,
        });
      },
    );
    if (decrypted !== undefined) {
      args.secrets[row.secretName] = decrypted;
    }
  }
}

async function syncFirewallRuntimeSecrets(args: {
  readonly db: Db;
  readonly auth: SandboxAuth;
  readonly body: FirewallAuthBody;
  readonly orgId: string;
  readonly secrets: Record<string, string>;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<void> {
  await syncStoredConnectorRuntimeSecrets({
    db: args.db,
    orgId: args.orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    secretConnectorMap: args.body.secretConnectorMap,
    secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
    referencedKeys: args.referencedKeys,
    connectorAccessBySlug: args.connectorAccessBySlug,
    featureSwitchContext: args.featureSwitchContext,
  });
  await syncModelProviderRuntimeSecrets({
    db: args.db,
    orgId: args.orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    secretConnectorMap: args.body.secretConnectorMap,
    secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
    referencedKeys: args.referencedKeys,
    featureSwitchContext: args.featureSwitchContext,
  });
  await syncCustomConnectorRuntimeSecrets({
    db: args.db,
    runId: args.auth.runId,
    orgId: args.orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    referencedKeys: args.referencedKeys,
    featureSwitchContext: args.featureSwitchContext,
  });
  syncPlatformRuntimeSecrets({
    secrets: args.secrets,
    secretConnectorMap: args.body.secretConnectorMap,
    secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
    referencedKeys: args.referencedKeys,
    connectorAccessBySlug: args.connectorAccessBySlug,
  });
}

function canResolveMissingAccessSecret(args: {
  readonly key: string;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
}): boolean {
  const accessSourceKey = getOwnConnectorOwner(
    args.secretConnectorMap,
    args.key,
  );
  const metadata = args.secretConnectorMetadataMap?.[args.key];
  if (!accessSourceKey) {
    return false;
  }
  const refreshMetadata = resolveRefreshMetadata(accessSourceKey, metadata);
  if (refreshMetadata.sourceType === "model-provider") {
    const providerKey = accessSourceKey;
    return (
      modelProviderAccessSecretName({
        key: args.key,
        providerKey,
        metadata: refreshMetadata,
      }) !== undefined
    );
  }
  if (refreshMetadata.sourceType === "platform-secret") {
    return false;
  }

  const connectorSlug = accessSourceKey;
  const connectorAccess = args.connectorAccessBySlug.get(connectorSlug);
  if (connectorAccess?.accessMetadata.kind !== "refresh-token") {
    return false;
  }
  return isRefreshableConnectorRuntimeSecretKey(args.key, connectorAccess);
}

function referencedConnectorSlugs(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
}): readonly string[] {
  if (!args.secretConnectorMap) {
    return [];
  }
  const connectorSlugs = new Set<string>();
  for (const key of args.referencedKeys) {
    const accessSourceKey = args.secretConnectorMap[key];
    if (!accessSourceKey) {
      continue;
    }
    const sourceType = resolveRefreshMetadata(
      accessSourceKey,
      args.secretConnectorMetadataMap?.[key],
    ).sourceType;
    if (sourceType === "connector" || sourceType === "platform-secret") {
      const connectorSlug = accessSourceKey;
      connectorSlugs.add(connectorSlug);
    }
  }
  return [...connectorSlugs];
}

function hasUnavailableAccessSource(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
  readonly modelProviderSourceStateByProviderKey: ReadonlyMap<
    string,
    RefreshSourceState
  >;
}): boolean {
  if (!args.secretConnectorMap) {
    return false;
  }
  return [...args.referencedKeys].some((key) => {
    const accessSourceKey = args.secretConnectorMap?.[key];
    if (!accessSourceKey) {
      return false;
    }
    const metadata = resolveRefreshMetadata(
      accessSourceKey,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType === "model-provider") {
      const providerKey = accessSourceKey;
      const accessSecretName = modelProviderAccessSecretName({
        key,
        providerKey,
        metadata,
      });
      if (accessSecretName !== undefined) {
        return !args.modelProviderSourceStateByProviderKey.has(providerKey);
      }
      return (
        modelProviderRuntimeSecretName({
          key,
          providerKey,
          metadata,
        }) === undefined
      );
    }
    if (metadata.sourceType === "platform-secret") {
      const connectorSlug = accessSourceKey;
      const connectorAccess = args.connectorAccessBySlug.get(connectorSlug);
      return (
        !connectorAccess ||
        !isConnectorRuntimePlatformSecretKey(key, connectorAccess)
      );
    }

    const connectorSlug = accessSourceKey;
    const connectorAccess = args.connectorAccessBySlug.get(connectorSlug);
    return (
      !connectorAccess || !isConnectorRuntimeSecretKey(key, connectorAccess)
    );
  });
}

function connectorAccessCredentialStatus(
  connectorAccess: ConnectorAccessState,
  nowSeconds: number,
): ConnectorCredentialStatus {
  return connectorRuntimeCredentialStatusForAccess({
    storedNeedsReconnect: connectorAccess.needsReconnect,
    tokenExpiresAt:
      connectorAccess.tokenExpiresAt === null
        ? null
        : new Date(connectorAccess.tokenExpiresAt * 1000),
    now: new Date(nowSeconds * 1000),
    isRefreshable: connectorAccess.accessMetadata.kind === "refresh-token",
  });
}

function connectorSlugsWithReconnectRequiredStatus(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
}): readonly string[] {
  if (!args.secretConnectorMap) {
    return [];
  }
  const nowSeconds = Math.floor(nowDate().getTime() / 1000);
  const reconnectRequiredConnectorSlugs = new Set<string>();
  for (const key of args.referencedKeys) {
    const accessSourceKey = args.secretConnectorMap[key];
    if (!accessSourceKey) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      accessSourceKey,
      args.secretConnectorMetadataMap?.[key],
    );
    if (
      metadata.sourceType !== "connector" &&
      metadata.sourceType !== "platform-secret"
    ) {
      continue;
    }
    const connectorSlug = accessSourceKey;
    const connectorAccess = args.connectorAccessBySlug.get(connectorSlug);
    const isAvailableKey =
      metadata.sourceType === "platform-secret"
        ? connectorAccess &&
          isConnectorRuntimePlatformSecretKey(key, connectorAccess)
        : connectorAccess && isConnectorRuntimeSecretKey(key, connectorAccess);
    if (!connectorAccess || !isAvailableKey) {
      continue;
    }
    if (
      connectorAccessCredentialStatus(connectorAccess, nowSeconds) ===
      "reconnect-required"
    ) {
      reconnectRequiredConnectorSlugs.add(connectorSlug);
    }
  }
  return [...reconnectRequiredConnectorSlugs];
}

function hasMissingUnresolvableSecrets(args: {
  readonly secrets: Record<string, string>;
  readonly referencedKeys: Set<string>;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly connectorAccessBySlug: ReadonlyMap<string, ConnectorAccessState>;
}): boolean {
  return [...args.referencedKeys].some((key) => {
    return (
      !Object.hasOwn(args.secrets, key) &&
      !canResolveMissingAccessSecret({
        key,
        secretConnectorMap: args.secretConnectorMap,
        secretConnectorMetadataMap: args.secretConnectorMetadataMap,
        connectorAccessBySlug: args.connectorAccessBySlug,
      })
    );
  });
}

async function prepareFirewallAuthResolutionContext(args: {
  readonly db: Db;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
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
    args.body.authAwsSigv4,
  );
  const vars = args.body.vars ?? {};
  if (
    args.body.secretConnectorMap &&
    hasForbiddenModelProviderOwner(
      args.auth,
      args.body.secretConnectorMap,
      args.body.secretConnectorMetadataMap,
      referenced.secrets,
    )
  ) {
    return { ok: false, response: forbiddenModelProviderOwner() };
  }
  const connectorAccessBySlug = await loadConnectorAccessStates(
    args.db,
    args.orgId,
    args.auth.userId,
    referencedConnectorSlugs({
      secretConnectorMap: args.body.secretConnectorMap,
      secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
      referencedKeys: referenced.secrets,
    }),
    args.connectorCatalogSnapshot,
  );
  const modelProviderRefreshable = referencedModelProviderAccessMap({
    secretConnectorMap: args.body.secretConnectorMap,
    secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
    referencedKeys: referenced.secrets,
  });
  const modelProviderSourceStateByProviderKey =
    modelProviderRefreshable.size === 0
      ? new Map<string, RefreshSourceState>()
      : await loadAccessSourceStates({
          db: args.db,
          orgId: args.orgId,
          userId: args.auth.userId,
          accessSourceKeys: [...new Set(modelProviderRefreshable.values())],
          metadataByAccessSource: buildMetadataByAccessSource(
            modelProviderRefreshable,
            args.body.secretConnectorMetadataMap,
          ),
          connectorAccessBySlug,
        });
  if (
    hasUnavailableAccessSource({
      secretConnectorMap: args.body.secretConnectorMap,
      secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
      referencedKeys: referenced.secrets,
      connectorAccessBySlug,
      modelProviderSourceStateByProviderKey,
    })
  ) {
    return { ok: false, response: connectorNotConfigured() };
  }
  const reconnectRequiredConnectorSlugs =
    connectorSlugsWithReconnectRequiredStatus({
      secretConnectorMap: args.body.secretConnectorMap,
      secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
      referencedKeys: referenced.secrets,
      connectorAccessBySlug,
    });
  if (reconnectRequiredConnectorSlugs.length > 0) {
    return {
      ok: false,
      response: connectorReconnectRequired(reconnectRequiredConnectorSlugs),
    };
  }
  await syncFirewallRuntimeSecrets({
    db: args.db,
    auth: args.auth,
    body: args.body,
    orgId: args.orgId,
    secrets: args.secrets,
    referencedKeys: referenced.secrets,
    connectorAccessBySlug,
    featureSwitchContext: args.featureSwitchContext,
  });

  const hasMissingSecrets = hasMissingUnresolvableSecrets({
    secrets: args.secrets,
    referencedKeys: referenced.secrets,
    secretConnectorMap: args.body.secretConnectorMap,
    secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
    connectorAccessBySlug,
  });
  const hasMissingVars = [...referenced.vars].some((key) => {
    return !Object.hasOwn(vars, key);
  });
  if (hasMissingSecrets || hasMissingVars) {
    return { ok: false, response: connectorNotConfigured() };
  }

  return {
    ok: true,
    context: {
      referenced,
      vars,
      connectorAccessBySlug,
    },
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
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.userId, auth.userId),
        eq(agentRuns.orgId, auth.orgId),
      ),
    )
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
  const secrets = await tapError(
    decryptPersistentSecretsMap(encryptedSecrets, featureSwitchContext),
  );
  return {
    ok: true,
    orgId,
    featureSwitchContext,
    secrets: secrets ?? null,
  };
}

function accessSourceKeysNeedingRefresh(args: {
  readonly accessSourceKeys: readonly string[];
  readonly sourceStateMap: Map<string, RefreshSourceState>;
  readonly forceRefresh: boolean;
}): readonly string[] {
  const nowSeconds = Math.floor(nowDate().getTime() / 1000);
  return args.accessSourceKeys.filter((accessSourceKey) => {
    if (args.forceRefresh) {
      return true;
    }
    const sourceState = args.sourceStateMap.get(accessSourceKey);
    if (!sourceState) {
      return true;
    }
    if (sourceState.needsReconnect || sourceState.tokenExpiresAt === null) {
      return true;
    }
    return sourceState.tokenExpiresAt <= nowSeconds + REFRESH_BUFFER_SECS;
  });
}

function buildEnvVarsByAccessSource(
  refreshable: Map<string, string>,
): Map<string, readonly string[]> {
  const envVarsByAccessSource = new Map<string, string[]>();
  for (const [envVar, accessSourceKey] of refreshable) {
    const envVars = envVarsByAccessSource.get(accessSourceKey) ?? [];
    envVars.push(envVar);
    envVarsByAccessSource.set(accessSourceKey, envVars);
  }
  return envVarsByAccessSource;
}

async function refreshSelectedTokens(
  context: RefreshBatchContext,
  accessSourceKeys: readonly string[],
): Promise<readonly RefreshExecutionResult[]> {
  return await Promise.all(
    accessSourceKeys.map(async (accessSourceKey) => {
      L.debug(
        `[${context.auth.runId}] Refreshing expired ${accessSourceKey} token`,
      );
      const metadata = resolveRefreshMetadata(
        accessSourceKey,
        context.metadataByAccessSource.get(accessSourceKey),
      );
      if (metadata.sourceType === "platform-secret") {
        throw new Error("Platform secrets are not refreshable");
      }
      const refreshResult = await refreshAccessTokenForSource({
        db: context.db,
        accessSourceKey,
        orgId: context.orgId,
        userId: context.userId,
        sourceType: metadata.sourceType,
        sourceUserId: metadata.sourceUserId,
        metadataKey: metadata.metadataKey,
        connectorSecrets: context.secrets,
        accessEnvVars: context.envVarsByAccessSource.get(accessSourceKey) ?? [],
        forceRefresh: context.forceRefresh,
        forceRefreshStartedAtMicros: context.forceRefreshStartedAtMicros,
        connectorAccessBySlug: context.connectorAccessBySlug,
        featureSwitchContext: context.featureSwitchContext,
      });
      if (!refreshResult.ok) {
        L.warn(
          `[${context.auth.runId}] Failed to refresh ${accessSourceKey} token`,
          {
            sourceType: metadata.sourceType,
            sourceUserId: metadata.sourceUserId,
            metadataKey: metadata.metadataKey,
            reason: refreshResult.reason,
          },
        );
        if (refreshResult.reason === "source-missing") {
          return {
            accessSourceKey,
            status: "source-missing",
          };
        }
        return {
          accessSourceKey,
          status: "failed",
          ...(refreshResult.failureReason
            ? { failureReason: refreshResult.failureReason }
            : {}),
        };
      }

      Object.assign(context.secrets, refreshResult.secrets);
      return { accessSourceKey, status: refreshResult.status };
    }),
  );
}

async function syncSkippedTokens(
  context: RefreshBatchContext,
  skippedAccessSourceKeys: readonly string[],
  sourceStateMap: Map<string, RefreshSourceState>,
): Promise<readonly RefreshExecutionResult[]> {
  const results: RefreshExecutionResult[] = [];
  const currentTokens = await Promise.all(
    skippedAccessSourceKeys.map(async (accessSourceKey) => {
      const sourceState = sourceStateMap.get(accessSourceKey);
      if (!sourceState) {
        return {
          accessSourceKey,
          token: null,
          sourceMissing: true as const,
        };
      }
      if (sourceState?.needsReconnect) {
        return {
          accessSourceKey,
          token: null,
          failureReason: "reconnect_required" as const,
        };
      }
      const metadata = resolveRefreshMetadata(
        accessSourceKey,
        context.metadataByAccessSource.get(accessSourceKey),
      );
      if (metadata.sourceType === "platform-secret") {
        throw new Error("Platform secrets are not refreshable");
      }
      return {
        accessSourceKey,
        tokens: await getCurrentAccessSecrets({
          db: context.db,
          accessSourceKey,
          orgId: context.orgId,
          userId: context.userId,
          sourceType: metadata.sourceType,
          sourceUserId: metadata.sourceUserId,
          metadataKey: metadata.metadataKey,
          metadata,
          accessEnvVars:
            context.envVarsByAccessSource.get(accessSourceKey) ?? [],
          connectorAccessBySlug: context.connectorAccessBySlug,
          featureSwitchContext: context.featureSwitchContext,
        }),
      };
    }),
  );
  for (const {
    accessSourceKey,
    tokens,
    failureReason,
    sourceMissing,
  } of currentTokens) {
    if (sourceMissing) {
      L.warn(
        `[${context.auth.runId}] Skipped access source ${accessSourceKey}: source missing`,
      );
      for (const envVar of context.envVarsByAccessSource.get(accessSourceKey) ??
        []) {
        delete context.secrets[envVar];
      }
      results.push({
        accessSourceKey,
        status: "source-missing",
      });
      continue;
    }
    if (failureReason) {
      L.warn(
        `[${context.auth.runId}] Skipped access source ${accessSourceKey}: reconnect still required`,
      );
      for (const envVar of context.envVarsByAccessSource.get(accessSourceKey) ??
        []) {
        delete context.secrets[envVar];
      }
      results.push({
        accessSourceKey,
        status: "failed",
        failureReason,
      });
      continue;
    }
    const missingEnvVars = Object.entries(tokens ?? {}).flatMap(
      ([envName, token]) => {
        return token ? [] : [envName];
      },
    );
    if (missingEnvVars.length > 0) {
      L.warn(
        `[${context.auth.runId}] No DB token for skipped access source ${accessSourceKey}; marking access unresolved`,
        { missingEnvVars },
      );
      for (const envVar of context.envVarsByAccessSource.get(accessSourceKey) ??
        []) {
        delete context.secrets[envVar];
      }
      continue;
    }
    Object.assign(context.secrets, tokens);
  }
  return results;
}

function summarizeRefreshResults(
  refreshResults: readonly RefreshExecutionResult[],
  envVarsByAccessSource: Map<string, readonly string[]>,
): Pick<
  RefreshResult,
  | "failedConnectors"
  | "unavailableConnectors"
  | "refreshedConnectors"
  | "refreshedSecrets"
  | "failureReason"
> {
  const refreshedConnectors = refreshResults
    .filter((result) => {
      return result.status === "refreshed";
    })
    .map((result) => {
      return result.accessSourceKey;
    });
  const refreshedSecrets = refreshedConnectors
    .flatMap((accessSourceKey) => {
      return envVarsByAccessSource.get(accessSourceKey) ?? [];
    })
    .sort();
  const failedConnectors = refreshResults
    .filter((result) => {
      return result.status === "failed";
    })
    .map((result) => {
      return result.accessSourceKey;
    });
  const unavailableConnectors = refreshResults
    .filter((result) => {
      return result.status === "source-missing";
    })
    .map((result) => {
      return result.accessSourceKey;
    });
  const failedResults = refreshResults.filter((result) => {
    return result.status === "failed";
  });
  const failureReasons = new Set(
    failedResults.map((result) => {
      return result.failureReason;
    }),
  );
  const failureReason =
    failureReasons.size === 1 ? [...failureReasons][0] : undefined;

  return {
    refreshedConnectors,
    refreshedSecrets,
    failedConnectors,
    unavailableConnectors,
    ...(failureReason ? { failureReason } : {}),
  };
}

function earliestAccessSourceExpiry(
  accessSourceKeys: readonly string[],
  finalSourceStateMap: Map<string, RefreshSourceState>,
): number | null {
  let earliestExpiry: number | null = null;
  for (const accessSourceKey of accessSourceKeys) {
    const expiry = finalSourceStateMap.get(accessSourceKey)?.tokenExpiresAt;
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
    args.connectorAccessBySlug,
    args.referencedKeys,
  );
  if (refreshable.size === 0) {
    return emptyRefreshResult;
  }

  const accessSourceKeys = [...new Set(refreshable.values())];
  const metadataByAccessSource = buildMetadataByAccessSource(
    refreshable,
    args.secretConnectorMetadataMap,
  );
  const connectorSlugs = connectorSlugsForAccessSources({
    accessSourceKeys,
    metadataByAccessSource,
  });
  const sourceStateMap = await loadAccessSourceStates({
    db: args.db,
    orgId: args.orgId,
    userId: args.auth.userId,
    accessSourceKeys,
    metadataByAccessSource,
    connectorAccessBySlug: args.connectorAccessBySlug,
  });
  const toRefresh = accessSourceKeysNeedingRefresh({
    accessSourceKeys,
    sourceStateMap,
    forceRefresh: args.forceRefresh,
  });
  const envVarsByAccessSource = buildEnvVarsByAccessSource(refreshable);

  const context = {
    db: args.db,
    connectorCatalogSnapshot: args.connectorCatalogSnapshot,
    auth: args.auth,
    orgId: args.orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    forceRefresh: args.forceRefresh,
    forceRefreshStartedAtMicros: args.forceRefreshStartedAtMicros,
    metadataByAccessSource,
    connectorAccessBySlug: args.connectorAccessBySlug,
    envVarsByAccessSource,
    featureSwitchContext: args.featureSwitchContext,
  } satisfies RefreshBatchContext;
  const selectedRefreshResults = await refreshSelectedTokens(
    context,
    toRefresh,
  );
  const skippedAccessSourceKeys = accessSourceKeys.filter((accessSourceKey) => {
    return !toRefresh.includes(accessSourceKey);
  });
  const skippedStateSnapshot =
    skippedAccessSourceKeys.length === 0
      ? { connectorAccessBySlug: context.connectorAccessBySlug, sourceStateMap }
      : await loadCurrentSourceStateSnapshot({
          db: args.db,
          connectorCatalogSnapshot: args.connectorCatalogSnapshot,
          orgId: args.orgId,
          userId: args.auth.userId,
          accessSourceKeys: skippedAccessSourceKeys,
          metadataByAccessSource,
        });
  const skippedResults = await syncSkippedTokens(
    {
      ...context,
      connectorAccessBySlug: skippedStateSnapshot.connectorAccessBySlug,
    },
    skippedAccessSourceKeys,
    skippedStateSnapshot.sourceStateMap,
  );
  const refreshResults = [...selectedRefreshResults, ...skippedResults];

  const summary = summarizeRefreshResults(
    refreshResults,
    envVarsByAccessSource,
  );
  const hasCurrentOrRefreshed = refreshResults.some((result) => {
    return result.status === "current" || result.status === "refreshed";
  });
  const finalConnectorAccessBySlug = hasCurrentOrRefreshed
    ? new Map([
        ...args.connectorAccessBySlug,
        ...(await loadConnectorAccessStates(
          args.db,
          args.orgId,
          args.auth.userId,
          connectorSlugs,
          args.connectorCatalogSnapshot,
        )),
      ])
    : args.connectorAccessBySlug;
  const finalSourceStateMap = hasCurrentOrRefreshed
    ? await loadAccessSourceStates({
        db: args.db,
        orgId: args.orgId,
        userId: args.auth.userId,
        accessSourceKeys,
        metadataByAccessSource,
        connectorAccessBySlug: finalConnectorAccessBySlug,
      })
    : new Map([...sourceStateMap, ...skippedStateSnapshot.sourceStateMap]);

  return {
    expiresAt: earliestAccessSourceExpiry(
      accessSourceKeys,
      finalSourceStateMap,
    ),
    ...summary,
  };
}

function collectReferencedKeys(
  authHeaders: Record<string, string>,
  authBase?: string,
  authQuery?: Record<string, string>,
  authAwsSigv4?: FirewallAwsSigv4AuthConfig,
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
  if (authAwsSigv4) {
    for (const template of Object.values(authAwsSigv4)) {
      if (template) {
        collectSimpleReferencedKeys(template, addKey);
      }
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

interface ResolveTemplatesArgs {
  readonly authHeaders: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly vars: Record<string, string>;
  readonly authBase?: string;
  readonly authQuery?: Record<string, string>;
  readonly authAwsSigv4?: FirewallAwsSigv4AuthConfig;
}

function resolveTemplates(args: ResolveTemplatesArgs): {
  readonly headers: Record<string, string>;
  readonly resolvedSecrets: readonly string[];
  readonly base?: string;
  readonly query?: Record<string, string>;
  readonly awsSigv4?: FirewallAwsSigv4AuthConfig;
} {
  const resolvedKeys = new Set<string>();

  const resolveSimple = (template: string): string => {
    return template.replace(
      TEMPLATE_RE,
      (_match, namespace: string, key: string) => {
        if (namespace === "secrets") {
          resolvedKeys.add(key);
          return getOwnValue(args.secrets, key) ?? "";
        }
        return getOwnValue(args.vars, key) ?? "";
      },
    );
  };

  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(args.authHeaders)) {
    let resolved = replaceBasicAuthTemplates(template, (match) => {
      const user = resolveBasicArg({
        ...match.first,
        secrets: args.secrets,
        vars: args.vars,
        resolvedKeys,
      });
      const pass = resolveBasicArg({
        ...match.second,
        secrets: args.secrets,
        vars: args.vars,
        resolvedKeys,
      });
      return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    });
    resolved = resolveSimple(resolved);
    headers[name] = resolved;
  }

  const base = args.authBase ? resolveSimple(args.authBase) : undefined;
  const query = args.authQuery
    ? Object.fromEntries(
        Object.entries(args.authQuery).map(([key, value]) => {
          return [key, resolveSimple(value)];
        }),
      )
    : undefined;
  const awsSigv4 = args.authAwsSigv4
    ? ({
        accessKeyId: resolveSimple(args.authAwsSigv4.accessKeyId),
        secretAccessKey: resolveSimple(args.authAwsSigv4.secretAccessKey),
        ...(args.authAwsSigv4.sessionToken
          ? { sessionToken: resolveSimple(args.authAwsSigv4.sessionToken) }
          : {}),
      } satisfies FirewallAwsSigv4AuthConfig)
    : undefined;

  return {
    headers,
    resolvedSecrets: [...resolvedKeys].sort(),
    base,
    query,
    awsSigv4,
  };
}

function hasEmptyAwsSigv4Credential(
  credentials: FirewallAwsSigv4AuthConfig | undefined,
): boolean {
  return (
    credentials !== undefined &&
    (credentials.accessKeyId === "" ||
      credentials.secretAccessKey === "" ||
      credentials.sessionToken === "")
  );
}

export async function resolveFirewallAuth(
  db: Db,
  auth: SandboxAuth,
  body: FirewallAuthBody,
): Promise<ResolveFirewallAuthResult> {
  const connectorCatalogSnapshot = await loadConnectorRuntimeSnapshot(db);
  const forceRefreshStartedAtMicros =
    body.forceRefresh === true
      ? await currentDatabaseTimestampMicros(db)
      : null;
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
    connectorCatalogSnapshot,
    auth,
    body,
    orgId: decrypted.orgId,
    featureSwitchContext: decrypted.featureSwitchContext,
    secrets: decryptedSecrets,
  });
  if (!prepared.ok) {
    return prepared.response;
  }
  const { connectorAccessBySlug, referenced, vars } = prepared.context;

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
  let unavailableConnectors: readonly string[] = [];
  let failureReason: FirewallAuthFailureReason | undefined;

  if (body.secretConnectorMap) {
    const result = await refreshExpiredTokens({
      db,
      connectorCatalogSnapshot,
      auth,
      secrets: decryptedSecrets,
      secretConnectorMap: body.secretConnectorMap,
      secretConnectorMetadataMap: body.secretConnectorMetadataMap,
      referencedKeys: referenced.secrets,
      connectorAccessBySlug,
      orgId: decrypted.orgId,
      featureSwitchContext: decrypted.featureSwitchContext,
      forceRefresh: body.forceRefresh ?? false,
      forceRefreshStartedAtMicros,
    });
    expiresAt = result.expiresAt;
    refreshedConnectors = result.refreshedConnectors;
    refreshedSecrets = result.refreshedSecrets;
    failedConnectors = result.failedConnectors;
    unavailableConnectors = result.unavailableConnectors;
    failureReason = result.failureReason;
  }

  if (unavailableConnectors.length > 0) {
    return connectorNotConfigured();
  }

  if (failedConnectors.length > 0) {
    return tokenRefreshFailed(failedConnectors, failureReason);
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

  const resolved = resolveTemplates({
    authHeaders: body.authHeaders,
    secrets: decryptedSecrets,
    vars,
    authBase: body.authBase,
    authQuery: body.authQuery,
    authAwsSigv4: body.authAwsSigv4,
  });
  if (hasEmptyAwsSigv4Credential(resolved.awsSigv4)) {
    return connectorNotConfigured();
  }

  return {
    status: 200,
    body: {
      headers: resolved.headers,
      base: resolved.base,
      query: resolved.query,
      awsSigv4: resolved.awsSigv4,
      expiresAt: mergeExpiresAt(expiresAt, billableCacheExpiry.expiresAt),
      resolvedSecrets: resolved.resolvedSecrets,
      refreshedConnectors,
      refreshedSecrets,
    },
  };
}
