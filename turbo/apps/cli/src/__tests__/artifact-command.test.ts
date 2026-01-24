/**
 * Unit tests for artifact command validation and error handling
 *
 * These tests validate artifact name validation rules, configuration checks,
 * and error message formatting. They replace E2E tests that tested the same
 * behavior through the full stack.
 *
 * Key behaviors tested:
 * - Artifact name validation (lowercase, with hyphens, 3-64 chars)
 * - Init command behavior with existing configs
 * - Push/Pull config validation (no config, wrong type)
 * - Error message formatting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initCommand } from "../commands/artifact/init";
import { pushCommand } from "../commands/artifact/push";
import { pullCommand } from "../commands/artifact/pull";
import { artifactCommand } from "../commands/artifact/index";
// Import the actual isValidStorageName function for validation tests
import { isValidStorageName } from "../lib/storage/storage-utils";
import * as storageUtils from "../lib/storage/storage-utils";
import chalk from "chalk";

// Mock storage utils but keep the real isValidStorageName implementation available
// Note: Consider replacing with real implementations using temp directories
vi.mock("../lib/storage/storage-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/storage/storage-utils")>();
  return {
    ...actual,
    readStorageConfig: vi.fn(),
    writeStorageConfig: vi.fn(),
  };
});
vi.mock("../lib/storage/direct-upload", () => ({
  directUpload: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  getStorageDownload: vi.fn(),
}));

describe("Artifact Command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const originalCwd = process.cwd;

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    process.cwd = () => "/test/dir";
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    process.cwd = originalCwd;
    vi.unstubAllEnvs();
  });

  describe("help text", () => {
    it("artifact --help shows command description", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await artifactCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain(
        "Manage artifacts (specified at run, versioned after run)",
      );
      expect(output).toContain("init");
      expect(output).toContain("push");
      expect(output).toContain("pull");
      expect(output).toContain("status");

      mockStdoutWrite.mockRestore();
    });

    it("artifact init --help shows --name option", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await initCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Initialize an artifact");
      expect(output).toContain("--name");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("artifact name validation", () => {
    it("isValidStorageName rejects uppercase names", () => {
      expect(isValidStorageName("INVALID_NAME")).toBe(false);
    });

    it("isValidStorageName rejects names with underscores", () => {
      expect(isValidStorageName("invalid_name")).toBe(false);
    });

    it("isValidStorageName rejects names shorter than 3 characters", () => {
      expect(isValidStorageName("ab")).toBe(false);
    });

    it("isValidStorageName rejects names with consecutive hyphens", () => {
      expect(isValidStorageName("invalid--name")).toBe(false);
    });

    it("isValidStorageName accepts valid lowercase names with hyphens", () => {
      expect(isValidStorageName("my-artifact")).toBe(true);
      expect(isValidStorageName("test-artifact-123")).toBe(true);
    });

    it("artifact init rejects invalid artifact name", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue(null);
      // The real isValidStorageName will be used here since we don't mock it

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "INVALID_NAME"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid artifact name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("artifact init shows format requirements on validation error", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue(null);
      // Using "ab" which is too short (less than 3 chars) triggers validation error

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "ab"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("3-64 characters"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("lowercase"),
      );
    });
  });

  describe("artifact init", () => {
    it("should show already initialized message for existing artifact", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue({
        name: "existing-artifact",
        type: "artifact",
      });

      await initCommand.parseAsync(["node", "cli", "--name", "new-name"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Artifact already initialized"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("existing-artifact"),
      );
    });

    it("should warn if directory is initialized as volume", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue({
        name: "my-volume",
        type: "volume",
      });

      await initCommand.parseAsync(["node", "cli", "--name", "new-artifact"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("initialized as volume"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("delete .vm0/storage.yaml"),
      );
    });

    it("should successfully initialize new artifact", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue(null);
      // isValidStorageName is not mocked, so we use a valid name
      vi.mocked(storageUtils.writeStorageConfig).mockResolvedValue();

      await initCommand.parseAsync([
        "node",
        "cli",
        "--name",
        "my-new-artifact",
      ]);

      expect(storageUtils.writeStorageConfig).toHaveBeenCalledWith(
        "my-new-artifact",
        "/test/dir",
        "artifact",
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Initialized artifact"),
      );
    });
  });

  describe("artifact push config validation", () => {
    it("should fail if no artifact initialized", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue(null);

      await expect(async () => {
        await pushCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No artifact initialized"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 artifact init"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail if initialized as volume", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue({
        name: "my-volume",
        type: "volume",
      });

      await expect(async () => {
        await pushCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("initialized as a volume"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 volume push"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("artifact pull config validation", () => {
    it("should fail if no artifact initialized", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue(null);

      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No artifact initialized"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 artifact init"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail if initialized as volume", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue({
        name: "my-volume",
        type: "volume",
      });

      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("initialized as a volume"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 volume pull"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
