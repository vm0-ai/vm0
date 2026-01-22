import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupCommand } from "../setup";

describe("model-provider setup command", () => {
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

  describe("input validation", () => {
    it("should reject invalid provider type", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "invalid-type",
          "--credential",
          "test-credential",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid type "invalid-type"'),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Valid types:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject when only --type is provided without --credential", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "anthropic-api-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Both --type and --credential are required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject when only --credential is provided without --type", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--credential",
          "test-credential",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Both --type and --credential are required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should list valid types when invalid type is provided", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "not-a-real-type",
          "--credential",
          "test-credential",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should show anthropic-api-key as a valid type
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("anthropic-api-key"),
      );
    });
  });
});
