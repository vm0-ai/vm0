/**
 * Shared extension-to-MIME-type mapping used by download routes and
 * services that need to infer a content-type from a filename.
 */
export const EXT_MIMETYPE_MAP: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
};

/**
 * Infer a MIME type from a filename's extension.
 * Falls back to `application/octet-stream` for unknown extensions.
 */
export function inferMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mapped = ext ? EXT_MIMETYPE_MAP[ext] : undefined;
  return mapped ?? "application/octet-stream";
}
