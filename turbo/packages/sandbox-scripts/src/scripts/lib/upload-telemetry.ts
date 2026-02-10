/**
 * Telemetry upload module for sandbox.
 * Uploads system log and metrics to VM0 API.
 * Masks secrets before sending using client-side masking.
 */
import * as fs from "fs";
import {
  RUN_ID,
  TELEMETRY_URL,
  TELEMETRY_INTERVAL,
  SYSTEM_LOG_FILE,
  METRICS_LOG_FILE,
  SANDBOX_OPS_LOG_FILE,
  TELEMETRY_LOG_POS_FILE,
  TELEMETRY_METRICS_POS_FILE,
  TELEMETRY_SANDBOX_OPS_POS_FILE,
} from "./common.js";
import { logInfo, logError, logDebug, logWarn } from "./log.js";
import { httpPostJson } from "./http-client.js";
import { maskData } from "./secret-masker.js";

// Shutdown flag for stopping the uploader
let shutdownRequested = false;

/**
 * Read new content from file starting from last position.
 * Exported for testing.
 *
 * @param filePath - Path to the file to read
 * @param posFile - Path to position tracking file
 * @returns Tuple of [new_content, new_position]
 */
export function readFileFromPosition(
  filePath: string,
  posFile: string,
): [string, number] {
  // Get last read position
  let lastPos = 0;
  if (fs.existsSync(posFile)) {
    try {
      const content = fs.readFileSync(posFile, "utf-8").trim();
      lastPos = parseInt(content, 10) || 0;
    } catch {
      lastPos = 0;
    }
  }

  // Read new content
  let newContent = "";
  let newPos = lastPos;

  if (fs.existsSync(filePath)) {
    try {
      const fd = fs.openSync(filePath, "r");
      const stats = fs.fstatSync(fd);
      const bufferSize = stats.size - lastPos;

      if (bufferSize > 0) {
        const buffer = Buffer.alloc(bufferSize);
        fs.readSync(fd, buffer, 0, bufferSize, lastPos);
        newContent = buffer.toString("utf-8");
        newPos = stats.size;
      }

      fs.closeSync(fd);
    } catch (error) {
      logDebug(`Failed to read ${filePath}: ${error}`);
    }
  }

  return [newContent, newPos];
}

/**
 * Save file read position for next iteration.
 * Exported for testing.
 */
export function savePosition(posFile: string, position: number): void {
  try {
    fs.writeFileSync(posFile, String(position));
  } catch (error) {
    logDebug(`Failed to save position to ${posFile}: ${error}`);
  }
}

interface JsonEntry {
  [key: string]: unknown;
}

/**
 * Read new entries from JSONL file starting from last position.
 * Exported for testing.
 *
 * @param filePath - Path to the JSONL file to read
 * @param posFile - Path to position tracking file
 * @returns Tuple of [entries list, new_position]
 */
export function readJsonlFromPosition(
  filePath: string,
  posFile: string,
): [JsonEntry[], number] {
  const [content, newPos] = readFileFromPosition(filePath, posFile);

  const entries: JsonEntry[] = [];
  if (content) {
    for (const line of content.trim().split("\n")) {
      if (line) {
        try {
          entries.push(JSON.parse(line) as JsonEntry);
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
  }

  return [entries, newPos];
}

/**
 * Read new metrics from JSONL file starting from last position.
 */
function readMetricsFromPosition(posFile: string): [JsonEntry[], number] {
  return readJsonlFromPosition(METRICS_LOG_FILE, posFile);
}

/**
 * Read new sandbox operations from JSONL file starting from last position.
 */
function readSandboxOpsFromPosition(posFile: string): [JsonEntry[], number] {
  return readJsonlFromPosition(SANDBOX_OPS_LOG_FILE, posFile);
}

/**
 * Upload telemetry data to VM0 API.
 *
 * @returns true if upload succeeded or no data to upload, false on failure
 */
async function uploadTelemetry(): Promise<boolean> {
  // Read new system log content
  const [systemLog, logPos] = readFileFromPosition(
    SYSTEM_LOG_FILE,
    TELEMETRY_LOG_POS_FILE,
  );

  // Read new metrics
  const [metrics, metricsPos] = readMetricsFromPosition(
    TELEMETRY_METRICS_POS_FILE,
  );

  // Read new sandbox operations
  const [sandboxOps, sandboxOpsPos] = readSandboxOpsFromPosition(
    TELEMETRY_SANDBOX_OPS_POS_FILE,
  );

  // Skip if nothing new
  if (!systemLog && metrics.length === 0 && sandboxOps.length === 0) {
    logDebug("No new telemetry data to upload");
    return true;
  }

  // Mask secrets in telemetry data before sending
  const maskedSystemLog = systemLog ? maskData(systemLog) : "";

  // Upload to API
  const payload = {
    runId: RUN_ID,
    systemLog: maskedSystemLog,
    metrics, // Metrics don't contain secrets (just numbers)
    sandboxOperations: sandboxOps, // Sandbox ops don't contain secrets (just timing data)
  };

  logDebug(
    `Uploading telemetry: ${systemLog.length} bytes log, ${metrics.length} metrics, ${sandboxOps.length} sandbox ops`,
  );

  const result = await httpPostJson(TELEMETRY_URL, payload, 1);

  if (result) {
    // Save positions only on successful upload
    savePosition(TELEMETRY_LOG_POS_FILE, logPos);
    savePosition(TELEMETRY_METRICS_POS_FILE, metricsPos);
    savePosition(TELEMETRY_SANDBOX_OPS_POS_FILE, sandboxOpsPos);
    logDebug(
      `Telemetry uploaded successfully: ${(result as { id?: string }).id ?? "unknown"}`,
    );
    return true;
  } else {
    logWarn("Failed to upload telemetry (will retry next interval)");
    return false;
  }
}

/**
 * Background loop that uploads telemetry every TELEMETRY_INTERVAL seconds.
 */
async function telemetryUploadLoop(): Promise<void> {
  logInfo(`Telemetry upload started (interval: ${TELEMETRY_INTERVAL}s)`);

  const runUpload = async (): Promise<void> => {
    if (shutdownRequested) {
      logInfo("Telemetry upload stopped");
      return;
    }

    try {
      await uploadTelemetry();
    } catch (error) {
      logError(`Telemetry upload error: ${error}`);
    }

    // Schedule next upload
    setTimeout(() => void runUpload(), TELEMETRY_INTERVAL * 1000);
  };

  // Start uploading
  await runUpload();
}

/**
 * Start the telemetry uploader as a background process.
 */
export function startTelemetryUpload(): void {
  shutdownRequested = false;
  // Run in background
  setTimeout(() => void telemetryUploadLoop(), 0);
}

/**
 * Stop the telemetry uploader.
 */
export function stopTelemetryUpload(): void {
  shutdownRequested = true;
}

/**
 * Perform final telemetry upload before agent completion.
 * This ensures all remaining data is captured.
 *
 * @returns true if upload succeeded, false on failure
 */
export async function finalTelemetryUpload(): Promise<boolean> {
  logInfo("Performing final telemetry upload...");
  return uploadTelemetry();
}
