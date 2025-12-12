/**
 * Secret masking module for protecting sensitive data in event logs.
 *
 * Similar to GitHub Actions secret masking, this module replaces secret values
 * with a placeholder before storing events in the database.
 */

/** Placeholder used to replace masked secrets */
export const MASK_PLACEHOLDER = "***";

/** Minimum length for a secret to be masked (avoid false positives on short strings) */
export const MIN_SECRET_LENGTH = 5;

export interface SecretMasker {
  /**
   * Recursively mask all occurrences of secrets in the given data.
   * Handles strings, arrays, and nested objects.
   */
  mask(data: unknown): unknown;
}

/**
 * Recursively mask all occurrences of secret patterns in the given data.
 */
function deepMask(data: unknown, patterns: Set<string>): unknown {
  if (typeof data === "string") {
    let result = data;
    for (const pattern of patterns) {
      // Use split/join for global replacement (faster than regex for many patterns)
      result = result.split(pattern).join(MASK_PLACEHOLDER);
    }
    return result;
  }

  if (Array.isArray(data)) {
    return data.map((item) => deepMask(item, patterns));
  }

  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = deepMask(value, patterns);
    }
    return result;
  }

  return data;
}

/**
 * Create a secret masker instance with the given secret values.
 * Pre-computes encoding variants (original, Base64, URL-encoded) for efficient matching.
 *
 * @param secretValues - Array of secret values to mask
 * @returns A SecretMasker instance
 */
export function createSecretMasker(secretValues: string[]): SecretMasker {
  // Filter secrets shorter than minimum length to avoid false positives
  const validSecrets = secretValues.filter(
    (s) => s && s.length >= MIN_SECRET_LENGTH,
  );

  // Pre-compute encoding variants for each secret
  const patterns = new Set<string>();
  for (const secret of validSecrets) {
    // Original value
    patterns.add(secret);

    // Base64 encoded
    const base64 = Buffer.from(secret).toString("base64");
    if (base64.length >= MIN_SECRET_LENGTH) {
      patterns.add(base64);
    }

    // URL encoded (only add if different from original)
    const urlEncoded = encodeURIComponent(secret);
    if (urlEncoded !== secret && urlEncoded.length >= MIN_SECRET_LENGTH) {
      patterns.add(urlEncoded);
    }
  }

  return {
    mask(data: unknown): unknown {
      return deepMask(data, patterns);
    },
  };
}
