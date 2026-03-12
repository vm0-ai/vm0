/**
 * System Image Resolution
 *
 * Handles resolution of system image references to E2B template names:
 * - vm0/claude-code → vm0-claude-code
 * - vm0-* → legacy passthrough (deprecated)
 */

/**
 * System image constants
 */
export const SYSTEM_IMAGE_CLAUDE_CODE = "claude-code";
export const SYSTEM_IMAGE_CODEX = "codex";
export const SYSTEM_IMAGES = [
  SYSTEM_IMAGE_CLAUDE_CODE,
  SYSTEM_IMAGE_CODEX,
] as const;
export const SYSTEM_VALID_TAGS = ["latest"] as const;

export type SystemValidTag = (typeof SYSTEM_VALID_TAGS)[number];

/**
 * Legacy image aliases that map to base templates.
 * These existed when the `apps` field selected separate image variants.
 * Now that gh CLI is included in the base images, these aliases ensure
 * backward compatibility for already-stored compose versions.
 */
type SystemImage = (typeof SYSTEM_IMAGES)[number];

const IMAGE_ALIASES: Record<string, SystemImage> = {
  "claude-code-github": "claude-code",
  "codex-github": "codex",
};

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
 * - vm0/claude-code → vm0-claude-code
 * - vm0/claude-code:latest → vm0-claude-code
 * - vm0/codex → vm0-codex
 * - vm0/codex:latest → vm0-codex
 * - vm0/claude-code-github → vm0-claude-code (legacy alias)
 * - vm0/codex-github → vm0-codex (legacy alias)
 *
 * Note: :dev tag is no longer supported. Development and production use the
 * same template names but different E2B accounts (controlled by E2B_API_KEY).
 *
 * @throws Error if image name is unknown or tag is not supported
 */
export function resolveSystemImageToE2b(
  name: string,
  tag?: string,
): { e2bTemplate: string; deprecationWarning?: string } {
  // TODO: "vm0" is hardcoded as the system org slug. This should be configurable.
  const systemOrgSlug = "vm0";

  // Resolve legacy aliases (e.g., claude-code-github → claude-code)
  const resolvedName = IMAGE_ALIASES[name] ?? name;

  // Validate system image name
  if (!SYSTEM_IMAGES.includes(resolvedName as (typeof SYSTEM_IMAGES)[number])) {
    throw new Error(
      `Unknown system image: ${systemOrgSlug}/${name}. Available: ${SYSTEM_IMAGES.map((img) => `${systemOrgSlug}/${img}`).join(", ")}`,
    );
  }

  // Validate tag (only 'latest' or undefined allowed)
  if (!isValidSystemTag(tag)) {
    throw new Error(
      `Invalid tag ":${tag}" for system image. System images only support: :latest`,
    );
  }

  // Convert to E2B template name: vm0-{resolvedName}
  return { e2bTemplate: `${systemOrgSlug}-${resolvedName}` };
}

/**
 * Check if an image reference is a legacy vm0-* system template
 */
export function isLegacySystemTemplate(reference: string): boolean {
  return reference.startsWith("vm0-");
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
    return `Warning: "${legacyFormat}" format is deprecated. Use "vm0/claude-code" instead.`;
  }
  if (legacyFormat === "vm0-codex") {
    return `Warning: "${legacyFormat}" format is deprecated. Use "vm0/codex" instead.`;
  }
  if (legacyFormat.startsWith("vm0-github-cli")) {
    return `Warning: "${legacyFormat}" is deprecated. GitHub CLI is now included in the base image.`;
  }

  // Generic warning for other vm0-* formats
  return `Warning: "${legacyFormat}" format is deprecated.`;
}
