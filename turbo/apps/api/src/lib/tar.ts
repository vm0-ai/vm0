import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

interface ExtractedTarFile {
  readonly path: string;
  readonly content: string;
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
        content: tarBuffer.subarray(offset, offset + size).toString("utf8"),
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
