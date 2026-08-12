import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { zeroSearchCommand } from "../index";

describe("okou search --source agent-session", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    zeroSearchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
  });

  it("prints both agent session locations and the analysis query", async () => {
    await zeroSearchCommand.parseAsync([
      "node",
      "okou",
      "find the failed tool call",
      "--source",
      "agent-session",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(
      "/home/user/.claude/projects/-home-user-workspace/",
    );
    expect(output).toContain("/home/user/.codex/sessions/");
    expect(output).toContain(
      "A single thread may use both Claude Code and Codex",
    );
    expect(output).toContain("find the failed tool call");
  });
});
