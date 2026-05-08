/**
 * Minimal tar archive utilities.
 *
 * Used by:
 *  - Instructions route (create + extract)
 *  - Docker sandbox (create)
 */

const BLOCK_SIZE = 512;

function createFileHeader(filename: string, content: Buffer): Buffer {
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
  return header;
}

/**
 * Create a tar archive containing multiple files.
 * Produces a valid POSIX (ustar) tar with checksum, end-of-archive markers,
 * and 512-byte block alignment.
 */
export function createTarArchive(
  files: Array<{ filename: string; content: Buffer }>,
): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    blocks.push(createFileHeader(file.filename, file.content));
    blocks.push(file.content);

    // Pad content to 512-byte boundary
    const padding = BLOCK_SIZE - (file.content.length % BLOCK_SIZE);
    if (padding < BLOCK_SIZE) {
      blocks.push(Buffer.alloc(padding, 0));
    }
  }

  // End-of-archive marker: two 512-byte zero blocks
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

  return Buffer.concat(blocks);
}

/**
 * Create a tar archive containing a single file.
 */
export function createSingleFileTar(filename: string, content: Buffer): Buffer {
  return createTarArchive([{ filename, content }]);
}

/**
 * Extract a single file from a tar archive buffer.
 * Tar format: 512-byte header + file data (padded to 512-byte blocks).
 */
export function extractFileFromTar(
  tarBuffer: Buffer,
  targetPath: string,
): Buffer | null {
  let offset = 0;
  while (offset + BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK_SIZE);

    // End of archive: two consecutive zero blocks
    if (
      header.every((b) => {
        return b === 0;
      })
    )
      break;

    // File name: bytes 0-99, null-terminated
    const nameEnd = header.indexOf(0);
    const name = header
      .subarray(0, nameEnd > 0 && nameEnd < 100 ? nameEnd : 100)
      .toString("utf-8");

    // File size: bytes 124-135, octal string
    const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
    const size = parseInt(sizeStr, 8) || 0;

    offset += BLOCK_SIZE; // Move past header

    if (name === targetPath || name === `./${targetPath}`) {
      return tarBuffer.subarray(offset, offset + size);
    }

    // Skip file data (padded to 512-byte boundary)
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return null;
}
