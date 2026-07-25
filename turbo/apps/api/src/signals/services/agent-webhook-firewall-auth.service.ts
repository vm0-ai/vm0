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
  ConnectorRef,
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
} from "@vm0/connectors/connector-utils";
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
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows, pgInt8ToBigIntSchema } from "../../lib/db-raw-rows";
import {
  pgInt8ToBigIntDecoder,
  pgNullDecoder,
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
  readonly connectorType: string;
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
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
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
  failedConnectors: readonly string[],
  failureReason?: FirewallAuthFailureReason,
): ResolveFirewallAuthResult {
  const connectorList = failedConnectors.join(", ");
  const message =
    failureReason === "upstream_provider"
      ? `Access token refresh failed for: ${connectorList}. The upstream provider may be temporarily unavailable.`
      : `Access token expired and refresh failed for: ${connectorList}. The connector may need to be reconnected.`;
  const error = {
    message,
    code: "TOKEN_REFRESH_FAILED",
    connectors: failedConnectors,
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
  failedConnectors: readonly string[],
): ResolveFirewallAuthResult {
  const connectorList = failedConnectors.join(", ");
  return {
    status: 502,
    body: {
      error: {
        message: `Connector credential requires reconnect for: ${connectorList}.`,
        code: "TOKEN_REFRESH_FAILED",
        connectors: failedConnectors,
        failureReason: "reconnect_required",
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
  readonly connectorType: string;
  readonly orgId: string;
  readonly userId: string;
  readonly sourceType: StorageSecretSource;
  readonly sourceUserId?: string;
  readonly metadataKey?: string;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface RefreshAccessTokenArgs extends SecretTokenLookupArgs {
  readonly connectorSecrets: Record<string, string>;
  readonly accessEnvVars: readonly string[];
  readonly forceRefresh: boolean;
  readonly forceRefreshStartedAtMicros: bigint | null;
}

function requiredModelProviderMetadataKey(
  args: Pick<RefreshAccessTokenArgs, "connectorType" | "metadataKey">,
): string {
  if (!args.metadataKey) {
    throw new Error(
      `metadataKey required for model-provider source on ${args.connectorType}`,
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
  readonly connectorRef: ConnectorRef;
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
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
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
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
  readonly envVarsByConnector: Map<string, readonly string[]>;
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

function getRefreshProviderKeySourceType(
  providerKey: string,
): AccessSecretSource {
  return modelProviderTypeForProviderKey(providerKey)
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
  connectorType: string,
  metadata: SecretConnectorMetadata | undefined,
): SecretConnectorMetadata {
  const sourceType =
    metadata?.sourceType ?? getRefreshProviderKeySourceType(connectorType);
  return {
    sourceType,
    sourceUserId:
      sourceType === "model-provider" ? metadata?.sourceUserId : undefined,
    metadataKey:
      sourceType === "model-provider"
        ? (metadata?.metadataKey ??
          modelProviderTypeForProviderKey(connectorType))
        : undefined,
  };
}

function modelProviderTypeForMetadata(
  connectorType: string,
  metadata: SecretConnectorMetadata,
): ModelProviderType | undefined {
  const providerType =
    metadata.metadataKey ?? modelProviderTypeForProviderKey(connectorType);
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
      set: {
        encryptedValue,
        updatedAt: nowDate(),
      },
    });
}

function modelProviderRuntimeSecretName(args: {
  readonly key: string;
  readonly connectorType: string;
  readonly metadata: SecretConnectorMetadata;
}): string | undefined {
  const providerType = modelProviderTypeForMetadata(
    args.connectorType,
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
  readonly connectorType: string;
  readonly metadata: SecretConnectorMetadata;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): string | undefined {
  if (args.metadata.sourceType === "model-provider") {
    const secretName = modelProviderRuntimeSecretName(args);
    const secretMetadata = getModelProviderRefreshMetadata(args.connectorType);
    return secretName && secretMetadata?.refreshableSecrets.includes(secretName)
      ? secretName
      : undefined;
  }
  if (args.metadata.sourceType === "platform-secret") {
    return undefined;
  }

  const connectorAccess = args.connectorAccessByType.get(args.connectorType);
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
  readonly connectorType: string;
  readonly metadata: SecretConnectorMetadata;
  readonly accessEnvVars: readonly string[];
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): Record<string, string> {
  return Object.fromEntries(
    args.accessEnvVars.flatMap((key) => {
      const secretName = refreshableRuntimeSecretNameForSource({
        key,
        connectorType: args.connectorType,
        metadata: args.metadata,
        connectorAccessByType: args.connectorAccessByType,
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
    connectorType: args.connectorType,
    metadata: args.metadata,
    accessEnvVars: args.accessEnvVars,
    connectorAccessByType: args.connectorAccessByType,
  });
  const secretUserId = resolveSecretUserId(
    args.sourceType,
    args.userId,
    args.sourceUserId,
  );
  const secretNames = [...new Set(Object.values(runtimeOutputSecrets))];
  let values: ReadonlyMap<string, string>;
  if (args.sourceType === "connector") {
    const access = args.connectorAccessByType.get(args.connectorType)?.access;
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
  connectorTypes: readonly string[],
  snapshot: ConnectorRuntimeSnapshot,
): Promise<Map<string, ConnectorAccessState>> {
  const result = new Map<string, ConnectorAccessState>();
  if (connectorTypes.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      connectorId: connectors.id,
      type: connectors.type,
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
        inArray(connectors.type, [...connectorTypes]),
      ),
    );

  for (const row of rows) {
    const accessResult = resolveConnectorCredentialAccess({
      snapshot,
      stored: {
        authMethodId: row.authMethod,
        connectorId: row.connectorId,
        connectorRef: row.type,
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
    result.set(row.type, {
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
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}

function modelProviderSourceLookup(args: {
  readonly providerKey: string;
  readonly userId: string;
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
}): ModelProviderSourceLookup {
  const metadata = resolveRefreshMetadata(
    args.providerKey,
    args.metadataByConnector.get(args.providerKey),
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
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
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
      metadataByConnector: args.metadataByConnector,
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

async function getSourceStateByProviderKey(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorTypes: readonly string[];
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): Promise<Map<string, RefreshSourceState>> {
  const connectorOnly = args.connectorTypes.filter((connectorType) => {
    return (
      resolveRefreshMetadata(
        connectorType,
        args.metadataByConnector.get(connectorType),
      ).sourceType === "connector"
    );
  });
  const modelProviderRefreshProviderKeys = args.connectorTypes.filter(
    (connectorType) => {
      return (
        resolveRefreshMetadata(
          connectorType,
          args.metadataByConnector.get(connectorType),
        ).sourceType === "model-provider"
      );
    },
  );

  const merged = new Map<string, RefreshSourceState>();
  for (const connectorType of connectorOnly) {
    const state = args.connectorAccessByType.get(connectorType);
    if (state) {
      merged.set(connectorType, state);
    }
  }

  const modelProviderStates = await loadModelProviderSourceStates({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    providerKeys: modelProviderRefreshProviderKeys,
    metadataByConnector: args.metadataByConnector,
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
  readonly connectorTypes: readonly string[];
  readonly metadataByConnector: Map<string, SecretConnectorMetadata>;
}): Promise<SourceStateSnapshot> {
  const connectorOnly = args.connectorTypes.filter((connectorType) => {
    return (
      resolveRefreshMetadata(
        connectorType,
        args.metadataByConnector.get(connectorType),
      ).sourceType === "connector"
    );
  });
  const connectorAccessByType = await loadConnectorAccessStates(
    args.db,
    args.orgId,
    args.userId,
    connectorOnly,
    args.connectorCatalogSnapshot,
  );
  return {
    connectorAccessByType,
    sourceStateMap: await getSourceStateByProviderKey({
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      connectorTypes: args.connectorTypes,
      metadataByConnector: args.metadataByConnector,
      connectorAccessByType,
    }),
  };
}

function prepareRefreshTokenContext(
  args: RefreshAccessTokenArgs,
): PrepareRefreshTokenContextResult {
  const metadata = resolveRefreshMetadata(args.connectorType, {
    sourceType: args.sourceType,
    ...(args.sourceUserId ? { sourceUserId: args.sourceUserId } : {}),
    ...(args.metadataKey ? { metadataKey: args.metadataKey } : {}),
  });
  const runtimeOutputSecrets = runtimeOutputSecretsForSource({
    connectorType: args.connectorType,
    metadata,
    accessEnvVars: args.accessEnvVars,
    connectorAccessByType: args.connectorAccessByType,
  });
  if (Object.keys(runtimeOutputSecrets).length === 0) {
    return { ok: false, reason: "not-refreshable" };
  }

  if (args.sourceType === "model-provider") {
    if (!isModelProviderRefreshProviderKey(args.connectorType)) {
      return { ok: false, reason: "not-refreshable" };
    }
    const secretMetadata = getModelProviderRefreshMetadata(args.connectorType);
    if (!secretMetadata.isRefreshable) {
      return { ok: false, reason: "not-refreshable" };
    }
    if (!args.metadataKey) {
      throw new Error(
        `metadataKey required for model-provider source on ${args.connectorType}`,
      );
    }

    const env = currentProviderEnv();
    if (
      !isModelProviderRefreshConfigured({
        providerKey: args.connectorType,
        currentEnv: env,
      })
    ) {
      L.debug(
        `${args.connectorType} auth client not configured, skipping token refresh`,
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
      `${args.connectorType} connector client not configured, skipping token refresh`,
    );
    return { ok: false, reason: "client-unconfigured" };
  }

  return {
    ok: true,
    prepared: {
      sourceType: "connector",
      connectorId: connectorAccess.connectorId,
      connectorRef: connectorAccess.runtimeMethod.connectorRef,
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
        eq(modelProviders.type, requiredModelProviderMetadataKey(args)),
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
        eq(connectors.type, args.connectorType),
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

  const connectorAccess =
    args.sourceType === "connector"
      ? args.connectorAccessByType.get(args.connectorType)?.access
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
          eq(modelProviders.type, requiredModelProviderMetadataKey(args)),
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
        eq(connectors.type, args.connectorType),
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
          eq(modelProviders.type, requiredModelProviderMetadataKey(args)),
        ),
      );
    return;
  }

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
        eq(connectors.type, args.connectorType),
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
  L.warn(`${args.connectorType} token refresh failed: ${message}`, {
    connectorType: args.connectorType,
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
    connectorRef: args.prepared.connectorRef,
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
      type: prepared.connectorRef,
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
    args.connectorType === prepared.connectorRef &&
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
    L.warn(`${args.refreshArgs.connectorType} token refresh source missing`, {
      connectorType: args.refreshArgs.connectorType,
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
  readonly connectorType: string;
  readonly context: RefreshTokenContext;
  readonly state: RefreshState;
}): RefreshAccessTokenResult {
  const currentSecrets = nonNullRuntimeOutputValues({
    context: args.context,
    state: args.state,
  });
  if (!currentSecrets) {
    throw new Error(
      `${args.connectorType} current refresh outputs disappeared unexpectedly`,
    );
  }
  return {
    ok: true,
    status: "current",
    secrets: currentSecrets,
  };
}

function refreshInputsFromLockedState(args: {
  readonly connectorType: string;
  readonly state: RefreshState;
}): Record<string, string> {
  const refreshInputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(args.state.inputValues)) {
    if (value === null) {
      throw new Error(`${args.connectorType} refresh input ${name} missing`);
    }
    refreshInputs[name] = value;
  }
  return refreshInputs;
}

function runtimeSecretsFromRefreshResult(args: {
  readonly connectorType: string;
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
        `${args.connectorType} token refresh did not return runtime secret ${secretName}`,
      );
    }
    refreshedSecrets[envName] = value;
  }
  return refreshedSecrets;
}

function validateRefreshResultOutputs(args: {
  readonly connectorType: string;
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
        message: `${args.connectorType} token refresh returned undeclared output ${outputName}`,
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
        message: `${args.connectorType} token refresh did not return required output for ${secretName}`,
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
      connectorType: args.refreshArgs.connectorType,
      context: args.prepared.context,
      state: lockedState,
    });
  }

  const missingInputNames = missingRefreshInputNames(lockedState);
  if (missingInputNames.length > 0) {
    L.debug(
      `No ${args.refreshArgs.connectorType} refresh inputs available, skipping`,
      { missingInputNames },
    );
    return markRefreshTokenMissing(args.refreshArgs, args.prepared.context);
  }

  const refreshSignal = firewallAuthRefreshTimeoutSignal();
  const refreshResult = await settle(
    refreshPreparedAccessToken({
      prepared: args.prepared,
      inputs: refreshInputsFromLockedState({
        connectorType: args.refreshArgs.connectorType,
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
    connectorType: args.refreshArgs.connectorType,
    context: args.prepared.context,
    result: refreshResult.value,
  });
  if (!outputValidation.ok) {
    L.warn(outputValidation.message, {
      connectorType: args.refreshArgs.connectorType,
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
    connectorType: args.refreshArgs.connectorType,
    context: args.prepared.context,
    returnedSecretValues,
  });
  Object.assign(
    args.refreshArgs.connectorSecrets,
    returnedSecretValues,
    refreshedSecrets,
  );
  L.debug(
    `${args.refreshArgs.connectorType} access token refreshed successfully`,
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
  unavailableConnectors: [],
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
    const refreshableSecretName = refreshableRuntimeSecretNameForSource({
      key,
      connectorType,
      metadata,
      connectorAccessByType,
    });
    if (refreshableSecretName) {
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
  readonly connectorType: string;
  readonly metadata: SecretConnectorMetadata;
}): string | undefined {
  const secretMetadata = getModelProviderRefreshMetadata(args.connectorType);
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
    const connectorType = args.secretConnectorMap[key];
    if (!connectorType) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      connectorType,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "model-provider") {
      continue;
    }
    if (
      modelProviderAccessSecretName({
        key,
        connectorType,
        metadata,
      }) === undefined
    ) {
      continue;
    }
    refreshable.set(key, connectorType);
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
    const connectorAccess = args.connectorAccessByType.get(connectorType);
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
    const connectorType = getOwnConnectorOwner(args.secretConnectorMap, key);
    if (!connectorType) {
      return [];
    }
    const metadata = resolveRefreshMetadata(
      connectorType,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "model-provider") {
      return [];
    }
    if (
      modelProviderAccessSecretName({
        key,
        connectorType,
        metadata,
      }) !== undefined
    ) {
      return [];
    }
    const providerType = modelProviderTypeForMetadata(connectorType, metadata);
    const secretName = modelProviderRuntimeSecretName({
      key,
      connectorType,
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
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): void {
  if (!args.secretConnectorMap) {
    return;
  }

  for (const key of args.referencedKeys) {
    const connectorType = getOwnConnectorOwner(args.secretConnectorMap, key);
    if (!connectorType) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      connectorType,
      args.secretConnectorMetadataMap?.[key],
    );
    if (metadata.sourceType !== "platform-secret") {
      continue;
    }
    const connectorAccess = args.connectorAccessByType.get(connectorType);
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
    const decrypted = await tapError(
      decryptStoredSecretValue(row.encryptedValue, args.featureSwitchContext),
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
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
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
    connectorAccessByType: args.connectorAccessByType,
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
    secrets: args.secrets,
    referencedKeys: args.referencedKeys,
    featureSwitchContext: args.featureSwitchContext,
  });
  syncPlatformRuntimeSecrets({
    secrets: args.secrets,
    secretConnectorMap: args.body.secretConnectorMap,
    secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
    referencedKeys: args.referencedKeys,
    connectorAccessByType: args.connectorAccessByType,
  });
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
  if (refreshMetadata.sourceType === "platform-secret") {
    return false;
  }

  const connectorAccess = args.connectorAccessByType.get(connectorType);
  if (connectorAccess?.accessMetadata.kind !== "refresh-token") {
    return false;
  }
  return isRefreshableConnectorRuntimeSecretKey(args.key, connectorAccess);
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
    if (sourceType === "connector" || sourceType === "platform-secret") {
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
  readonly modelProviderSourceStateByConnector: ReadonlyMap<
    string,
    RefreshSourceState
  >;
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
      const accessSecretName = modelProviderAccessSecretName({
        key,
        connectorType,
        metadata,
      });
      if (accessSecretName !== undefined) {
        return !args.modelProviderSourceStateByConnector.has(connectorType);
      }
      return (
        modelProviderRuntimeSecretName({
          key,
          connectorType,
          metadata,
        }) === undefined
      );
    }
    if (metadata.sourceType === "platform-secret") {
      const connectorAccess = args.connectorAccessByType.get(connectorType);
      return (
        !connectorAccess ||
        !isConnectorRuntimePlatformSecretKey(key, connectorAccess)
      );
    }

    const connectorAccess = args.connectorAccessByType.get(connectorType);
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

function connectorAccessSourcesWithReconnectRequiredStatus(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly referencedKeys: Set<string>;
  readonly connectorAccessByType: ReadonlyMap<string, ConnectorAccessState>;
}): readonly string[] {
  if (!args.secretConnectorMap) {
    return [];
  }
  const nowSeconds = Math.floor(nowDate().getTime() / 1000);
  const reconnectRequiredConnectorTypes = new Set<string>();
  for (const key of args.referencedKeys) {
    const connectorType = args.secretConnectorMap[key];
    if (!connectorType) {
      continue;
    }
    const metadata = resolveRefreshMetadata(
      connectorType,
      args.secretConnectorMetadataMap?.[key],
    );
    if (
      metadata.sourceType !== "connector" &&
      metadata.sourceType !== "platform-secret"
    ) {
      continue;
    }
    const connectorAccess = args.connectorAccessByType.get(connectorType);
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
      reconnectRequiredConnectorTypes.add(connectorType);
    }
  }
  return [...reconnectRequiredConnectorTypes];
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
  const connectorAccessByType = await loadConnectorAccessStates(
    args.db,
    args.orgId,
    args.auth.userId,
    referencedConnectorTypes({
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
  const modelProviderSourceStateByConnector =
    modelProviderRefreshable.size === 0
      ? new Map<string, RefreshSourceState>()
      : await getSourceStateByProviderKey({
          db: args.db,
          orgId: args.orgId,
          userId: args.auth.userId,
          connectorTypes: [...new Set(modelProviderRefreshable.values())],
          metadataByConnector: buildMetadataByConnector(
            modelProviderRefreshable,
            args.body.secretConnectorMetadataMap,
          ),
          connectorAccessByType,
        });
  if (
    hasUnavailableAccessSource({
      secretConnectorMap: args.body.secretConnectorMap,
      secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
      referencedKeys: referenced.secrets,
      connectorAccessByType,
      modelProviderSourceStateByConnector,
    })
  ) {
    return { ok: false, response: connectorNotConfigured() };
  }
  const reconnectRequiredConnectorTypes =
    connectorAccessSourcesWithReconnectRequiredStatus({
      secretConnectorMap: args.body.secretConnectorMap,
      secretConnectorMetadataMap: args.body.secretConnectorMetadataMap,
      referencedKeys: referenced.secrets,
      connectorAccessByType,
    });
  if (reconnectRequiredConnectorTypes.length > 0) {
    return {
      ok: false,
      response: connectorReconnectRequired(reconnectRequiredConnectorTypes),
    };
  }
  await syncFirewallRuntimeSecrets({
    db: args.db,
    auth: args.auth,
    body: args.body,
    orgId: args.orgId,
    secrets: args.secrets,
    referencedKeys: referenced.secrets,
    connectorAccessByType,
    featureSwitchContext: args.featureSwitchContext,
  });

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
    context: {
      referenced,
      vars,
      connectorAccessByType,
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

function connectorTypesNeedingRefresh(args: {
  readonly connectorTypes: readonly string[];
  readonly sourceStateMap: Map<string, RefreshSourceState>;
  readonly forceRefresh: boolean;
}): readonly string[] {
  const nowSeconds = Math.floor(nowDate().getTime() / 1000);
  return args.connectorTypes.filter((connectorType) => {
    if (args.forceRefresh) {
      return true;
    }
    const sourceState = args.sourceStateMap.get(connectorType);
    if (!sourceState) {
      return true;
    }
    if (sourceState.needsReconnect || sourceState.tokenExpiresAt === null) {
      return true;
    }
    return sourceState.tokenExpiresAt <= nowSeconds + REFRESH_BUFFER_SECS;
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
      if (metadata.sourceType === "platform-secret") {
        throw new Error("Platform secrets are not refreshable");
      }
      const refreshResult = await refreshAccessTokenForSource({
        db: context.db,
        connectorType,
        orgId: context.orgId,
        userId: context.userId,
        sourceType: metadata.sourceType,
        sourceUserId: metadata.sourceUserId,
        metadataKey: metadata.metadataKey,
        connectorSecrets: context.secrets,
        accessEnvVars: context.envVarsByConnector.get(connectorType) ?? [],
        forceRefresh: context.forceRefresh,
        forceRefreshStartedAtMicros: context.forceRefreshStartedAtMicros,
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
        if (refreshResult.reason === "source-missing") {
          return {
            connectorType,
            status: "source-missing",
          };
        }
        return {
          connectorType,
          status: "failed",
          ...(refreshResult.failureReason
            ? { failureReason: refreshResult.failureReason }
            : {}),
        };
      }

      Object.assign(context.secrets, refreshResult.secrets);
      return { connectorType, status: refreshResult.status };
    }),
  );
}

async function syncSkippedTokens(
  context: RefreshBatchContext,
  skippedTypes: readonly string[],
  sourceStateMap: Map<string, RefreshSourceState>,
): Promise<readonly RefreshExecutionResult[]> {
  const results: RefreshExecutionResult[] = [];
  const currentTokens = await Promise.all(
    skippedTypes.map(async (connectorType) => {
      const sourceState = sourceStateMap.get(connectorType);
      if (!sourceState) {
        return {
          connectorType,
          token: null,
          sourceMissing: true as const,
        };
      }
      if (sourceState?.needsReconnect) {
        return {
          connectorType,
          token: null,
          failureReason: "reconnect_required" as const,
        };
      }
      const metadata = resolveRefreshMetadata(
        connectorType,
        context.metadataByConnector.get(connectorType),
      );
      if (metadata.sourceType === "platform-secret") {
        throw new Error("Platform secrets are not refreshable");
      }
      return {
        connectorType,
        tokens: await getCurrentAccessSecrets({
          db: context.db,
          connectorType,
          orgId: context.orgId,
          userId: context.userId,
          sourceType: metadata.sourceType,
          sourceUserId: metadata.sourceUserId,
          metadataKey: metadata.metadataKey,
          metadata,
          accessEnvVars: context.envVarsByConnector.get(connectorType) ?? [],
          connectorAccessByType: context.connectorAccessByType,
          featureSwitchContext: context.featureSwitchContext,
        }),
      };
    }),
  );
  for (const {
    connectorType,
    tokens,
    failureReason,
    sourceMissing,
  } of currentTokens) {
    if (sourceMissing) {
      L.warn(
        `[${context.auth.runId}] Skipped connector ${connectorType} source missing`,
      );
      for (const envVar of context.envVarsByConnector.get(connectorType) ??
        []) {
        delete context.secrets[envVar];
      }
      results.push({
        connectorType,
        status: "source-missing",
      });
      continue;
    }
    if (failureReason) {
      L.warn(
        `[${context.auth.runId}] Skipped connector ${connectorType} still requires reconnect`,
      );
      for (const envVar of context.envVarsByConnector.get(connectorType) ??
        []) {
        delete context.secrets[envVar];
      }
      results.push({
        connectorType,
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
        `[${context.auth.runId}] No DB token for skipped connector ${connectorType}, marking access unresolved`,
        { missingEnvVars },
      );
      for (const envVar of context.envVarsByConnector.get(connectorType) ??
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
  envVarsByConnector: Map<string, readonly string[]>,
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
  const unavailableConnectors = refreshResults
    .filter((result) => {
      return result.status === "source-missing";
    })
    .map((result) => {
      return result.connectorType;
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

function earliestConnectorExpiry(
  connectorTypes: readonly string[],
  finalSourceStateMap: Map<string, RefreshSourceState>,
): number | null {
  let earliestExpiry: number | null = null;
  for (const connectorType of connectorTypes) {
    const expiry = finalSourceStateMap.get(connectorType)?.tokenExpiresAt;
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
  const sourceStateMap = await getSourceStateByProviderKey({
    db: args.db,
    orgId: args.orgId,
    userId: args.auth.userId,
    connectorTypes,
    metadataByConnector,
    connectorAccessByType: args.connectorAccessByType,
  });
  const toRefresh = connectorTypesNeedingRefresh({
    connectorTypes,
    sourceStateMap,
    forceRefresh: args.forceRefresh,
  });
  const envVarsByConnector = buildEnvVarsByConnector(refreshable);

  const context = {
    db: args.db,
    connectorCatalogSnapshot: args.connectorCatalogSnapshot,
    auth: args.auth,
    orgId: args.orgId,
    userId: args.auth.userId,
    secrets: args.secrets,
    forceRefresh: args.forceRefresh,
    forceRefreshStartedAtMicros: args.forceRefreshStartedAtMicros,
    metadataByConnector,
    connectorAccessByType: args.connectorAccessByType,
    envVarsByConnector,
    featureSwitchContext: args.featureSwitchContext,
  } satisfies RefreshBatchContext;
  const selectedRefreshResults = await refreshSelectedTokens(
    context,
    toRefresh,
  );
  const skippedTypes = connectorTypes.filter((connectorType) => {
    return !toRefresh.includes(connectorType);
  });
  const skippedStateSnapshot =
    skippedTypes.length === 0
      ? { connectorAccessByType: context.connectorAccessByType, sourceStateMap }
      : await loadCurrentSourceStateSnapshot({
          db: args.db,
          connectorCatalogSnapshot: args.connectorCatalogSnapshot,
          orgId: args.orgId,
          userId: args.auth.userId,
          connectorTypes: skippedTypes,
          metadataByConnector,
        });
  const skippedResults = await syncSkippedTokens(
    {
      ...context,
      connectorAccessByType: skippedStateSnapshot.connectorAccessByType,
    },
    skippedTypes,
    skippedStateSnapshot.sourceStateMap,
  );
  const refreshResults = [...selectedRefreshResults, ...skippedResults];

  const summary = summarizeRefreshResults(refreshResults, envVarsByConnector);
  const hasCurrentOrRefreshed = refreshResults.some((result) => {
    return result.status === "current" || result.status === "refreshed";
  });
  const finalConnectorAccessByType = hasCurrentOrRefreshed
    ? new Map([
        ...args.connectorAccessByType,
        ...(await loadConnectorAccessStates(
          args.db,
          args.orgId,
          args.auth.userId,
          connectorTypes,
          args.connectorCatalogSnapshot,
        )),
      ])
    : args.connectorAccessByType;
  const finalSourceStateMap = hasCurrentOrRefreshed
    ? await getSourceStateByProviderKey({
        db: args.db,
        orgId: args.orgId,
        userId: args.auth.userId,
        connectorTypes,
        metadataByConnector,
        connectorAccessByType: finalConnectorAccessByType,
      })
    : new Map([...sourceStateMap, ...skippedStateSnapshot.sourceStateMap]);

  return {
    expiresAt: earliestConnectorExpiry(connectorTypes, finalSourceStateMap),
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
  const { connectorAccessByType, referenced, vars } = prepared.context;

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
      connectorAccessByType,
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
