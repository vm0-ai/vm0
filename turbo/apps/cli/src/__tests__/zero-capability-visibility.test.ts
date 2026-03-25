import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { applyCapabilityVisibility } from "../zero";
import { decodeZeroTokenPayload } from "../lib/api/zero-token";

function buildZeroToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

function buildProgram(): Command {
  const prog = new Command();
  prog.addCommand(new Command("org"));
  prog.addCommand(new Command("agent"));
  prog.addCommand(new Command("connector"));
  prog.addCommand(new Command("preference"));
  prog.addCommand(new Command("schedule"));
  prog.addCommand(new Command("secret"));
  prog.addCommand(new Command("slack"));
  prog.addCommand(new Command("variable"));
  prog.addCommand(new Command("whoami"));
  return prog;
}

function visibleCommandNames(prog: Command): string[] {
  return prog.commands
    .filter((cmd) => !(cmd as unknown as { _hidden: boolean })._hidden)
    .map((cmd) => cmd.name());
}

function hiddenCommandNames(prog: Command): string[] {
  return prog.commands
    .filter((cmd) => (cmd as unknown as { _hidden: boolean })._hidden)
    .map((cmd) => cmd.name());
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

describe("applyCapabilityVisibility", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should not hide any commands when ZERO_TOKEN is absent", () => {
    const prog = buildProgram();
    applyCapabilityVisibility(prog);
    expect(hiddenCommandNames(prog)).toEqual([]);
  });

  it("should hide unmapped commands and show capable ones with valid token", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent:read", "schedule:read", "schedule:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();
    applyCapabilityVisibility(prog);

    expect(visibleCommandNames(prog)).toEqual(["agent", "schedule", "whoami"]);
    expect(hiddenCommandNames(prog)).toEqual([
      "org",
      "connector",
      "preference",
      "secret",
      "slack",
      "variable",
    ]);
  });

  it("should not hide any commands with malformed token (graceful fallback)", () => {
    vi.stubEnv("ZERO_TOKEN", "not-a-valid-token");

    const prog = buildProgram();
    applyCapabilityVisibility(prog);

    expect(hiddenCommandNames(prog)).toEqual([]);
  });

  it("should not hide any commands when scope is not zero", () => {
    const token = buildZeroToken({
      scope: "sandbox",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();
    applyCapabilityVisibility(prog);

    expect(hiddenCommandNames(prog)).toEqual([]);
  });

  it("should only show whoami when capabilities array is empty", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: [],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();
    applyCapabilityVisibility(prog);

    expect(visibleCommandNames(prog)).toEqual(["whoami"]);
  });

  it("should show slack when slack:write capability is present", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["slack:write"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();
    applyCapabilityVisibility(prog);

    expect(visibleCommandNames(prog)).toContain("slack");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide agent when agent:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["schedule:read"],
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = buildProgram();
    applyCapabilityVisibility(prog);

    expect(visibleCommandNames(prog)).toEqual(["schedule", "whoami"]);
    expect(hiddenCommandNames(prog)).toContain("agent");
  });
});
