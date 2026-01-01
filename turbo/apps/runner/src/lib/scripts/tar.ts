/**
 * Tar Archive Utility
 *
 * Creates POSIX ustar tar archives for bundling scripts.
 * This reduces vsock API calls from O(n) to O(1) for script uploads.
 *
 * Implementation matches e2b-service.ts createScriptsTarBuffer() for consistency.
 */

import {
  INIT_SCRIPT,
  COMMON_SCRIPT,
  LOG_SCRIPT,
  HTTP_SCRIPT,
  EVENTS_SCRIPT,
  DIRECT_UPLOAD_SCRIPT,
  DOWNLOAD_SCRIPT,
  CHECKPOINT_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  METRICS_SCRIPT,
  UPLOAD_TELEMETRY_SCRIPT,
  PROXY_SETUP_SCRIPT,
  MITM_ADDON_SCRIPT,
  SECRET_MASKER_SCRIPT,
  RUN_AGENT_SCRIPT,
  SCRIPT_PATHS,
} from "./index.js";

export interface ScriptEntry {
  content: string;
  path: string;
}

/**
 * Get all scripts that need to be uploaded to the VM
 */
export function getAllScripts(): ScriptEntry[] {
  return [
    { content: INIT_SCRIPT, path: SCRIPT_PATHS.libInit },
    { content: COMMON_SCRIPT, path: SCRIPT_PATHS.common },
    { content: LOG_SCRIPT, path: SCRIPT_PATHS.log },
    { content: HTTP_SCRIPT, path: SCRIPT_PATHS.httpClient },
    { content: EVENTS_SCRIPT, path: SCRIPT_PATHS.events },
    { content: DIRECT_UPLOAD_SCRIPT, path: SCRIPT_PATHS.directUpload },
    { content: DOWNLOAD_SCRIPT, path: SCRIPT_PATHS.download },
    { content: CHECKPOINT_SCRIPT, path: SCRIPT_PATHS.checkpoint },
    { content: MOCK_CLAUDE_SCRIPT, path: SCRIPT_PATHS.mockClaude },
    { content: METRICS_SCRIPT, path: SCRIPT_PATHS.metrics },
    { content: UPLOAD_TELEMETRY_SCRIPT, path: SCRIPT_PATHS.uploadTelemetry },
    { content: PROXY_SETUP_SCRIPT, path: SCRIPT_PATHS.proxySetup },
    { content: MITM_ADDON_SCRIPT, path: SCRIPT_PATHS.mitmAddon },
    { content: SECRET_MASKER_SCRIPT, path: SCRIPT_PATHS.secretMasker },
    { content: RUN_AGENT_SCRIPT, path: SCRIPT_PATHS.runAgent },
  ];
}

/**
 * Create a tar archive containing all scripts with correct paths
 *
 * TAR format (POSIX ustar):
 * - Each file: 512-byte header + content padded to 512-byte boundary
 * - End: Two 512-byte zero blocks
 */
export function createScriptsTarBuffer(scripts: ScriptEntry[]): Buffer {
  const BLOCK_SIZE = 512;
  const blocks: Buffer[] = [];

  for (const script of scripts) {
    const content = Buffer.from(script.content, "utf-8");
    // Remove leading slash for tar path
    const path = script.path.startsWith("/")
      ? script.path.slice(1)
      : script.path;

    // Create 512-byte tar header
    const header = Buffer.alloc(BLOCK_SIZE, 0);

    // File name (100 bytes, position 0)
    header.write(path, 0, 100, "utf-8");

    // File mode (8 bytes, position 100) - 0755 for executable
    header.write("0000755\0", 100, 8, "utf-8");

    // Owner UID (8 bytes, position 108) - 0
    header.write("0000000\0", 108, 8, "utf-8");

    // Owner GID (8 bytes, position 116) - 0
    header.write("0000000\0", 116, 8, "utf-8");

    // File size in octal (12 bytes, position 124)
    const sizeOctal = content.length.toString(8).padStart(11, "0");
    header.write(sizeOctal + "\0", 124, 12, "utf-8");

    // Modification time (12 bytes, position 136) - current time
    const mtime = Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0");
    header.write(mtime + "\0", 136, 12, "utf-8");

    // Checksum placeholder (8 bytes, position 148) - spaces for calculation
    header.write("        ", 148, 8, "utf-8");

    // Type flag (1 byte, position 156) - '0' for regular file
    header.write("0", 156, 1, "utf-8");

    // Link name (100 bytes, position 157) - empty
    // Already zero-filled

    // USTAR magic (6 bytes, position 257)
    header.write("ustar\0", 257, 6, "utf-8");

    // USTAR version (2 bytes, position 263)
    header.write("00", 263, 2, "utf-8");

    // Owner name (32 bytes, position 265)
    header.write("root", 265, 32, "utf-8");

    // Group name (32 bytes, position 297)
    header.write("root", 297, 32, "utf-8");

    // Calculate checksum (sum of all bytes in header, treating checksum field as spaces)
    let checksum = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      checksum += header.readUInt8(i);
    }
    // Write checksum in octal (6 digits + null + space)
    const checksumStr = checksum.toString(8).padStart(6, "0");
    header.write(checksumStr + "\0 ", 148, 8, "utf-8");

    blocks.push(header);

    // Add content
    blocks.push(content);

    // Pad content to 512-byte boundary
    const padding = BLOCK_SIZE - (content.length % BLOCK_SIZE);
    if (padding < BLOCK_SIZE) {
      blocks.push(Buffer.alloc(padding, 0));
    }
  }

  // Add two empty blocks to mark end of archive
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

  return Buffer.concat(blocks);
}
