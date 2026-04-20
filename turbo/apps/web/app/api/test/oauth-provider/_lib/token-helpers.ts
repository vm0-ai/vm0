import { randomBytes } from "node:crypto";

/**
 * Statelessly encode a scenario into code / refresh_token strings so the
 * authorize and token endpoints don't need shared memory. Required because
 * this runs on Vercel — authorize and token grants land on different
 * serverless instances and cannot rely on process-local state.
 */

export const TEST_OAUTH_SCENARIOS = [
  "success",
  "expired-access",
  "invalid-refresh",
  "revoked",
] as const;

export type TestOAuthScenario = (typeof TEST_OAUTH_SCENARIOS)[number];

const TOKEN_PREFIX = "testoauth_";
const ACCESS_PREFIX = `${TOKEN_PREFIX}at_`;
const REFRESH_PREFIX = `${TOKEN_PREFIX}rt_`;
const CODE_PREFIX = `${TOKEN_PREFIX}code_`;

function randomId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Access tokens carry their own expiry as unix-ms so userinfo/echo can
 * reject expired tokens without shared state. Format:
 *   testoauth_at_<unix_ms>_<hex>
 * Anyone can craft one — integrity is not the goal (this is a test fixture,
 * not a real OAuth provider). The point is to give the test-server endpoints
 * deterministic "is this token still alive?" behavior that matches real
 * providers closely enough to exercise the refresh pipeline end-to-end.
 */
export function mintAccessToken(expiresInSecs: number): string {
  const expiresAtMs = Date.now() + expiresInSecs * 1000;
  return `${ACCESS_PREFIX}${expiresAtMs}_${randomId()}`;
}

/**
 * Mint a token whose embedded expiry is unambiguously in the past.
 * Avoids the `mintAccessToken(0)` + "hope the next Date.now() is later"
 * race in tests.
 */
export function mintExpiredAccessToken(): string {
  const pastMs = Date.now() - 1000;
  return `${ACCESS_PREFIX}${pastMs}_${randomId()}`;
}

export function mintRefreshToken(scenario: TestOAuthScenario): string {
  return `${REFRESH_PREFIX}${scenario}_${randomId()}`;
}

export function mintAuthCode(scenario: TestOAuthScenario): string {
  return `${CODE_PREFIX}${scenario}_${randomId()}`;
}

export function isTestOAuthAccessToken(value: string): boolean {
  return value.startsWith(ACCESS_PREFIX);
}

export function isTestOAuthRefreshToken(value: string): boolean {
  return value.startsWith(REFRESH_PREFIX);
}

/**
 * Parse the embedded expiry (unix-ms) from an access token, or null if the
 * token isn't shaped like one of ours.
 */
function parseAccessTokenExpiryMs(token: string): number | null {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const tail = token.slice(ACCESS_PREFIX.length);
  const underscoreIdx = tail.indexOf("_");
  if (underscoreIdx === -1) return null;
  const msStr = tail.slice(0, underscoreIdx);
  const ms = Number(msStr);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

export function isTestOAuthAccessTokenExpired(token: string): boolean {
  const expiresAt = parseAccessTokenExpiryMs(token);
  if (expiresAt === null) return true;
  return Date.now() >= expiresAt;
}

function parseScenarioFromToken(
  value: string,
  prefix: string,
): TestOAuthScenario | null {
  if (!value.startsWith(prefix)) return null;
  const tail = value.slice(prefix.length);
  // tail = "<scenario>_<hex>"
  const underscoreIdx = tail.indexOf("_");
  if (underscoreIdx === -1) return null;
  const scenario = tail.slice(0, underscoreIdx);
  if ((TEST_OAUTH_SCENARIOS as readonly string[]).includes(scenario)) {
    return scenario as TestOAuthScenario;
  }
  return null;
}

export function parseScenarioFromCode(code: string): TestOAuthScenario | null {
  return parseScenarioFromToken(code, CODE_PREFIX);
}

export function parseScenarioFromRefreshToken(
  refreshToken: string,
): TestOAuthScenario | null {
  return parseScenarioFromToken(refreshToken, REFRESH_PREFIX);
}
