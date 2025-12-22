/**
 * Scope Reference Parser and Formatter
 *
 * Handles parsing and formatting of scoped resource references:
 * - @scope/name - explicit scope reference
 * - @vm0/name - system scope (special handling)
 * - name - implicit (uses user's default scope)
 * - vm0-* - legacy system template passthrough (deprecated)
 */

/**
 * System scope constants
 */
export const SYSTEM_SCOPE_SLUG = "vm0";
export const SYSTEM_IMAGE_CLAUDE_CODE = "claude-code";
export const SYSTEM_VALID_TAGS = ["latest", "dev"] as const;

export type SystemValidTag = (typeof SYSTEM_VALID_TAGS)[number];

/**
 * Check if a scope is the system scope
 */
export function isSystemScope(scope: string): boolean {
  return scope === SYSTEM_SCOPE_SLUG;
}

/**
 * Check if a tag is valid for system images
 */
export function isValidSystemTag(
  tag: string | undefined,
): tag is SystemValidTag | undefined {
  return tag === undefined || SYSTEM_VALID_TAGS.includes(tag as SystemValidTag);
}

/**
 * Resolve a system image reference to E2B template name
 *
 * Conversion rules:
 * - @vm0/claude-code → vm0-claude-code
 * - @vm0/claude-code:latest → vm0-claude-code
 * - @vm0/claude-code:dev → vm0-claude-code-dev
 *
 * @throws Error if image name is unknown or tag is not supported
 */
export function resolveSystemImageToE2b(
  name: string,
  tag?: string,
): { e2bTemplate: string; deprecationWarning?: string } {
  // Only claude-code is supported
  if (name !== SYSTEM_IMAGE_CLAUDE_CODE) {
    throw new Error(
      `Unknown system image: @${SYSTEM_SCOPE_SLUG}/${name}. Available: @${SYSTEM_SCOPE_SLUG}/${SYSTEM_IMAGE_CLAUDE_CODE}`,
    );
  }

  // Validate tag
  if (!isValidSystemTag(tag)) {
    throw new Error(
      `Invalid tag ":${tag}" for system image. System images only support: :latest, :dev (hash versions not supported)`,
    );
  }

  // Convert to E2B template name
  if (tag === "dev") {
    return { e2bTemplate: `${SYSTEM_SCOPE_SLUG}-${name}-dev` };
  }

  // Default (undefined or 'latest') → vm0-claude-code
  return { e2bTemplate: `${SYSTEM_SCOPE_SLUG}-${name}` };
}

/**
 * Get deprecation warning for legacy system template format
 */
export function getLegacySystemTemplateWarning(
  legacyFormat: string,
): string | undefined {
  if (!isLegacySystemTemplate(legacyFormat)) {
    return undefined;
  }

  // Map legacy format to new format
  if (legacyFormat === "vm0-claude-code") {
    return `Warning: "${legacyFormat}" format is deprecated. Use "@vm0/claude-code" instead.`;
  }
  if (legacyFormat === "vm0-claude-code-dev") {
    return `Warning: "${legacyFormat}" format is deprecated. Use "@vm0/claude-code:dev" instead.`;
  }
  if (legacyFormat.startsWith("vm0-github-cli")) {
    return `Warning: "${legacyFormat}" is deprecated and will be removed. No replacement available.`;
  }

  // Generic warning for other vm0-* formats
  return `Warning: "${legacyFormat}" format is deprecated.`;
}

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
 * Versioned image reference with optional tag
 */
export interface VersionedImageReference {
  scope?: string;
  name: string;
  tag?: string; // 'latest' or version ID (e.g., 'a1b2c3d4')
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
      scope: scope.toLowerCase(),
      name: name.toLowerCase(),
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
    name: input.toLowerCase(),
    isLegacy: false,
  };
}

/**
 * Parse image reference with optional tag
 *
 * Supports these formats:
 *   @scope/name         → { scope, name, tag: undefined }
 *   @scope/name:latest  → { scope, name, tag: 'latest' }
 *   @scope/name:a1b2    → { scope, name, tag: 'a1b2' }
 *   name                → { name, tag: undefined } (implicit scope)
 *   name:tag            → { name, tag } (implicit scope with tag)
 *   vm0-*               → { name, isLegacy: true } (legacy system template)
 *
 * @param input - The image reference string
 * @param userScopeSlug - The user's default scope slug (required for implicit references)
 * @returns Versioned reference with scope, name, tag, and legacy flag
 * @throws Error if implicit reference without userScopeSlug
 */
export function parseImageReferenceWithTag(
  input: string,
  userScopeSlug?: string,
): VersionedImageReference {
  // 1. Legacy vm0-* format: passthrough directly (no tag support)
  if (isLegacySystemTemplate(input)) {
    return {
      name: input,
      isLegacy: true,
    };
  }

  // 2. Explicit @scope/name format (potentially with tag)
  if (input.startsWith("@")) {
    // Find the colon for tag, but only after the slash
    const slashIndex = input.indexOf("/");
    if (slashIndex === -1) {
      throw new Error(
        `Invalid scoped reference: missing / separator (got "${input}")`,
      );
    }

    const afterSlash = input.slice(slashIndex + 1);
    const colonIndex = afterSlash.indexOf(":");

    let name: string;
    let tag: string | undefined;

    if (colonIndex !== -1) {
      name = afterSlash.slice(0, colonIndex);
      tag = afterSlash.slice(colonIndex + 1);
      if (!tag) {
        throw new Error(`Invalid tag: empty tag after colon (got "${input}")`);
      }
    } else {
      name = afterSlash;
    }

    const scope = input.slice(1, slashIndex);
    if (!scope) {
      throw new Error(`Invalid scoped reference: empty scope (got "${input}")`);
    }
    if (!name) {
      throw new Error(`Invalid scoped reference: empty name (got "${input}")`);
    }

    return {
      scope: scope.toLowerCase(),
      name: name.toLowerCase(),
      tag,
      isLegacy: false,
    };
  }

  // 3. Implicit format (potentially with tag)
  if (!userScopeSlug) {
    throw new Error(
      "Please set up your scope first with: vm0 scope set <slug>",
    );
  }

  const colonIndex = input.indexOf(":");
  let name: string;
  let tag: string | undefined;

  if (colonIndex !== -1) {
    name = input.slice(0, colonIndex);
    tag = input.slice(colonIndex + 1);
    if (!tag) {
      throw new Error(`Invalid tag: empty tag after colon (got "${input}")`);
    }
  } else {
    name = input;
  }

  if (!name) {
    throw new Error(`Invalid image reference: empty name (got "${input}")`);
  }

  return {
    scope: userScopeSlug,
    name: name.toLowerCase(),
    tag,
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
