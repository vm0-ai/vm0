/**
 * Unit tests for agent list and status commands
 *
 * These tests validate command metadata (name, description, aliases).
 * This replaces E2E tests for help/alias tests from t26-vm0-agent-list-status.bats.
 *
 * Note: API interaction tests (error handling for nonexistent agents/versions)
 * remain in E2E tests because ts-rest client intercepting requires complex setup.
 * The E2E tests provide better coverage for actual API error scenarios.
 *
 * Key behaviors tested:
 * - Command descriptions match expected text
 * - Command names are correct
 * - Command aliases work correctly (ls for list)
 */

import { describe, it, expect } from "vitest";
import { listCommand } from "../commands/agent/list";
import { statusCommand } from "../commands/agent/status";

describe("agent list command", () => {
  describe("command metadata", () => {
    it("should have correct command description", () => {
      expect(listCommand.description()).toBe("List all agent composes");
    });

    it("should have correct command name", () => {
      expect(listCommand.name()).toBe("list");
    });

    it("should have 'ls' as an alias", () => {
      expect(listCommand.alias()).toBe("ls");
    });

    it("should have --scope option", () => {
      const scopeOption = listCommand.options.find(
        (opt) => opt.long === "--scope",
      );
      expect(scopeOption).toBeDefined();
      expect(scopeOption?.description).toContain("Scope");
    });
  });
});

describe("agent status command", () => {
  describe("command metadata", () => {
    it("should have correct command description", () => {
      expect(statusCommand.description()).toBe("Show status of agent compose");
    });

    it("should have correct command name", () => {
      expect(statusCommand.name()).toBe("status");
    });

    it("should accept name[:version] argument format", () => {
      // The command is configured to accept a single required argument
      const args = statusCommand.registeredArguments;
      expect(args.length).toBe(1);
      expect(args[0]?.name()).toBe("name[:version]");
      expect(args[0]?.required).toBe(true);
    });

    it("should have --scope option", () => {
      const scopeOption = statusCommand.options.find(
        (opt) => opt.long === "--scope",
      );
      expect(scopeOption).toBeDefined();
      expect(scopeOption?.description).toContain("Scope");
    });

    it("should have --no-sources option", () => {
      const noSourcesOption = statusCommand.options.find(
        (opt) => opt.long === "--no-sources",
      );
      expect(noSourcesOption).toBeDefined();
      expect(noSourcesOption?.description).toContain("source");
    });
  });
});
