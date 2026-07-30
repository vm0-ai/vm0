import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import {
  isOAuthProviderHttpError,
  OAuthProviderHttpError,
} from "@vm0/connectors/auth-providers/oauth/error";
import { connectors } from "@vm0/db/schema/connector";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { orgCustomConnectorOauthConfigs } from "@vm0/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { secrets } from "@vm0/db/schema/secret";

import {
  fetchHostHasBlockedAddress,
  resolveFetchHostAddresses,
  type ResolvedFetchAddress,
} from "../../lib/blocked-fetch-host";
import { badRequestMessage, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import {
  CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS,
  generateConnectorOAuthState,
} from "../routes/connector-oauth-route-state";
import { createDeferredPromise, safeJsonParse, settle } from "../utils";
import { writeDb$, type Db } from "../external/db";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
  CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME,
  CUSTOM_CONNECTOR_OAUTH_ID_TOKEN_SECRET_NAME,
  CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
  getCustomConnectorById,
  normaliseCustomConnectorRow,
  type CustomConnectorOAuthConfigRow,
  type CustomConnectorRow,
  type StoredValueRow,
} from "./zero-custom-connector.service";

const CUSTOM_CONNECTOR_OAUTH_METHOD_ID = "oauth2";
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;

const customConnectorOAuthStateContextSchema = z.object({
  connectorId: z.string().uuid(),
  connectorRevision: z.number().int().positive(),
});

type CustomConnectorOAuthStateContext = z.infer<
  typeof customConnectorOAuthStateContextSchema
>;

const oauthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullable().optional(),
  id_token: z.string().min(1).nullable().optional(),
  token_type: z.string().min(1).optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
});

const oauthTokenErrorResponseSchema = z.object({
  error: z.string().min(1).optional(),
  error_subtype: z.string().min(1).optional(),
});

interface OAuthTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAt: Date | null;
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

async function requestToken(args: {
  readonly config: CustomConnectorOAuthConfigRow;
  readonly clientSecret: string;
  readonly form: URLSearchParams;
  readonly signal: AbortSignal;
}): Promise<OAuthTokenResult> {
  const authorization = tokenRequestAuthentication(args);
  const response = await postPublicHttpsForm(
    new URL(args.config.tokenUrl),
    args.form,
    authorization,
    args.signal,
  );
  args.signal.throwIfAborted();
  return tokenResult(response);
}

export async function exchangeCustomConnectorOAuth2Code(args: {
  readonly config: CustomConnectorOAuthConfigRow;
  readonly clientSecret: string;
  readonly code: string;
  readonly codeVerifier: string | null;
  readonly redirectUri: string;
  readonly signal: AbortSignal;
}): Promise<OAuthTokenResult> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  if (args.codeVerifier) {
    form.set("code_verifier", args.codeVerifier);
  }
  return await requestToken({ ...args, form });
}

async function refreshCustomConnectorOAuth2Token(args: {
  readonly config: CustomConnectorOAuthConfigRow;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly signal: AbortSignal;
}): Promise<OAuthTokenResult> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
  });
  return await requestToken({ ...args, form });
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

export const startCustomConnectorOAuth2$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly redirectUri: string;
      readonly agentId?: string;
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
    if (connector.oauthConfig.providerAdapter !== "standard") {
      return badRequestMessage("OAuth provider adapter is not supported");
    }
    const state = generateConnectorOAuthState();
    const codeVerifier =
      connector.oauthConfig.pkceMethod === "S256" ? createPkceVerifier() : null;
    const authorizationUrl = buildCustomConnectorOAuth2AuthorizationUrl({
      config: connector.oauthConfig,
      redirectUri: args.redirectUri,
      state,
      codeVerifier,
    });
    const context: CustomConnectorOAuthStateContext = {
      connectorId: connector.id,
      connectorRevision: connector.revision,
    };
    await set(writeDb$)
      .insert(connectorOauthStates)
      .values({
        state,
        customConnectorId: connector.id,
        connectorRevision: connector.revision,
        authMethod: CUSTOM_CONNECTOR_OAUTH_METHOD_ID,
        userId: args.userId,
        orgId: args.orgId,
        agentId: args.agentId,
        authorizeAgent: args.agentId !== undefined,
        redirectUri: args.redirectUri,
        authorizationUrl,
        codeVerifier,
        oauthContext: JSON.stringify(context),
        expiresAt: new Date(
          nowDate().getTime() + CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS * 1000,
        ),
      });
    signal.throwIfAborted();
    return { authorizationUrl };
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

export async function storeCustomConnectorOAuth2Connection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly token: OAuthTokenResult;
  readonly featureContext: FeatureSwitchContext;
}): Promise<void> {
  const encrypted = await encryptTokenValues(args);
  await args.db.transaction(async (tx) => {
    const [connection] = await tx
      .insert(connectors)
      .values({
        customConnectorId: args.connectorId,
        authMethod: "oauth",
        storageVersion: 1,
        tokenExpiresAt: args.token.expiresAt,
        userId: args.userId,
        orgId: args.orgId,
      })
      .onConflictDoUpdate({
        target: [
          connectors.orgId,
          connectors.userId,
          connectors.customConnectorId,
        ],
        targetWhere: isNotNull(connectors.customConnectorId),
        set: {
          tokenExpiresAt: args.token.expiresAt,
          needsReconnect: false,
          reconnectReason: null,
          updatedAt: nowDate(),
        },
      })
      .returning({ id: connectors.id });
    if (!connection) {
      throw new Error("Expected custom connector OAuth connection");
    }
    await tx.delete(secrets).where(eq(secrets.connectorId, connection.id));
    await tx.insert(secrets).values(
      connectionTokenRows({
        ...args,
        connectionId: connection.id,
        encrypted,
      }),
    );
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
  readonly connectorId: string;
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
        eq(connectors.customConnectorId, args.connectorId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.authMethod, "oauth"),
      ),
    );
  const rows = args.lockRow
    ? await query.for("update").limit(1)
    : await query.limit(1);
  const connection = rows[0];
  if (!connection) {
    return null;
  }
  const tokenRows = await args.db
    .select({
      secretName: secrets.name,
      encryptedValue: secrets.encryptedValue,
    })
    .from(secrets)
    .where(eq(secrets.connectorId, connection.id));
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
  return (
    !connection.tokenExpiresAt ||
    connection.tokenExpiresAt.getTime() >
      nowDate().getTime() + TOKEN_REFRESH_LEEWAY_MS
  );
}

function withoutRuntimeOAuthToken(
  values: readonly StoredValueRow[],
): readonly StoredValueRow[] {
  return values.filter((value) => {
    return !(
      value.kind === "secret" &&
      value.key === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY
    );
  });
}

function withRuntimeOAuthToken(
  values: readonly StoredValueRow[],
  connectorId: string,
  encryptedValue: string,
): readonly StoredValueRow[] {
  return [
    ...withoutRuntimeOAuthToken(values),
    {
      connectorId,
      kind: "secret",
      key: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
      encryptedValue,
    },
  ];
}

async function resolveCustomConnectorOAuth2AccessToken(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connector: CustomConnectorRow;
  readonly featureContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  if (args.connector.authMode !== "oauth" || !args.connector.oauthConfig) {
    return null;
  }
  const oauthConfig = args.connector.oauthConfig;
  const connection = await loadConnection({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    connectorId: args.connector.id,
  });
  args.signal.throwIfAborted();
  if (!connection?.encryptedAccessToken || connection.needsReconnect) {
    return null;
  }
  if (connectionAccessTokenIsCurrent(connection)) {
    return connection.encryptedAccessToken;
  }
  return await args.db.transaction(async (tx) => {
    const lockedConnection = await loadConnection({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connector.id,
      lockRow: true,
    });
    args.signal.throwIfAborted();
    if (
      !lockedConnection?.encryptedAccessToken ||
      lockedConnection.needsReconnect
    ) {
      return null;
    }
    if (connectionAccessTokenIsCurrent(lockedConnection)) {
      return lockedConnection.encryptedAccessToken;
    }
    if (!lockedConnection.encryptedRefreshToken) {
      await tx
        .update(connectors)
        .set({
          needsReconnect: true,
          reconnectReason: "missing_refresh_token",
          updatedAt: nowDate(),
        })
        .where(eq(connectors.id, lockedConnection.id));
      return null;
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
    args.signal.throwIfAborted();
    if (!credentials) {
      return null;
    }
    const refreshResult = await settle(
      refreshCustomConnectorOAuth2Token({
        config: oauthConfig,
        clientSecret: credentials.clientSecret,
        refreshToken,
        signal: args.signal,
      }),
    );
    if (!refreshResult.ok) {
      if (
        !isOAuthProviderHttpError(refreshResult.error) ||
        refreshResult.error.oauthError !== "invalid_grant"
      ) {
        throw refreshResult.error;
      }
      await tx
        .update(connectors)
        .set({
          needsReconnect: true,
          reconnectReason: "authorization_expired_or_revoked",
          updatedAt: nowDate(),
        })
        .where(eq(connectors.id, lockedConnection.id));
      return null;
    }
    args.signal.throwIfAborted();
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
    args.signal.throwIfAborted();
    return encryptedAccessToken;
  });
}

export async function refreshCustomConnectorOAuth2ValuesIfNeeded(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connector: CustomConnectorRow;
  readonly values: readonly StoredValueRow[];
  readonly featureContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<readonly StoredValueRow[]> {
  if (args.connector.authMode !== "oauth") {
    return args.values;
  }
  const encryptedAccessToken =
    await resolveCustomConnectorOAuth2AccessToken(args);
  return encryptedAccessToken
    ? withRuntimeOAuthToken(
        args.values,
        args.connector.id,
        encryptedAccessToken,
      )
    : withoutRuntimeOAuthToken(args.values);
}

async function loadLiveCustomConnector(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly connectorId: string;
}): Promise<CustomConnectorRow | null> {
  const [row] = await args.db
    .select({
      connector: orgCustomConnectors,
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
        eq(orgCustomConnectors.id, args.connectorId),
        eq(orgCustomConnectors.orgId, args.orgId),
        eq(orgCustomConnectors.enabled, true),
      ),
    )
    .limit(1);
  return row
    ? normaliseCustomConnectorRow(row.connector, row.oauthConfig)
    : null;
}

export async function resolveLiveCustomConnectorOAuth2AccessToken(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly connectorRevision: number;
  readonly featureContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const connector = await loadLiveCustomConnector(args);
  args.signal.throwIfAborted();
  if (
    !connector ||
    connector.revision !== args.connectorRevision ||
    connector.authMode !== "oauth"
  ) {
    return null;
  }
  return await resolveCustomConnectorOAuth2AccessToken({
    ...args,
    connector,
  });
}
