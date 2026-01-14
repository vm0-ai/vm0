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

    it("returns state for current PPID", async () => {
      const mockPpid = String(process.ppid);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          ppid: {
            [mockPpid]: {
              lastRunId: "run-123",
              lastSessionId: "session-456",
              lastCheckpointId: "checkpoint-789",
              lastActiveAt: Date.now(),
            },
          },
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

    it("returns empty object for different PPID", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          ppid: {
            "99999": {
              lastRunId: "run-123",
              lastActiveAt: Date.now(),
            },
          },
        }),
      );

      const { loadCookState } = await import("../cook-state");
      const state = await loadCookState();

      expect(state).toEqual({});
    });

    it("migrates old format to current PPID", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          lastRunId: "old-run",
          lastSessionId: "old-session",
        }),
      );

      const { loadCookState } = await import("../cook-state");
      const state = await loadCookState();

      expect(state).toEqual({
        lastRunId: "old-run",
        lastSessionId: "old-session",
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

    it("saves state under current PPID with timestamp", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue();

      const { saveCookState } = await import("../cook-state");
      await saveCookState({ lastRunId: "new-run" });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]!;
      const written = JSON.parse(writeCall[1] as string) as {
        ppid: Record<string, { lastRunId: string; lastActiveAt: number }>;
      };
      const ppidEntry = written.ppid[String(process.ppid)];

      expect(ppidEntry).toMatchObject({
        lastRunId: "new-run",
      });
      expect(ppidEntry?.lastActiveAt).toBeDefined();
    });

    it("cleans up entries older than 48 hours", async () => {
      const now = Date.now();
      const oldTimestamp = now - 49 * 60 * 60 * 1000; // 49 hours ago

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          ppid: {
            "old-ppid": {
              lastRunId: "old-run",
              lastActiveAt: oldTimestamp,
            },
            "recent-ppid": {
              lastRunId: "recent-run",
              lastActiveAt: now - 1000, // 1 second ago
            },
          },
        }),
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue();

      const { saveCookState } = await import("../cook-state");
      await saveCookState({ lastRunId: "new-run" });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]!;
      const written = JSON.parse(writeCall[1] as string) as {
        ppid: Record<string, unknown>;
      };

      expect(written.ppid["old-ppid"]).toBeUndefined();
      expect(written.ppid["recent-ppid"]).toBeDefined();
    });

    it("merges with existing entry for same PPID", async () => {
      const mockPpid = String(process.ppid);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          ppid: {
            [mockPpid]: {
              lastRunId: "old-run",
              lastSessionId: "old-session",
              lastActiveAt: Date.now() - 1000,
            },
          },
        }),
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue();

      const { saveCookState } = await import("../cook-state");
      await saveCookState({ lastRunId: "new-run" });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]!;
      const written = JSON.parse(writeCall[1] as string) as {
        ppid: Record<string, { lastRunId: string; lastSessionId: string }>;
      };

      expect(written.ppid[mockPpid]).toMatchObject({
        lastRunId: "new-run",
        lastSessionId: "old-session", // preserved from existing
      });
    });

    it("migrates old format on save", async () => {
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
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]!;
      const written = JSON.parse(writeCall[1] as string) as {
        ppid: Record<
          string,
          {
            lastRunId: string;
            lastSessionId: string;
            lastCheckpointId: string;
          }
        >;
      };

      // Should have ppid structure now
      expect(written.ppid).toBeDefined();
      expect(written.ppid[String(process.ppid)]).toMatchObject({
        lastRunId: "new-run",
        lastSessionId: "old-session",
        lastCheckpointId: "old-checkpoint",
      });
    });
  });
});
