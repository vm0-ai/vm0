import { randomBytes } from "node:crypto";

const TOKEN_PREFIX = "testoauth_";
const ACCESS_PREFIX = `${TOKEN_PREFIX}at_`;

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

export function isTestOAuthAccessToken(value: string): boolean {
  return value.startsWith(ACCESS_PREFIX);
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
