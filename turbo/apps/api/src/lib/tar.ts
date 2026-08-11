import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const TAR_END_BLOCKS = 2;
const TAR_NAME_BYTES = 100;
const TAR_PREFIX_BYTES = 155;

interface TarGzipFile {
  readonly path: string;
  readonly content: Uint8Array;
}

interface ExtractedTarFile {
  readonly path: string;
  readonly content: string;
}

interface ExtractedBinaryTarFile {
  readonly path: string;
  readonly content: Buffer;
}

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeBytes(
  target: Uint8Array,
  offset: number,
  width: number,
  value: Uint8Array,
): void {
  if (value.length > width) {
    throw new Error("Tar header field exceeds its fixed width");
  }
  target.set(value, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  width: number,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Tar numeric fields must be non-negative safe integers");
  }
  const octal = value.toString(8);
  if (octal.length > width - 1) {
    throw new Error("Tar numeric field exceeds its fixed width");
  }
  writeBytes(
    target,
    offset,
    width,
    encoded(`${octal.padStart(width - 1, "0")}\0`),
  );
}

function splitTarPath(path: string): {
  readonly name: Uint8Array;
  readonly prefix: Uint8Array;
} {
  if (!path || path.includes("\0")) {
    throw new Error("Tar paths must be non-empty and cannot contain NUL");
  }
  const fullPath = encoded(path);
  if (fullPath.length <= TAR_NAME_BYTES) {
    return { name: fullPath, prefix: new Uint8Array() };
  }

  for (let separator = path.lastIndexOf("/"); separator > 0; ) {
    const prefix = encoded(path.slice(0, separator));
    const name = encoded(path.slice(separator + 1));
    if (prefix.length <= TAR_PREFIX_BYTES && name.length <= TAR_NAME_BYTES) {
      return { name, prefix };
    }
    separator = path.lastIndexOf("/", separator - 1);
  }
  throw new Error(`Tar path exceeds the USTAR path limit: ${path}`);
}

function createTarHeader(file: TarGzipFile): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const path = splitTarPath(file.path);
  writeBytes(header, 0, TAR_NAME_BYTES, path.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, file.content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeBytes(header, 257, 6, encoded("ustar\0"));
  writeBytes(header, 263, 2, encoded("00"));
  writeBytes(header, 345, TAR_PREFIX_BYTES, path.prefix);

  const checksum = header.reduce((sum, byte) => {
    return sum + byte;
  }, 0);
  const checksumText = checksum.toString(8);
  if (checksumText.length > 6) {
    throw new Error("Tar checksum exceeds its fixed width");
  }
  writeBytes(header, 148, 6, encoded(checksumText.padStart(6, "0")));
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function paddedContentBytes(contentBytes: number): number {
  return Math.ceil(contentBytes / BLOCK_SIZE) * BLOCK_SIZE;
}

export function createTarGzip(files: readonly TarGzipFile[]): Buffer {
  const tarBytes = files.reduce((total, file) => {
    return total + BLOCK_SIZE + paddedContentBytes(file.content.byteLength);
  }, BLOCK_SIZE * TAR_END_BLOCKS);
  if (!Number.isSafeInteger(tarBytes)) {
    throw new Error("Tar archive is too large");
  }

  const archive = new Uint8Array(tarBytes);
  let offset = 0;
  for (const file of files) {
    archive.set(createTarHeader(file), offset);
    offset += BLOCK_SIZE;
    archive.set(file.content, offset);
    offset += paddedContentBytes(file.content.byteLength);
  }
  return gzipSync(archive, { level: 1 });
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

export function extractBinaryFilesFromTarGz(
  gzBuffer: Buffer,
  targetPaths?: readonly string[],
): readonly ExtractedBinaryTarFile[] {
  const tarBuffer = gunzipSync(gzBuffer);
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
): readonly ExtractedTarFile[] {
  return extractBinaryFilesFromTarGz(gzBuffer, targetPaths).map((file) => {
    return { path: file.path, content: file.content.toString("utf8") };
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
