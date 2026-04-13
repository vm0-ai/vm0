/**
 * Minimal tar archive utilities.
 *
 * Used by:
 *  - Instructions route (create + extract)
 *  - Docker sandbox (create)
 */

const BLOCK_SIZE = 512;

/**
 * Create a tar archive containing a single file.
 * Produces a valid POSIX (ustar) tar with checksum, end-of-archive markers,
 * and 512-byte block alignment.
 */
export function createSingleFileTar(filename: string, content: Buffer): Buffer {
  const blocks: Buffer[] = [];

  const header = Buffer.alloc(BLOCK_SIZE, 0);
  // File name (bytes 0-99)
  header.write(filename, 0, Math.min(filename.length, 100), "utf-8");
  // File mode (bytes 100-107): 0644
  header.write("0000644\0", 100, 8, "utf-8");
  // UID/GID (bytes 108-123): 0
  header.write("0000000\0", 108, 8, "utf-8");
  header.write("0000000\0", 116, 8, "utf-8");
  // File size (bytes 124-135): octal
  const sizeOctal = content.length.toString(8).padStart(11, "0");
  header.write(sizeOctal + "\0", 124, 12, "utf-8");
  // Mtime (bytes 136-147)
  const mtime = Math.floor(Date.now() / 1000)
    .toString(8)
    .padStart(11, "0");
  header.write(mtime + "\0", 136, 12, "utf-8");
  // Checksum placeholder (bytes 148-155): spaces for initial calculation
  header.write("        ", 148, 8, "utf-8");
  // Type flag (byte 156): '0' = regular file
  header.write("0", 156, 1, "utf-8");
  // ustar magic (bytes 257-264)
  header.write("ustar\0", 257, 6, "utf-8");
  header.write("00", 263, 2, "utf-8");

  // Compute and write checksum
  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    checksum += header.readUInt8(i);
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");

  blocks.push(header);
  blocks.push(content);

  // Pad content to 512-byte boundary
  const padding = BLOCK_SIZE - (content.length % BLOCK_SIZE);
  if (padding < BLOCK_SIZE) {
    blocks.push(Buffer.alloc(padding, 0));
  }

  // End-of-archive marker: two 512-byte zero blocks
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

  return Buffer.concat(blocks);
}

/**
 * Extract a single file from a tar archive buffer.
 * Tar format: 512-byte header + file data (padded to 512-byte blocks).
 */
export function extractFileFromTar(
  tarBuffer: Buffer,
  targetPath: string,
): Buffer | null {
  for (const entry of iterateTarEntries(tarBuffer)) {
    if (entry.path === targetPath || entry.path === `./${targetPath}`) {
      return entry.content;
    }
  }
  return null;
}

/**
 * Extract every regular file from a tar archive.
 * Paths are normalized to drop the leading `./` if present.
 * Directory entries and other non-regular entries are skipped.
 */
export function extractAllFilesFromTar(
  tarBuffer: Buffer,
): { path: string; content: Buffer }[] {
  const result: { path: string; content: Buffer }[] = [];
  for (const entry of iterateTarEntries(tarBuffer)) {
    if (!entry.isRegularFile) continue;
    const normalized = entry.path.startsWith("./")
      ? entry.path.slice(2)
      : entry.path;
    result.push({ path: normalized, content: entry.content });
  }
  return result;
}

interface TarEntry {
  path: string;
  content: Buffer;
  isRegularFile: boolean;
}

function* iterateTarEntries(tarBuffer: Buffer): Generator<TarEntry> {
  let offset = 0;
  while (offset + BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK_SIZE);

    // End of archive: two consecutive zero blocks
    if (
      header.every((b) => {
        return b === 0;
      })
    )
      return;

    // File name: bytes 0-99, null-terminated
    const nameEnd = header.indexOf(0);
    const name = header
      .subarray(0, nameEnd > 0 && nameEnd < 100 ? nameEnd : 100)
      .toString("utf-8");

    // File size: bytes 124-135, octal string
    const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
    const size = parseInt(sizeStr, 8) || 0;

    // Type flag (byte 156): '0' or '\0' = regular file, '5' = directory, etc.
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const isRegularFile = typeFlag === "0" || typeFlag === "\0";

    offset += BLOCK_SIZE; // Move past header
    const content = tarBuffer.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    yield { path: name, content, isRegularFile };
  }
}
