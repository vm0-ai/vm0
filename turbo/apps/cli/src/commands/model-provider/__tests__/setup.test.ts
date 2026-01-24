import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupCommand } from "../setup";
import { MODEL_PROVIDER_TYPES } from "@vm0/core";

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

  describe("help text configuration", () => {
    it("should have helpText defined for all provider types", () => {
      for (const config of Object.values(MODEL_PROVIDER_TYPES)) {
        expect(config.helpText).toBeDefined();
        expect(config.helpText.length).toBeGreaterThan(0);
      }
    });

    it("should have correct helpText for claude-code-oauth-token", () => {
      const config = MODEL_PROVIDER_TYPES["claude-code-oauth-token"];
      expect(config.helpText).toContain("claude setup-token");
      expect(config.helpText).toContain("Claude Pro or Max subscription");
    });

    it("should have correct helpText for anthropic-api-key", () => {
      const config = MODEL_PROVIDER_TYPES["anthropic-api-key"];
      expect(config.helpText).toContain("console.anthropic.com");
    });

    it("should have correct helpText for openai-api-key", () => {
      const config = MODEL_PROVIDER_TYPES["openai-api-key"];
      expect(config.helpText).toContain("platform.openai.com");
    });
  });
});
