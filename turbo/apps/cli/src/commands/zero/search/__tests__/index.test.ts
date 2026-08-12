/**
 * Tests for okou search command scaffold (#10244).
 *
 * Entry point: zeroSearchCommand.parseAsync()
 * Mock (external): none — no API calls in the scaffold
 * Real (internal): all CLI validation and help wiring
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zeroSearchCommand, SEARCH_EXPLAINER } from "../index";

describe("okou search command (scaffold)", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    // Commander retains parsed option state across parseAsync calls on the
    // same Command instance. Reset the collector value before each test so
    // ordering does not leak state between cases.
    zeroSearchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("prints the explainer and exits 0 when --source is omitted", async () => {
    await zeroSearchCommand.parseAsync(["node", "cli", "hello"]);

    expect(mockExit).not.toHaveBeenCalled();
    const logs = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("Available sources:");
    expect(logs).toContain("agent-session  locates local Claude Code");
    expect(logs).toContain("chat           user/assistant text messages");
    expect(logs).toContain("slack          returns a recipe");
  });

  it("rejects multiple --source flags", async () => {
    await expect(
      zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "agent-session",
        "--source",
        "chat",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Only one --source is allowed.");
  });

  it("rejects an unknown --source value", async () => {
    await expect(
      zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "nope",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain('Unknown --source "nope"');
    expect(errors).toContain("agent-session, chat, slack");
  });

  it("routes --source agent-session to local file guidance", async () => {
    await zeroSearchCommand.parseAsync([
      "node",
      "cli",
      "hello",
      "--source",
      "agent-session",
    ]);

    const logs = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("/home/user/.claude/projects/");
    expect(logs).toContain("/home/user/.codex/sessions/");
  });

  it("--help output includes the three source descriptions", () => {
    let captured = "";
    zeroSearchCommand.configureOutput({
      writeOut: (s) => {
        captured += s;
      },
      writeErr: (s) => {
        captured += s;
      },
    });
    zeroSearchCommand.outputHelp();
    expect(captured).toContain("agent-session  locates local Claude Code");
    expect(captured).toContain("chat           user/assistant text messages");
    expect(captured).toContain("slack          returns a recipe");
  });

  it("SEARCH_EXPLAINER is the single source of truth for source descriptions", () => {
    expect(SEARCH_EXPLAINER).toContain(
      "agent-session  locates local Claude Code",
    );
    expect(SEARCH_EXPLAINER).toContain(
      "chat           user/assistant text messages",
    );
    expect(SEARCH_EXPLAINER).toContain("slack          returns a recipe");
  });
});
