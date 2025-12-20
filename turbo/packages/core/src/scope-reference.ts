/**
 * Scope Reference Parser and Formatter
 *
 * Handles parsing and formatting of scoped resource references:
 * - @scope/name - explicit scope reference
 * - name - implicit (uses user's default scope)
 * - vm0-* - legacy system template passthrough
 */

export interface ScopedReference {
  scope: string;
  name: string;
}

export interface ResolvedImageReference {
  scope?: string;
  name: string;
  isLegacy: boolean;
}

/**
 * Parse a scoped reference string (@scope/name format)
 * @throws Error if format is invalid
 */
export function parseScopedReference(reference: string): ScopedReference {
  if (!reference.startsWith("@")) {
    throw new Error(
      `Invalid scoped reference: must start with @ (got "${reference}")`,
    );
  }

  const withoutAt = reference.slice(1);
  const slashIndex = withoutAt.indexOf("/");

  if (slashIndex === -1) {
    throw new Error(
      `Invalid scoped reference: missing / separator (got "${reference}")`,
    );
  }

  const scope = withoutAt.slice(0, slashIndex);
  const name = withoutAt.slice(slashIndex + 1);

  if (!scope) {
    throw new Error(
      `Invalid scoped reference: empty scope (got "${reference}")`,
    );
  }

  if (!name) {
    throw new Error(
      `Invalid scoped reference: empty name (got "${reference}")`,
    );
  }

  return { scope, name };
}

/**
 * Format a scope and name into a scoped reference string
 */
export function formatScopedReference(scope: string, name: string): string {
  return `@${scope}/${name}`;
}

/**
 * Check if an image reference is a legacy vm0-* system template
 */
export function isLegacySystemTemplate(reference: string): boolean {
  return reference.startsWith("vm0-");
}

/**
 * Resolve an image reference to its components
 *
 * Resolution order:
 * 1. Legacy vm0-* prefix: passthrough without scope resolution
 * 2. Explicit @scope/name format: parse scope and name
 * 3. Implicit format: use user's default scope
 *
 * @param input - The image reference string
 * @param userScopeSlug - The user's default scope slug (required for implicit references)
 * @returns Resolved reference with scope, name, and legacy flag
 * @throws Error if implicit reference without userScopeSlug
 */
export function resolveImageReference(
  input: string,
  userScopeSlug?: string,
): ResolvedImageReference {
  // 1. Legacy vm0-* format: passthrough directly
  if (isLegacySystemTemplate(input)) {
    return {
      name: input,
      isLegacy: true,
    };
  }

  // 2. Explicit @scope/name format
  if (input.startsWith("@")) {
    const { scope, name } = parseScopedReference(input);
    return {
      scope,
      name,
      isLegacy: false,
    };
  }

  // 3. Implicit: use user's default scope
  if (!userScopeSlug) {
    throw new Error(
      "Please set up your scope first with: vm0 scope set <slug>",
    );
  }

  return {
    scope: userScopeSlug,
    name: input,
    isLegacy: false,
  };
}

/**
 * Generate E2B template alias from scope ID, image name, and version hash
 *
 * Format: scope-{scopeId}-image-{name}-version-{versionHash}
 *
 * Note: E2B only allows lowercase letters, numbers, dashes, and underscores.
 * We use scopeId (UUID) instead of scopeSlug for stability when users change their slug.
 *
 * @param scopeId - The scope UUID (stable identifier)
 * @param imageName - The image name (user-specified)
 * @param versionHash - SHA-256 hash of Dockerfile (first 8 chars)
 * @returns E2B-compatible template alias
 */
export function generateScopedE2bAlias(
  scopeId: string,
  imageName: string,
  versionHash: string,
): string {
  // Sanitize components to ensure E2B compatibility
  const sanitizedScopeId = scopeId.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const sanitizedName = imageName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const sanitizedHash = versionHash.toLowerCase().replace(/[^a-z0-9]/g, "");

  return `scope-${sanitizedScopeId}-image-${sanitizedName}-version-${sanitizedHash}`;
}

/**
 * Compute version hash from Dockerfile content
 * Uses SHA-256 hash, returning first 8 characters
 */
export async function computeDockerfileVersionHash(
  dockerfile: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(dockerfile);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex.slice(0, 8);
}
