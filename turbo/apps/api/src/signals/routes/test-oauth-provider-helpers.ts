import { randomBytes } from "node:crypto";

import { env, optionalEnv } from "../../lib/env";
import { now } from "../../lib/time";

export const TEST_OAUTH_CLIENT_ID = "test-oauth-client";
export const TEST_OAUTH_CLIENT_SECRET = "test-oauth-secret";
export const TEST_OAUTH_DEVICE_CLIENT_ID = "test-oauth-device-client";
export const TEST_OAUTH_DEVICE_USER_CODE = "TEST-DEVICE";
export const TEST_OAUTH_DEVICE_VERIFICATION_URI =
  "https://oauth-device.test/device";

const TEST_OAUTH_SCENARIOS = [
  "success",
  "short-lived-access",
  "expired-access",
  "invalid-refresh",
  "revoked",
] as const;

export type TestOAuthScenario = (typeof TEST_OAUTH_SCENARIOS)[number];

const TOKEN_PREFIX = "testoauth_";
const ACCESS_PREFIX = `${TOKEN_PREFIX}at_`;
const REFRESH_PREFIX = `${TOKEN_PREFIX}rt_`;
const CODE_PREFIX = `${TOKEN_PREFIX}code_`;
const TEST_ENDPOINT_BYPASS_HEADER = "x-vm0-test-endpoint-bypass";

interface HeaderReader {
  readonly header: (name: string) => string | undefined;
}

function isPreviewRuntime(deployEnv: string): boolean {
  return deployEnv === "preview" || optionalEnv("VERCEL_ENV") === "preview";
}

function expectedTestEndpointBypassSecret(): string | undefined {
  return (
    optionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET") ??
    env("VERCEL_AUTOMATION_BYPASS_SECRET")
  );
}

// Vercel consumes the protection-bypass header before protected preview
// rewrites reach the API runtime. Production still stays denied.
function isProtectedPreviewRewrite(): boolean {
  return (
    optionalEnv("USE_MOCK_CLAUDE") === "true" &&
    !!expectedTestEndpointBypassSecret()
  );
}

function randomId(): string {
  return randomBytes(16).toString("hex");
}

export function isTestEndpointAllowed(request: HeaderReader): boolean {
  const deployEnv = env("ENV");

  if (deployEnv === "development") {
    return true;
  }

  if (isPreviewRuntime(deployEnv)) {
    const vercelBypassHeader = request.header("x-vercel-protection-bypass");
    const internalBypassHeader = request.header(TEST_ENDPOINT_BYPASS_HEADER);
    const expectedSecret = expectedTestEndpointBypassSecret();
    return (
      isProtectedPreviewRewrite() ||
      (!!expectedSecret &&
        (vercelBypassHeader === expectedSecret ||
          internalBypassHeader === expectedSecret))
    );
  }

  return false;
}

export function testEndpointNotFoundResponse(): Response {
  return new Response("Not found", { status: 404 });
}

export function parseTestOAuthScenario(
  value: string,
): TestOAuthScenario | null {
  if ((TEST_OAUTH_SCENARIOS as readonly string[]).includes(value)) {
    return value as TestOAuthScenario;
  }
  return null;
}

export function mintAuthCode(scenario: TestOAuthScenario): string {
  return `${CODE_PREFIX}${scenario}_${randomId()}`;
}

export function mintAccessToken(expiresInSecs: number): string {
  const expiresAtMs = now() + expiresInSecs * 1000;
  return `${ACCESS_PREFIX}${expiresAtMs}_${randomId()}`;
}

export function mintRefreshToken(scenario: TestOAuthScenario): string {
  return `${REFRESH_PREFIX}${scenario}_${randomId()}`;
}

export function mintExpiredAccessToken(): string {
  const pastMs = now() - 1000;
  return `${ACCESS_PREFIX}${pastMs}_${randomId()}`;
}

export function isTestOAuthAccessToken(value: string): boolean {
  return value.startsWith(ACCESS_PREFIX);
}

export function isPreviewTestOAuthAccessToken(
  value: string | undefined,
): boolean {
  return env("ENV") === "preview" && !!value && isTestOAuthAccessToken(value);
}

export function isTestOAuthRefreshToken(value: string): boolean {
  return value.startsWith(REFRESH_PREFIX);
}

function parseScenarioFromToken(
  value: string,
  prefix: string,
): TestOAuthScenario | null {
  if (!value.startsWith(prefix)) {
    return null;
  }

  const tail = value.slice(prefix.length);
  const underscoreIdx = tail.indexOf("_");
  if (underscoreIdx === -1) {
    return null;
  }

  return parseTestOAuthScenario(tail.slice(0, underscoreIdx));
}

export function parseScenarioFromCode(code: string): TestOAuthScenario | null {
  return parseScenarioFromToken(code, CODE_PREFIX);
}

export function parseScenarioFromRefreshToken(
  refreshToken: string,
): TestOAuthScenario | null {
  return parseScenarioFromToken(refreshToken, REFRESH_PREFIX);
}

function parseAccessTokenExpiryMs(token: string): number | null {
  if (!token.startsWith(ACCESS_PREFIX)) {
    return null;
  }

  const tail = token.slice(ACCESS_PREFIX.length);
  const underscoreIdx = tail.indexOf("_");
  if (underscoreIdx === -1) {
    return null;
  }

  const ms = Number(tail.slice(0, underscoreIdx));
  if (!Number.isFinite(ms)) {
    return null;
  }

  return ms;
}

export function isTestOAuthAccessTokenExpired(token: string): boolean {
  const expiresAt = parseAccessTokenExpiryMs(token);
  if (expiresAt === null) {
    return true;
  }
  return now() >= expiresAt;
}

export function bearerTokenFrom(authorization: string): string | undefined {
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
