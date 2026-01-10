/**
 * Secret masking module for VM0 sandbox.
 *
 * Masks secrets in event data before sending to server.
 * Similar to GitHub Actions secret masking.
 */

// Placeholder for masked secrets
const MASK_PLACEHOLDER = "***";

// Minimum length for secrets (avoid false positives on short strings)
const MIN_SECRET_LENGTH = 5;

// Global masker instance (initialized lazily)
let _masker: SecretMasker | null = null;

/**
 * Masks secret values in data structures.
 * Pre-computes encoding variants for efficient matching.
 */
export class SecretMasker {
  private patterns: Set<string>;

  /**
   * Initialize masker with secret values.
   *
   * @param secretValues - List of secret values to mask
   */
  constructor(secretValues: string[]) {
    this.patterns = new Set<string>();

    for (const secret of secretValues) {
      if (!secret || secret.length < MIN_SECRET_LENGTH) {
        continue;
      }

      // Original value
      this.patterns.add(secret);

      // Base64 encoded
      try {
        const b64 = Buffer.from(secret).toString("base64");
        if (b64.length >= MIN_SECRET_LENGTH) {
          this.patterns.add(b64);
        }
      } catch {
        // Skip invalid encoding
      }

      // URL encoded (only if different from original)
      try {
        const urlEnc = encodeURIComponent(secret);
        if (urlEnc !== secret && urlEnc.length >= MIN_SECRET_LENGTH) {
          this.patterns.add(urlEnc);
        }
      } catch {
        // Skip invalid encoding
      }
    }
  }

  /**
   * Recursively mask all occurrences of secrets in the data.
   *
   * @param data - Data to mask (string, array, object, or primitive)
   * @returns Masked data with the same structure
   */
  mask<T>(data: T): T {
    return this.deepMask(data) as T;
  }

  private deepMask(data: unknown): unknown {
    if (typeof data === "string") {
      let result = data;
      for (const pattern of this.patterns) {
        // Use split/join for global replacement
        result = result.split(pattern).join(MASK_PLACEHOLDER);
      }
      return result;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.deepMask(item));
    }

    if (data !== null && typeof data === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.deepMask(value);
      }
      return result;
    }

    // Primitives (number, boolean, null, undefined) pass through unchanged
    return data;
  }
}

/**
 * Get the global masker instance.
 * Initializes on first call using VM0_SECRET_VALUES env var.
 *
 * @returns SecretMasker instance
 */
export function getMasker(): SecretMasker {
  if (_masker === null) {
    _masker = createMasker();
  }
  return _masker;
}

/**
 * Create a masker from VM0_SECRET_VALUES env var.
 *
 * VM0_SECRET_VALUES contains comma-separated base64-encoded secret values.
 * This avoids exposing plaintext secrets in environment variable names.
 */
function createMasker(): SecretMasker {
  const secretValuesStr = process.env.VM0_SECRET_VALUES ?? "";

  if (!secretValuesStr) {
    // No secrets to mask
    return new SecretMasker([]);
  }

  // Parse base64-encoded values
  const secretValues: string[] = [];
  for (const encodedValue of secretValuesStr.split(",")) {
    const trimmed = encodedValue.trim();
    if (trimmed) {
      try {
        const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
        if (decoded) {
          secretValues.push(decoded);
        }
      } catch {
        // Skip invalid base64 values
      }
    }
  }

  return new SecretMasker(secretValues);
}

/**
 * Convenience function to mask data using global masker.
 *
 * @param data - Data to mask
 * @returns Masked data
 */
export function maskData<T>(data: T): T {
  return getMasker().mask(data);
}
