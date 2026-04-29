import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

/**
 * Extract a single file from a .tar.gz archive buffer.
 *
 * The input buffer is gunzip'd first, then parsed as a POSIX tar.
 * Returns the file content as a UTF-8 string, or null if not found.
 */
export function extractFileFromTarGz(
  gzBuffer: Buffer,
  targetPath: string,
): string | null {
  const tarBuffer = gunzipSync(gzBuffer);
  const normalized = targetPath.replace(/^\.\//, "");

  let offset = 0;
  while (offset + BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK_SIZE);

    // End of archive: two consecutive zero blocks
    if (
      header.every((b) => {
        return b === 0;
      })
    ) {
      break;
    }

    // File name: bytes 0-99, null-terminated
    const nameEnd = header.indexOf(0);
    const name = header
      .subarray(0, nameEnd > 0 && nameEnd < 100 ? nameEnd : 100)
      .toString("utf8");

    // File size: bytes 124-135, octal string
    const sizeStr = header.subarray(124, 136).toString("utf8").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;

    offset += BLOCK_SIZE; // Move past header

    const entryName = name.replace(/^\.\//, "");
    if (entryName === normalized) {
      return tarBuffer.subarray(offset, offset + size).toString("utf8");
    }

    // Skip file data (padded to 512-byte boundary)
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return null;
}
