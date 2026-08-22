import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

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

function readTarString(
  buffer: Buffer,
  start: number,
  end: number,
  strictUtf8 = false,
): string {
  const slice = buffer.subarray(start, end);
  const nullIndex = slice.indexOf(0);
  const value = slice.subarray(0, nullIndex !== -1 ? nullIndex : slice.length);
  return strictUtf8
    ? new TextDecoder("utf-8", { fatal: true }).decode(value)
    : value.toString("utf8");
}

function readTarPath(header: Buffer, strictUtf8: boolean): string {
  const name = readTarString(header, 0, 100, strictUtf8);
  const prefix = readTarString(header, 345, 500, strictUtf8);
  return normalizeTarPath(prefix ? `${prefix}/${name}` : name);
}

function isRegularFile(typeFlag: string): boolean {
  return typeFlag === "" || typeFlag === "0";
}

function extractBinaryFilesFromTarGz(
  gzBuffer: Buffer,
  targetPaths?: readonly string[],
  maxOutputBytes?: number,
  options?: TarExtractionOptions,
): readonly ExtractedBinaryTarFile[] {
  const tarBuffer = gunzipSync(gzBuffer, {
    ...(maxOutputBytes === undefined
      ? {}
      : { maxOutputLength: maxOutputBytes }),
  });
  const normalizedTargets = targetPaths
    ? new Set(
        targetPaths.map((path) => {
          return normalizeTarPath(path);
        }),
      )
    : null;
  const files: ExtractedBinaryTarFile[] = [];
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

    const name = readTarPath(header, options?.strictUtf8 === true);
    const sizeStr = header.subarray(124, 136).toString("utf8").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;
    const typeFlag = readTarString(header, 156, 157);

    offset += BLOCK_SIZE;

    if (
      isRegularFile(typeFlag) &&
      (!normalizedTargets || normalizedTargets.has(name))
    ) {
      files.push({
        path: name,
        content: Buffer.from(tarBuffer.subarray(offset, offset + size)),
      });
    }

    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
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
  return extractBinaryFilesFromTarGz(
    gzBuffer,
    targetPaths,
    maxOutputBytes,
    options,
  ).map((file) => {
    return {
      path: file.path,
      content: strictUtf8
        ? new TextDecoder("utf-8", { fatal: true }).decode(file.content)
        : file.content.toString("utf8"),
    };
  });
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
