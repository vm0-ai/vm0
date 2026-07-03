import type { ComputerUseHostRuntimeState } from "./computer-use-types";

export const DESKTOP_UPDATE_SILENT_RESTART_IDLE_MS = 30 * 60 * 1000;

function timestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecentTimestamp(value: string | null, nowMs: number): boolean {
  const parsed = timestampMs(value);
  return (
    parsed !== null && parsed >= nowMs - DESKTOP_UPDATE_SILENT_RESTART_IDLE_MS
  );
}

export function shouldNotifyUserForDesktopUpdate(
  hostState: ComputerUseHostRuntimeState,
  nowMs = Date.now(),
): boolean {
  if (isRecentTimestamp(hostState.lastCommandAt, nowMs)) {
    return true;
  }

  return hostState.localCommandLog.some((entry) => {
    if (entry.status === "running") {
      return true;
    }
    return (
      isRecentTimestamp(entry.startedAt, nowMs) ||
      isRecentTimestamp(entry.completedAt, nowMs)
    );
  });
}
