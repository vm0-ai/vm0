import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

// Mock os module to return our temp directory as homedir
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

describe("cook-state", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-cook-state-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    // Make os.homedir() return tempDir
    vi.mocked(os.homedir).mockReturnValue(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  describe("loadCookState", () => {
    it("returns empty object when file doesn't exist", async () => {
      // Don't create the file, so it doesn't exist
      const { loadCookState } = await import("../cook-state");
      const state = await loadCookState();

      expect(state).toEqual({});
    });

    it("returns state for current PPID", async () => {
      const mockPpid = String(process.ppid);

      // Create real state file (note: the file is named cook.json, not cook-state.json)
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
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
      // Create real state file with different PPID
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
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
      // Create real state file with old format
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
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
      // Create real state file with invalid JSON
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
        "not valid json {{{",
      );

      const { loadCookState } = await import("../cook-state");
      const state = await loadCookState();

      expect(state).toEqual({});
    });
  });

  describe("saveCookState", () => {
    it("creates config directory if needed", async () => {
      // Directory doesn't exist yet
      const { saveCookState } = await import("../cook-state");
      await saveCookState({ lastRunId: "new-run" });

      // Verify directory was created
      expect(existsSync(path.join(tempDir, ".vm0"))).toBe(true);
    });

    it("saves state under current PPID with timestamp", async () => {
      const { saveCookState } = await import("../cook-state");
      await saveCookState({ lastRunId: "new-run" });

      // Read the real file (note: the file is named cook.json, not cook-state.json)
      const content = await fs.readFile(
        path.join(tempDir, ".vm0", "cook.json"),
        "utf-8",
      );
      const written = JSON.parse(content) as {
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

      // Create real state file with old and recent entries
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
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

      const { saveCookState } = await import("../cook-state");
      await saveCookState({ lastRunId: "new-run" });

      // Read the real file
      const content = await fs.readFile(
        path.join(tempDir, ".vm0", "cook.json"),
        "utf-8",
      );
      const written = JSON.parse(content) as {
        ppid: Record<string, unknown>;
      };

      expect(written.ppid["old-ppid"]).toBeUndefined();
      expect(written.ppid["recent-ppid"]).toBeDefined();
    });

    it("merges with existing entry for same PPID", async () => {
      const mockPpid = String(process.ppid);

      // Create real state file with existing entry
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
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

      const { saveCookState } = await import("../cook-state");
      await saveCookState({ lastRunId: "new-run" });

      // Read the real file
      const content = await fs.readFile(
        path.join(tempDir, ".vm0", "cook.json"),
        "utf-8",
      );
      const written = JSON.parse(content) as {
        ppid: Record<string, { lastRunId: string; lastSessionId: string }>;
      };

      expect(written.ppid[mockPpid]).toMatchObject({
        lastRunId: "new-run",
        lastSessionId: "old-session", // preserved from existing
      });
    });

    it("migrates old format on save", async () => {
      // Create real state file with old format
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "cook.json"),
        JSON.stringify({
          lastRunId: "old-run",
          lastSessionId: "old-session",
          lastCheckpointId: "old-checkpoint",
        }),
      );

      const { saveCookState } = await import("../cook-state");
      await saveCookState({
        lastRunId: "new-run",
      });

      // Read the real file
      const content = await fs.readFile(
        path.join(tempDir, ".vm0", "cook.json"),
        "utf-8",
      );
      const written = JSON.parse(content) as {
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
