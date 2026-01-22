import { createHmac, hkdfSync, randomBytes } from "crypto";
import { TOKEN_PREFIXES } from "@vm0/core";
import { env } from "../../env";
import { logger } from "../logger";

const log = logger("auth:sandbox");

/**
 * JWT payload for sandbox tokens
 */
interface SandboxTokenPayload {
  userId: string;
  runId: string;
  scope: "sandbox";
  iat: number;
  exp: number;
}

/**
 * Result of verifying a sandbox token
 */
export interface SandboxAuth {
  userId: string;
  runId: string;
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
    // Development fallback - NOT FOR PRODUCTION
    if (env().NODE_ENV === "production") {
      throw new Error("SECRETS_ENCRYPTION_KEY must be set in production");
    }
    log.warn(
      "SECRETS_ENCRYPTION_KEY not configured, using random key (dev mode only)",
    );
    return randomBytes(32);
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
 * Create a JWT token with HMAC-SHA256 signature
 */
function createJwt(payload: SandboxTokenPayload): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));

  const data = `${headerEncoded}.${payloadEncoded}`;
  const signature = createHmac("sha256", getJwtKey()).update(data).digest();
  const signatureEncoded = base64UrlEncode(signature);

  return `${data}.${signatureEncoded}`;
}

/**
 * Verify and decode a JWT token
 * Returns null if invalid or expired
 */
function verifyJwt(token: string): SandboxTokenPayload | null {
  const parts = token.split(".");
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

  // Decode and validate payload
  try {
    const payload = JSON.parse(
      base64UrlDecode(payloadEncoded!).toString(),
    ) as SandboxTokenPayload;

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    // Validate required fields
    if (payload.scope !== "sandbox" || !payload.userId || !payload.runId) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate a JWT token for E2B sandbox
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
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 2 * 60 * 60; // 2 hours in seconds

  const payload: SandboxTokenPayload = {
    userId,
    runId,
    scope: "sandbox",
    iat: now,
    exp: now + expiresIn,
  };

  const jwt = createJwt(payload);
  const token = `${TOKEN_PREFIXES.SANDBOX}${jwt}`;
  log.debug(`Generated sandbox token for run ${runId}`);
  return token;
}

/**
 * Verify a sandbox token and extract auth info
 * Returns null if token is invalid, expired, or not a sandbox token
 *
 * @param token - The full token with vm0_sandbox_ prefix (without "Bearer " prefix)
 */
export function verifySandboxToken(token: string): SandboxAuth | null {
  // Must have the sandbox prefix
  if (!token.startsWith(TOKEN_PREFIXES.SANDBOX)) {
    return null;
  }

  // Extract the JWT part (remove prefix)
  const jwt = token.slice(TOKEN_PREFIXES.SANDBOX.length);
  const payload = verifyJwt(jwt);
  if (!payload) {
    return null;
  }

  return {
    userId: payload.userId,
    runId: payload.runId,
  };
}

/**
 * Check if a token is a sandbox token by its prefix
 */
export function isSandboxToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIXES.SANDBOX);
}
