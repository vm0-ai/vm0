import { createHmac, hkdfSync } from "crypto";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { ZERO_CAPABILITIES } from "@vm0/api-contracts/contracts/composes";
import { env } from "../../env";
import { logger } from "../shared/logger";

type ZeroCapability = (typeof ZERO_CAPABILITIES)[number];

/**
 * Capabilities that are conditionally included based on feature flags.
 * Each entry maps a capability to the feature flag that gates it.
 * Capabilities not listed here are always included.
 */
const CONDITIONAL_CAPABILITIES: ReadonlyMap<ZeroCapability, FeatureSwitchKey> =
  new Map([["computer-use:write", FeatureSwitchKey.ComputerUse]]);

/**
 * Capabilities that are never included in agent run (zero) tokens.
 * Unlike CONDITIONAL_CAPABILITIES (feature-flag gated for gradual rollout),
 * these are structurally excluded for safety — agents should never have them.
 */
const AGENT_EXCLUDED_CAPABILITIES: ReadonlySet<ZeroCapability> = new Set([
  "schedule:delete",
  "agent-run:write",
  "agent:delete",
]);

const log = logger("auth:sandbox");

/**
 * Token prefix for self-signed JWTs (sandbox, compose-job, and zero tokens).
 * These token types share this prefix and are differentiated by the
 * `scope` field inside the JWT payload.
 */
export const SANDBOX_TOKEN_PREFIX = "vm0_sandbox_";

/**
 * Token prefix for CLI personal access tokens (PAT).
 * CLI tokens use this prefix to distinguish from sandbox/zero/compose-job tokens.
 */
export const PAT_TOKEN_PREFIX = "vm0_pat_";

/**
 * JWT payload for sandbox tokens (agent runs)
 */
interface SandboxTokenPayload {
  userId: string;
  runId: string;
  orgId: string;
  scope: "sandbox";
  iat: number;
  exp: number;
}

/**
 * JWT payload for compose job tokens
 */
interface ComposeJobTokenPayload {
  userId: string;
  jobId: string;
  scope: "compose-job";
  iat: number;
  exp: number;
}

/**
 * JWT payload for zero tokens (zero agent runs)
 */
interface ZeroTokenPayload {
  userId: string;
  runId: string;
  orgId: string;
  scope: "zero";
  capabilities: readonly ZeroCapability[];
  iat: number;
  exp: number;
}

/**
 * JWT payload for CLI tokens (user CLI sessions)
 */
interface CliTokenPayload {
  userId: string;
  orgId: string;
  tokenId: string;
  scope: "cli";
  iat: number;
  exp: number;
}

/**
 * Result of verifying a sandbox token
 */
export interface SandboxAuth {
  userId: string;
  runId: string;
  orgId: string;
}

/**
 * Result of verifying a zero token
 */
export interface ZeroAuth {
  userId: string;
  runId: string;
  orgId: string;
  capabilities: readonly ZeroCapability[];
}

/**
 * Result of verifying a CLI token
 */
export interface CliAuth {
  userId: string;
  orgId: string;
  tokenId: string;
}

/**
 * Base64url encode a buffer or string
 */
function base64UrlEncode(data: Buffer | string): string {
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  return buffer.toString("base64url");
}

/**
 * Base64url decode a string
 */
function base64UrlDecode(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

/**
 * Derive JWT signing key from SECRETS_ENCRYPTION_KEY using HKDF
 * This keeps the encryption key and signing key cryptographically separated
 */
function deriveJwtKey(): Buffer {
  const keyHex = env().SECRETS_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be configured");
  }

  const masterKey = Buffer.from(keyHex, "hex");

  // Use HKDF to derive a separate key for JWT signing
  // info: "jwt-sandbox-signing" ensures this key is different from other derived keys
  return Buffer.from(
    hkdfSync("sha256", masterKey, "", "jwt-sandbox-signing", 32),
  );
}

// Cache the derived key for the lifetime of the process
let cachedJwtKey: Buffer | null = null;

function getJwtKey(): Buffer {
  if (!cachedJwtKey) {
    cachedJwtKey = deriveJwtKey();
  }
  return cachedJwtKey;
}

/**
 * Union of all self-signed JWT payload types
 */
type JwtPayload =
  | SandboxTokenPayload
  | ComposeJobTokenPayload
  | ZeroTokenPayload
  | CliTokenPayload;

/**
 * Create a JWT token with HMAC-SHA256 signature
 */
function createJwt(payload: JwtPayload): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));

  const data = `${headerEncoded}.${payloadEncoded}`;
  const signature = createHmac("sha256", getJwtKey()).update(data).digest();
  const signatureEncoded = base64UrlEncode(signature);

  return `${data}.${signatureEncoded}`;
}

/**
 * Verify JWT signature and expiry, decode payload.
 * Does NOT validate scope or fields — callers handle that.
 * @param rawJwt - The raw JWT string (without any prefix)
 */
function verifyJwtPayload(rawJwt: string): JwtPayload | null {
  const parts = rawJwt.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [headerEncoded, payloadEncoded, signatureEncoded] = parts;

  // Verify signature
  const data = `${headerEncoded}.${payloadEncoded}`;
  const expectedSignature = createHmac("sha256", getJwtKey())
    .update(data)
    .digest();
  const actualSignature = base64UrlDecode(signatureEncoded!);

  if (!expectedSignature.equals(actualSignature)) {
    return null;
  }

  // Decode payload and check expiration
  try {
    const parsed: unknown = JSON.parse(
      base64UrlDecode(payloadEncoded!).toString(),
    );

    // Runtime validation: ensure parsed value has the shape of a JWT payload
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("scope" in parsed) ||
      typeof (parsed as Record<string, unknown>).scope !== "string" ||
      !("exp" in parsed) ||
      typeof (parsed as Record<string, unknown>).exp !== "number" ||
      !("iat" in parsed) ||
      typeof (parsed as Record<string, unknown>).iat !== "number" ||
      !("userId" in parsed) ||
      typeof (parsed as Record<string, unknown>).userId !== "string"
    ) {
      return null;
    }

    const payload = parsed as JwtPayload;

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate a JWT token for sandbox authentication
 * Token is valid for 2 hours (longer than typical sandbox timeout)
 *
 * The token encodes userId and runId, allowing webhook endpoints to:
 * 1. Authenticate the request without database lookup
 * 2. Verify the runId matches the token's runId
 * 3. Reject the token on non-webhook endpoints
 */
export async function generateSandboxToken(
  userId: string,
  runId: string,
  orgId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 2 * 60 * 60; // 2 hours in seconds

  const payload: SandboxTokenPayload = {
    userId,
    runId,
    orgId,
    scope: "sandbox",
    iat: now,
    exp: now + expiresIn,
  };

  const jwt = createJwt(payload);
  log.debug(`Generated sandbox JWT for run ${runId}`);
  return SANDBOX_TOKEN_PREFIX + jwt;
}

/**
 * Verify a sandbox JWT token and extract auth info.
 * Returns null if token is invalid, expired, or not a sandbox token.
 *
 * @param token - The full prefixed token (without "Bearer " prefix)
 */
export function verifySandboxToken(token: string): SandboxAuth | null {
  if (!token.startsWith(SANDBOX_TOKEN_PREFIX)) {
    return null;
  }

  const rawJwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
  const payload = verifyJwtPayload(rawJwt);
  if (!payload) {
    return null;
  }

  // Validate scope and required fields. Tokens minted before orgId was added
  // to the payload (2-hour expiry) fail this check and force a re-auth instead
  // of leaking a partial claim.
  if (payload.scope !== "sandbox") {
    return null;
  }
  if (
    !("runId" in payload) ||
    !("orgId" in payload) ||
    !payload.userId ||
    !payload.runId ||
    !payload.orgId
  ) {
    return null;
  }

  return {
    userId: payload.userId,
    runId: payload.runId,
    orgId: payload.orgId,
  };
}

/**
 * Check if a token is a self-signed JWT (sandbox, compose-job, or zero)
 * by checking for the vm0_sandbox_ prefix.
 */
export function isSandboxToken(token: string): boolean {
  return token.startsWith(SANDBOX_TOKEN_PREFIX);
}

/**
 * Check if a token is a CLI personal access token
 * by checking for the vm0_pat_ prefix.
 */
export function isPatToken(token: string): boolean {
  return token.startsWith(PAT_TOKEN_PREFIX);
}

// ============================================================================
// Zero Token Functions
// ============================================================================

/**
 * Generate a JWT token for zero agent authentication.
 * Token is valid for 2 hours and carries all ZERO_CAPABILITIES plus orgId.
 */
export async function generateZeroToken(
  userId: string,
  runId: string,
  orgId: string,
  overrides?: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 2 * 60 * 60; // 2 hours

  // Build capabilities, filtering out agent-excluded and conditionally gated ones
  const capabilities: ZeroCapability[] = [];
  for (const cap of ZERO_CAPABILITIES) {
    if (AGENT_EXCLUDED_CAPABILITIES.has(cap)) {
      continue;
    }
    const flag = CONDITIONAL_CAPABILITIES.get(cap);
    if (flag) {
      if (isFeatureEnabled(flag, { userId, orgId, overrides })) {
        capabilities.push(cap);
      }
    } else {
      capabilities.push(cap);
    }
  }

  const payload: ZeroTokenPayload = {
    userId,
    runId,
    orgId,
    scope: "zero",
    capabilities,
    iat: now,
    exp: now + expiresIn,
  };

  const jwt = createJwt(payload);
  log.debug(`Generated zero JWT for run ${runId}`);
  return SANDBOX_TOKEN_PREFIX + jwt;
}

/**
 * Verify a zero JWT token and extract auth info.
 * Returns null if token is invalid, expired, or not a zero token.
 *
 * @param token - The full prefixed token (without "Bearer " prefix)
 */
export function verifyZeroToken(token: string): ZeroAuth | null {
  if (!token.startsWith(SANDBOX_TOKEN_PREFIX)) {
    return null;
  }

  const rawJwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
  const payload = verifyJwtPayload(rawJwt);
  if (!payload) {
    return null;
  }

  if (payload.scope !== "zero") {
    return null;
  }
  if (!payload.userId || !payload.runId || !payload.orgId) {
    return null;
  }

  const p = payload as ZeroTokenPayload;
  if (!Array.isArray(p.capabilities)) {
    return null;
  }
  const validSet = new Set<string>(ZERO_CAPABILITIES);
  for (const cap of p.capabilities) {
    if (typeof cap !== "string" || !validSet.has(cap)) {
      return null;
    }
  }

  return {
    userId: p.userId,
    runId: p.runId,
    orgId: p.orgId,
    capabilities: p.capabilities,
  };
}

// ============================================================================
// Compose Job Token Functions
// ============================================================================

/**
 * Result of verifying a compose job token
 */
export interface ComposeJobAuth {
  userId: string;
  jobId: string;
}

/**
 * Generate a JWT token for compose job sandbox
 * Token is valid for 10 minutes (longer than 5-minute sandbox timeout)
 */
export async function generateComposeJobToken(
  userId: string,
  jobId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 10 * 60; // 10 minutes in seconds

  const payload: ComposeJobTokenPayload = {
    userId,
    jobId,
    scope: "compose-job",
    iat: now,
    exp: now + expiresIn,
  };

  const jwt = createJwt(payload);
  log.debug(`Generated compose job JWT for job ${jobId}`);
  return SANDBOX_TOKEN_PREFIX + jwt;
}

/**
 * Verify a compose job JWT token and extract auth info.
 * Returns null if token is invalid, expired, or not a compose-job token.
 *
 * @param token - The full prefixed token (without "Bearer " prefix)
 */
export function verifyComposeJobToken(token: string): ComposeJobAuth | null {
  if (!token.startsWith(SANDBOX_TOKEN_PREFIX)) {
    return null;
  }

  const rawJwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
  const payload = verifyJwtPayload(rawJwt);
  if (!payload) {
    return null;
  }

  // Validate scope and required fields
  if (payload.scope !== "compose-job") {
    return null;
  }
  if (!("jobId" in payload) || !payload.userId || !payload.jobId) {
    return null;
  }

  return {
    userId: payload.userId,
    jobId: payload.jobId,
  };
}

// ============================================================================
// CLI Token Functions
// ============================================================================

/**
 * Generate a JWT token for CLI authentication.
 * Token is valid for 90 days (matching existing opaque token lifetime).
 * Carries orgId for org-scoped operations and tokenId for revocation checks.
 */
export async function generateCliToken(
  userId: string,
  orgId: string,
  tokenId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 90 * 24 * 60 * 60; // 90 days in seconds

  const payload: CliTokenPayload = {
    userId,
    orgId,
    tokenId,
    scope: "cli",
    iat: now,
    exp: now + expiresIn,
  };

  const jwt = createJwt(payload);
  log.debug(`Generated CLI JWT for user ${userId}`);
  return PAT_TOKEN_PREFIX + jwt;
}

/**
 * Verify a CLI JWT token and extract auth info.
 * Returns null if token is invalid, expired, or not a CLI token.
 *
 * @param token - The full prefixed token (without "Bearer " prefix)
 */
export function verifyCliToken(token: string): CliAuth | null {
  let rawJwt: string;
  if (token.startsWith(PAT_TOKEN_PREFIX)) {
    rawJwt = token.slice(PAT_TOKEN_PREFIX.length);
  } else if (token.startsWith(SANDBOX_TOKEN_PREFIX)) {
    // Backward compat: accept old vm0_sandbox_ prefix for CLI tokens during transition
    rawJwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
  } else {
    return null;
  }
  const payload = verifyJwtPayload(rawJwt);
  if (!payload) {
    return null;
  }

  if (payload.scope !== "cli") {
    return null;
  }
  if (
    !payload.userId ||
    !("orgId" in payload) ||
    !payload.orgId ||
    !("tokenId" in payload) ||
    !payload.tokenId
  ) {
    return null;
  }

  return {
    userId: payload.userId,
    orgId: payload.orgId,
    tokenId: payload.tokenId,
  };
}

/**
 * Test-only: sign an arbitrary payload with the sandbox JWT key and
 * prepend the sandbox prefix. Lets tests construct payload shapes
 * `generateSandboxToken` can't produce (e.g. a legacy payload missing
 * `orgId`) so the verifier's fail-closed contract is pinned against
 * regressions. Do not use in production code.
 */
export function signSandboxJwtForTests(payload: object): string {
  return SANDBOX_TOKEN_PREFIX + createJwt(payload as JwtPayload);
}
