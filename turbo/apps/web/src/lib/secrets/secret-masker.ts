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

/**
 * Recursively traverse and mask data structures.
 */
function deepMask(value: unknown, patterns: Set<string>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return maskString(value, patterns);
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepMask(item, patterns));
  }

  if (typeof value === "object") {
    const masked: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      masked[key] = deepMask(val, patterns);
    }
    return masked;
  }

  // Numbers, booleans, etc. - return as-is
  return value;
}

/**
 * Replace all occurrences of secret patterns in a string.
 * Longer patterns are replaced first to handle overlapping secrets correctly.
 */
function maskString(str: string, patterns: Set<string>): string {
  if (patterns.size === 0) {
    return str;
  }

  let result = str;

  // Sort patterns by length (descending) to mask longer secrets first
  // This handles cases where one secret is a substring of another
  const sortedPatterns = Array.from(patterns).sort(
    (a, b) => b.length - a.length,
  );

  for (const pattern of sortedPatterns) {
    if (result.includes(pattern)) {
      result = result.split(pattern).join(MASK_PLACEHOLDER);
    }
  }

  return result;
}
