import { describe, it, expect } from "vitest";
import { program, registerZeroCommands } from "../zero";

describe("zero CLI program", () => {
  registerZeroCommands(program);
  const commandNames = program.commands.map((cmd) => cmd.name());

  it("should be named 'zero'", () => {
    expect(program.name()).toBe("zero");
  });

  it("should register all expected zero commands", () => {
    const expectedCommands = [
      "org",
      "agent",
      "connector",
      "doctor",
      "preference",
      "run",
      "schedule",
      "secret",
      "skill",
      "slack",
      "variable",
      "whoami",
      "ask-user",
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
      "logs",
      "cook",
      "init",
      "upgrade",
      "info",
    ];
    for (const name of excludedCommands) {
      expect(commandNames).not.toContain(name);
    }
  });

  it("should have exactly 13 commands", () => {
    expect(commandNames).toHaveLength(13);
  });
});
