import { eq, and, desc } from "drizzle-orm";
import { ApiClient, ConnectionConfig, Template, BuildError } from "e2b";
import { nanoid } from "nanoid";

import { images } from "../../db/schema/image";
import { scopes } from "../../db/schema/scope";
import { BadRequestError, NotFoundError, ForbiddenError } from "../errors";
import { logger } from "../logger";
import { getUserScopeByClerkId } from "../scope/scope-service";
import type { ImageStatusEnum } from "../../db/schema/image";
import {
  parseImageReferenceWithTag,
  generateScopedE2bAlias,
} from "@vm0/core";

const log = logger("service:image");

/**
 * Check if an image alias is a legacy system template (starts with vm0-)
 */
function isLegacySystemTemplate(reference: string): boolean {
  return reference.startsWith("vm0-");
}

/**
 * Generate E2B alias from userId and user-specified alias
 * Format: user-{userId}-{alias}
 */
export function generateE2bAlias(userId: string, alias: string): string {
  return `user-${userId}-${alias}`;
}

/**
 * Check if an image alias is a system template (starts with vm0-)
 */
export function isSystemTemplate(alias: string): boolean {
  return isLegacySystemTemplate(alias);
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
 * Get a specific version of an image by scope ID, alias, and version ID
 */
export async function getImageByScopeAliasAndVersion(
  scopeId: string,
  alias: string,
  versionId: string,
) {
  const result = await globalThis.services.db
    .select()
    .from(images)
    .where(
      and(
        eq(images.scopeId, scopeId),
        eq(images.alias, alias),
        eq(images.versionId, versionId),
      ),
    )
    .limit(1);
  return result[0] ?? null;
}

/**
 * List all versions of an image by scope ID and alias
 * Orders by createdAt DESC (newest first)
 */
export async function listImageVersions(scopeId: string, alias: string) {
  const result = await globalThis.services.db
    .select({
      id: images.id,
      alias: images.alias,
      versionId: images.versionId,
      status: images.status,
      errorMessage: images.errorMessage,
      createdAt: images.createdAt,
      updatedAt: images.updatedAt,
    })
    .from(images)
    .where(and(eq(images.scopeId, scopeId), eq(images.alias, alias)))
    .orderBy(desc(images.createdAt));
  return result;
}

/**
 * Try to delete an E2B template by its alias
 * This is needed when database record doesn't exist but E2B template might
 * E2B API accepts alias as templateID parameter (same as buildInBackground)
 */
export async function tryDeleteE2bTemplateByAlias(
  e2bAlias: string,
): Promise<void> {
  const config = new ConnectionConfig({});
  const client = new ApiClient(config);

  log.debug("attempting to delete E2B template", { e2bAlias });

  try {
    // E2B API accepts alias as templateID - same as how buildInBackground uses alias
    await client.api.DELETE("/templates/{templateID}", {
      params: { path: { templateID: e2bAlias } },
    });
    log.debug("E2B template deleted successfully", { e2bAlias });
  } catch (error) {
    // Template may not exist - this is expected when --delete-existing is used
    // and the image has never been built before
    log.debug("E2B template deletion skipped (may not exist)", {
      e2bAlias,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface BuildResult {
  imageId: string;
  buildId: string;
  alias: string;
  versionId: string;
  e2bAlias: string;
}

/**
 * Start building an image from a Dockerfile
 * Uses E2B's Template.buildInBackground for async building
 * Each build creates a new version with a unique versionId
 */
export async function buildImage(
  userId: string,
  dockerfile: string,
  alias: string,
): Promise<BuildResult> {
  // Get user's scope - required for versioned builds
  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    throw new BadRequestError(
      "Please set up your scope first with: vm0 scope set <slug>",
    );
  }

  // Generate fresh version ID for each build
  const versionId = nanoid(8);

  // Generate versioned E2B alias: scope-{scopeId}-image-{name}-version-{versionId}
  const e2bAlias = generateScopedE2bAlias(userScope.id, alias, versionId);

  log.debug("starting image build", {
    userId,
    alias,
    versionId,
    e2bAlias,
    scopeId: userScope.id,
  });

  // Create template from Dockerfile content
  const template = Template().fromDockerfile(dockerfile);

  // Start background build
  let buildInfo;
  try {
    buildInfo = await Template.buildInBackground(template, {
      alias: e2bAlias,
    });
  } catch (error) {
    // Convert E2B BuildError to BadRequestError so it's returned to user
    if (error instanceof BuildError) {
      const message = error.message;
      log.debug("E2B build error", { alias, versionId, e2bAlias, message });
      throw new BadRequestError(message);
    }
    throw error;
  }

  log.debug("E2B build started", {
    alias,
    versionId,
    e2bAlias,
    buildId: buildInfo.buildId,
    templateId: buildInfo.templateId,
  });

  // Insert new version record (each build = new record)
  const [image] = await globalThis.services.db
    .insert(images)
    .values({
      userId,
      scopeId: userScope.id,
      alias,
      versionId,
      e2bAlias,
      e2bTemplateId: buildInfo.templateId,
      e2bBuildId: buildInfo.buildId,
      status: "building" as ImageStatusEnum,
    })
    .returning();

  log.debug("image version record created", {
    imageId: image!.id,
    alias,
    versionId,
  });

  return {
    imageId: image!.id,
    buildId: buildInfo.buildId,
    alias,
    versionId,
    e2bAlias,
  };
}

interface BuildStatusResult {
  status: ImageStatusEnum;
  logs: string[];
  logsOffset: number;
  error?: string;
}

/**
 * Get the build status from E2B and update database if status changed
 */
export async function getBuildStatus(
  buildId: string,
  templateId: string,
  logsOffset = 0,
): Promise<BuildStatusResult> {
  // Query E2B for build status
  const e2bStatus = await Template.getBuildStatus(
    { buildId, templateId },
    { logsOffset },
  );

  // Map E2B status to our status enum
  const status: ImageStatusEnum = e2bStatus.status as ImageStatusEnum;
  const logs = e2bStatus.logEntries.map((entry) => entry.message);
  const newLogsOffset = logsOffset + logs.length;

  // Extract error message from logs if build failed
  // Usually the last few log entries contain the actual error
  let errorMessage: string | undefined;
  if (status === "error") {
    // Try to extract meaningful error from recent logs
    const errorLogs = logs.filter(
      (log) =>
        log.toLowerCase().includes("error") ||
        log.toLowerCase().includes("failed") ||
        log.toLowerCase().includes("fatal"),
    );
    errorMessage =
      errorLogs.length > 0
        ? errorLogs[errorLogs.length - 1]
        : logs[logs.length - 1] || "Build failed";
  }

  // Update database if build is complete (ready or error)
  if (status === "ready" || status === "error") {
    await globalThis.services.db
      .update(images)
      .set({
        status,
        errorMessage: errorMessage || null,
        updatedAt: new Date(),
      })
      .where(eq(images.e2bBuildId, buildId));
  }

  return {
    status,
    logs,
    logsOffset: newLogsOffset,
    error: errorMessage,
  };
}

/**
 * Get an image by user ID and alias
 */
export async function getImageByAlias(userId: string, alias: string) {
  const result = await globalThis.services.db
    .select()
    .from(images)
    .where(and(eq(images.userId, userId), eq(images.alias, alias)))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Get an image by build ID
 */
export async function getImageByBuildId(buildId: string) {
  const result = await globalThis.services.db
    .select()
    .from(images)
    .where(eq(images.e2bBuildId, buildId))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Resolve an image alias to E2B template name
 * Supports multiple formats with optional tag:
 * - Legacy vm0-* prefix: passthrough directly (system templates)
 * - @scope/name[:tag] format: explicit scope resolution with optional tag
 * - name[:tag]: implicit scope (user's scope) with optional tag
 *
 * Tag resolution:
 * - No tag or :latest → most recently built ready version
 * - Specific tag (e.g., :a1b2c3d4) → exact version by versionId
 *
 * @throws NotFoundError if user image not found
 * @throws BadRequestError if user image is not ready
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

  // 2. Resolve scope
  const scope = ref.scope
    ? await getScopeBySlug(ref.scope)
    : userScope;

  if (!scope) {
    throw new NotFoundError(`Scope "@${ref.scope}" not found`);
  }

  // 3. Resolve version based on tag
  let image;
  const refDisplay = ref.scope ? `@${ref.scope}/${ref.name}` : ref.name;

  if (!ref.tag || ref.tag === "latest") {
    // Resolve :latest or no tag to most recent ready version
    image = await getLatestImage(scope.id, ref.name);
    if (!image) {
      throw new NotFoundError(
        `Image "${refDisplay}" not found. Build it first with: vm0 image build`,
      );
    }
  } else {
    // Resolve specific version by tag (versionId)
    image = await getImageByScopeAliasAndVersion(scope.id, ref.name, ref.tag);
    if (!image) {
      throw new NotFoundError(
        `Image "${refDisplay}:${ref.tag}" not found. Check available versions with: vm0 image versions ${ref.name}`,
      );
    }

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
 */
export async function validateImageAccess(
  userId: string,
  imageAlias: string,
): Promise<{ error: string; status: number } | null> {
  // System templates are always allowed
  if (isSystemTemplate(imageAlias)) {
    return null;
  }

  // Check if image exists for this user
  // Each user has their own namespace of images, so we query by userId + alias
  const existingImage = await globalThis.services.db
    .select()
    .from(images)
    .where(and(eq(images.userId, userId), eq(images.alias, imageAlias)))
    .limit(1);

  if (existingImage.length === 0) {
    return { error: `Image "${imageAlias}" not found`, status: 404 };
  }

  const image = existingImage[0]!;

  // Check if image is ready
  if (image.status !== "ready") {
    return {
      error: `Image "${imageAlias}" is not ready (status: ${image.status})`,
      status: 400,
    };
  }

  return null;
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

/**
 * List all images (all versions) for a user
 * Orders by createdAt DESC (newest first)
 */
export async function listImages(userId: string) {
  const result = await globalThis.services.db
    .select({
      id: images.id,
      alias: images.alias,
      versionId: images.versionId,
      status: images.status,
      errorMessage: images.errorMessage,
      createdAt: images.createdAt,
      updatedAt: images.updatedAt,
    })
    .from(images)
    .where(eq(images.userId, userId))
    .orderBy(desc(images.createdAt));

  return result;
}

/**
 * Get an image by ID
 */
export async function getImageById(imageId: string) {
  const result = await globalThis.services.db
    .select()
    .from(images)
    .where(eq(images.id, imageId))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Delete an image by ID
 * Deletes from both our database and E2B
 */
export async function deleteImage(
  userId: string,
  imageId: string,
): Promise<void> {
  // Get image to verify ownership
  const image = await getImageById(imageId);

  if (!image) {
    throw new NotFoundError(`Image not found: ${imageId}`);
  }

  if (image.userId !== userId) {
    throw new ForbiddenError("You don't have access to this image");
  }

  log.debug("deleting image", { imageId, alias: image.alias, userId });

  // Delete from E2B
  if (image.e2bTemplateId) {
    const config = new ConnectionConfig({});
    const client = new ApiClient(config);

    try {
      await client.api.DELETE("/templates/{templateID}", {
        params: { path: { templateID: image.e2bTemplateId } },
      });
      log.debug("E2B template deleted", { templateId: image.e2bTemplateId });
    } catch (error) {
      // Template may already be deleted on E2B side
      log.debug("E2B template deletion failed (may already be deleted)", {
        templateId: image.e2bTemplateId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Delete from database
  await globalThis.services.db.delete(images).where(eq(images.id, imageId));
  log.debug("image deleted from database", { imageId });
}

/**
 * Delete an image by alias
 * Deletes from both our database and E2B
 */
export async function deleteImageByAlias(
  userId: string,
  alias: string,
): Promise<void> {
  const image = await getImageByAlias(userId, alias);

  if (!image) {
    throw new NotFoundError(`Image "${alias}" not found`);
  }

  await deleteImage(userId, image.id);
}
