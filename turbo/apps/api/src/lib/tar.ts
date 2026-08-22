import { gunzipSync } from "node:zlib";
import { Parser } from "tar";

const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCK_COUNT = 2;

interface ExtractedTarFile {
  readonly path: string;
  readonly content: string;
}

interface ExtractedBinaryTarFile {
  readonly path: string;
  readonly content: Buffer;
}

interface TarExtractionOptions {
  readonly strictUtf8?: boolean;
}

function normalizeTarPath(path: string): string {
  return path.replace(/^\.\//, "");
}

function isEmptyTarArchive(buffer: Buffer): boolean {
  return (
    buffer.length >= TAR_BLOCK_SIZE * TAR_END_BLOCK_COUNT &&
    buffer.length % TAR_BLOCK_SIZE === 0 &&
    buffer.every((byte) => {
      return byte === 0;
    })
  );
}

export function extractBinaryFilesFromTarGz(
  gzBuffer: Buffer,
  targetPaths?: readonly string[],
  maxOutputBytes?: number,
): readonly ExtractedBinaryTarFile[] {
  const tarBuffer =
    maxOutputBytes === undefined
      ? gunzipSync(gzBuffer)
      : gunzipSync(gzBuffer, { maxOutputLength: maxOutputBytes });
  const normalizedTargets = targetPaths
    ? new Set(
        targetPaths.map((path) => {
          return normalizeTarPath(path);
        }),
      )
    : null;
  // A canonical empty TAR consists only of the two zero-filled end blocks.
  // node-tar's strict parser reports TAR_BAD_ARCHIVE when it sees no entries,
  // so recognize this valid archive shape before handing non-empty input to it.
  if (isEmptyTarArchive(tarBuffer)) {
    return [];
  }
  const files: ExtractedBinaryTarFile[] = [];
  let parseError: unknown;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      const path = normalizeTarPath(entry.path);
      if (
        !["File", "OldFile", "ContiguousFile"].includes(entry.type) ||
        (normalizedTargets !== null && !normalizedTargets.has(path))
      ) {
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        files.push({ path, content: Buffer.concat(chunks) });
      });
    },
  });
  parser.on("error", (error) => {
    parseError = error;
  });
  parser.end(tarBuffer);
  if (parseError !== undefined) {
    throw parseError;
  }
  return files;
}

export function extractFilesFromTarGz(
  gzBuffer: Buffer,
  targetPaths?: readonly string[],
  maxOutputBytes?: number,
  options?: TarExtractionOptions,
): readonly ExtractedTarFile[] {
  const strictUtf8 = options?.strictUtf8 === true;
  return extractBinaryFilesFromTarGz(gzBuffer, targetPaths, maxOutputBytes).map(
    (file) => {
      return {
        path: file.path,
        content: strictUtf8
          ? new TextDecoder("utf-8", { fatal: true }).decode(file.content)
          : file.content.toString("utf8"),
      };
    },
  );
}

export function extractFileFromTarGz(
  gzBuffer: Buffer,
  targetPath: string,
): string | null {
  const normalized = normalizeTarPath(targetPath);
  const file = extractFilesFromTarGz(gzBuffer, [normalized]).find((item) => {
    return item.path === normalized;
  });
  return file?.content ?? null;
}
