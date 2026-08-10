import { describe, it, expect } from "vitest";
import { program, registerZeroCommands } from "../zero";

describe("zero CLI program", () => {
  registerZeroCommands(program);
  const commandNames = program.commands.map((cmd) => {
    return cmd.name();
  });
  const publicCommandNames = commandNames.filter((name) => {
    return !name.startsWith("__");
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
      "seo",
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

  it("should keep internal commands out of the public surface", () => {
    expect(commandNames).toContain("__agent-loop");
    expect(publicCommandNames).not.toContain("__agent-loop");
  });

  it("should have exactly 39 public commands", () => {
    expect(publicCommandNames).toHaveLength(39);
  });
});
