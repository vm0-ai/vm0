/**
 * Tests for credential parent command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { credentialCommand } from "../index";
import chalk from "chalk";

describe("credential command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("help text", () => {
    it("should show command description and subcommands", async () => {
      // Commander outputs help to stdout via process.stdout.write
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await credentialCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Manage stored credentials");
      expect(output).toContain("list");
      expect(output).toContain("set");
      expect(output).toContain("delete");

      mockStdoutWrite.mockRestore();
    });
  });
});
