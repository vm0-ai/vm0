import {
  IMAGE_REFERENCE_CONTENT_TYPES,
  MAX_IMAGE_REFERENCE_DIMENSION,
  MAX_IMAGE_REFERENCE_PIXELS,
  MAX_IMAGE_REFERENCE_SOURCE_BYTES,
} from "@okouai/api-contracts/contracts/image-references";

import { createDeferredPromise, withCleanup } from "../utils.ts";

const IMAGE_REFERENCE_MAX_FILE_SIZE = MAX_IMAGE_REFERENCE_SOURCE_BYTES;
export const IMAGE_REFERENCE_ACCEPT =
  ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";

export type ReferenceImageQuarterTurns = 0 | 1 | 2 | 3;

export interface ReferenceImageCrop {
  /** A value from 1 (no crop) through 3. */
  readonly zoom: number;
  /** Horizontal focal point as a percentage from 0 through 100. */
  readonly x: number;
  /** Vertical focal point as a percentage from 0 through 100. */
  readonly y: number;
}

export interface CanonicalReferenceImage {
  readonly file: File;
  readonly width: number;
  readonly height: number;
}

interface DecodedReferenceImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  release(): void;
}

interface CropRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function normalizedPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function normalizedZoom(value: number): number {
  return Math.max(1, Math.min(3, value));
}

export function referenceImageTitleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.(?:jpe?g|png|webp)$/iu, "");
  const normalized = withoutExtension.replace(/[_-]+/gu, " ").trim();
  return (normalized || filename.trim() || "Reference image").slice(0, 80);
}

export function validateReferenceImageFile(
  file: File,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "format" | "size" } {
  if (
    !IMAGE_REFERENCE_CONTENT_TYPES.some((contentType) => {
      return contentType === file.type.toLowerCase();
    })
  ) {
    return { ok: false, reason: "format" };
  }
  if (file.size > IMAGE_REFERENCE_MAX_FILE_SIZE) {
    return { ok: false, reason: "size" };
  }
  return { ok: true };
}

function loadHtmlReferenceImage(
  file: File,
  signal: AbortSignal,
): Promise<DecodedReferenceImage> {
  signal.throwIfAborted();
  const sourceUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";

  const loaded = createDeferredPromise<DecodedReferenceImage>(signal);
  const onLoad = (): void => {
    if (!loaded.settled()) {
      loaded.resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release() {},
      });
    }
  };
  const onError = (): void => {
    if (!loaded.settled()) {
      loaded.reject(
        new Error("The selected file could not be decoded as an image."),
      );
    }
  };
  const cleanup = (): void => {
    image.removeEventListener("load", onLoad);
    image.removeEventListener("error", onError);
    URL.revokeObjectURL(sourceUrl);
  };

  image.addEventListener("load", onLoad, { once: true });
  image.addEventListener("error", onError, { once: true });
  image.src = sourceUrl;
  return withCleanup(loaded.promise, cleanup);
}

async function decodeReferenceImage(
  file: File,
  signal: AbortSignal,
): Promise<DecodedReferenceImage> {
  signal.throwIfAborted();
  if (typeof createImageBitmap !== "function") {
    return await loadHtmlReferenceImage(file, signal);
  }

  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  signal.throwIfAborted();
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    release() {
      bitmap.close();
    },
  };
}

function canvas2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas image processing is unavailable in this browser.");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return context;
}

function renderRotatedImage(
  decoded: DecodedReferenceImage,
  quarterTurns: ReferenceImageQuarterTurns,
): HTMLCanvasElement {
  const rotated = quarterTurns % 2 === 1;
  const canvas = document.createElement("canvas");
  canvas.width = rotated ? decoded.height : decoded.width;
  canvas.height = rotated ? decoded.width : decoded.height;
  const context = canvas2d(canvas);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((quarterTurns * Math.PI) / 2);
  context.drawImage(
    decoded.source,
    -decoded.width / 2,
    -decoded.height / 2,
    decoded.width,
    decoded.height,
  );
  return canvas;
}

function cropRectangle(
  width: number,
  height: number,
  crop: ReferenceImageCrop,
): CropRectangle {
  const zoom = normalizedZoom(crop.zoom);
  const cropWidth = Math.max(1, Math.round(width / zoom));
  const cropHeight = Math.max(1, Math.round(height / zoom));
  const maxX = Math.max(0, width - cropWidth);
  const maxY = Math.max(0, height - cropHeight);
  return {
    x: Math.round((normalizedPercentage(crop.x) / 100) * maxX),
    y: Math.round((normalizedPercentage(crop.y) / 100) * maxY),
    width: cropWidth,
    height: cropHeight,
  };
}

function renderCroppedImage(
  source: HTMLCanvasElement,
  crop: ReferenceImageCrop,
): HTMLCanvasElement {
  const rectangle = cropRectangle(source.width, source.height, crop);
  const canvas = document.createElement("canvas");
  canvas.width = rectangle.width;
  canvas.height = rectangle.height;
  canvas2d(canvas).drawImage(
    source,
    rectangle.x,
    rectangle.y,
    rectangle.width,
    rectangle.height,
    0,
    0,
    rectangle.width,
    rectangle.height,
  );
  return canvas;
}

function canonicalContentType(
  file: File,
): "image/jpeg" | "image/png" | "image/webp" {
  if (file.type === "image/jpeg" || file.type === "image/webp") {
    return file.type;
  }
  return "image/png";
}

function canonicalFilename(filename: string, contentType: string): string {
  const extension =
    contentType === "image/jpeg"
      ? "jpg"
      : contentType === "image/webp"
        ? "webp"
        : "png";
  const base = filename.replace(/\.(?:jpe?g|png|webp)$/iu, "").trim();
  return `${base || "reference-image"}.${extension}`;
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  contentType: "image/jpeg" | "image/png" | "image/webp",
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  const encoded = createDeferredPromise<Blob>(signal);
  canvas.toBlob(
    (blob) => {
      if (encoded.settled()) {
        return;
      }
      if (!blob) {
        encoded.reject(new Error("The reviewed image could not be encoded."));
        return;
      }
      encoded.resolve(blob);
    },
    contentType,
    contentType === "image/png" ? undefined : 0.92,
  );
  return encoded.promise;
}

/**
 * Decodes with browser orientation handling, applies the member's review, and
 * encodes one metadata-free bitmap. The returned file is the only binary the
 * direct-upload command receives; the original is never uploaded separately.
 */
async function renderDecodedReferenceImage(
  decoded: DecodedReferenceImage,
  file: File,
  crop: ReferenceImageCrop,
  quarterTurns: ReferenceImageQuarterTurns,
  signal: AbortSignal,
): Promise<CanonicalReferenceImage> {
  if (decoded.width < 1 || decoded.height < 1) {
    throw new Error("The selected image has invalid dimensions.");
  }
  if (
    decoded.width > MAX_IMAGE_REFERENCE_DIMENSION ||
    decoded.height > MAX_IMAGE_REFERENCE_DIMENSION ||
    decoded.width * decoded.height > MAX_IMAGE_REFERENCE_PIXELS
  ) {
    throw new Error("The selected image dimensions are too large.");
  }
  const rotated = renderRotatedImage(decoded, quarterTurns);
  const canonical = renderCroppedImage(rotated, crop);
  const contentType = canonicalContentType(file);
  const blob = await encodeCanvas(canonical, contentType, signal);
  if (blob.size > IMAGE_REFERENCE_MAX_FILE_SIZE) {
    throw new Error("The reviewed image must be 20 MB or smaller.");
  }
  return {
    file: new File([blob], canonicalFilename(file.name, contentType), {
      type: contentType,
    }),
    width: canonical.width,
    height: canonical.height,
  };
}

export async function renderCanonicalReferenceImage(
  file: File,
  crop: ReferenceImageCrop,
  quarterTurns: ReferenceImageQuarterTurns,
  signal: AbortSignal,
): Promise<CanonicalReferenceImage> {
  const validation = validateReferenceImageFile(file);
  if (!validation.ok) {
    throw new Error(
      validation.reason === "size"
        ? "Reference images must be 20 MB or smaller."
        : "Reference images must be PNG, JPEG, or WebP files.",
    );
  }

  const decoded = await decodeReferenceImage(file, signal);
  return await withCleanup(
    renderDecodedReferenceImage(decoded, file, crop, quarterTurns, signal),
    decoded.release,
  );
}
