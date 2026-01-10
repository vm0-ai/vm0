/**
 * Metrics collection module for VM0 sandbox.
 * Collects system resource metrics (CPU, memory, disk) and writes to JSONL file.
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
    const idle = (values[3] ?? 0) + (values[4] ?? 0); // idle + iowait
    const total = values.reduce((a, b) => a + b, 0);

    // For simplicity, just return instantaneous value based on idle ratio
    // This gives a rough estimate; for accurate CPU%, we'd need to track deltas
    if (total === 0) {
      return 0;
    }

    const cpuPercent = 100.0 * (1.0 - idle / total);
    return Math.round(cpuPercent * 100) / 100;
  } catch (e) {
    logDebug(`Failed to get CPU percent: ${e}`);
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
        const total = parseInt(parts[1] ?? "0", 10);
        const used = parseInt(parts[2] ?? "0", 10);
        return [used, total];
      }
    }

    return [0, 0];
  } catch (e) {
    logDebug(`Failed to get memory info: ${e}`);
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
    const total = parseInt(parts[1] ?? "0", 10);
    const used = parseInt(parts[2] ?? "0", 10);
    return [used, total];
  } catch (e) {
    logDebug(`Failed to get disk info: ${e}`);
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
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    cpu,
    mem_used: memUsed,
    mem_total: memTotal,
    disk_used: diskUsed,
    disk_total: diskTotal,
  };
}

/**
 * Shutdown signal for background loops.
 */
let shutdownRequested = false;

/**
 * Request shutdown of background loops.
 */
export function requestShutdown(): void {
  shutdownRequested = true;
}

/**
 * Check if shutdown has been requested.
 */
export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

/**
 * Background loop that collects metrics every METRICS_INTERVAL seconds.
 * Writes metrics as JSONL to METRICS_LOG_FILE.
 */
export function metricsCollectorLoop(): void {
  logInfo(`Metrics collector started, writing to ${METRICS_LOG_FILE}`);

  const collectAndWrite = (): void => {
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
    } catch (e) {
      logError(`Failed to collect/write metrics: ${e}`);
    }

    // Schedule next collection
    if (!shutdownRequested) {
      setTimeout(collectAndWrite, METRICS_INTERVAL * 1000);
    }
  };

  // Start collecting immediately
  collectAndWrite();
}

/**
 * Start the metrics collector as a background timer.
 */
export function startMetricsCollector(): void {
  // Reset shutdown flag
  shutdownRequested = false;

  // Start in next tick to avoid blocking
  setImmediate(() => {
    metricsCollectorLoop();
  });
}
