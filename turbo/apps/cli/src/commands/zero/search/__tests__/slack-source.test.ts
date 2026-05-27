/**
 * Tests for zero search --source slack (#10263).
 *
 * Entry point: zeroSearchCommand.parseAsync()
 * Mock (external): none — the CLI must make zero outbound HTTP calls.
 *   MSW's global setup (src/test/setup.ts) uses onUnhandledRequest: "error",
 *   so any accidental network call would fail the test. That IS the guard.
 * Real (internal): command routing, recipe builder, console output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zeroSearchCommand, buildSlackRecipe } from "../index";

describe("zero search --source slack", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    // Commander retains parsed option state across parseAsync calls on the
    // same Command instance — match the pattern in the scaffold test.
    zeroSearchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("zero outbound HTTP", () => {
    it("makes no network call (MSW would error on any unhandled request)", async () => {
      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "slack",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
      expect(mockConsoleError).not.toHaveBeenCalled();
    });
  });

  describe("recipe content", () => {
    it("includes the Slack search.messages endpoint and SLACK_TOKEN", async () => {
      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "slack",
      ]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("search.messages");
      expect(output).toContain("SLACK_TOKEN");
    });

    it("includes both diagnostic pointers", async () => {
      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "slack",
      ]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("zero connector status slack");
      expect(output).toContain(
        "zero doctor check-connector --env-name SLACK_TOKEN",
      );
    });

    it("links to Slack's search.messages docs", async () => {
      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "slack",
      ]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("https://api.slack.com/methods/search.messages");
    });

    it("notes that CLI-local flags are ignored for this source", async () => {
      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "slack",
      ]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("--limit");
      expect(output).toContain("--since");
      expect(output).toContain("ignored");
    });
  });

  describe("keyword substitution", () => {
    it("URL-encodes the query with encodeURIComponent", async () => {
      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "bug report",
        "--source",
        "slack",
      ]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("query=bug%20report");
    });

    it("encodes special URL characters in the query", async () => {
      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "foo&bar",
        "--source",
        "slack",
      ]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("query=foo%26bar");
    });
  });

  describe("unconditional emission", () => {
    it("prints the recipe regardless of connector state (no branching)", async () => {
      // The recipe path does not import getZeroConnector — emission cannot
      // depend on connector state. Calling twice yields identical output.
      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "slack",
      ]);
      const first = mockConsoleLog.mock.calls.flat().join("\n");

      mockConsoleLog.mockClear();
      zeroSearchCommand.setOptionValue("source", []);

      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "slack",
      ]);
      const second = mockConsoleLog.mock.calls.flat().join("\n");

      expect(first).toBe(second);
    });

    it("ignores unrelated flags without erroring", async () => {
      await zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "slack",
        "--limit",
        "100",
        "--since",
        "30d",
        "-C",
        "3",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("search.messages");
    });
  });

  describe("buildSlackRecipe (exported helper)", () => {
    it("is pure and deterministic", () => {
      expect(buildSlackRecipe("foo")).toBe(buildSlackRecipe("foo"));
    });

    it("encodes the query once (does not double-encode)", () => {
      // Raw space → %20 (single encoding). Double-encoding would yield %2520.
      const recipe = buildSlackRecipe("a b");
      expect(recipe).toContain("query=a%20b");
      expect(recipe).not.toContain("query=a%2520b");
    });
  });
});
