/**
 * Network Logs
 *
 * Functions for reading, uploading, and cleaning up network logs
 * captured by mitmproxy addon during VM execution.
 */

import fs from "fs";
import type { NetworkLogEntry } from "./types.js";
import { createLogger } from "../logger.js";
import { tempPaths } from "../paths.js";

const logger = createLogger("NetworkLogs");

/**
 * Get the network log file path for a run
 */
function getNetworkLogPath(runId: string): string {
  return tempPaths.networkLog(runId);
}

/**
 * Read network logs from the JSONL file
 */
function readNetworkLogs(runId: string): NetworkLogEntry[] {
  const logPath = getNetworkLogPath(runId);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    return lines.map((line) => JSON.parse(line) as NetworkLogEntry);
  } catch (err) {
    logger.error(
      `Failed to read network logs: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    return [];
  }
}

/**
 * Delete network log file after upload
 */
function cleanupNetworkLogs(runId: string): void {
  const logPath = getNetworkLogPath(runId);

  try {
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  } catch (err) {
    logger.error(
      `Failed to cleanup network logs: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

/**
 * Upload network logs to telemetry endpoint
 */
export async function uploadNetworkLogs(
  apiUrl: string,
  sandboxToken: string,
  runId: string,
): Promise<void> {
  const networkLogs = readNetworkLogs(runId);

  if (networkLogs.length === 0) {
    logger.log(`No network logs to upload for ${runId}`);
    return;
  }

  logger.log(
    `Uploading ${networkLogs.length} network log entries for ${runId}`,
  );

  const headers: Record<string, string> = {
    Authorization: `Bearer ${sandboxToken}`,
    "Content-Type": "application/json",
  };

  // Add Vercel bypass secret if available
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  const response = await fetch(`${apiUrl}/api/webhooks/agent/telemetry`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      runId,
      networkLogs,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`Failed to upload network logs: ${errorText}`);
    return;
  }

  logger.log(`Network logs uploaded successfully for ${runId}`);

  // Cleanup log file after successful upload
  cleanupNetworkLogs(runId);
}
