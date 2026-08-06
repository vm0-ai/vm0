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
      "model",
      "model-provider",
      "agent",
      "connector",
      "mail",
      "credit",
      "upgrade",
      "doctor",
      "logs",
      "search",
      "chat",
      "resource",
      "workflow",
      "goal",
      "slack",
      "feishu",
      "teams",
      "telegram",
      "github",
      "phone",
      "whoami",
      "intro",
      "developer-support",
      "computer-use",
      "browser",
      "generate",
      "web",
      "video",
      "host",
      "maps",
      "weather",
      "scrape",
      "web-search",
      "people-search",
      "recognize",
      "translate",
      "finance",
      "banking",
    ];
    for (const name of expectedCommands) {
      expect(commandNames).toContain(name);
    }
  });

  it("should not include infrastructure or utility commands", () => {
    const excludedCommands = [
      "org",
      "auth",
      "compose",
      "volume",
      "artifact",
      "run",
      "preference",
      "secret",
      "variable",

      "init",
      "info",
    ];
    for (const name of excludedCommands) {
      expect(commandNames).not.toContain(name);
    }
  });

  it("should have exactly 38 commands", () => {
    expect(commandNames).toHaveLength(38);
  });
});
