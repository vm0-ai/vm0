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
} from "./common.js";
import { logInfo, logError } from "./log.js";
import { httpPostJson } from "./http-client.js";
import { createDirectUploadSnapshot } from "./direct-upload.js";

/**
 * Find Codex session file by searching in date-organized directories.
 * Codex stores sessions in: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * @param sessionsDir - Base sessions directory (e.g., ~/.codex/sessions)
 * @param sessionId - Session ID to find
 * @returns Full path to session file, or null if not found
 */
export function findCodexSessionFile(
  sessionsDir: string,
  sessionId: string,
): string | null {
  // Search for session file containing the session ID
  // Pattern: sessions/YYYY/MM/DD/rollout-*-{session_id_parts}.jsonl

  // Get all JSONL files recursively
  const files = findFilesRecursive(sessionsDir, ".jsonl");

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

/**
 * Recursively find files with given extension
 */
function findFilesRecursive(dir: string, ext: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Create checkpoint after successful run.
 *
 * @returns true on success, false on failure
 */
export async function createCheckpoint(): Promise<boolean> {
  logInfo("Creating checkpoint...");

  // Read session ID from temp file
  if (!fs.existsSync(SESSION_ID_FILE)) {
    logError("No session ID found, checkpoint creation failed");
    return false;
  }

  const cliAgentSessionId = fs.readFileSync(SESSION_ID_FILE, "utf-8").trim();

  // Read session history path from temp file
  if (!fs.existsSync(SESSION_HISTORY_PATH_FILE)) {
    logError("No session history path found, checkpoint creation failed");
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
      return false;
    }
    const sessionsDir = parts[1] as string;
    const codexSessionId = parts[2] as string;
    logInfo(`Searching for Codex session in ${sessionsDir}`);

    const foundPath = findCodexSessionFile(sessionsDir, codexSessionId);
    if (!foundPath) {
      logError(
        `Could not find Codex session file for ${codexSessionId} in ${sessionsDir}`,
      );
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
    return false;
  }

  // Read session history
  let cliAgentSessionHistory: string;
  try {
    cliAgentSessionHistory = fs.readFileSync(sessionHistoryPath, "utf-8");
  } catch (err) {
    logError(`Failed to read session history: ${err}`);
    return false;
  }

  if (!cliAgentSessionHistory.trim()) {
    logError("Session history is empty, checkpoint creation failed");
    return false;
  }

  const lineCount = cliAgentSessionHistory.trim().split("\n").length;
  logInfo(`Session history loaded (${lineCount} lines)`);

  // CLI agent type (default to claude-code)
  const cliAgentType = CLI_AGENT_TYPE;

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
      return false;
    }

    // Extract versionId from snapshot response
    const artifactVersion = snapshot.versionId;
    if (!artifactVersion) {
      logError("Failed to extract versionId from snapshot");
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
    cliAgentType,
    cliAgentSessionId,
    cliAgentSessionHistory,
  };

  // Only add artifact snapshot if present
  if (artifactSnapshot) {
    checkpointPayload.artifactSnapshot = artifactSnapshot;
  }

  // Call checkpoint API
  const result = await httpPostJson(CHECKPOINT_URL, checkpointPayload);

  // Validate response contains checkpointId to confirm checkpoint was actually created
  // Note: result can be {} (empty dict) on network issues, which is not null but invalid
  if (result && result.checkpointId) {
    const checkpointId = result.checkpointId;
    logInfo(`Checkpoint created successfully: ${checkpointId}`);
    return true;
  } else {
    logError(
      `Checkpoint API returned invalid response: ${JSON.stringify(result)}`,
    );
    return false;
  }
}
