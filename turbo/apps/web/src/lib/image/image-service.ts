import { eq, and, desc } from "drizzle-orm";

import { images } from "../../db/schema/image";
import { BadRequestError, NotFoundError, ForbiddenError } from "../errors";
import type { ImageStatusEnum } from "../../db/schema/image";

// Note: E2B SDK is imported dynamically in functions that need it
// to avoid loading the heavy SDK in routes that only use validation functions

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
  return alias.startsWith("vm0-");
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
  // Dynamic import to avoid loading E2B SDK in routes that don't need it
  const { Template } = await import("e2b");

  const e2bAlias = generateE2bAlias(userId, alias);

  // Create template from Dockerfile content
  const template = Template().fromDockerfile(dockerfile);

  // Start background build
  const buildInfo = await Template.buildInBackground(template, {
    alias: e2bAlias,
  });

  // Insert record into database
  const [image] = await globalThis.services.db
    .insert(images)
    .values({
      userId,
      alias,
      e2bAlias,
      e2bTemplateId: buildInfo.templateId,
      e2bBuildId: buildInfo.buildId,
      status: "building" as ImageStatusEnum,
    })
    .onConflictDoUpdate({
      target: [images.userId, images.alias],
      set: {
        e2bAlias,
        e2bTemplateId: buildInfo.templateId,
        e2bBuildId: buildInfo.buildId,
        status: "building" as ImageStatusEnum,
        errorMessage: null,
        updatedAt: new Date(),
      },
    })
    .returning();

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
  // Dynamic import to avoid loading E2B SDK in routes that don't need it
  const { Template } = await import("e2b");

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
 * - System templates (vm0-*): return as-is
 * - User templates: lookup in DB and return e2bAlias
 * @throws NotFoundError if user image not found
 * @throws BadRequestError if user image is not ready
 */
export async function resolveImageAlias(
  userId: string,
  alias: string,
): Promise<{ templateName: string; isUserImage: boolean }> {
  // System templates bypass DB lookup
  if (isSystemTemplate(alias)) {
    return { templateName: alias, isUserImage: false };
  }

  // User template - must exist in DB
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
 * Note: This only deletes from our database. E2B templates remain and will
 * be garbage collected by E2B based on their retention policy.
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

  // Delete from database
  // Note: E2B template cleanup is handled by E2B's retention policy
  await globalThis.services.db.delete(images).where(eq(images.id, imageId));
}
