/**
 * Heartbeat module for agent health monitoring.
 *
 * Sends periodic heartbeat signals to indicate agent is alive.
 * The first heartbeat is critical - if it fails, the returned Promise rejects
 * to notify the main execution loop (fail-fast for network issues).
 */

import { httpPostJson } from "./http-client.js";
import { logInfo, logWarn, logError } from "./log.js";

// Global shutdown flag
let shutdownRequested = false;

/**
 * Request shutdown of heartbeat loop.
 * Called during cleanup to stop background heartbeats.
 */
export function requestShutdown(): void {
  shutdownRequested = true;
}

/**
 * Reset shutdown flag.
 * Used for testing to reset state between tests.
 */
export function resetShutdown(): void {
  shutdownRequested = false;
}

export interface HeartbeatConfig {
  heartbeatUrl: string;
  runId: string;
  intervalSeconds: number;
  /**
   * Optional scheduler for next heartbeat. Defaults to setTimeout.
   * Injected for testing to avoid fake timers.
   */
  scheduleNext?: (callback: () => void, delayMs: number) => void;
}

/**
 * Start heartbeat loop.
 *
 * The first heartbeat is critical - if it fails, the returned Promise rejects
 * to notify the main execution loop. Subsequent failures are logged as warnings
 * since they may be transient network issues.
 *
 * @param config - Heartbeat configuration
 * @returns Promise that rejects if first heartbeat fails (never resolves otherwise)
 */
export function startHeartbeat(config: HeartbeatConfig): Promise<never> {
  const { heartbeatUrl, runId, intervalSeconds, scheduleNext } = config;
  const scheduler = scheduleNext ?? setTimeout;

  let isFirstHeartbeat = true;
  let rejectFirstHeartbeat: ((error: Error) => void) | null = null;

  // Create a promise that rejects on first heartbeat failure
  const heartbeatFailed = new Promise<never>((_, reject) => {
    rejectFirstHeartbeat = reject;
  });

  const sendHeartbeat = async (): Promise<void> => {
    if (shutdownRequested) {
      return;
    }

    try {
      const result = await httpPostJson(heartbeatUrl, { runId });

      if (result !== null) {
        logInfo(
          isFirstHeartbeat ? "Heartbeat sent (initial)" : "Heartbeat sent",
        );
        isFirstHeartbeat = false;
      } else if (isFirstHeartbeat) {
        // First heartbeat failed - fatal, network issue
        const error = new Error(
          `Network connectivity check failed - cannot reach API at ${heartbeatUrl}`,
        );
        logError(error.message);
        isFirstHeartbeat = false; // Prevent repeated rejection
        rejectFirstHeartbeat?.(error);
        return; // Stop heartbeat loop
      } else {
        // Subsequent heartbeat failed - just warn (may be transient)
        logWarn("Heartbeat failed");
      }
    } catch (err) {
      if (isFirstHeartbeat) {
        const error = new Error(`Network connectivity check failed: ${err}`);
        logError(error.message);
        isFirstHeartbeat = false; // Prevent repeated rejection
        rejectFirstHeartbeat?.(error);
        return; // Stop heartbeat loop
      } else {
        logWarn(`Heartbeat error: ${err}`);
      }
    }

    // Schedule next heartbeat (fire-and-forget, errors handled internally)
    scheduler(() => {
      sendHeartbeat().catch(() => {
        // Errors already logged in sendHeartbeat
      });
    }, intervalSeconds * 1000);
  };

  // Start heartbeat loop immediately (fire-and-forget)
  sendHeartbeat().catch(() => {
    // Errors already logged in sendHeartbeat
  });

  return heartbeatFailed;
}
