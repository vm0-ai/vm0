import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type {
  CustomConnectorOAuth2AuthMethod,
  StartCustomConnectorOAuth2Body,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";

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
import { createDeferredPromise, safeJsonParse } from "../utils";
import { writeDb$, type Db } from "../external/db";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import {
  CUSTOM_CONNECTOR_OAUTH_AUTHORIZATION_KEY,
  CUSTOM_CONNECTOR_OAUTH_CLIENT_ID_KEY,
  CUSTOM_CONNECTOR_OAUTH_CLIENT_SECRET_KEY,
  CUSTOM_CONNECTOR_OAUTH_EXPIRES_AT_KEY,
  CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_KEY,
  CUSTOM_CONNECTOR_OAUTH_VALUE_KEYS,
  customConnectorOAuth2AuthMethod,
  getCustomConnectorById,
  type CustomConnectorRow,
  type StoredValueRow,
} from "./zero-custom-connector.service";

const CUSTOM_CONNECTOR_OAUTH_STATE_PREFIX = "custom:";
const CUSTOM_CONNECTOR_OAUTH_METHOD_ID = "oauth2";
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;

const customConnectorOAuthStateContextSchema = z.object({
  connectorId: z.string().uuid(),
  method: z.object({
    type: z.literal("oauth2"),
    authorizationUrl: z.string(),
    tokenUrl: z.string(),
    scopes: z.array(z.string()),
    clientAuthentication: z.enum(["client_secret_basic", "client_secret_post"]),
  }),
  encryptedClientId: z.string(),
  encryptedClientSecret: z.string(),
});

type CustomConnectorOAuthStateContext = z.infer<
  typeof customConnectorOAuthStateContextSchema
>;

const oauthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullable().optional(),
  token_type: z.string().min(1).optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
});

interface OAuthTokenResult {
  readonly authorization: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
}

interface PublicHttpsResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

interface StoredPlainValue {
  readonly key: string;
  readonly value: string;
}

function customConnectorOAuthStateType(connectorId: string): string {
  return `${CUSTOM_CONNECTOR_OAUTH_STATE_PREFIX}${connectorId}`;
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
    throw new Error(
      `OAuth token request failed with status ${response.status}`,
    );
  }
  const parsed = oauthTokenResponseSchema.safeParse(
    tokenResponseData(response),
  );
  if (!parsed.success) {
    throw new Error("OAuth token response is invalid");
  }
  const tokenType = parsed.data.token_type ?? "Bearer";
  if (
    !/^[A-Za-z][A-Za-z0-9._~-]*$/u.test(tokenType) ||
    hasHttpHeaderControlCharacter(parsed.data.access_token)
  ) {
    throw new Error("OAuth token response contains an invalid access token");
  }
  const expiresIn = expiresInSeconds(parsed.data.expires_in);
  return {
    authorization: `${tokenType} ${parsed.data.access_token}`,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt:
      expiresIn === null
        ? null
        : new Date(nowDate().getTime() + expiresIn * 1000).toISOString(),
  };
}

function tokenRequestAuthentication(args: {
  readonly method: CustomConnectorOAuth2AuthMethod;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly form: URLSearchParams;
}): string | undefined {
  if (args.method.clientAuthentication === "client_secret_post") {
    args.form.set("client_id", args.clientId);
    args.form.set("client_secret", args.clientSecret);
    return undefined;
  }
  if (args.clientId.includes(":")) {
    throw new Error(
      "OAuth client ID must not contain a colon when using HTTP Basic authentication",
    );
  }
  return `Basic ${Buffer.from(
    `${args.clientId}:${args.clientSecret}`,
    "utf8",
  ).toString("base64")}`;
}

async function requestToken(args: {
  readonly method: CustomConnectorOAuth2AuthMethod;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly form: URLSearchParams;
  readonly signal: AbortSignal;
}): Promise<OAuthTokenResult> {
  const authorization = tokenRequestAuthentication(args);
  const response = await postPublicHttpsForm(
    new URL(args.method.tokenUrl),
    args.form,
    authorization,
    args.signal,
  );
  args.signal.throwIfAborted();
  return tokenResult(response);
}

export async function exchangeCustomConnectorOAuth2Code(args: {
  readonly method: CustomConnectorOAuth2AuthMethod;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly signal: AbortSignal;
}): Promise<OAuthTokenResult> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  return await requestToken({ ...args, form });
}

async function refreshCustomConnectorOAuth2Token(args: {
  readonly method: CustomConnectorOAuth2AuthMethod;
  readonly clientId: string;
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

function buildCustomConnectorOAuth2AuthorizationUrl(args: {
  readonly method: CustomConnectorOAuth2AuthMethod;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const url = new URL(args.method.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  if (args.method.scopes.length > 0) {
    url.searchParams.set("scope", args.method.scopes.join(" "));
  } else {
    url.searchParams.delete("scope");
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
      readonly input: StartCustomConnectorOAuth2Body;
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
    const method = customConnectorOAuth2AuthMethod(connector);
    if (!method) {
      return badRequestMessage(
        "Custom connector does not support OAuth 2.0 authentication",
      );
    }
    const clientId = args.input.clientId.trim();
    if (clientId.length === 0 || args.input.clientSecret.trim().length === 0) {
      return badRequestMessage(
        "OAuth client ID and client secret are required",
      );
    }
    if (
      method.clientAuthentication === "client_secret_basic" &&
      clientId.includes(":")
    ) {
      return badRequestMessage(
        "OAuth client ID must not contain a colon when using HTTP Basic authentication",
      );
    }
    const featureContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const [encryptedClientId, encryptedClientSecret] = await Promise.all([
      encryptStoredSecretValue(clientId, featureContext),
      encryptStoredSecretValue(args.input.clientSecret, featureContext),
    ]);
    signal.throwIfAborted();
    const state = generateConnectorOAuthState();
    const authorizationUrl = buildCustomConnectorOAuth2AuthorizationUrl({
      method,
      clientId,
      redirectUri: args.redirectUri,
      state,
    });
    const context: CustomConnectorOAuthStateContext = {
      connectorId: connector.id,
      method,
      encryptedClientId,
      encryptedClientSecret,
    };
    const writeDb = set(writeDb$);
    await writeDb.insert(connectorOauthStates).values({
      state,
      type: customConnectorOAuthStateType(connector.id),
      authMethod: CUSTOM_CONNECTOR_OAUTH_METHOD_ID,
      userId: args.userId,
      orgId: args.orgId,
      redirectUri: args.redirectUri,
      authorizationUrl,
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

export function customConnectorOAuthMethodMatchesState(
  method: CustomConnectorOAuth2AuthMethod,
  stateMethod: CustomConnectorOAuth2AuthMethod,
): boolean {
  return (
    method.authorizationUrl === stateMethod.authorizationUrl &&
    method.tokenUrl === stateMethod.tokenUrl &&
    method.clientAuthentication === stateMethod.clientAuthentication &&
    method.scopes.length === stateMethod.scopes.length &&
    method.scopes.every((scope, index) => {
      return scope === stateMethod.scopes[index];
    })
  );
}

async function encryptedStoredValues(
  values: readonly StoredPlainValue[],
  featureContext: FeatureSwitchContext,
): Promise<
  readonly {
    readonly key: string;
    readonly encryptedValue: string;
  }[]
> {
  return await Promise.all(
    values.map(async (value) => {
      return {
        key: value.key,
        encryptedValue: await encryptStoredSecretValue(
          value.value,
          featureContext,
        ),
      };
    }),
  );
}

function plainOAuthValues(args: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly token: OAuthTokenResult;
  readonly fallbackRefreshToken?: string;
}): readonly StoredPlainValue[] {
  const refreshToken = args.token.refreshToken ?? args.fallbackRefreshToken;
  return [
    {
      key: CUSTOM_CONNECTOR_OAUTH_AUTHORIZATION_KEY,
      value: args.token.authorization,
    },
    { key: CUSTOM_CONNECTOR_OAUTH_CLIENT_ID_KEY, value: args.clientId },
    {
      key: CUSTOM_CONNECTOR_OAUTH_CLIENT_SECRET_KEY,
      value: args.clientSecret,
    },
    ...(refreshToken
      ? [
          {
            key: CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_KEY,
            value: refreshToken,
          },
        ]
      : []),
    ...(args.token.expiresAt
      ? [
          {
            key: CUSTOM_CONNECTOR_OAUTH_EXPIRES_AT_KEY,
            value: args.token.expiresAt,
          },
        ]
      : []),
  ];
}

async function replaceCustomConnectorOAuthValues(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly values: readonly StoredPlainValue[];
  readonly featureContext: FeatureSwitchContext;
  readonly clearApiValues: boolean;
}): Promise<readonly StoredValueRow[]> {
  const encrypted = await encryptedStoredValues(
    args.values,
    args.featureContext,
  );
  await args.db.transaction(async (tx) => {
    await tx
      .delete(orgCustomConnectorValues)
      .where(
        and(
          eq(orgCustomConnectorValues.connectorId, args.connectorId),
          eq(orgCustomConnectorValues.userId, args.userId),
          eq(orgCustomConnectorValues.orgId, args.orgId),
          eq(orgCustomConnectorValues.kind, "secret"),
          ...(args.clearApiValues
            ? []
            : [
                inArray(orgCustomConnectorValues.key, [
                  ...CUSTOM_CONNECTOR_OAUTH_VALUE_KEYS,
                ]),
              ]),
        ),
      );
    if (args.clearApiValues) {
      await tx
        .delete(orgCustomConnectorSecrets)
        .where(
          and(
            eq(orgCustomConnectorSecrets.connectorId, args.connectorId),
            eq(orgCustomConnectorSecrets.userId, args.userId),
            eq(orgCustomConnectorSecrets.orgId, args.orgId),
          ),
        );
    }
    await tx.insert(orgCustomConnectorValues).values(
      encrypted.map((value) => {
        return {
          connectorId: args.connectorId,
          userId: args.userId,
          orgId: args.orgId,
          kind: "secret",
          key: value.key,
          encryptedValue: value.encryptedValue,
        };
      }),
    );
  });
  return encrypted.map((value) => {
    return {
      connectorId: args.connectorId,
      kind: "secret",
      key: value.key,
      encryptedValue: value.encryptedValue,
    };
  });
}

export async function storeCustomConnectorOAuth2Connection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly token: OAuthTokenResult;
  readonly featureContext: FeatureSwitchContext;
}): Promise<void> {
  await replaceCustomConnectorOAuthValues({
    ...args,
    values: plainOAuthValues(args),
    clearApiValues: true,
  });
}

function encryptedValueByKey(
  values: readonly StoredValueRow[],
  key: string,
): string | null {
  return (
    values.find((value) => {
      return value.kind === "secret" && value.key === key;
    })?.encryptedValue ?? null
  );
}

async function decryptRequiredOAuthValue(args: {
  readonly values: readonly StoredValueRow[];
  readonly key: string;
  readonly featureContext: FeatureSwitchContext;
}): Promise<string | null> {
  const encrypted = encryptedValueByKey(args.values, args.key);
  return encrypted
    ? await decryptStoredSecretValue(encrypted, args.featureContext)
    : null;
}

async function clearStoredCustomConnectorOAuthValues(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
}): Promise<void> {
  await args.db
    .delete(orgCustomConnectorValues)
    .where(
      and(
        eq(orgCustomConnectorValues.connectorId, args.connectorId),
        eq(orgCustomConnectorValues.userId, args.userId),
        eq(orgCustomConnectorValues.orgId, args.orgId),
        eq(orgCustomConnectorValues.kind, "secret"),
        inArray(orgCustomConnectorValues.key, [
          ...CUSTOM_CONNECTOR_OAUTH_VALUE_KEYS,
        ]),
      ),
    );
}

function withoutOAuthValues(
  values: readonly StoredValueRow[],
): readonly StoredValueRow[] {
  const oauthKeys = new Set<string>(CUSTOM_CONNECTOR_OAUTH_VALUE_KEYS);
  return values.filter((value) => {
    return value.kind !== "secret" || !oauthKeys.has(value.key);
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
  const method = customConnectorOAuth2AuthMethod(args.connector);
  const authorization = encryptedValueByKey(
    args.values,
    CUSTOM_CONNECTOR_OAUTH_AUTHORIZATION_KEY,
  );
  if (!method || !authorization) {
    return args.values;
  }
  const expiresAtValue = await decryptRequiredOAuthValue({
    values: args.values,
    key: CUSTOM_CONNECTOR_OAUTH_EXPIRES_AT_KEY,
    featureContext: args.featureContext,
  });
  args.signal.throwIfAborted();
  if (!expiresAtValue) {
    return args.values;
  }
  const expiresAt = new Date(expiresAtValue);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("Stored custom connector OAuth expiration is invalid");
  }
  if (expiresAt.getTime() > nowDate().getTime() + TOKEN_REFRESH_LEEWAY_MS) {
    return args.values;
  }
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    decryptRequiredOAuthValue({
      values: args.values,
      key: CUSTOM_CONNECTOR_OAUTH_CLIENT_ID_KEY,
      featureContext: args.featureContext,
    }),
    decryptRequiredOAuthValue({
      values: args.values,
      key: CUSTOM_CONNECTOR_OAUTH_CLIENT_SECRET_KEY,
      featureContext: args.featureContext,
    }),
    decryptRequiredOAuthValue({
      values: args.values,
      key: CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_KEY,
      featureContext: args.featureContext,
    }),
  ]);
  args.signal.throwIfAborted();
  if (!clientId || !clientSecret || !refreshToken) {
    await clearStoredCustomConnectorOAuthValues({
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connector.id,
    });
    args.signal.throwIfAborted();
    return withoutOAuthValues(args.values);
  }
  const token = await refreshCustomConnectorOAuth2Token({
    method,
    clientId,
    clientSecret,
    refreshToken,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  const refreshed = await replaceCustomConnectorOAuthValues({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    connectorId: args.connector.id,
    values: plainOAuthValues({
      clientId,
      clientSecret,
      token,
      fallbackRefreshToken: refreshToken,
    }),
    featureContext: args.featureContext,
    clearApiValues: false,
  });
  args.signal.throwIfAborted();
  return [...withoutOAuthValues(args.values), ...refreshed];
}
