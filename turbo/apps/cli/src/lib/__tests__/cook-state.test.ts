import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { existsSync } from "fs";

// Mock dependencies
vi.mock("fs/promises");
vi.mock("fs");
vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

describe("cook-state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("loadCookState", () => {
    it("returns empty object when file doesn't exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { loadCookState } = await import("../cook-state");
      const state = await loadCookState();

      expect(state).toEqual({});
    });

    it("returns parsed state from file", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          lastRunId: "run-123",
          lastSessionId: "session-456",
          lastCheckpointId: "checkpoint-789",
        }),
      );

      const { loadCookState } = await import("../cook-state");
      const state = await loadCookState();

      expect(state).toEqual({
        lastRunId: "run-123",
        lastSessionId: "session-456",
        lastCheckpointId: "checkpoint-789",
      });
    });

    it("returns empty object when JSON is corrupted", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("not valid json {{{");

      const { loadCookState } = await import("../cook-state");
      const state = await loadCookState();

      expect(state).toEqual({});
    });
  });

  describe("saveCookState", () => {
    it("creates config directory if needed", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue();

      const { saveCookState } = await import("../cook-state");
      await saveCookState({ lastRunId: "new-run" });

      expect(fs.mkdir).toHaveBeenCalledWith("/home/testuser/.vm0", {
        recursive: true,
      });
    });

    it("merges with existing state", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          lastRunId: "old-run",
          lastSessionId: "old-session",
        }),
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue();

      const { saveCookState } = await import("../cook-state");
      await saveCookState({ lastRunId: "new-run" });

      expect(fs.writeFile).toHaveBeenCalledWith(
        "/home/testuser/.vm0/cook.json",
        JSON.stringify(
          {
            lastRunId: "new-run",
            lastSessionId: "old-session",
          },
          null,
          2,
        ),
        "utf8",
      );
    });

    it("overwrites existing keys", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          lastRunId: "old-run",
          lastSessionId: "old-session",
          lastCheckpointId: "old-checkpoint",
        }),
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue();

      const { saveCookState } = await import("../cook-state");
      await saveCookState({
        lastRunId: "new-run",
        lastSessionId: "new-session",
        lastCheckpointId: "new-checkpoint",
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        "/home/testuser/.vm0/cook.json",
        JSON.stringify(
          {
            lastRunId: "new-run",
            lastSessionId: "new-session",
            lastCheckpointId: "new-checkpoint",
          },
          null,
          2,
        ),
        "utf8",
      );
    });
  });
});
