/**
 * Telemetry upload module for VM0 sandbox.
 * Reads system log and metrics files, tracks position to avoid duplicates,
 * and uploads to the telemetry webhook endpoint.
 * Masks secrets before sending using client-side masking.
 */
import * as fs from "fs";
import {
  RUN_ID,
  TELEMETRY_URL,
  TELEMETRY_INTERVAL,
  SYSTEM_LOG_FILE,
  METRICS_LOG_FILE,
  NETWORK_LOG_FILE,
  TELEMETRY_LOG_POS_FILE,
  TELEMETRY_METRICS_POS_FILE,
  TELEMETRY_NETWORK_POS_FILE,
} from "./common.js";
import { logInfo, logError, logDebug, logWarn } from "./log.js";
import { httpPostJson } from "./http-client.js";
import { maskData } from "./secret-masker.js";
import { isShutdownRequested } from "./metrics.js";

/**
 * Read new content from file starting from last position.
 *
 * @param filePath - Path to the file to read
 * @param posFile - Path to position tracking file
 * @returns [newContent, newPosition]
 */
export function readFileFromPosition(
  filePath: string,
  posFile: string,
): [string, number] {
  // Get last read position
  let lastPos = 0;
  if (fs.existsSync(posFile)) {
    try {
      lastPos = parseInt(fs.readFileSync(posFile, "utf-8").trim(), 10);
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
      try {
        const stats = fs.fstatSync(fd);
        const bytesToRead = stats.size - lastPos;
        if (bytesToRead > 0) {
          const buffer = Buffer.alloc(bytesToRead);
          fs.readSync(fd, buffer, 0, bytesToRead, lastPos);
          newContent = buffer.toString("utf-8");
          newPos = stats.size;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      logDebug(`Failed to read ${filePath}: ${e}`);
    }
  }

  return [newContent, newPos];
}

/**
 * Save file read position for next iteration.
 */
export function savePosition(posFile: string, position: number): void {
  try {
    fs.writeFileSync(posFile, String(position));
  } catch (e) {
    logDebug(`Failed to save position to ${posFile}: ${e}`);
  }
}

/**
 * Read new entries from JSONL file starting from last position.
 *
 * @param filePath - Path to the JSONL file to read
 * @param posFile - Path to position tracking file
 * @returns [entries, newPosition]
 */
export function readJsonlFromPosition(
  filePath: string,
  posFile: string,
): [Record<string, unknown>[], number] {
  const [content, newPos] = readFileFromPosition(filePath, posFile);

  const entries: Record<string, unknown>[] = [];
  if (content) {
    for (const line of content.trim().split("\n")) {
      if (line) {
        try {
          entries.push(JSON.parse(line) as Record<string, unknown>);
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
export function readMetricsFromPosition(
  posFile: string,
): [Record<string, unknown>[], number] {
  return readJsonlFromPosition(METRICS_LOG_FILE, posFile);
}

/**
 * Read new network logs from JSONL file starting from last position.
 */
export function readNetworkLogsFromPosition(
  posFile: string,
): [Record<string, unknown>[], number] {
  return readJsonlFromPosition(NETWORK_LOG_FILE, posFile);
}

/**
 * Upload telemetry data to VM0 API.
 *
 * @returns true if upload succeeded or no data to upload, false on failure
 */
export async function uploadTelemetry(): Promise<boolean> {
  // Read new system log content
  const [systemLog, logPos] = readFileFromPosition(
    SYSTEM_LOG_FILE,
    TELEMETRY_LOG_POS_FILE,
  );

  // Read new metrics
  const [metrics, metricsPos] = readMetricsFromPosition(
    TELEMETRY_METRICS_POS_FILE,
  );

  // Read new network logs
  const [networkLogs, networkPos] = readNetworkLogsFromPosition(
    TELEMETRY_NETWORK_POS_FILE,
  );

  // Skip if nothing new
  if (!systemLog && metrics.length === 0 && networkLogs.length === 0) {
    logDebug("No new telemetry data to upload");
    return true;
  }

  // Mask secrets in telemetry data before sending
  // System log and network logs may contain sensitive information
  const maskedSystemLog = systemLog ? maskData(systemLog) : "";
  const maskedNetworkLogs = networkLogs.length > 0 ? maskData(networkLogs) : [];

  // Upload to API
  const payload = {
    runId: RUN_ID,
    systemLog: maskedSystemLog,
    metrics, // Metrics don't contain secrets (just numbers)
    networkLogs: maskedNetworkLogs,
  };

  logDebug(
    `Uploading telemetry: ${systemLog.length} bytes log, ${metrics.length} metrics, ${networkLogs.length} network logs`,
  );

  const result = await httpPostJson(TELEMETRY_URL, payload, 1);

  if (result) {
    // Save positions only on successful upload
    savePosition(TELEMETRY_LOG_POS_FILE, logPos);
    savePosition(TELEMETRY_METRICS_POS_FILE, metricsPos);
    savePosition(TELEMETRY_NETWORK_POS_FILE, networkPos);
    logDebug(
      `Telemetry uploaded successfully: ${(result as Record<string, unknown>).id ?? "unknown"}`,
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
export function telemetryUploadLoop(): void {
  logInfo(`Telemetry upload started (interval: ${TELEMETRY_INTERVAL}s)`);

  const uploadAndSchedule = (): void => {
    if (isShutdownRequested()) {
      logInfo("Telemetry upload stopped");
      return;
    }

    uploadTelemetry().catch((e) => {
      logError(`Telemetry upload error: ${e}`);
    });

    // Schedule next upload
    if (!isShutdownRequested()) {
      setTimeout(uploadAndSchedule, TELEMETRY_INTERVAL * 1000);
    }
  };

  // Start uploading after first interval
  setTimeout(uploadAndSchedule, TELEMETRY_INTERVAL * 1000);
}

/**
 * Start the telemetry uploader as a background timer.
 */
export function startTelemetryUpload(): void {
  // Start in next tick to avoid blocking
  setImmediate(() => {
    telemetryUploadLoop();
  });
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
