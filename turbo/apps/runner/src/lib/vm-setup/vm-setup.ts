/**
 * VM Setup Operations
 *
 * Guest-based setup operations for Firecracker VMs.
 * These functions configure the VM environment before agent execution.
 * Works with any GuestClient implementation (currently VsockClient).
 */

import type { GuestClient } from "../firecracker/guest.js";
import type { StorageManifest, ResumeSession } from "../api.js";
import { GUEST_BINARY_PATHS } from "../scripts/index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("VMSetup");

/** Path where proxy CA certificate is installed in VM (for NODE_EXTRA_CA_CERTS) */
export const VM_PROXY_CA_PATH =
  "/usr/local/share/ca-certificates/vm0-proxy-ca.crt";

/**
 * Download storages to VM using storage manifest
 */
export async function downloadStorages(
  guest: GuestClient,
  manifest: StorageManifest,
): Promise<void> {
  // Count archives to download
  const totalArchives =
    manifest.storages.filter((s) => s.archiveUrl).length +
    (manifest.artifact?.archiveUrl ? 1 : 0);

  if (totalArchives === 0) {
    logger.log(`No archives to download`);
    return;
  }

  logger.log(`Downloading ${totalArchives} archive(s)...`);

  // Write manifest to VM
  const manifestJson = JSON.stringify(manifest);
  await guest.writeFile("/tmp/storage-manifest.json", manifestJson);

  // Run download script (Rust binary for parallel downloads)
  const result = await guest.exec(
    `${GUEST_BINARY_PATHS.guestDownload} /tmp/storage-manifest.json`,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Storage download failed: ${result.stderr}`);
  }

  logger.log(`Storage download completed`);
}

/**
 * Restore session history for resume functionality
 */
export async function restoreSessionHistory(
  guest: GuestClient,
  resumeSession: ResumeSession,
  workingDir: string,
  cliAgentType: string,
): Promise<void> {
  const { sessionId, sessionHistory } = resumeSession;

  // Calculate session history path based on CLI agent type
  let sessionPath: string;
  if (cliAgentType === "codex") {
    // Codex uses different path structure - for now use a marker
    // The checkpoint.py will search for the actual file
    logger.log(`Codex resume session will be handled by checkpoint.py`);
    return;
  } else {
    // Claude Code path: ~/.claude/projects/-{path}/{session_id}.jsonl
    const projectName = workingDir.replace(/^\//, "").replace(/\//g, "-");
    sessionPath = `/home/user/.claude/projects/-${projectName}/${sessionId}.jsonl`;
  }

  logger.log(`Restoring session history to ${sessionPath}`);

  // Create directory and write file
  const dirPath = sessionPath.substring(0, sessionPath.lastIndexOf("/"));
  await guest.execOrThrow(`mkdir -p "${dirPath}"`);
  await guest.writeFile(sessionPath, sessionHistory);

  logger.log(
    `Session history restored (${sessionHistory.split("\n").length} lines)`,
  );
}
