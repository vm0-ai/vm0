import { gunzipSync } from "node:zlib";

const TAR_BLOCK_BYTES = 512;

function allZero(bytes: Buffer): boolean {
  return bytes.every((byte) => {
    return byte === 0;
  });
}

function nullTerminatedText(bytes: Buffer): string {
  const terminator = bytes.indexOf(0);
  return bytes
    .subarray(0, terminator === -1 ? bytes.length : terminator)
    .toString();
}

function readOctal(bytes: Buffer, width: number): number {
  const text = bytes.toString("ascii");
  if (!new RegExp(`^[0-7]{${width - 1}}\\0$`, "u").test(text)) {
    throw new Error(`Invalid tar numeric field: ${JSON.stringify(text)}`);
  }
  return Number.parseInt(text.slice(0, -1), 8);
}

function readChecksum(header: Buffer): number {
  const field = header.subarray(148, 156).toString("ascii");
  if (!/^[0-7]{6}\0 $/u.test(field)) {
    throw new Error(`Invalid tar checksum field: ${JSON.stringify(field)}`);
  }
  return Number.parseInt(field.slice(0, 6), 8);
}

function computedChecksum(header: Buffer): number {
  return header.reduce((sum, byte, index) => {
    return sum + (index >= 148 && index < 156 ? 0x20 : byte);
  }, 0);
}

export function readStrictTarGzip(
  archive: Buffer,
): ReadonlyMap<string, Buffer> {
  const tar = gunzipSync(archive);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (allZero(header)) {
      const secondEndBlock = tar.subarray(
        offset + TAR_BLOCK_BYTES,
        offset + TAR_BLOCK_BYTES * 2,
      );
      if (
        secondEndBlock.length !== TAR_BLOCK_BYTES ||
        !allZero(secondEndBlock)
      ) {
        throw new Error("Tar archive is missing its second end block");
      }
      return files;
    }

    const expectedChecksum = readChecksum(header);
    const actualChecksum = computedChecksum(header);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Tar checksum mismatch: expected ${expectedChecksum.toString()}, received ${actualChecksum.toString()}`,
      );
    }
    const name = nullTerminatedText(header.subarray(0, 100));
    const prefix = nullTerminatedText(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header.subarray(124, 136), 12);
    const contentOffset = offset + TAR_BLOCK_BYTES;
    files.set(path, tar.subarray(contentOffset, contentOffset + size));
    offset =
      contentOffset + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  throw new Error("Tar archive is missing its end blocks");
}
