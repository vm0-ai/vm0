import { Command, Help } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { program, registerCommands, registerRequestedCommand } from "../okou";

function buildOkouToken(capabilities: readonly string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({ scope: "okou", capabilities }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

function visibleCommandNames(prog: Command): string[] {
  return new Help()
    .visibleCommands(prog)
    .map((command) => {
      return command.name();
    })
    .filter((name) => {
      return name !== "help";
    });
}

describe("Okou CLI program", () => {
  registerCommands(program);
  const commandNames = program.commands.map((cmd) => {
    return cmd.name();
  });
  const canonicalCommandNames = commandNames.filter((name) => {
    return !name.startsWith("__") && name !== "recognize";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      "presentation",
      "maps",
      "weather",
      "scrape",
      "web-search",
      "people-search",
      "social",
      "image-recognition",
      "finance",
      "seo",
      "banking",
    ];
    for (const name of expectedCommands) {
      expect(canonicalCommandNames).toContain(name);
    }
  });

  it("should keep recognize registered but out of canonical command listings", () => {
    vi.stubEnv("OKOU_TOKEN", buildOkouToken(["image-recognition:write"]));
    const prog = new Command();
    registerCommands(prog);

    expect(commandNames).toContain("recognize");
    expect(visibleCommandNames(prog)).toContain("image-recognition");
    expect(visibleCommandNames(prog)).not.toContain("recognize");
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
    expect(commandNames).toContain("__intro-video-presenter");
    expect(commandNames).toContain("__intro-video-voice");
    expect(canonicalCommandNames).not.toContain("__agent-loop");
    expect(canonicalCommandNames).not.toContain("__intro-video-presenter");
    expect(canonicalCommandNames).not.toContain("__intro-video-voice");
  });

  it("should have exactly 40 canonical commands", () => {
    expect(canonicalCommandNames).toHaveLength(40);
  });
});

describe("Okou CLI lazy command loading", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      label: "direct canonical invocation",
      argv: ["node", "okou", "image-recognition", "--help"],
      expectedName: "image-recognition",
      expectedHelpCode: "commander.helpDisplayed",
    },
    {
      label: "direct compatibility invocation",
      argv: ["node", "okou", "recognize", "--help"],
      expectedName: "recognize",
      expectedHelpCode: "commander.helpDisplayed",
    },
    {
      label: "canonical help invocation",
      argv: ["node", "okou", "help", "image-recognition"],
      expectedName: "image-recognition",
      expectedHelpCode: "commander.help",
    },
    {
      label: "compatibility help invocation",
      argv: ["node", "okou", "help", "recognize"],
      expectedName: "recognize",
      expectedHelpCode: "commander.help",
    },
  ])(
    "should lazy-load $label",
    async ({ argv, expectedName, expectedHelpCode }) => {
      vi.stubEnv("OKOU_TOKEN", buildOkouToken(["image-recognition:write"]));
      let helpOutput = "";
      const prog = new Command()
        .name("okou")
        .exitOverride()
        .configureOutput({
          writeOut: (text: string) => {
            helpOutput += text;
          },
        });

      await registerRequestedCommand(prog, argv);

      expect(prog.commands).toHaveLength(1);
      const loadedCommand = prog.commands[0];
      expect(loadedCommand?.name()).toBe(expectedName);
      loadedCommand?.exitOverride().configureOutput({
        writeOut: (text: string) => {
          helpOutput += text;
        },
      });
      await expect(prog.parseAsync(argv)).rejects.toMatchObject({
        code: expectedHelpCode,
      });
      expect(helpOutput).toContain(`Usage: okou ${expectedName}`);
    },
  );
});
