import { describe, it, expect } from "vitest";
import { program, registerZeroCommands } from "../okou";

describe("Okou CLI program", () => {
  registerZeroCommands(program);
  const commandNames = program.commands.map((cmd) => {
    return cmd.name();
  });
  const publicCommandNames = commandNames.filter((name) => {
    return !name.startsWith("__");
  });

  it("should use the canonical Okou product identity", () => {
    expect(program.name()).toBe("okou");
    expect(program.description()).toContain("Okou CLI");
  });

  it("should register all expected zero commands", () => {
    const expectedCommands = [
      "model",
      "model-provider",
      "agent",
      "connector",
      "mcp",
      "presentation-template",
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

  it("should have exactly 41 public commands", () => {
    expect(publicCommandNames).toHaveLength(41);
  });
});
