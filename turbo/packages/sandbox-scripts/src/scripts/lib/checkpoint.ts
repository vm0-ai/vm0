/**
 * Checkpoint creation module.
 * Creates checkpoints with conversation history and optional artifact snapshot (VAS only).
 * Uses direct S3 upload exclusively (no fallback to legacy methods).
 */
import * as fs from "fs";
import * as path from "path";
import {
  RUN_ID,
  CHECKPOINT_URL,
  SESSION_ID_FILE,
  SESSION_HISTORY_PATH_FILE,
  ARTIFACT_DRIVER,
  ARTIFACT_MOUNT_PATH,
  ARTIFACT_VOLUME_NAME,
  MEMORY_DRIVER,
  MEMORY_MOUNT_PATH,
  MEMORY_NAME,
  CLI_AGENT_TYPE,
  recordSandboxOp,
} from "./common.js";
import { logInfo, logError } from "./log.js";
import { httpPostJson } from "./http-client.js";
import { createDirectUploadSnapshot } from "./direct-upload.js";

/**
 * Find all JSONL files recursively in a directory.
 */
function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    try {
      const items = fs.readdirSync(currentDir);
      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (item.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(dir);
  return files;
}

/**
 * Find Codex session file by searching in date-organized directories.
 * Codex stores sessions in: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * @param sessionsDir - Base sessions directory (e.g., ~/.codex/sessions)
 * @param sessionId - Session ID to find (e.g., 019b3aca-2df2-7573-8f88-4240b7bc350a)
 * @returns Full path to session file, or null if not found
 */
export function findCodexSessionFile(
  sessionsDir: string,
  sessionId: string,
): string | null {
  // First, try searching all JSONL files recursively
  const files = findJsonlFiles(sessionsDir);

  logInfo(`Searching for Codex session ${sessionId} in ${files.length} files`);

  // The session ID in Codex filenames uses the format with dashes
  // e.g., rollout-2025-12-20T08-04-44-019b3aca-2df2-7573-8f88-4240b7bc350a.jsonl
  for (const filepath of files) {
    const filename = path.basename(filepath);
    // Check if session ID is in the filename
    if (
      filename.includes(sessionId) ||
      filename.replace(/-/g, "").includes(sessionId.replace(/-/g, ""))
    ) {
      logInfo(`Found Codex session file: ${filepath}`);
      return filepath;
    }
  }

  // If not found by ID match, get the most recent file (fallback)
  if (files.length > 0) {
    // Sort by modification time, newest first
    files.sort((a, b) => {
      const statA = fs.statSync(a);
      const statB = fs.statSync(b);
      return statB.mtimeMs - statA.mtimeMs;
    });
    const mostRecent = files[0] ?? null;
    if (mostRecent) {
      logInfo(
        `Session ID not found in filenames, using most recent: ${mostRecent}`,
      );
    }
    return mostRecent;
  }

  return null;
}

interface CheckpointResponse {
  checkpointId?: string;
}

interface StorageSnapshot {
  name: string;
  version: string;
}

/**
 * Create a VAS storage snapshot using direct S3 upload.
 *
 * @returns snapshot with name and version, or null on failure
 */
async function createVasSnapshot(
  driver: string,
  volumeName: string,
  mountPath: string,
  label: string,
  storageType: "artifact" | "memory",
): Promise<StorageSnapshot | null> {
  logInfo(`Processing ${label} with driver: ${driver}`);

  if (driver !== "vas") {
    logError(`Unknown ${label} driver: ${driver} (only 'vas' is supported)`);
    return null;
  }

  if (!fs.existsSync(mountPath)) {
    logInfo(`${label} directory does not exist at ${mountPath}, skipping`);
    return null;
  }

  logInfo(`Creating VAS snapshot for ${label} '${volumeName}' at ${mountPath}`);

  const snapshot = await createDirectUploadSnapshot(
    mountPath,
    volumeName,
    storageType,
    RUN_ID,
    `${label} checkpoint from run ${RUN_ID}`,
  );

  if (!snapshot?.versionId) {
    logInfo(`Failed to create ${label} snapshot, continuing without it`);
    return null;
  }

  logInfo(`VAS ${label} snapshot created: ${volumeName}@${snapshot.versionId}`);
  return { name: volumeName, version: snapshot.versionId };
}

/**
 * Read session history from file system, handling Codex search markers.
 *
 * @returns session history string, or null on failure
 */
function readSessionHistory(): string | null {
  const start = Date.now();

  if (!fs.existsSync(SESSION_HISTORY_PATH_FILE)) {
    logError("No session history path found, checkpoint creation failed");
    recordSandboxOp(
      "session_history_read",
      Date.now() - start,
      false,
      "Session history path file not found",
    );
    return null;
  }

  const raw = fs.readFileSync(SESSION_HISTORY_PATH_FILE, "utf-8").trim();

  // Handle Codex session search marker format: CODEX_SEARCH:{sessions_dir}:{session_id}
  let sessionHistoryPath: string;
  if (raw.startsWith("CODEX_SEARCH:")) {
    const parts = raw.split(":");
    if (parts.length !== 3) {
      logError(`Invalid Codex search marker format: ${raw}`);
      recordSandboxOp(
        "session_history_read",
        Date.now() - start,
        false,
        "Invalid Codex search marker",
      );
      return null;
    }
    const sessionsDir = parts[1] ?? "";
    const codexSessionId = parts[2] ?? "";
    logInfo(`Searching for Codex session in ${sessionsDir}`);
    const foundPath = findCodexSessionFile(sessionsDir, codexSessionId);
    if (!foundPath) {
      logError(
        `Could not find Codex session file for ${codexSessionId} in ${sessionsDir}`,
      );
      recordSandboxOp(
        "session_history_read",
        Date.now() - start,
        false,
        "Codex session file not found",
      );
      return null;
    }
    sessionHistoryPath = foundPath;
  } else {
    sessionHistoryPath = raw;
  }

  if (!fs.existsSync(sessionHistoryPath)) {
    logError(
      `Session history file not found at ${sessionHistoryPath}, checkpoint creation failed`,
    );
    recordSandboxOp(
      "session_history_read",
      Date.now() - start,
      false,
      "Session history file not found",
    );
    return null;
  }

  let content: string;
  try {
    content = fs.readFileSync(sessionHistoryPath, "utf-8");
  } catch (error) {
    logError(`Failed to read session history: ${error}`);
    recordSandboxOp(
      "session_history_read",
      Date.now() - start,
      false,
      String(error),
    );
    return null;
  }

  if (!content.trim()) {
    logError("Session history is empty, checkpoint creation failed");
    recordSandboxOp(
      "session_history_read",
      Date.now() - start,
      false,
      "Session history empty",
    );
    return null;
  }

  const lineCount = content.trim().split("\n").length;
  logInfo(`Session history loaded (${lineCount} lines)`);
  recordSandboxOp("session_history_read", Date.now() - start, true);
  return content;
}

/**
 * Create checkpoint after successful run.
 *
 * @returns true on success, false on failure
 */
export async function createCheckpoint(): Promise<boolean> {
  const checkpointStart = Date.now();
  logInfo("Creating checkpoint...");

  // Read session ID from temp file
  const sessionIdStart = Date.now();
  if (!fs.existsSync(SESSION_ID_FILE)) {
    logError("No session ID found, checkpoint creation failed");
    recordSandboxOp(
      "session_id_read",
      Date.now() - sessionIdStart,
      false,
      "Session ID file not found",
    );
    recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
    return false;
  }

  const cliAgentSessionId = fs.readFileSync(SESSION_ID_FILE, "utf-8").trim();
  recordSandboxOp("session_id_read", Date.now() - sessionIdStart, true);

  // Read session history
  const cliAgentSessionHistory = readSessionHistory();
  if (!cliAgentSessionHistory) {
    recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
    return false;
  }

  // Create artifact snapshot (VAS only, optional)
  let artifactSnapshot: {
    artifactName: string;
    artifactVersion: string;
  } | null = null;
  if (ARTIFACT_DRIVER && ARTIFACT_VOLUME_NAME) {
    const snap = await createVasSnapshot(
      ARTIFACT_DRIVER,
      ARTIFACT_VOLUME_NAME,
      ARTIFACT_MOUNT_PATH,
      "artifact",
      "artifact",
    );
    if (snap) {
      artifactSnapshot = {
        artifactName: snap.name,
        artifactVersion: snap.version,
      };
    } else if (ARTIFACT_DRIVER !== "vas") {
      // Unknown driver is a hard error for artifacts
      recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
      return false;
    }
  } else {
    logInfo(
      "No artifact configured, creating checkpoint without artifact snapshot",
    );
  }

  // Create memory snapshot (VAS only, optional — same pattern as artifact)
  let memorySnapshot: { memoryName: string; memoryVersion: string } | null =
    null;
  if (MEMORY_DRIVER && MEMORY_NAME) {
    const snap = await createVasSnapshot(
      MEMORY_DRIVER,
      MEMORY_NAME,
      MEMORY_MOUNT_PATH,
      "memory",
      "memory",
    );
    if (snap) {
      memorySnapshot = { memoryName: snap.name, memoryVersion: snap.version };
    }
  }

  logInfo("Calling checkpoint API...");

  // Build checkpoint payload
  const checkpointPayload: Record<string, unknown> = {
    runId: RUN_ID,
    cliAgentType: CLI_AGENT_TYPE,
    cliAgentSessionId,
    cliAgentSessionHistory,
  };

  if (artifactSnapshot) {
    checkpointPayload.artifactSnapshot = artifactSnapshot;
  }
  if (memorySnapshot) {
    checkpointPayload.memorySnapshot = memorySnapshot;
  }

  // Call checkpoint API
  const apiCallStart = Date.now();
  const result = (await httpPostJson(
    CHECKPOINT_URL,
    checkpointPayload,
  )) as CheckpointResponse | null;

  // Validate response contains checkpointId to confirm checkpoint was actually created
  // Note: result can be {} (empty dict) on network issues, which is not null but invalid
  if (result && result.checkpointId) {
    const checkpointId = result.checkpointId;
    logInfo(`Checkpoint created successfully: ${checkpointId}`);
    recordSandboxOp("checkpoint_api_call", Date.now() - apiCallStart, true);
    recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, true);
    return true;
  } else {
    logError(
      `Checkpoint API returned invalid response: ${JSON.stringify(result)}`,
    );
    recordSandboxOp(
      "checkpoint_api_call",
      Date.now() - apiCallStart,
      false,
      "Invalid API response",
    );
    recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
    return false;
  }
}
