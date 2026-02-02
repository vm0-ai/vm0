/**
 * Metrics collection module for sandbox resource monitoring.
 * Collects CPU, memory, and disk usage metrics.
 */
import * as fs from "fs";
import { execSync } from "child_process";
import { METRICS_LOG_FILE, METRICS_INTERVAL } from "./common.js";
import { logInfo, logError, logDebug } from "./log.js";

interface Metrics {
  ts: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

// Shutdown flag for stopping the collector
let shutdownRequested = false;

/**
 * Get CPU usage percentage by parsing /proc/stat.
 * Returns the CPU usage as a percentage (0-100).
 */
export function getCpuPercent(): number {
  try {
    const content = fs.readFileSync("/proc/stat", "utf-8");
    const line = content.split("\n")[0];

    if (!line) {
      return 0;
    }

    // cpu  user nice system idle iowait irq softirq steal guest guest_nice
    const parts = line.split(/\s+/);
    if (parts[0] !== "cpu") {
      return 0;
    }

    const values = parts.slice(1).map((x) => parseInt(x, 10));
    const idleVal = values[3];
    const iowaitVal = values[4];
    if (idleVal === undefined || iowaitVal === undefined) {
      return 0;
    }
    const idle = idleVal + iowaitVal; // idle + iowait
    const total = values.reduce((a, b) => a + b, 0);

    if (total === 0) {
      return 0;
    }

    const cpuPercent = 100 * (1 - idle / total);
    return Math.round(cpuPercent * 100) / 100;
  } catch (error) {
    logDebug(`Failed to get CPU percent: ${error}`);
    return 0;
  }
}

/**
 * Get memory usage using 'free -b' command.
 * Returns [used, total] in bytes.
 */
export function getMemoryInfo(): [number, number] {
  try {
    const result = execSync("free -b", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse output:
    // Mem:  total  used  free  shared  buff/cache  available
    const lines = result.trim().split("\n");
    for (const line of lines) {
      if (line.startsWith("Mem:")) {
        const parts = line.split(/\s+/);
        const totalStr = parts[1];
        const usedStr = parts[2];
        if (!totalStr || !usedStr) {
          return [0, 0];
        }
        const total = parseInt(totalStr, 10);
        const used = parseInt(usedStr, 10);
        return [used, total];
      }
    }

    return [0, 0];
  } catch (error) {
    logDebug(`Failed to get memory info: ${error}`);
    return [0, 0];
  }
}

/**
 * Get disk usage using 'df -B1 /' command.
 * Returns [used, total] in bytes.
 */
export function getDiskInfo(): [number, number] {
  try {
    const result = execSync("df -B1 /", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse output:
    // Filesystem  1B-blocks  Used  Available  Use%  Mounted
    const lines = result.trim().split("\n");
    if (lines.length < 2) {
      return [0, 0];
    }

    // Skip header, parse data line
    const dataLine = lines[1];
    if (!dataLine) {
      return [0, 0];
    }
    const parts = dataLine.split(/\s+/);
    const totalStr = parts[1];
    const usedStr = parts[2];
    if (!totalStr || !usedStr) {
      return [0, 0];
    }
    const total = parseInt(totalStr, 10);
    const used = parseInt(usedStr, 10);
    return [used, total];
  } catch (error) {
    logDebug(`Failed to get disk info: ${error}`);
    return [0, 0];
  }
}

/**
 * Collect all system metrics and return as an object.
 */
export function collectMetrics(): Metrics {
  const cpu = getCpuPercent();
  const [memUsed, memTotal] = getMemoryInfo();
  const [diskUsed, diskTotal] = getDiskInfo();

  return {
    ts: new Date().toISOString(),
    cpu,
    mem_used: memUsed,
    mem_total: memTotal,
    disk_used: diskUsed,
    disk_total: diskTotal,
  };
}

/**
 * Background loop that collects metrics every METRICS_INTERVAL seconds.
 * Writes metrics as JSONL to METRICS_LOG_FILE.
 */
function metricsCollectorLoop(): void {
  logInfo(`Metrics collector started, writing to ${METRICS_LOG_FILE}`);

  const writeMetrics = (): void => {
    if (shutdownRequested) {
      logInfo("Metrics collector stopped");
      return;
    }

    try {
      const metrics = collectMetrics();
      fs.appendFileSync(METRICS_LOG_FILE, JSON.stringify(metrics) + "\n");
      logDebug(
        `Metrics collected: cpu=${metrics.cpu}%, mem=${metrics.mem_used}/${metrics.mem_total}`,
      );
    } catch (error) {
      logError(`Failed to collect/write metrics: ${error}`);
    }

    // Schedule next collection
    setTimeout(writeMetrics, METRICS_INTERVAL * 1000);
  };

  // Start collecting immediately
  writeMetrics();
}

/**
 * Start the metrics collector as a background process.
 * Uses setTimeout chain internally, no explicit thread management needed.
 */
export function startMetricsCollector(): void {
  shutdownRequested = false;
  // Run in background using setTimeout chain
  setTimeout(metricsCollectorLoop, 0);
}

/**
 * Stop the metrics collector.
 */
export function stopMetricsCollector(): void {
  shutdownRequested = true;
}
