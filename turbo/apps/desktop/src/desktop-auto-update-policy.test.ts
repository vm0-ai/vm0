import { describe, expect, it } from "vitest";

import {
  DESKTOP_UPDATE_SILENT_RESTART_IDLE_MS,
  shouldDeferDesktopUpdate,
} from "./desktop-auto-update-policy";
import type {
  ComputerUseHostRuntimeState,
  ComputerUseLocalCommandLogEntry,
} from "./computer-use-types";

const now = Date.parse("2026-06-11T12:00:00.000Z");

function isoAgo(ms: number): string {
  return new Date(now - ms).toISOString();
}

function commandEntry(
  overrides: Partial<ComputerUseLocalCommandLogEntry>,
): ComputerUseLocalCommandLogEntry {
  return {
    commandId: "command-1",
    kind: "click",
    app: "Safari",
    status: "succeeded",
    payload: {},
    result: null,
    error: null,
    startedAt: isoAgo(60 * 60 * 1000),
    completedAt: isoAgo(60 * 60 * 1000),
    durationMs: 100,
    ...overrides,
  };
}

function hostState(
  overrides: Partial<ComputerUseHostRuntimeState>,
): ComputerUseHostRuntimeState {
  return {
    status: "offline",
    hostId: null,
    lastHeartbeatAt: null,
    lastCommandAt: null,
    lastError: null,
    recovery: null,
    errorLog: [],
    localCommandLog: [],
    ...overrides,
  };
}

describe("desktop auto-update policy", () => {
  it("allows silent restart when there is no command activity", () => {
    expect(shouldDeferDesktopUpdate(hostState({}), now)).toBe(false);
  });

  it("allows silent restart when the last command is older than 30 minutes", () => {
    expect(
      shouldDeferDesktopUpdate(
        hostState({
          lastCommandAt: isoAgo(DESKTOP_UPDATE_SILENT_RESTART_IDLE_MS + 1),
        }),
        now,
      ),
    ).toBe(false);
  });

  it("defers when the last command completed within 30 minutes", () => {
    expect(
      shouldDeferDesktopUpdate(
        hostState({
          lastCommandAt: isoAgo(DESKTOP_UPDATE_SILENT_RESTART_IDLE_MS - 1),
        }),
        now,
      ),
    ).toBe(true);
  });

  it("defers when a local command log entry completed within 30 minutes", () => {
    expect(
      shouldDeferDesktopUpdate(
        hostState({
          localCommandLog: [
            commandEntry({
              startedAt: isoAgo(DESKTOP_UPDATE_SILENT_RESTART_IDLE_MS + 1),
              completedAt: isoAgo(DESKTOP_UPDATE_SILENT_RESTART_IDLE_MS - 1),
            }),
          ],
        }),
        now,
      ),
    ).toBe(true);
  });

  it("defers while a command is still running", () => {
    expect(
      shouldDeferDesktopUpdate(
        hostState({
          localCommandLog: [
            commandEntry({
              status: "running",
              completedAt: null,
              startedAt: isoAgo(2 * 60 * 60 * 1000),
            }),
          ],
        }),
        now,
      ),
    ).toBe(true);
  });

  it("ignores malformed timestamps", () => {
    expect(
      shouldDeferDesktopUpdate(
        hostState({
          lastCommandAt: "not-a-date",
          localCommandLog: [
            commandEntry({
              startedAt: "not-a-date",
              completedAt: "not-a-date",
            }),
          ],
        }),
        now,
      ),
    ).toBe(false);
  });
});
