import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setCommand } from "../set";
import { apiClient } from "../../../lib/api/api-client";

// Mock dependencies
vi.mock("../../../lib/api/api-client");

describe("scope set command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("authentication", () => {
    it("should exit with error if not authenticated", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("No scope configured"),
      );
      vi.mocked(apiClient.createScope).mockRejectedValue(
        new Error("Not authenticated"),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "testslug"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("create new scope", () => {
    it("should create scope successfully", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("No scope configured"),
      );
      vi.mocked(apiClient.createScope).mockResolvedValue({
        id: "test-id",
        slug: "testslug",
        type: "personal",
        displayName: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });

      await setCommand.parseAsync(["node", "cli", "testslug"]);

      expect(apiClient.createScope).toHaveBeenCalledWith({
        slug: "testslug",
        displayName: undefined,
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Scope created: testslug"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("testslug/<image-name>"),
      );
    });

    it("should create scope with display name", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("No scope configured"),
      );
      vi.mocked(apiClient.createScope).mockResolvedValue({
        id: "test-id",
        slug: "testslug",
        type: "personal",
        displayName: "Test Display",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });

      await setCommand.parseAsync([
        "node",
        "cli",
        "testslug",
        "--display-name",
        "Test Display",
      ]);

      expect(apiClient.createScope).toHaveBeenCalledWith({
        slug: "testslug",
        displayName: "Test Display",
      });
    });
  });

  describe("update existing scope", () => {
    it("should require --force to update existing scope", async () => {
      vi.mocked(apiClient.getScope).mockResolvedValue({
        id: "test-id",
        slug: "oldslug",
        type: "personal",
        displayName: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "newslug"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("already have a scope: oldslug"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--force"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should update scope with --force", async () => {
      vi.mocked(apiClient.getScope).mockResolvedValue({
        id: "test-id",
        slug: "oldslug",
        type: "personal",
        displayName: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });
      vi.mocked(apiClient.updateScope).mockResolvedValue({
        id: "test-id",
        slug: "newslug",
        type: "personal",
        displayName: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });

      await setCommand.parseAsync(["node", "cli", "newslug", "--force"]);

      expect(apiClient.updateScope).toHaveBeenCalledWith({
        slug: "newslug",
        force: true,
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Scope updated to newslug"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle slug already taken", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("No scope configured"),
      );
      vi.mocked(apiClient.createScope).mockRejectedValue(
        new Error("Scope already exists"),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "takenslug"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("already taken"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle reserved slug", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("No scope configured"),
      );
      vi.mocked(apiClient.createScope).mockRejectedValue(
        new Error('Scope slug "vm0" is reserved'),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "vm0"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("reserved"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle vm0 prefix rejection", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("No scope configured"),
      );
      vi.mocked(apiClient.createScope).mockRejectedValue(
        new Error('Scope slug "vm0test" is reserved'),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "vm0test"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("reserved"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("No scope configured"),
      );
      vi.mocked(apiClient.createScope).mockRejectedValue(
        new Error("Unexpected error"),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "testslug"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unexpected error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle non-Error exceptions", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("No scope configured"),
      );
      vi.mocked(apiClient.createScope).mockRejectedValue("Unknown error");

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "testslug"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("unexpected error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
