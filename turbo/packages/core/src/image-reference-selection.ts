/** How a saved reference image is named in the Illustration selection slot. */
const USER_IMAGE_REFERENCE_ID_PREFIX = "user-image-reference:";

/** The canonical UUID form used by image_references row ids. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type UserImageReferenceSelectionId = `user-image-reference:${string}`;

export function formatUserImageReferenceId(
  referenceId: string,
): UserImageReferenceSelectionId {
  return `${USER_IMAGE_REFERENCE_ID_PREFIX}${referenceId}`;
}

/**
 * Read the row id out of a saved-reference selection.
 *
 * Syntax only: existence and access are resolved against the image-reference
 * authority immediately before each message or run dispatch.
 */
export function parseUserImageReferenceId(
  selectionId: string,
): string | undefined {
  if (!isUserImageReferenceId(selectionId)) {
    return undefined;
  }
  const referenceId = selectionId.slice(USER_IMAGE_REFERENCE_ID_PREFIX.length);
  return UUID_PATTERN.test(referenceId) ? referenceId : undefined;
}

/** Distinguish malformed saved-reference ids from built-in style ids. */
export function isUserImageReferenceId(selectionId: string): boolean {
  return selectionId.startsWith(USER_IMAGE_REFERENCE_ID_PREFIX);
}
