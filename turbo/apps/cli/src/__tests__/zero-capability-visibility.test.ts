import { describe, it, expect, vi, afterEach } from "vitest";
import { Command, Help } from "commander";
import { buildZeroHelpText, registerZeroCommands } from "../zero";
import { decodeZeroTokenPayload } from "../lib/api/zero-token";

function buildZeroToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

function buildCommands(): Command[] {
  return [
    new Command("org"),
    new Command("agent"),
    new Command("connector"),
    new Command("logs"),
    new Command("preference"),
    new Command("run"),
    new Command("schedule"),
    new Command("secret"),
    new Command("slack"),
    new Command("telegram"),
    new Command("phone"),
    new Command("variable"),
    new Command("whoami"),
    new Command("built-in"),
    new Command("web"),
    new Command("host"),
    new Command("local-agent"),
    new Command("local-browser"),
  ];
}

function buildProgram(): Command {
  const prog = new Command();
  registerZeroCommands(prog, buildCommands());
  return prog;
}

function visibleCommandNames(prog: Command): string[] {
  return new Help()
    .visibleCommands(prog)
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return name !== "help";
    });
}

function hiddenCommandNames(prog: Command): string[] {
  const visible = new Set(visibleCommandNames(prog));
  return prog.commands
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return !visible.has(name);
    });
}

describe("decodeZeroTokenPayload", () => {
  it("should decode payload from a valid zero-scoped token", () => {
    const token = buildZeroToken({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "zero",
      capabilities: ["agent:read", "schedule:read"],
      iat: 1000,
      exp: 2000,
    });
    const payload = decodeZeroTokenPayload(token);
    expect(payload).toEqual({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "zero",
      capabilities: ["agent:read", "schedule:read"],
      iat: 1000,
      exp: 2000,
    });
  });

  it("should return undefined for token without vm0_sandbox_ prefix", () => {
    expect(decodeZeroTokenPayload("some-other-token")).toBeUndefined();
  });

  it("should return undefined for malformed JWT (not 3 parts)", () => {
    expect(decodeZeroTokenPayload("vm0_sandbox_only-one-part")).toBeUndefined();
  });

  it("should return undefined for non-zero scope", () => {
    const token = buildZeroToken({
      scope: "sandbox",
      capabilities: ["agent:read"],
    });
    expect(decodeZeroTokenPayload(token)).toBeUndefined();
  });

  it("should return undefined when capabilities is not an array", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: "not-an-array",
    });
    expect(decodeZeroTokenPayload(token)).toBeUndefined();
  });

  it("should return undefined for invalid base64 payload", () => {
    expect(
      decodeZeroTokenPayload("vm0_sandbox_a.!!!invalid.c"),
    ).toBeUndefined();
  });
});

describe("registerZeroCommands", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should not hide any commands when ZERO_TOKEN is absent", () => {
    const prog = buildProgram();
    expect(hiddenCommandNames(prog)).toEqual([]);
  });

  it("should hide unmapped commands and show capable ones with valid token", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent:read", "schedule:read", "schedule:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toEqual([
      "agent",
      "schedule",
      "whoami",
      "web",
    ]);
    expect(hiddenCommandNames(prog)).toEqual([
      "org",
      "connector",
      "logs",
      "preference",
      "run",
      "secret",
      "slack",
      "telegram",
      "phone",
      "variable",
      "built-in",
      "host",
      "local-agent",
      "local-browser",
    ]);
  });

  it("should not hide any commands with malformed token (graceful fallback)", () => {
    vi.stubEnv("ZERO_TOKEN", "not-a-valid-token");

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toEqual([]);
  });

  it("should not hide any commands when scope is not zero", () => {
    const token = buildZeroToken({
      scope: "sandbox",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toEqual([]);
  });

  it("should only show whoami when capabilities array is empty", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: [],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toEqual(["whoami", "web"]);
  });

  it("should show slack when slack:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["slack:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("slack");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show telegram when telegram:read capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["telegram:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("telegram");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show telegram when telegram:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["telegram:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("telegram");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show phone when phone:read capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["phone:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("phone");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show phone when phone:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["phone:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("phone");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide telegram when only file:read capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["file:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("telegram");
    expect(hiddenCommandNames(prog)).toContain("phone");
  });

  it("should hide telegram when only file:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["file:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("telegram");
    expect(hiddenCommandNames(prog)).toContain("phone");
  });

  it("should show built-in when file:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["file:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("built-in");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show host when host:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["host:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("host");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show the host help example when host:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["host:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Host a static site?",
    );
  });

  it("should hide host when host:write capability is missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["file:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("host");
  });

  it("should hide the host help example when host:write capability is missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["file:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Host a static site?",
    );
  });

  it("should hide telegram when file read and telegram write capabilities are missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("telegram");
    expect(hiddenCommandNames(prog)).toContain("phone");
  });

  it("should show run when agent-run:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent-run:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("run");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show logs when agent-run:read capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent-run:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("logs");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show local-agent when local-agent:read capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["local-agent:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("local-agent");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show local-agent when local-agent:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["local-agent:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("local-agent");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide logs when agent-run:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("logs");
  });

  it("should hide run when agent-run:write capability is missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("run");
  });

  it("should hide local-agent when local-agent capabilities are missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent-run:read", "agent-run:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("local-agent");
  });

  it("should show local-browser when local-browser:read capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["local-browser:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("local-browser");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show local-browser when local-browser:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["local-browser:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("local-browser");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide local-browser when local-browser capabilities are missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent-run:read", "agent-run:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("local-browser");
  });

  it("should hide agent when agent:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["schedule:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toEqual(["schedule", "whoami", "web"]);
    expect(hiddenCommandNames(prog)).toContain("agent");
  });

  it("should show connector when connector:read capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["connector:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("connector");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide connector when connector:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("connector");
  });
});
