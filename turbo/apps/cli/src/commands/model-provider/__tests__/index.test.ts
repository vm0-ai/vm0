/**
 * Tests for model-provider parent command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): None (help text only)
 * - Real (internal): All CLI code
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { modelProviderCommand } from "../index";

describe("model-provider command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("help text", () => {
    it("should show command description and subcommands", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await modelProviderCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      // Main command description
      expect(output).toContain("Manage model providers");

      // Subcommands should be listed
      expect(output).toContain("ls");
      expect(output).toContain("setup");
      expect(output).toContain("delete");
      expect(output).toContain("set-default");

      mockStdoutWrite.mockRestore();
    });
  });
});
