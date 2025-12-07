import { eq, and, desc } from "drizzle-orm";

import { images } from "../../db/schema/image";
import { BadRequestError, NotFoundError, ForbiddenError } from "../errors";
import type { ImageStatusEnum } from "../../db/schema/image";

// NOTE: E2B SDK is NOT imported at all - all functions return mock data
// This is for CI debugging to isolate the issue

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
 * MOCKED: Returns fake data without calling E2B SDK
 */
export async function buildImage(
  userId: string,
  _dockerfile: string,
  alias: string,
): Promise<BuildResult> {
  const e2bAlias = generateE2bAlias(userId, alias);

  // MOCKED: Generate fake build info
  const mockBuildId = `mock-build-${Date.now()}`;
  const mockTemplateId = `mock-template-${Date.now()}`;

  // Insert record into database
  const [image] = await globalThis.services.db
    .insert(images)
    .values({
      userId,
      alias,
      e2bAlias,
      e2bTemplateId: mockTemplateId,
      e2bBuildId: mockBuildId,
      status: "building" as ImageStatusEnum,
    })
    .onConflictDoUpdate({
      target: [images.userId, images.alias],
      set: {
        e2bAlias,
        e2bTemplateId: mockTemplateId,
        e2bBuildId: mockBuildId,
        status: "building" as ImageStatusEnum,
        errorMessage: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return {
    imageId: image!.id,
    buildId: mockBuildId,
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
 * MOCKED: Returns fake "ready" status
 */
export async function getBuildStatus(
  buildId: string,
  _templateId: string,
  logsOffset = 0,
): Promise<BuildStatusResult> {
  // MOCKED: Always return ready status
  const status: ImageStatusEnum = "ready";
  const logs = ["[MOCK] Build completed successfully"];
  const newLogsOffset = logsOffset + logs.length;

  // Update database to mark as ready
  await globalThis.services.db
    .update(images)
    .set({
      status,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(images.e2bBuildId, buildId));

  return {
    status,
    logs,
    logsOffset: newLogsOffset,
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
 */
export async function resolveImageAlias(
  userId: string,
  alias: string,
): Promise<{ templateName: string; isUserImage: boolean } | null> {
  // System templates bypass DB lookup
  if (isSystemTemplate(alias)) {
    return { templateName: alias, isUserImage: false };
  }

  // User template - must exist in DB
  const image = await getImageByAlias(userId, alias);

  if (!image) {
    return null;
  }

  if (image.status !== "ready") {
    return null;
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
 */
export async function deleteImage(
  userId: string,
  imageId: string,
): Promise<void> {
  const image = await getImageById(imageId);

  if (!image) {
    throw new NotFoundError(`Image not found: ${imageId}`);
  }

  if (image.userId !== userId) {
    throw new ForbiddenError("You don't have access to this image");
  }

  await globalThis.services.db.delete(images).where(eq(images.id, imageId));
}
