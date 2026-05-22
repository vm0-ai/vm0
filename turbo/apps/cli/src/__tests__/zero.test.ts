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
      "model",
      "model-provider",
      "agent",
      "chat",
      "connector",
      "doctor",
      "logs",
      "search",
      "preference",
      "run",
      "schedule",
      "secret",
      "skill",
      "slack",
      "telegram",
      "github",
      "phone",
      "variable",
      "whoami",
      "developer-support",
      "computer-use",
      "built-in",
      "web",
      "host",
      "maps",
      "local-agent",
      "local-browser",
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

      "init",
      "upgrade",
      "info",
    ];
    for (const name of excludedCommands) {
      expect(commandNames).not.toContain(name);
    }
  });

  it("should have exactly 28 commands", () => {
    expect(commandNames).toHaveLength(28);
  });
});
