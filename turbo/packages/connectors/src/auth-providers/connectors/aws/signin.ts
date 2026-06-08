import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { OAuthProviderHttpError } from "../../oauth/error";
import { ProviderResponseError } from "../../provider-error";

export const AWS_SIGNIN_CROSS_DEVICE_CLIENT_ID =
  "arn:aws:signin:::devtools/cross-device";
export const AWS_DEFAULT_SIGNIN_REGION = "us-east-1";
export const AWS_DEFAULT_RUNTIME_REGION = "us-east-1";

const AWS_SIGNIN_TOKEN_TYPE =
  "urn:aws:params:oauth:token-type:access_token_sigv4";
const AWS_CODE_CHALLENGE_METHOD = "SHA-256";
const AWS_OPENID_SCOPE = "openid";
const AWS_AUTHORIZATION_RESPONSE_TYPE = "code";
const AWS_ERROR_BODY_MAX_LENGTH = 500;
const AWS_REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

const awsSigninTokenResponseSchema = z.object({
  accessToken: z.object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1),
  }),
  expiresIn: z.number().int().min(1).max(900),
  refreshToken: z.string().min(1),
  tokenType: z.literal(AWS_SIGNIN_TOKEN_TYPE),
  idToken: z.string().optional(),
});

const awsSigninErrorResponseSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  message: z.string().optional(),
  Message: z.string().optional(),
  code: z.string().optional(),
  Code: z.string().optional(),
  __type: z.string().optional(),
});

export interface AwsSigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

export interface AwsSigninTokenResult {
  readonly credentials: AwsSigV4Credentials;
  readonly expiresIn: number;
  readonly refreshToken: string;
}

export interface AwsExternalCodeProviderState {
  readonly version: 1;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly signinRegion: string;
  readonly runtimeRegion: string;
}

interface AwsSigninErrorDetails {
  readonly message: string;
  readonly oauthError: string | undefined;
}

export function awsSigninRedirectUri(signinRegion: string): string {
  return `https://${validatedAwsRegion(signinRegion)}.signin.aws.amazon.com/v1/sessions/confirmation`;
}

export function awsSigninAuthorizeUrl(signinRegion: string): string {
  return `https://${validatedAwsRegion(signinRegion)}.signin.aws.amazon.com/v1/authorize`;
}

export function awsSigninTokenUrl(signinRegion: string): string {
  return `https://${validatedAwsRegion(signinRegion)}.signin.aws.amazon.com/v1/token`;
}

export function createAwsExternalCodeProviderState(): AwsExternalCodeProviderState {
  const signinRegion = AWS_DEFAULT_SIGNIN_REGION;
  return {
    version: 1,
    state: randomBase64UrlBytes(32),
    codeVerifier: randomBase64UrlBytes(64),
    redirectUri: awsSigninRedirectUri(signinRegion),
    signinRegion,
    runtimeRegion: AWS_DEFAULT_RUNTIME_REGION,
  };
}

export function buildAwsSigninAuthorizationUrl(args: {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly providerState: AwsExternalCodeProviderState;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    response_type: AWS_AUTHORIZATION_RESPONSE_TYPE,
    scope: awsSigninScope(args.scopes),
    code_challenge_method: AWS_CODE_CHALLENGE_METHOD,
    code_challenge: codeChallenge(args.providerState.codeVerifier),
    redirect_uri: args.providerState.redirectUri,
    state: args.providerState.state,
  });

  return `${awsSigninAuthorizeUrl(args.providerState.signinRegion)}?${params.toString()}`;
}

export async function exchangeAwsSigninAuthorizationCode(args: {
  readonly clientId: string;
  readonly signinRegion: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly signal: AbortSignal;
}): Promise<AwsSigninTokenResult> {
  return await fetchAwsSigninToken({
    signinRegion: args.signinRegion,
    operation: "exchange",
    reconnectOnClientError: true,
    signal: args.signal,
    body: {
      clientId: args.clientId,
      grantType: "authorization_code",
      code: args.code,
      codeVerifier: args.codeVerifier,
      redirectUri: args.redirectUri,
    },
  });
}

export async function refreshAwsSigninToken(args: {
  readonly clientId: string;
  readonly signinRegion: string;
  readonly refreshToken: string;
  readonly signal: AbortSignal;
}): Promise<AwsSigninTokenResult> {
  return await fetchAwsSigninToken({
    signinRegion: args.signinRegion,
    operation: "refresh",
    reconnectOnClientError: true,
    signal: args.signal,
    body: {
      clientId: args.clientId,
      grantType: "refresh_token",
      refreshToken: args.refreshToken,
    },
  });
}

async function fetchAwsSigninToken(args: {
  readonly signinRegion: string;
  readonly operation: "exchange" | "refresh";
  readonly reconnectOnClientError: boolean;
  readonly body: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}): Promise<AwsSigninTokenResult> {
  const response = await fetch(awsSigninTokenUrl(args.signinRegion), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.body),
    signal: args.signal,
  });

  if (!response.ok) {
    await throwAwsSigninHttpError({
      response,
      operation: args.operation,
      reconnectOnClientError: args.reconnectOnClientError,
    });
  }

  const data = await readAwsSigninTokenResponse(response);
  return {
    credentials: {
      accessKeyId: data.accessToken.accessKeyId,
      secretAccessKey: data.accessToken.secretAccessKey,
      sessionToken: data.accessToken.sessionToken,
    },
    expiresIn: data.expiresIn,
    refreshToken: data.refreshToken,
  };
}

async function readAwsSigninTokenResponse(
  response: Response,
): Promise<z.infer<typeof awsSigninTokenResponseSchema>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ProviderResponseError("Invalid AWS Sign-In token response");
  }

  const parsed = awsSigninTokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderResponseError("Invalid AWS Sign-In token response");
  }
  return parsed.data;
}

async function throwAwsSigninHttpError(args: {
  readonly response: Response;
  readonly operation: "exchange" | "refresh";
  readonly reconnectOnClientError: boolean;
}): Promise<never> {
  const details = await readAwsSigninErrorDetails(args.response);
  const oauthError =
    args.reconnectOnClientError &&
    args.response.status >= 400 &&
    args.response.status < 500 &&
    args.response.status !== 429
      ? "invalid_grant"
      : details.oauthError;
  const suffix = details.message ? ` ${details.message}` : "";
  throw new OAuthProviderHttpError(
    `AWS Sign-In token ${args.operation} failed: ${args.response.status}${suffix}`,
    args.response.status,
    oauthError,
  );
}

async function readAwsSigninErrorDetails(
  response: Response,
): Promise<AwsSigninErrorDetails> {
  const raw = await response.text();
  if (!raw) {
    return { message: "", oauthError: undefined };
  }

  const truncated =
    raw.length > AWS_ERROR_BODY_MAX_LENGTH
      ? `${raw.slice(0, AWS_ERROR_BODY_MAX_LENGTH)}...`
      : raw;

  try {
    const parsed = awsSigninErrorResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        message: redactAwsSigninErrorText(truncated),
        oauthError: undefined,
      };
    }
    const errorCode =
      parsed.data.error ??
      parsed.data.code ??
      parsed.data.Code ??
      parsed.data.__type;
    const description =
      parsed.data.error_description ??
      parsed.data.message ??
      parsed.data.Message;
    const message = errorCode
      ? description
        ? `${errorCode} (${description})`
        : errorCode
      : (description ?? redactAwsSigninErrorText(truncated));
    return {
      message: redactAwsSigninErrorText(message),
      oauthError: parsed.data.error,
    };
  } catch {
    return {
      message: redactAwsSigninErrorText(truncated),
      oauthError: undefined,
    };
  }
}

function awsSigninScope(scopes: readonly string[]): string {
  return scopes.length === 0 ? AWS_OPENID_SCOPE : scopes.join(" ");
}

function codeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function randomBase64UrlBytes(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function validatedAwsRegion(region: string): string {
  if (!AWS_REGION_RE.test(region)) {
    throw new Error(`Invalid AWS Sign-In region ${region}`);
  }
  return region;
}

function redactAwsSigninErrorText(value: string): string {
  return value
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY_ID]")
    .replace(/ASIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY_ID]")
    .replace(
      /("(?:secretAccessKey|sessionToken|refreshToken|code)"\s*:\s*")[^"]+/g,
      "$1[REDACTED]",
    )
    .replace(
      /((?:secretAccessKey|sessionToken|refreshToken|code)=)[^&\s]+/g,
      "$1[REDACTED]",
    );
}
