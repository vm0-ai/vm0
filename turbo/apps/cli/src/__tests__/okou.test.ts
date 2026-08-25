import { describe, it, expect } from "vitest";
import { program, registerCommands } from "../okou";

describe("Okou CLI program", () => {
  registerCommands(program);
  const commandNames = program.commands.map((cmd) => {
    return cmd.name();
  });
  const publicCommandNames = commandNames.filter((name) => {
    return !name.startsWith("__");
  });

  it("should use the canonical Okou product identity", () => {
    expect(program.name()).toBe("okou");
    expect(program.description()).toBe(
      "Okou CLI — interact with Okou from inside the sandbox",
    );
  });

  it("should use Okou branding for the generate entry-point description", () => {
    const generateCommand = program.commands.find((command) => {
      return command.name() === "generate";
    });

    expect(generateCommand?.description()).toBe(
      "Generate assets via Okou's built-in pipelines or get connector skill-invocation guidance",
    );
  });

  it("should register all expected Okou commands", () => {
    const expectedCommands = [
      "model",
      "model-provider",
      "agent",
      "connector",
      "mcp",
      "mail",
      "credit",
      "upgrade",
      "doctor",
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
      "social",
      "recognize",
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
