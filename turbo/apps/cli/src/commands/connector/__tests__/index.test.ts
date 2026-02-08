/**
 * Tests for connector parent command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): None (help text only)
 * - Real (internal): All CLI code
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectorCommand } from "../index";

describe("connector command", () => {
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
        await connectorCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      // Main command description
      expect(output).toContain("Manage third-party service connections");

      // Subcommands should be listed
      expect(output).toContain("list");
      expect(output).toContain("connect");
      expect(output).toContain("disconnect");

      mockStdoutWrite.mockRestore();
    });
  });
});
