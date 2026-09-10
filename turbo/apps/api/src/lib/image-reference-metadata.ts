import type { ImageReferenceContentType } from "@okouai/api-contracts/contracts/image-references";
import { imageDimensionsFromData } from "image-dimensions";

interface ImageMetadata {
  readonly contentType: ImageReferenceContentType;
  readonly width: number;
  readonly height: number;
}

function contentTypeForImageFormat(
  format: string,
): ImageReferenceContentType | null {
  switch (format) {
    case "jpeg": {
      // image-dimensions reports both .jpg and .jpeg files as "jpeg".
      return "image/jpeg";
    }
    case "png": {
      return "image/png";
    }
    case "webp": {
      return "image/webp";
    }
    default: {
      return null;
    }
  }
}

/** Read the actual image format and dimensions from the stored bytes. */
export function parseImageReferenceMetadata(
  buffer: Buffer,
): ImageMetadata | null {
  const metadata = imageDimensionsFromData(buffer);
  if (!metadata) {
    return null;
  }
  const contentType = contentTypeForImageFormat(metadata.type);
  return contentType
    ? { contentType, width: metadata.width, height: metadata.height }
    : null;
}
