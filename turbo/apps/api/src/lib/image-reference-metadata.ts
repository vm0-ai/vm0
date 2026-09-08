import type { ImageReferenceContentType } from "@okouai/api-contracts/contracts/image-references";

interface ImageMetadata {
  readonly contentType: ImageReferenceContentType;
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
function isJpegStartOfFrameMarker(marker: number): boolean {
  return (
    marker === 0xc0 ||
    marker === 0xc1 ||
    marker === 0xc2 ||
    marker === 0xc3 ||
    marker === 0xc5 ||
    marker === 0xc6 ||
    marker === 0xc7 ||
    marker === 0xc9 ||
    marker === 0xca ||
    marker === 0xcb ||
    marker === 0xcd ||
    marker === 0xce ||
    marker === 0xcf
  );
}

function pngMetadata(buffer: Buffer): ImageMetadata | null {
  if (
    buffer.length < 33 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  return {
    contentType: "image/png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function jpegMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      return null;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) {
      return null;
    }
    const marker = buffer[offset] as number;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > buffer.length) {
      return null;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      return null;
    }
    if (isJpegStartOfFrameMarker(marker)) {
      if (segmentLength < 8) {
        return null;
      }
      return {
        contentType: "image/jpeg",
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function unsigned24LittleEndian(buffer: Buffer, offset: number): number {
  return (
    buffer.readUInt8(offset) +
    (buffer.readUInt8(offset + 1) << 8) +
    (buffer.readUInt8(offset + 2) << 16)
  );
}

function webpMetadata(buffer: Buffer): ImageMetadata | null {
  if (
    buffer.length < 20 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP" ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  ) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + chunkSize;
    if (payloadEnd > buffer.length) {
      return null;
    }

    if (chunkType === "VP8X" && chunkSize >= 10) {
      return {
        contentType: "image/webp",
        width: unsigned24LittleEndian(buffer, payloadOffset + 4) + 1,
        height: unsigned24LittleEndian(buffer, payloadOffset + 7) + 1,
      };
    }
    if (
      chunkType === "VP8L" &&
      chunkSize >= 5 &&
      buffer[payloadOffset] === 0x2f
    ) {
      const byte1 = buffer.readUInt8(payloadOffset + 1);
      const byte2 = buffer.readUInt8(payloadOffset + 2);
      const byte3 = buffer.readUInt8(payloadOffset + 3);
      const byte4 = buffer.readUInt8(payloadOffset + 4);
      return {
        contentType: "image/webp",
        width: 1 + byte1 + ((byte2 & 0x3f) << 8),
        height:
          1 + ((byte2 & 0xc0) >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
      };
    }
    if (
      chunkType === "VP8 " &&
      chunkSize >= 10 &&
      buffer[payloadOffset + 3] === 0x9d &&
      buffer[payloadOffset + 4] === 0x01 &&
      buffer[payloadOffset + 5] === 0x2a
    ) {
      return {
        contentType: "image/webp",
        width: buffer.readUInt16LE(payloadOffset + 6) & 0x3f_ff,
        height: buffer.readUInt16LE(payloadOffset + 8) & 0x3f_ff,
      };
    }

    offset = payloadEnd + (chunkSize % 2);
  }
  return null;
}

/** Parse only bounded metadata fields needed to validate a stored reference. */
export function parseImageReferenceMetadata(
  buffer: Buffer,
): ImageMetadata | null {
  return pngMetadata(buffer) ?? jpegMetadata(buffer) ?? webpMetadata(buffer);
}
