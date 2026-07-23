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
      "connector",
      "mail",
      "credit",
      "doctor",
      "logs",
      "search",
      "chat",
      "resource",
      "preference",
      "secret",
      "workflow",
      "goal",
      "slack",
      "telegram",
      "github",
      "phone",
      "variable",
      "whoami",
      "intro",
      "developer-support",
      "computer-use",
      "generate",
      "web",
      "video",
      "host",
      "maps",
      "weather",
      "scrape",
      "web-search",
      "banking",
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
      "run",

      "init",
      "upgrade",
      "info",
    ];
    for (const name of excludedCommands) {
      expect(commandNames).not.toContain(name);
    }
  });

  it("should have exactly 35 commands", () => {
    expect(commandNames).toHaveLength(35);
  });
});
