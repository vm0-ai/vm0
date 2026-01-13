import { eq, and, desc, like } from "drizzle-orm";

import { images } from "../../db/schema/image";
import { scopes } from "../../db/schema/scope";
import { BadRequestError, NotFoundError, ForbiddenError } from "../errors";
import { getUserScopeByClerkId } from "../scope/scope-service";
import {
  parseImageReferenceWithTag,
  MIN_VERSION_PREFIX_LENGTH,
  isValidVersionPrefix,
  isSystemScope,
  resolveSystemImageToE2b,
} from "@vm0/core";

/**
 * Check if an image alias is a legacy system template (starts with vm0-)
 */
function isLegacySystemTemplate(reference: string): boolean {
  return reference.startsWith("vm0-");
}

/**
 * Check if an image alias is a system template
 * Supports both legacy (vm0-*) and new (vm0/...) formats
 */
export function isSystemTemplate(alias: string): boolean {
  // Legacy vm0-* format
  if (isLegacySystemTemplate(alias)) {
    return true;
  }
  // New vm0/... format (system scope)
  if (alias.startsWith("vm0/")) {
    return true;
  }
  return false;
}

/**
 * Get scope by slug
 */
async function getScopeBySlug(slug: string) {
  const result = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.slug, slug))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Get image by scope ID and alias (legacy - returns first match)
 * @deprecated Use getLatestImage or getImageByScopeAliasAndVersion instead
 */
export async function getImageByScopeAndAlias(scopeId: string, alias: string) {
  const result = await globalThis.services.db
    .select()
    .from(images)
    .where(and(eq(images.scopeId, scopeId), eq(images.alias, alias)))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Get the latest ready version of an image by scope ID and alias
 * Orders by createdAt DESC to get the most recently built version
 */
export async function getLatestImage(scopeId: string, alias: string) {
  const result = await globalThis.services.db
    .select()
    .from(images)
    .where(
      and(
        eq(images.scopeId, scopeId),
        eq(images.alias, alias),
        eq(images.status, "ready"),
      ),
    )
    .orderBy(desc(images.createdAt))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Image version resolution result
 */
export type ImageVersionResolutionResult =
  | { image: typeof images.$inferSelect }
  | { error: string; status: number };

/**
 * Get a specific version of an image by scope ID, alias, and version ID or prefix
 * Supports both exact match and prefix matching (minimum 8 characters)
 */
export async function getImageByScopeAliasAndVersion(
  scopeId: string,
  alias: string,
  versionIdOrPrefix: string,
): Promise<ImageVersionResolutionResult> {
  // First, try exact match
  const [exactMatch] = await globalThis.services.db
    .select()
    .from(images)
    .where(
      and(
        eq(images.scopeId, scopeId),
        eq(images.alias, alias),
        eq(images.versionId, versionIdOrPrefix),
      ),
    )
    .limit(1);

  if (exactMatch) {
    return { image: exactMatch };
  }

  // If not exact match, try prefix match
  if (!isValidVersionPrefix(versionIdOrPrefix)) {
    if (versionIdOrPrefix.length < MIN_VERSION_PREFIX_LENGTH) {
      return {
        error: `Version prefix too short. Minimum ${MIN_VERSION_PREFIX_LENGTH} characters required.`,
        status: 400,
      };
    }
    return {
      error: `Version "${versionIdOrPrefix}" not found`,
      status: 404,
    };
  }

  // Search by prefix using LIKE
  const prefixMatches = await globalThis.services.db
    .select()
    .from(images)
    .where(
      and(
        eq(images.scopeId, scopeId),
        eq(images.alias, alias),
        like(images.versionId, `${versionIdOrPrefix.toLowerCase()}%`),
      ),
    )
    .limit(2); // Only need to know if there's more than one

  if (prefixMatches.length === 0) {
    return {
      error: `Version "${versionIdOrPrefix}" not found`,
      status: 404,
    };
  }

  if (prefixMatches.length > 1) {
    return {
      error: `Ambiguous version prefix "${versionIdOrPrefix}". Please use more characters.`,
      status: 400,
    };
  }

  const matchedImage = prefixMatches[0];
  if (!matchedImage) {
    return {
      error: `Version "${versionIdOrPrefix}" not found`,
      status: 404,
    };
  }

  return { image: matchedImage };
}

/**
 * Check if a resolution result is an error
 */
export function isImageResolutionError(
  result: ImageVersionResolutionResult,
): result is { error: string; status: number } {
  return "error" in result;
}

/**
 * Resolve an image alias to E2B template name
 * Supports multiple formats with optional tag:
 * - Legacy vm0-* prefix: passthrough directly (system templates, deprecated)
 * - vm0/name[:tag] format: system scope with special handling
 * - scope/name[:tag] format: explicit scope resolution with optional tag
 * - name[:tag]: implicit scope (user's scope) with optional tag
 *
 * Tag resolution:
 * - No tag or :latest → most recently built ready version
 * - Specific tag (e.g., :a1b2c3d4) → exact version by versionId
 * - For system scope: only :latest and :dev are supported
 *
 * @throws NotFoundError if user image not found
 * @throws BadRequestError if user image is not ready or invalid system tag
 */
export async function resolveImageAlias(
  userId: string,
  alias: string,
): Promise<{ templateName: string; isUserImage: boolean; versionId?: string }> {
  // Get user's scope for implicit references
  const userScope = await getUserScopeByClerkId(userId);
  const userScopeSlug = userScope?.slug;

  // Parse reference with tag support
  const ref = parseImageReferenceWithTag(alias, userScopeSlug);

  // 1. Legacy vm0-* system templates: passthrough directly
  if (ref.isLegacy) {
    return { templateName: ref.name, isUserImage: false };
  }

  // 2. System scope (vm0/...) - special handling
  if (ref.scope && isSystemScope(ref.scope)) {
    try {
      const { e2bTemplate } = resolveSystemImageToE2b(ref.name, ref.tag);
      return { templateName: e2bTemplate, isUserImage: false };
    } catch (error) {
      if (error instanceof Error) {
        throw new BadRequestError(error.message);
      }
      throw error;
    }
  }

  // 3. Resolve user scope
  const scope = ref.scope ? await getScopeBySlug(ref.scope) : userScope;

  if (!scope) {
    throw new NotFoundError(`Scope "${ref.scope}" not found`);
  }

  // 4. Resolve version based on tag
  let image;
  const refDisplay = ref.scope ? `${ref.scope}/${ref.name}` : ref.name;

  if (!ref.tag || ref.tag === "latest") {
    // Resolve :latest or no tag to most recent ready version
    image = await getLatestImage(scope.id, ref.name);
    if (!image) {
      throw new NotFoundError(
        `Image "${refDisplay}" not found. Custom image building has been removed. Use 'apps' field in vm0.yaml instead.`,
      );
    }
  } else {
    // Resolve specific version by tag (versionId or prefix)
    const result = await getImageByScopeAliasAndVersion(
      scope.id,
      ref.name,
      ref.tag,
    );
    if (isImageResolutionError(result)) {
      if (result.status === 400) {
        throw new BadRequestError(result.error);
      }
      throw new NotFoundError(`Image "${refDisplay}:${ref.tag}" not found.`);
    }
    image = result.image;

    if (image.status !== "ready") {
      throw new BadRequestError(
        `Image "${refDisplay}:${ref.tag}" is not ready (status: ${image.status})`,
      );
    }
  }

  return {
    templateName: image.e2bAlias,
    isUserImage: true,
    versionId: image.versionId ?? undefined,
  };
}

/**
 * Validate that a user has access to an image
 * Returns null if access is granted, or an error message if denied
 *
 * Supports all image reference formats:
 * - Plain alias: "my-image"
 * - Scoped reference: "scope/my-image"
 * - Version tags: "my-image:latest", "my-image:abc123", "scope/my-image:v1"
 */
export async function validateImageAccess(
  userId: string,
  imageAlias: string,
): Promise<{ error: string; status: number } | null> {
  // System templates (vm0-* prefix) are always allowed
  if (isSystemTemplate(imageAlias)) {
    return null;
  }

  try {
    // Use the same resolution logic as runtime - handles scope/name:tag format
    await resolveImageAlias(userId, imageAlias);
    return null;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { error: error.message, status: 404 };
    }
    if (error instanceof BadRequestError) {
      return { error: error.message, status: 400 };
    }
    throw error;
  }
}

/**
 * Validate image access and throw appropriate error if denied
 * Helper function to reduce duplicate error handling code
 */
export async function assertImageAccess(
  userId: string,
  imageAlias: string,
): Promise<void> {
  const error = await validateImageAccess(userId, imageAlias);
  if (error) {
    if (error.status === 404) {
      throw new NotFoundError(error.error);
    } else if (error.status === 403) {
      throw new ForbiddenError(error.error);
    } else {
      throw new BadRequestError(error.error);
    }
  }
}
