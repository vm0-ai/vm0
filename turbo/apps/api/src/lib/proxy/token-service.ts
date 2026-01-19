import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "../../env";
import { logger } from "../logger";

const log = logger("proxy:token");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Proxy token prefix - tokens with this prefix contain encrypted secrets
 */
export const PROXY_TOKEN_PREFIX = "vm0_enc_";

/**
 * Token payload structure
 */
interface ProxyTokenPayload {
  runId: string;
  userId: string;
  secretName: string;
  secretValue: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

/**
 * Token validation result
 */
interface TokenValidationResult {
  valid: boolean;
  payload?: ProxyTokenPayload;
  error?: string;
}

/**
 * Get the encryption key from environment
 */
function getEncryptionKey(): Buffer {
  const keyHex = env().SECRETS_ENCRYPTION_KEY;
  if (!keyHex) {
    if (env().NODE_ENV === "production") {
      throw new Error("SECRETS_ENCRYPTION_KEY must be set in production");
    }
    // Development fallback
    return Buffer.from(
      "0000000000000000000000000000000000000000000000000000000000000000",
      "hex",
    );
  }
  return Buffer.from(keyHex, "hex");
}

/**
 * Create an encrypted proxy token that wraps a secret value
 *
 * @param runId - The run ID this token is bound to
 * @param userId - The user ID who owns the run
 * @param secretName - The name of the secret (e.g., ANTHROPIC_API_KEY)
 * @param secretValue - The actual secret value to encrypt
 * @param expiresInMs - Token expiration time in milliseconds (default: 2 hours)
 * @returns Encrypted token in format: vm0_enc_<base64>
 */
export function createProxyToken(
  runId: string,
  userId: string,
  secretName: string,
  secretValue: string,
  expiresInMs: number = 2 * 60 * 60 * 1000, // 2 hours default
): string {
  const payload: ProxyTokenPayload = {
    runId,
    userId,
    secretName,
    secretValue,
    expiresAt: Date.now() + expiresInMs,
  };

  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Combine iv + authTag + ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted]);
  const base64 = combined.toString("base64");

  return `${PROXY_TOKEN_PREFIX}${base64}`;
}

/**
 * Decrypt and validate a proxy token
 *
 * @param token - The encrypted token (with or without vm0_enc_ prefix)
 * @param expectedRunId - Optional run ID to validate against
 * @returns Validation result with payload if valid
 */
export function decryptProxyToken(
  token: string,
  expectedRunId?: string,
): TokenValidationResult {
  // Remove prefix if present
  const base64 = token.startsWith(PROXY_TOKEN_PREFIX)
    ? token.slice(PROXY_TOKEN_PREFIX.length)
    : token;

  try {
    const combined = Buffer.from(base64, "base64");

    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      return { valid: false, error: "Token too short" };
    }

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const key = getEncryptionKey();
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const payload = JSON.parse(decrypted.toString("utf8")) as ProxyTokenPayload;

    // Validate expiration
    if (payload.expiresAt < Date.now()) {
      log.warn(`Token expired for run ${payload.runId}`);
      return { valid: false, error: "Token expired" };
    }

    // Validate run ID if provided
    if (expectedRunId && payload.runId !== expectedRunId) {
      log.warn(
        `Token run ID mismatch: expected ${expectedRunId}, got ${payload.runId}`,
      );
      return { valid: false, error: "Run ID mismatch" };
    }

    return { valid: true, payload };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn(`Failed to decrypt token: ${message}`);
    return { valid: false, error: "Invalid token" };
  }
}

/**
 * Check if a string is a proxy token (has the vm0_enc_ prefix)
 */
export function isProxyToken(value: string): boolean {
  return value.startsWith(PROXY_TOKEN_PREFIX);
}

/**
 * Extract the secret value from a proxy token
 * Returns null if token is invalid or expired
 *
 * @param token - The encrypted token
 * @param expectedRunId - Optional run ID to validate against
 * @returns The decrypted secret value or null
 */
export function extractSecretFromToken(
  token: string,
  expectedRunId?: string,
): string | null {
  const result = decryptProxyToken(token, expectedRunId);
  if (result.valid && result.payload) {
    return result.payload.secretValue;
  }
  return null;
}
