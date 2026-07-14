import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

interface ExtractedTarFile {
  readonly path: string;
  readonly content: string;
}

interface ExtractedTarBuffer {
  readonly path: string;
  readonly content: Buffer;
}

function normalizeTarPath(path: string): string {
  return path.replace(/^\.\//, "");
}

function readTarString(buffer: Buffer, start: number, end: number): string {
  const slice = buffer.subarray(start, end);
  const nullIndex = slice.indexOf(0);
  return slice
    .subarray(0, nullIndex !== -1 ? nullIndex : slice.length)
    .toString("utf8");
}

function readTarPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 500);
  return normalizeTarPath(prefix ? `${prefix}/${name}` : name);
}

function isRegularFile(typeFlag: string): boolean {
  return typeFlag === "" || typeFlag === "0";
}

function readTarEntrySize(header: Buffer): number {
  const sizeString = header.subarray(124, 136).toString("utf8").trim();
  const size = Number.parseInt(sizeString, 8) || 0;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Tar archive contains an invalid entry size");
  }
  return size;
}

export function extractFilesFromTarGz(
  gzBuffer: Buffer,
  targetPaths?: readonly string[],
): readonly ExtractedTarFile[] {
  const tarBuffer = gunzipSync(gzBuffer);
  const normalizedTargets = targetPaths
    ? new Set(
        targetPaths.map((path) => {
          return normalizeTarPath(path);
        }),
      )
    : null;
  const files: ExtractedTarFile[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK_SIZE);

    if (
      header.every((b) => {
        return b === 0;
      })
    ) {
      break;
    }

    const name = readTarPath(header);
    const size = readTarEntrySize(header);
    const typeFlag = readTarString(header, 156, 157);

    offset += BLOCK_SIZE;

    if (
      isRegularFile(typeFlag) &&
      (!normalizedTargets || normalizedTargets.has(name))
    ) {
      files.push({
        path: name,
        content: tarBuffer.subarray(offset, offset + size).toString("utf8"),
      });
    }

    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return files;
}

export function extractBuffersFromTarGz(
  gzBuffer: Buffer,
  targetPaths?: readonly string[],
  maxOutputBytes?: number,
): readonly ExtractedTarBuffer[] {
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
  const files: ExtractedTarBuffer[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK_SIZE);
    if (
      header.every((byte) => {
        return byte === 0;
      })
    ) {
      break;
    }

    const path = readTarPath(header);
    const size = readTarEntrySize(header);
    const typeFlag = readTarString(header, 156, 157);
    offset += BLOCK_SIZE;
    if (offset + size > tarBuffer.length) {
      throw new Error("Tar archive entry exceeds the archive boundary");
    }
    if (
      isRegularFile(typeFlag) &&
      (!normalizedTargets || normalizedTargets.has(path))
    ) {
      files.push({
        path,
        content: Buffer.from(tarBuffer.subarray(offset, offset + size)),
      });
    }
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return files;
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
