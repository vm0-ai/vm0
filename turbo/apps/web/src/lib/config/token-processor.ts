import { encryptToken, isEncryptedToken } from "../crypto/token-encryption";

/**
 * Check if a string is a GitHub token (plaintext)
 */
function isGitHubToken(value: string): boolean {
  // GitHub personal access tokens start with ghp_
  // GitHub OAuth tokens start with gho_
  // GitHub user-to-server tokens start with ghu_
  // GitHub server-to-server tokens start with ghs_
  // GitHub refresh tokens start with ghr_
  // Fine-grained PATs start with github_pat_
  return (
    value.startsWith("ghp_") ||
    value.startsWith("gho_") ||
    value.startsWith("ghu_") ||
    value.startsWith("ghs_") ||
    value.startsWith("ghr_") ||
    value.startsWith("github_pat_")
  );
}

/**
 * Process agent config and encrypt plaintext GitHub tokens
 * @param config - Agent configuration
 * @param userId - User ID for encryption
 * @param secret - Encryption secret
 * @returns Processed config with encrypted tokens
 */
export function processGitHubTokens(
  config: unknown,
  userId: string,
  secret: string,
): unknown {
  function process(value: unknown): unknown {
    // Handle strings - check if it's a plaintext GitHub token
    if (typeof value === "string") {
      // If already encrypted, return as-is
      if (isEncryptedToken(value)) {
        return value;
      }

      // If plaintext GitHub token, encrypt it
      if (isGitHubToken(value)) {
        return encryptToken(value, userId, secret);
      }

      // Otherwise return unchanged
      return value;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((item) => process(item));
    }

    // Handle objects
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = process(val);
      }
      return result;
    }

    // Return primitives unchanged
    return value;
  }

  return process(config);
}
