import { describe, it, expect } from "vitest";
import { program, registerZeroCommands } from "../zero";

describe("zero CLI program", () => {
  registerZeroCommands(program);
  const commandNames = program.commands.map((cmd) => {
    return cmd.name();
  });

  it("should be named 'zero'", () => {
    expect(program.name()).toBe("zero");
  });

  it("should register all expected zero commands", () => {
    const expectedCommands = [
      "org",
      "agent",
      "chat",
      "connector",
      "doctor",
      "logs",
      "phone",
      "preference",
      "run",
      "schedule",
      "secret",
      "skill",
      "slack",
      "variable",
      "whoami",
      "developer-support",
      "computer-use",
      "voice-chat",
    ];
    for (const name of expectedCommands) {
      expect(commandNames).toContain(name);
    }
  });

  it("should not include infrastructure or utility commands", () => {
    const excludedCommands = [
      "auth",
      "compose",
      "volume",
      "artifact",
      "memory",
      "cook",
      "init",
      "upgrade",
      "info",
    ];
    for (const name of excludedCommands) {
      expect(commandNames).not.toContain(name);
    }
  });

  it("should have exactly 18 commands", () => {
    expect(commandNames).toHaveLength(18);
  });
});
