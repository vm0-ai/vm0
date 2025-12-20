import { eq, and, desc } from "drizzle-orm";
import { ApiClient, ConnectionConfig, Template, BuildError } from "e2b";

import { images } from "../../db/schema/image";
import { scopes } from "../../db/schema/scope";
import { BadRequestError, NotFoundError, ForbiddenError } from "../errors";
import { logger } from "../logger";
import { getUserScopeByClerkId } from "../scope/scope-service";
import type { ImageStatusEnum } from "../../db/schema/image";

const log = logger("service:image");

/**
 * Check if an image alias is a legacy system template (starts with vm0-)
 */
function isLegacySystemTemplate(reference: string): boolean {
  return reference.startsWith("vm0-");
}

/**
 * Parse a scoped reference string (@scope/name format)
 */
function parseScopedReference(reference: string): {
  scope: string;
  name: string;
} {
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
 * Get image by scope ID and alias
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
  e2bAlias: string;
}

/**
 * Start building an image from a Dockerfile
 * Uses E2B's Template.buildInBackground for async building
 */
export async function buildImage(
  userId: string,
  dockerfile: string,
  alias: string,
): Promise<BuildResult> {
  const e2bAlias = generateE2bAlias(userId, alias);

  // Get user's scope if they have one (for @scope/name resolution)
  const userScope = await getUserScopeByClerkId(userId);
  const scopeId = userScope?.id ?? null;

  log.debug("starting image build", { userId, alias, e2bAlias, scopeId });

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
      log.debug("E2B build error", { alias, e2bAlias, message });
      // Provide helpful message for alias conflict (E2B buildInBackground bug)
      if (message.includes("403") && message.includes("already used")) {
        throw new BadRequestError(
          `Image "${alias}" already exists. Delete it first with: vm0 image delete ${alias}`,
        );
      }
      throw new BadRequestError(message);
    }
    throw error;
  }

  log.debug("E2B build started", {
    alias,
    e2bAlias,
    buildId: buildInfo.buildId,
    templateId: buildInfo.templateId,
  });

  // Insert record into database
  const [image] = await globalThis.services.db
    .insert(images)
    .values({
      userId,
      scopeId,
      alias,
      e2bAlias,
      e2bTemplateId: buildInfo.templateId,
      e2bBuildId: buildInfo.buildId,
      status: "building" as ImageStatusEnum,
    })
    .onConflictDoUpdate({
      target: [images.userId, images.alias],
      set: {
        scopeId,
        e2bAlias,
        e2bTemplateId: buildInfo.templateId,
        e2bBuildId: buildInfo.buildId,
        status: "building" as ImageStatusEnum,
        errorMessage: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  log.debug("image record created", { imageId: image!.id, alias });

  return {
    imageId: image!.id,
    buildId: buildInfo.buildId,
    alias,
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
 * Supports multiple formats:
 * - Legacy vm0-* prefix: passthrough directly (system templates)
 * - @scope/name format: explicit scope resolution
 * - Plain name: lookup by userId (legacy) or user's scope
 * @throws NotFoundError if user image not found
 * @throws BadRequestError if user image is not ready
 */
export async function resolveImageAlias(
  userId: string,
  alias: string,
): Promise<{ templateName: string; isUserImage: boolean }> {
  // 1. Legacy vm0-* system templates: passthrough directly
  if (isSystemTemplate(alias)) {
    return { templateName: alias, isUserImage: false };
  }

  // 2. Try to parse as scoped reference (@scope/name format)
  if (alias.startsWith("@")) {
    try {
      const parsed = parseScopedReference(alias);

      // Lookup scope by slug
      const scope = await getScopeBySlug(parsed.scope);
      if (!scope) {
        throw new NotFoundError(`Scope "@${parsed.scope}" not found`);
      }

      // Lookup image by scope and name
      const image = await getImageByScopeAndAlias(scope.id, parsed.name);
      if (!image) {
        throw new NotFoundError(
          `Image "@${parsed.scope}/${parsed.name}" not found`,
        );
      }

      if (image.status !== "ready") {
        throw new BadRequestError(
          `Image "@${parsed.scope}/${parsed.name}" is not ready (status: ${image.status})`,
        );
      }

      return { templateName: image.e2bAlias, isUserImage: true };
    } catch (error) {
      // If parsing fails, fall through to legacy lookup
      if (error instanceof NotFoundError || error instanceof BadRequestError) {
        throw error;
      }
      log.debug("Failed to parse scoped reference, falling back to legacy", {
        alias,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 3. Legacy lookup by userId (for backward compatibility)
  const image = await getImageByAlias(userId, alias);

  if (!image) {
    throw new NotFoundError(
      `Image "${alias}" not found. Build it first with: vm0 image build`,
    );
  }

  if (image.status !== "ready") {
    throw new BadRequestError(
      `Image "${alias}" is not ready (status: ${image.status}). Check build status with: vm0 image list`,
    );
  }

  return { templateName: image.e2bAlias, isUserImage: true };
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
 * List all images for a user
 */
export async function listImages(userId: string) {
  const result = await globalThis.services.db
    .select({
      id: images.id,
      alias: images.alias,
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
