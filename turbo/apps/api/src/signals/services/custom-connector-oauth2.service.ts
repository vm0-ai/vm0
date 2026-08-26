import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

import { command } from "ccstate";
import { and, eq, exists } from "drizzle-orm";
import { z } from "zod";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  isIntegrationManagedCustomConnector,
  isIntegrationManagedCustomConnectorProviderAdapter,
  type CustomConnectorOAuthProviderAdapter,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  isOAuthProviderHttpError,
  OAuthProviderHttpError,
} from "@okouai/connectors/auth-providers/oauth/error";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";

import {
  fetchHostHasBlockedAddress,
  resolveFetchHostAddresses,
  type ResolvedFetchAddress,
} from "../../lib/blocked-fetch-host";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import {
  connectorOAuthStateExpiresAt,
  generateConnectorOAuthState,
} from "../../lib/connector-oauth-state";
import { createDeferredPromise, safeJsonParse, settle } from "../utils";
import { writeDb$, type Db } from "../external/db";
import {
  exchangeFeishuOAuthCode,
  FeishuOAuthTokenError,
  refreshFeishuOAuthToken,
} from "../external/feishu-client";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME,
  CUSTOM_CONNECTOR_OAUTH_ID_TOKEN_SECRET_NAME,
  CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
  getCustomConnectorById,
  integrationManagedCustomConnectorMutationForbidden,
  normaliseCustomConnectorRow,
  type CustomConnectorOAuthConfigRow,
  type CustomConnectorRow,
} from "./custom-connector.service";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import {
  insertConnectorOAuthState,
  type StoredCustomConnectorOAuthState,
} from "./connector-oauth-state.service";
import {
  customConnectorMcpDisabledResponse,
  isCustomConnectorMcpEnabled,
} from "./custom-connector-mcp-feature.service";
import {
  replaceConnectorConnection,
  resolveConnectorConnectionMutation,
} from "./connector-connection-write.service";
import { connectorAccountSiblingWritesEnabled } from "./connector-account-mutation.service";
import { userFeatureSwitchContext } from "./feature-switches.service";

const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;

const customConnectorOAuthStateContextSchema = z.object({
  connectorId: z.string().uuid(),
  storageVersion: z.number().int().positive(),
  providerContext: z
    .object({
      provider: z.literal("feishu"),
      completionTarget: z.enum(["custom", "feishu"]),
      installationId: z.string().uuid().optional(),
      expectedOpenId: z.string().min(1).optional(),
    })
    .optional(),
});

export type CustomConnectorOAuthStateContext = z.infer<
  typeof customConnectorOAuthStateContextSchema
>;

const oauthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullable().optional(),
  id_token: z.string().min(1).nullable().optional(),
  token_type: z.string().min(1).optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
  scope: z.string().trim().min(1).optional(),
});

const oauthTokenErrorResponseSchema = z.object({
  error: z.string().min(1).optional(),
  error_subtype: z.string().min(1).optional(),
});

export interface OAuthTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[] | null;
}

interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

interface PublicHttpsResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

function internalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    normalized.length === 0 ||
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    (isIP(normalized) === 0 && !normalized.includes("."))
  );
}

function ipLiteralAddress(hostname: string): ResolvedFetchAddress | null {
  const address =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const family = isIP(address);
  if (family === 0) {
    return null;
  }
  return { address, family: family === 6 ? 6 : 4 };
}

async function resolvePublicHttpsAddress(
  url: URL,
): Promise<ResolvedFetchAddress> {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    internalHostname(url.hostname)
  ) {
    throw new Error("OAuth token URL is not allowed");
  }
  const literal = ipLiteralAddress(url.hostname);
  const addresses = literal
    ? [literal]
    : await resolveFetchHostAddresses(url.hostname);
  const address = addresses[0];
  if (!address || fetchHostHasBlockedAddress(addresses)) {
    throw new Error("OAuth token URL is not allowed");
  }
  return address;
}

async function postPublicHttpsForm(
  url: URL,
  form: URLSearchParams,
  authorization: string | undefined,
  signal: AbortSignal,
): Promise<PublicHttpsResponse> {
  const address = await resolvePublicHttpsAddress(url);
  signal.throwIfAborted();
  const body = form.toString();
  const deferred = createDeferredPromise<PublicHttpsResponse>(signal);
  const request = httpsRequest(
    url,
    {
      family: address.family,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body).toString(),
        ...(authorization ? { authorization } : {}),
      },
      lookup: (_hostname, _options, callback) => {
        callback(null, address.address, address.family);
      },
      signal,
    },
    (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      let responseBytes = 0;
      response.on("data", (chunk: string) => {
        responseBody += chunk;
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > MAX_TOKEN_RESPONSE_BYTES && !deferred.settled()) {
          deferred.reject(new Error("OAuth token response is too large"));
          response.destroy();
        }
      });
      response.on("error", (error) => {
        if (!deferred.settled()) {
          deferred.reject(error);
        }
      });
      response.on("end", () => {
        if (!deferred.settled()) {
          deferred.resolve({
            status: response.statusCode ?? 502,
            contentType: response.headers["content-type"] ?? "",
            body: responseBody,
          });
        }
      });
    },
  );
  request.on("error", (error) => {
    if (!deferred.settled()) {
      deferred.reject(error);
    }
  });
  request.end(body);
  return await deferred.promise;
}

function tokenResponseData(response: PublicHttpsResponse): unknown {
  if (
    response.contentType.toLowerCase().includes("json") ||
    response.body.trimStart().startsWith("{")
  ) {
    return safeJsonParse(response.body);
  }
  return Object.fromEntries(new URLSearchParams(response.body));
}

function expiresInSeconds(value: number | string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("OAuth token response has an invalid expires_in value");
  }
  return seconds;
}

function hasHttpHeaderControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function oauthScopeTokens(scope: string): readonly string[] {
  return scope.split(/\s+/u);
}

function customConnectorOAuth2AuthorizationScopes(
  authorizationUrl: string | null,
): readonly string[] {
  if (!authorizationUrl) {
    throw new Error("Custom connector OAuth state has no authorization URL");
  }
  const scope = new URL(authorizationUrl).searchParams.get("scope");
  return scope ? oauthScopeTokens(scope) : [];
}

export function customConnectorOAuth2EffectiveInitialToken(
  token: OAuthTokenResult,
  authorizationUrl: string | null,
): OAuthTokenResult {
  return token.scopes === null
    ? {
        ...token,
        scopes: customConnectorOAuth2AuthorizationScopes(authorizationUrl),
      }
    : token;
}

function tokenResult(response: PublicHttpsResponse): OAuthTokenResult {
  if (response.status < 200 || response.status >= 300) {
    const parsed = oauthTokenErrorResponseSchema.safeParse(
      tokenResponseData(response),
    );
    throw new OAuthProviderHttpError(
      `Custom connector OAuth token request failed with status ${response.status}`,
      response.status,
      parsed.success ? parsed.data.error : undefined,
      parsed.success ? parsed.data.error_subtype : undefined,
    );
  }
  const parsed = oauthTokenResponseSchema.safeParse(
    tokenResponseData(response),
  );
  if (!parsed.success) {
    throw new Error("OAuth token response is invalid");
  }
  if (hasHttpHeaderControlCharacter(parsed.data.access_token)) {
    throw new Error("OAuth token response contains an invalid access token");
  }
  const expiresIn = expiresInSeconds(parsed.data.expires_in);
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    idToken: parsed.data.id_token ?? null,
    expiresAt:
      expiresIn === null
        ? null
        : new Date(nowDate().getTime() + expiresIn * 1000),
    scopes:
      parsed.data.scope === undefined
        ? null
        : oauthScopeTokens(parsed.data.scope),
  };
}

function tokenRequestAuthentication(args: {
  readonly config: CustomConnectorOAuthConfigRow;
  readonly clientSecret: string;
  readonly form: URLSearchParams;
}): string | undefined {
  if (args.config.tokenEndpointAuthMethod === "client_secret_post") {
    args.form.set("client_id", args.config.clientId);
    args.form.set("client_secret", args.clientSecret);
    return undefined;
  }
  return `Basic ${Buffer.from(
    `${args.config.clientId}:${args.clientSecret}`,
    "utf8",
  ).toString("base64")}`;
}

async function requestToken(
  args: {
    readonly config: CustomConnectorOAuthConfigRow;
    readonly clientSecret: string;
    readonly form: URLSearchParams;
  },
  signal: AbortSignal,
): Promise<OAuthTokenResult> {
  const authorization = tokenRequestAuthentication(args);
  const response = await postPublicHttpsForm(
    new URL(args.config.tokenUrl),
    args.form,
    authorization,
    signal,
  );
  signal.throwIfAborted();
  return tokenResult(response);
}

function feishuOAuthTokenResult(token: {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number;
}): OAuthTokenResult {
  if (hasHttpHeaderControlCharacter(token.accessToken)) {
    throw new Error("OAuth token response contains an invalid access token");
  }
  if (!Number.isFinite(token.expiresInSeconds) || token.expiresInSeconds < 0) {
    throw new Error("OAuth token response has an invalid expires_in value");
  }
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    idToken: null,
    expiresAt: new Date(nowDate().getTime() + token.expiresInSeconds * 1000),
    scopes: null,
  };
}

function isFeishuInvalidGrantCode(code: number): boolean {
  return (
    code === 20_008 ||
    code === 20_009 ||
    code === 20_010 ||
    code === 20_024 ||
    code === 20_026 ||
    code === 20_037 ||
    code === 20_048 ||
    code === 20_064 ||
    code === 20_066 ||
    code === 20_069 ||
    code === 20_073 ||
    code === 20_074
  );
}

function throwCustomConnectorFeishuOAuthError(error: unknown): never {
  if (!(error instanceof FeishuOAuthTokenError)) {
    throw error;
  }
  throw new OAuthProviderHttpError(
    error.message,
    error.routeStatus,
    isFeishuInvalidGrantCode(error.code) ? "invalid_grant" : error.oauthError,
  );
}

export async function exchangeCustomConnectorOAuth2Code(
  args: {
    readonly config: CustomConnectorOAuthConfigRow;
    readonly clientSecret: string;
    readonly code: string;
    readonly codeVerifier: string | null;
    readonly redirectUri: string;
  },
  signal: AbortSignal,
): Promise<OAuthTokenResult> {
  if (args.config.providerAdapter === "feishu") {
    const result = await settle(
      exchangeFeishuOAuthCode(
        {
          appId: args.config.clientId,
          appSecret: args.clientSecret,
          code: args.code,
          redirectUri: args.redirectUri,
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      throwCustomConnectorFeishuOAuthError(result.error);
    }
    return feishuOAuthTokenResult(result.value);
  }
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  if (args.codeVerifier) {
    form.set("code_verifier", args.codeVerifier);
  }
  return await requestToken({ ...args, form }, signal);
}

async function refreshCustomConnectorOAuth2Token(
  args: {
    readonly config: CustomConnectorOAuthConfigRow;
    readonly clientSecret: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
): Promise<OAuthTokenResult> {
  if (args.config.providerAdapter === "feishu") {
    const result = await settle(
      refreshFeishuOAuthToken(
        {
          appId: args.config.clientId,
          appSecret: args.clientSecret,
          refreshToken: args.refreshToken,
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      throwCustomConnectorFeishuOAuthError(result.error);
    }
    return feishuOAuthTokenResult(result.value);
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
  });
  return await requestToken({ ...args, form }, signal);
}

function createPkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function buildCustomConnectorOAuth2AuthorizationUrl(args: {
  readonly config: CustomConnectorOAuthConfigRow;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string | null;
}): string {
  const url = new URL(args.config.authorizationUrl);
  for (const [name, value] of Object.entries(args.config.authorizationParams)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.config.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  if (args.config.scopes.length > 0) {
    url.searchParams.set("scope", args.config.scopes.join(" "));
  } else {
    url.searchParams.delete("scope");
  }
  if (args.codeVerifier) {
    url.searchParams.set("code_challenge", pkceChallenge(args.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

function customConnectorOAuthMcpIsDisabled(
  connector: CustomConnectorRow,
  featureContext: FeatureSwitchContext,
): boolean {
  return (
    connector.kind === "mcp" && !isCustomConnectorMcpEnabled(featureContext)
  );
}

export const startCustomConnectorOAuth2$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly redirectUri: string;
      readonly publicBrand: PublicBrand;
      readonly agentId?: string;
      readonly account: ConnectorAccountMutationIntent;
      readonly feishuContext?: {
        readonly installationId?: string;
        readonly expectedOpenId?: string;
      };
    },
    signal: AbortSignal,
  ) => {
    const connector = await get(
      getCustomConnectorById({
        orgId: args.orgId,
        connectorId: args.connectorId,
      }),
    );
    signal.throwIfAborted();
    if (!connector) {
      return notFound("Custom connector not found");
    }
    if (connector.authMode !== "oauth" || !connector.oauthConfig) {
      return badRequestMessage(
        "Custom connector does not support OAuth 2.0 authentication",
      );
    }
    if (isIntegrationManagedCustomConnector(connector) && !args.feishuContext) {
      return integrationManagedCustomConnectorMutationForbidden();
    }
    const featureContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    if (customConnectorOAuthMcpIsDisabled(connector, featureContext)) {
      return customConnectorMcpDisabledResponse();
    }
    const providerAdapter = connector.oauthConfig.providerAdapter;
    const redirectUri = args.redirectUri;
    const state = generateConnectorOAuthState(args.publicBrand);
    const codeVerifier =
      connector.oauthConfig.pkceMethod === "S256" ? createPkceVerifier() : null;
    const authorizationUrl = buildCustomConnectorOAuth2AuthorizationUrl({
      config: connector.oauthConfig,
      redirectUri,
      state,
      codeVerifier,
    });
    const context: CustomConnectorOAuthStateContext = {
      connectorId: connector.id,
      storageVersion: connector.storageVersion,
      ...(providerAdapter === "feishu" && args.feishuContext
        ? {
            providerContext: {
              provider: "feishu" as const,
              completionTarget: "feishu" as const,
              ...(args.feishuContext.installationId
                ? { installationId: args.feishuContext.installationId }
                : {}),
              ...(args.feishuContext.expectedOpenId
                ? { expectedOpenId: args.feishuContext.expectedOpenId }
                : {}),
            },
          }
        : {}),
    };
    const mutationStart = await set(writeDb$).transaction(async (tx) => {
      await lockCustomConnectorOAuth2CredentialContract({
        db: tx,
        orgId: args.orgId,
        connectorId: connector.id,
        storageVersion: connector.storageVersion,
      });
      const resolution = await resolveConnectorConnectionMutation(tx, {
        orgId: args.orgId,
        userId: args.userId,
        target: { kind: "custom", customConnectorId: connector.id },
        mutation: args.account,
        allowSiblings:
          !isIntegrationManagedCustomConnector(connector) &&
          connectorAccountSiblingWritesEnabled(featureContext),
      });
      if (resolution.kind !== "ready") {
        return { resolution, connectionId: null };
      }
      const oauthStateId = await insertConnectorOAuthState(tx, {
        state,
        customConnectorId: connector.id,
        storageVersion: connector.storageVersion,
        authMethod: "oauth",
        userId: args.userId,
        orgId: args.orgId,
        agentId: args.agentId,
        authorizeAgent: args.agentId !== undefined,
        redirectUri,
        authorizationUrl,
        codeVerifier,
        oauthContext: JSON.stringify(context),
        accountMutation: args.account,
        expiresAt: connectorOAuthStateExpiresAt(),
      });
      return {
        resolution,
        connectionId: args.account.intent === "add" ? oauthStateId : null,
      };
    });
    signal.throwIfAborted();
    if (mutationStart.resolution.kind !== "ready") {
      return mutationStart.resolution.kind === "missing"
        ? notFound("Connector account not found")
        : conflict(
            mutationStart.resolution.kind === "ambiguous"
              ? "Multiple connector accounts require an exact choice"
              : "Additional connector accounts are not enabled yet",
          );
    }
    return {
      authorizationUrl,
      connectionId: mutationStart.connectionId ?? undefined,
    };
  },
);

export function parseCustomConnectorOAuthStateContext(
  raw: string | null,
): CustomConnectorOAuthStateContext | null {
  if (!raw) {
    return null;
  }
  const parsed = customConnectorOAuthStateContextSchema.safeParse(
    safeJsonParse(raw),
  );
  return parsed.success ? parsed.data : null;
}

export function parseValidCustomConnectorOAuthState(
  storedState: StoredCustomConnectorOAuthState,
): CustomConnectorOAuthStateContext | null {
  const context = parseCustomConnectorOAuthStateContext(
    storedState.oauthContext,
  );
  if (
    !context ||
    storedState.customConnectorId !== context.connectorId ||
    storedState.storageVersion !== context.storageVersion
  ) {
    return null;
  }
  return context;
}

export function customConnectorOAuthStateMatchesDefinition(
  context: CustomConnectorOAuthStateContext,
  connector: Pick<CustomConnectorRow, "id" | "storageVersion">,
): boolean {
  return (
    connector.id === context.connectorId &&
    connector.storageVersion === context.storageVersion
  );
}

export async function decryptCustomConnectorOAuth2Credentials(
  connector: Pick<CustomConnectorRow, "oauthConfig">,
  featureContext: FeatureSwitchContext,
): Promise<OAuthClientCredentials | null> {
  if (!connector.oauthConfig) {
    return null;
  }
  return {
    clientId: connector.oauthConfig.clientId,
    clientSecret: await decryptStoredSecretValue(
      connector.oauthConfig.encryptedClientSecret,
      featureContext,
    ),
  };
}

async function encryptTokenValues(args: {
  readonly token: OAuthTokenResult;
  readonly fallbackRefreshToken?: string;
  readonly fallbackEncryptedIdToken?: string;
  readonly featureContext: FeatureSwitchContext;
}): Promise<{
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
}> {
  const refreshToken = args.token.refreshToken ?? args.fallbackRefreshToken;
  const [accessToken, encryptedRefreshToken, encryptedIdToken] =
    await Promise.all([
      encryptStoredSecretValue(args.token.accessToken, args.featureContext),
      refreshToken
        ? encryptStoredSecretValue(refreshToken, args.featureContext)
        : Promise.resolve(null),
      args.token.idToken
        ? encryptStoredSecretValue(args.token.idToken, args.featureContext)
        : Promise.resolve(args.fallbackEncryptedIdToken ?? null),
    ]);
  return {
    accessToken,
    refreshToken: encryptedRefreshToken,
    idToken: encryptedIdToken,
  };
}

function connectionTokenRows(args: {
  readonly connectionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly encrypted: Awaited<ReturnType<typeof encryptTokenValues>>;
}): (typeof secrets.$inferInsert)[] {
  return [
    {
      name: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME,
      encryptedValue: args.encrypted.accessToken,
      type: "connector",
      connectorId: args.connectionId,
      userId: args.userId,
      orgId: args.orgId,
    },
    ...(args.encrypted.refreshToken
      ? [
          {
            name: CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
            encryptedValue: args.encrypted.refreshToken,
            type: "connector" as const,
            connectorId: args.connectionId,
            userId: args.userId,
            orgId: args.orgId,
          },
        ]
      : []),
    ...(args.encrypted.idToken
      ? [
          {
            name: CUSTOM_CONNECTOR_OAUTH_ID_TOKEN_SECRET_NAME,
            encryptedValue: args.encrypted.idToken,
            type: "connector" as const,
            connectorId: args.connectionId,
            userId: args.userId,
            orgId: args.orgId,
          },
        ]
      : []),
  ];
}

async function replaceConnectionTokens(args: {
  readonly db: Db;
  readonly connectionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly token: OAuthTokenResult;
  readonly fallbackRefreshToken?: string;
  readonly fallbackEncryptedIdToken?: string;
  readonly featureContext: FeatureSwitchContext;
}): Promise<string> {
  const encrypted = await encryptTokenValues(args);
  await args.db
    .update(connectors)
    .set({
      tokenExpiresAt: args.token.expiresAt,
      needsReconnect: false,
      reconnectReason: null,
      ...(args.token.scopes === null
        ? {}
        : { oauthScopes: JSON.stringify(args.token.scopes) }),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectors.id, args.connectionId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
      ),
    );
  await args.db
    .delete(secrets)
    .where(eq(secrets.connectorId, args.connectionId));
  await args.db.insert(secrets).values(
    connectionTokenRows({
      ...args,
      encrypted,
    }),
  );
  return encrypted.accessToken;
}

export async function lockCustomConnectorOAuth2CredentialContract(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly connectorId: string;
  readonly storageVersion: number;
}): Promise<{
  readonly providerAdapter: CustomConnectorOAuthProviderAdapter | null;
}> {
  const [definition] = await args.db
    .select({
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
      providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(orgCustomConnectors.id, args.connectorId),
        eq(orgCustomConnectors.orgId, args.orgId),
      ),
    )
    .for("update", { of: orgCustomConnectors })
    .limit(1);
  if (
    !definition ||
    definition.authMode !== "oauth" ||
    definition.storageVersion !== args.storageVersion
  ) {
    throw new Error(
      "Custom connector credential contract changed during OAuth connection",
    );
  }
  return { providerAdapter: definition.providerAdapter };
}

export async function storeCustomConnectorOAuth2Connection(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly storageVersion: number;
    readonly token: OAuthTokenResult;
    readonly featureContext: FeatureSwitchContext;
    readonly account: ConnectorAccountMutationIntent;
    readonly insertConnectionId?: string;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "stored"; readonly connectionId: string }
  | { readonly kind: "missing" | "ambiguous" | "sibling-disabled" }
> {
  const encrypted = await encryptTokenValues(args);
  signal.throwIfAborted();
  return await args.db.transaction(async (tx) => {
    const contract = await lockCustomConnectorOAuth2CredentialContract({
      db: tx,
      orgId: args.orgId,
      connectorId: args.connectorId,
      storageVersion: args.storageVersion,
    });
    signal.throwIfAborted();
    const resolution = await resolveConnectorConnectionMutation(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "custom", customConnectorId: args.connectorId },
      mutation: args.account,
      allowSiblings:
        !isIntegrationManagedCustomConnectorProviderAdapter(
          contract.providerAdapter,
        ) && connectorAccountSiblingWritesEnabled(args.featureContext),
    });
    signal.throwIfAborted();
    if (resolution.kind !== "ready") {
      return resolution;
    }
    const connection = await replaceConnectorConnection(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        authMethod: "oauth",
        storageVersion: args.storageVersion,
        tokenExpiresAt: args.token.expiresAt,
        target: {
          kind: "custom",
          customConnectorId: args.connectorId,
          oauthScopes: args.token.scopes,
        },
        resolution: resolution.mutation,
        insertConnectionId: args.insertConnectionId,
        writeCredentials: async ({ db, connectorId }) => {
          await db.insert(secrets).values(
            connectionTokenRows({
              ...args,
              connectionId: connectorId,
              encrypted,
            }),
          );
        },
      },
      signal,
    );
    return { kind: "stored", connectionId: connection.id };
  });
}

interface StoredConnection {
  readonly id: string;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
  readonly encryptedAccessToken: string | null;
  readonly encryptedRefreshToken: string | null;
  readonly encryptedIdToken: string | null;
}

async function loadConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly customConnectorId: string;
  readonly memberConnectorId: string;
  readonly storageVersion: number;
  readonly lockRow?: boolean;
}): Promise<StoredConnection | null> {
  const query = args.db
    .select({
      id: connectors.id,
      tokenExpiresAt: connectors.tokenExpiresAt,
      needsReconnect: connectors.needsReconnect,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, args.memberConnectorId),
        eq(connectors.customConnectorId, args.customConnectorId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.authMethod, "oauth"),
        eq(connectors.storageVersion, args.storageVersion),
        exists(
          args.db
            .select({ id: orgCustomConnectors.id })
            .from(orgCustomConnectors)
            .where(
              and(
                eq(orgCustomConnectors.id, args.customConnectorId),
                eq(orgCustomConnectors.orgId, args.orgId),
                eq(orgCustomConnectors.authMode, "oauth"),
                eq(orgCustomConnectors.storageVersion, args.storageVersion),
              ),
            ),
        ),
      ),
    );
  const rows = args.lockRow
    ? await query.for("update").limit(1)
    : await query.limit(1);
  const connection = rows[0];
  if (!connection) {
    return null;
  }
  // Re-check the complete identity at the secret read boundary because the
  // organization definition can change after the parent lookup.
  const tokenRows = await args.db
    .select({
      secretName: secrets.name,
      encryptedValue: secrets.encryptedValue,
    })
    .from(secrets)
    .innerJoin(connectors, eq(connectors.id, secrets.connectorId))
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
        eq(orgCustomConnectors.authMode, "oauth"),
        eq(orgCustomConnectors.storageVersion, args.storageVersion),
      ),
    )
    .where(
      and(
        eq(connectors.id, connection.id),
        eq(connectors.customConnectorId, args.customConnectorId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.authMethod, "oauth"),
        eq(connectors.storageVersion, args.storageVersion),
      ),
    );
  return {
    id: connection.id,
    tokenExpiresAt: connection.tokenExpiresAt,
    needsReconnect: connection.needsReconnect,
    encryptedAccessToken:
      tokenRows.find((row) => {
        return (
          row.secretName === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
        );
      })?.encryptedValue ?? null,
    encryptedRefreshToken:
      tokenRows.find((row) => {
        return (
          row.secretName === CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME
        );
      })?.encryptedValue ?? null,
    encryptedIdToken:
      tokenRows.find((row) => {
        return row.secretName === CUSTOM_CONNECTOR_OAUTH_ID_TOKEN_SECRET_NAME;
      })?.encryptedValue ?? null,
  };
}

function connectionAccessTokenIsCurrent(connection: StoredConnection): boolean {
  const refreshLeewayMs = connection.encryptedRefreshToken
    ? TOKEN_REFRESH_LEEWAY_MS
    : 0;
  return (
    !connection.tokenExpiresAt ||
    connection.tokenExpiresAt.getTime() > nowDate().getTime() + refreshLeewayMs
  );
}

interface AvailableCustomConnectorOAuth2AccessToken {
  readonly kind: "available";
  readonly encryptedAccessToken: string;
  readonly tokenExpiresAt: Date | null;
  readonly status: "current" | "refreshed";
}

type CustomConnectorOAuth2AccessTokenResolution =
  | AvailableCustomConnectorOAuth2AccessToken
  | { readonly kind: "unavailable" }
  | { readonly kind: "reconnect-required" };

function storedConnectionAccessToken(
  connection: StoredConnection,
):
  | AvailableCustomConnectorOAuth2AccessToken
  | { readonly kind: "unavailable" } {
  if (!connection.encryptedAccessToken) {
    return { kind: "unavailable" };
  }
  return {
    kind: "available",
    encryptedAccessToken: connection.encryptedAccessToken,
    tokenExpiresAt: connection.tokenExpiresAt,
    status: "current",
  };
}

export class CustomConnectorOAuth2TokenRefreshError extends Error {
  constructor(cause: unknown) {
    super("Custom connector OAuth 2.0 token refresh failed", { cause });
    this.name = "CustomConnectorOAuth2TokenRefreshError";
  }
}

async function markCustomConnectorNeedsReconnect(
  db: Db,
  connectorId: string,
  reconnectReason: "missing_refresh_token" | "authorization_expired_or_revoked",
): Promise<void> {
  await db
    .update(connectors)
    .set({ needsReconnect: true, reconnectReason, updatedAt: nowDate() })
    .where(eq(connectors.id, connectorId));
}

interface ResolveCustomConnectorOAuth2AccessTokenArgs {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connector: CustomConnectorRow;
  readonly memberConnectorId: string;
  readonly featureContext: FeatureSwitchContext;
  readonly forceRefresh?: boolean;
}

async function resolveCustomConnectorOAuth2AccessToken(
  args: ResolveCustomConnectorOAuth2AccessTokenArgs,
  signal: AbortSignal,
): Promise<CustomConnectorOAuth2AccessTokenResolution> {
  if (args.connector.authMode !== "oauth" || !args.connector.oauthConfig) {
    return { kind: "unavailable" };
  }
  const oauthConfig = args.connector.oauthConfig;
  const connection = await loadConnection({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    customConnectorId: args.connector.id,
    memberConnectorId: args.memberConnectorId,
    storageVersion: args.connector.storageVersion,
  });
  signal.throwIfAborted();
  if (!connection) {
    return { kind: "unavailable" };
  }
  const accessToken = storedConnectionAccessToken(connection);
  if (
    !args.forceRefresh &&
    !connection.needsReconnect &&
    accessToken.kind === "available" &&
    connectionAccessTokenIsCurrent(connection)
  ) {
    return accessToken;
  }
  return await args.db.transaction(async (tx) => {
    const lockedConnection = await loadConnection({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      customConnectorId: args.connector.id,
      memberConnectorId: args.memberConnectorId,
      storageVersion: args.connector.storageVersion,
      lockRow: true,
    });
    signal.throwIfAborted();
    if (!lockedConnection) {
      return { kind: "unavailable" };
    }
    const lockedAccessToken = storedConnectionAccessToken(lockedConnection);
    const recoveredSinceInitialRead =
      connection.needsReconnect ||
      accessToken.kind !== "available" ||
      (lockedAccessToken.kind === "available" &&
        lockedAccessToken.encryptedAccessToken !==
          accessToken.encryptedAccessToken);
    if (
      !lockedConnection.needsReconnect &&
      lockedAccessToken.kind === "available" &&
      (!args.forceRefresh || recoveredSinceInitialRead) &&
      connectionAccessTokenIsCurrent(lockedConnection)
    ) {
      return lockedAccessToken;
    }
    if (!lockedConnection.encryptedRefreshToken) {
      await markCustomConnectorNeedsReconnect(
        tx,
        lockedConnection.id,
        "missing_refresh_token",
      );
      return { kind: "reconnect-required" };
    }
    const [credentials, refreshToken] = await Promise.all([
      decryptCustomConnectorOAuth2Credentials(
        args.connector,
        args.featureContext,
      ),
      decryptStoredSecretValue(
        lockedConnection.encryptedRefreshToken,
        args.featureContext,
      ),
    ]);
    signal.throwIfAborted();
    if (!credentials) {
      return { kind: "unavailable" };
    }
    const refreshResult = await settle(
      refreshCustomConnectorOAuth2Token(
        {
          config: oauthConfig,
          clientSecret: credentials.clientSecret,
          refreshToken,
        },
        signal,
      ),
    );
    if (!refreshResult.ok) {
      if (
        !isOAuthProviderHttpError(refreshResult.error) ||
        refreshResult.error.oauthError !== "invalid_grant"
      ) {
        throw new CustomConnectorOAuth2TokenRefreshError(refreshResult.error);
      }
      await markCustomConnectorNeedsReconnect(
        tx,
        lockedConnection.id,
        "authorization_expired_or_revoked",
      );
      return { kind: "reconnect-required" };
    }
    signal.throwIfAborted();
    const encryptedAccessToken = await replaceConnectionTokens({
      db: tx,
      connectionId: lockedConnection.id,
      orgId: args.orgId,
      userId: args.userId,
      token: refreshResult.value,
      fallbackRefreshToken: refreshToken,
      fallbackEncryptedIdToken: lockedConnection.encryptedIdToken ?? undefined,
      featureContext: args.featureContext,
    });
    signal.throwIfAborted();
    return {
      kind: "available",
      encryptedAccessToken,
      tokenExpiresAt: refreshResult.value.expiresAt,
      status: "refreshed",
    };
  });
}

async function loadLiveCustomConnector(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly customConnectorId: string;
}): Promise<CustomConnectorRow | null> {
  const [row] = await args.db
    .select({
      connector: customConnectorDefinitionSelection(),
      oauthConfig: orgCustomConnectorOauthConfigs,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(orgCustomConnectors.id, args.customConnectorId),
        eq(orgCustomConnectors.orgId, args.orgId),
        eq(orgCustomConnectors.enabled, true),
      ),
    )
    .limit(1);
  return row
    ? normaliseCustomConnectorRow(row.connector, row.oauthConfig)
    : null;
}

export async function resolveCurrentCustomConnectorOAuth2AccessToken(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly customConnectorId: string;
    readonly memberConnectorId: string;
    readonly featureContext: FeatureSwitchContext;
    readonly forceRefresh?: boolean;
  },
  signal: AbortSignal,
): Promise<CustomConnectorOAuth2AccessTokenResolution> {
  const connector = await loadLiveCustomConnector(args);
  signal.throwIfAborted();
  if (!connector || connector.authMode !== "oauth") {
    return { kind: "unavailable" };
  }
  return await resolveCustomConnectorOAuth2AccessToken(
    {
      ...args,
      connector,
    },
    signal,
  );
}
