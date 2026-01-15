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

  // Read session history path from temp file
  const sessionHistoryStart = Date.now();
  if (!fs.existsSync(SESSION_HISTORY_PATH_FILE)) {
    logError("No session history path found, checkpoint creation failed");
    recordSandboxOp(
      "session_history_read",
      Date.now() - sessionHistoryStart,
      false,
      "Session history path file not found",
    );
    recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
    return false;
  }

  const sessionHistoryPathRaw = fs
    .readFileSync(SESSION_HISTORY_PATH_FILE, "utf-8")
    .trim();

  // Handle Codex session search marker format: CODEX_SEARCH:{sessions_dir}:{session_id}
  let sessionHistoryPath: string;
  if (sessionHistoryPathRaw.startsWith("CODEX_SEARCH:")) {
    const parts = sessionHistoryPathRaw.split(":");
    if (parts.length !== 3) {
      logError(`Invalid Codex search marker format: ${sessionHistoryPathRaw}`);
      recordSandboxOp(
        "session_history_read",
        Date.now() - sessionHistoryStart,
        false,
        "Invalid Codex search marker",
      );
      recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
      return false;
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
        Date.now() - sessionHistoryStart,
        false,
        "Codex session file not found",
      );
      recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
      return false;
    }
    sessionHistoryPath = foundPath;
  } else {
    sessionHistoryPath = sessionHistoryPathRaw;
  }

  // Check if session history file exists
  if (!fs.existsSync(sessionHistoryPath)) {
    logError(
      `Session history file not found at ${sessionHistoryPath}, checkpoint creation failed`,
    );
    recordSandboxOp(
      "session_history_read",
      Date.now() - sessionHistoryStart,
      false,
      "Session history file not found",
    );
    recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
    return false;
  }

  // Read session history
  let cliAgentSessionHistory: string;
  try {
    cliAgentSessionHistory = fs.readFileSync(sessionHistoryPath, "utf-8");
  } catch (error) {
    logError(`Failed to read session history: ${error}`);
    recordSandboxOp(
      "session_history_read",
      Date.now() - sessionHistoryStart,
      false,
      String(error),
    );
    recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
    return false;
  }

  if (!cliAgentSessionHistory.trim()) {
    logError("Session history is empty, checkpoint creation failed");
    recordSandboxOp(
      "session_history_read",
      Date.now() - sessionHistoryStart,
      false,
      "Session history empty",
    );
    recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
    return false;
  }

  const lineCount = cliAgentSessionHistory.trim().split("\n").length;
  logInfo(`Session history loaded (${lineCount} lines)`);
  recordSandboxOp(
    "session_history_read",
    Date.now() - sessionHistoryStart,
    true,
  );

  // Create artifact snapshot (VAS only, optional)
  // If artifact is not configured, checkpoint is created without artifact snapshot
  let artifactSnapshot: {
    artifactName: string;
    artifactVersion: string;
  } | null = null;

  if (ARTIFACT_DRIVER && ARTIFACT_VOLUME_NAME) {
    logInfo(`Processing artifact with driver: ${ARTIFACT_DRIVER}`);

    if (ARTIFACT_DRIVER !== "vas") {
      logError(
        `Unknown artifact driver: ${ARTIFACT_DRIVER} (only 'vas' is supported)`,
      );
      recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
      return false;
    }

    // VAS artifact: create snapshot using direct S3 upload (bypasses Vercel 4.5MB limit)
    logInfo(
      `Creating VAS snapshot for artifact '${ARTIFACT_VOLUME_NAME}' at ${ARTIFACT_MOUNT_PATH}`,
    );
    logInfo("Using direct S3 upload...");

    const snapshot = await createDirectUploadSnapshot(
      ARTIFACT_MOUNT_PATH,
      ARTIFACT_VOLUME_NAME,
      "artifact",
      RUN_ID,
      `Checkpoint from run ${RUN_ID}`,
    );

    if (!snapshot) {
      logError("Failed to create VAS snapshot for artifact");
      recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
      return false;
    }

    // Extract versionId from snapshot response
    const artifactVersion = snapshot.versionId;
    if (!artifactVersion) {
      logError("Failed to extract versionId from snapshot");
      recordSandboxOp("checkpoint_total", Date.now() - checkpointStart, false);
      return false;
    }

    // Build artifact snapshot JSON with new format (artifactName + artifactVersion)
    artifactSnapshot = {
      artifactName: ARTIFACT_VOLUME_NAME,
      artifactVersion,
    };

    logInfo(
      `VAS artifact snapshot created: ${ARTIFACT_VOLUME_NAME}@${artifactVersion}`,
    );
  } else {
    logInfo(
      "No artifact configured, creating checkpoint without artifact snapshot",
    );
  }

  logInfo("Calling checkpoint API...");

  // Build checkpoint payload with new schema
  const checkpointPayload: Record<string, unknown> = {
    runId: RUN_ID,
    cliAgentType: CLI_AGENT_TYPE,
    cliAgentSessionId,
    cliAgentSessionHistory,
  };

  // Only add artifact snapshot if present
  if (artifactSnapshot) {
    checkpointPayload.artifactSnapshot = artifactSnapshot;
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
