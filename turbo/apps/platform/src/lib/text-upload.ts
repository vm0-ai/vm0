import { textEncoding } from "./text-encoding.ts";
import { settle } from "../signals/utils.ts";

// HTML/XML/SVG and RTF can declare their encoding inside the document. Leave
// those declarations, unknown formats and binary uploads to their consumers.
const TEXT_UPLOAD_TYPES = Object.freeze([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/yaml",
  "text/x-yaml",
  "application/json",
  "application/yaml",
  "application/x-yaml",
]);

const VALIDATION_CHUNK_BYTES = 256 * 1024;

async function isUtf8Text(file: Blob, signal: AbortSignal): Promise<boolean> {
  // Validate the entire file with bounded memory. A prefix can end halfway
  // through a character or miss non-UTF-8 bytes in a later multipart chunk.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 0; offset < file.size; offset += VALIDATION_CHUNK_BYTES) {
    signal.throwIfAborted();
    const buffer = await file
      .slice(offset, offset + VALIDATION_CHUNK_BYTES)
      .arrayBuffer();
    signal.throwIfAborted();
    const bytes = new Uint8Array(buffer);
    // NUL is also common in BOM-less UTF-16 and binary data that otherwise
    // passes UTF-8 validation. Do not label those bytes as UTF-8 text.
    if (bytes.includes(0)) {
      return false;
    }
    decoder.decode(bytes, { stream: true });
  }
  decoder.decode();
  return true;
}

export async function textUploadContentType(
  file: Blob,
  contentType: string,
  signal: AbortSignal,
): Promise<string> {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    !TEXT_UPLOAD_TYPES.includes(mediaType) ||
    textEncoding(contentType) !== undefined
  ) {
    return contentType;
  }
  const validated = await settle(isUtf8Text(file, signal), signal);
  if (!validated.ok) {
    if (!(validated.error instanceof TypeError)) {
      throw validated.error;
    }
    return contentType;
  }
  return validated.value ? `${contentType}; charset=utf-8` : contentType;
}
