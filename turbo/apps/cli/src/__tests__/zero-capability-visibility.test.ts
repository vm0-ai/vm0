import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import {
  applyCapabilityVisibility,
  decodeCapabilitiesFromZeroToken,
} from "../zero";

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

describe("decodeCapabilitiesFromZeroToken", () => {
  it("should decode capabilities from a valid zero-scoped token", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: ["agent:read", "schedule:read"],
    });
    expect(decodeCapabilitiesFromZeroToken(token)).toEqual([
      "agent:read",
      "schedule:read",
    ]);
  });

  it("should return null for token without vm0_sandbox_ prefix", () => {
    expect(decodeCapabilitiesFromZeroToken("some-other-token")).toBeNull();
  });

  it("should return null for malformed JWT (not 3 parts)", () => {
    expect(
      decodeCapabilitiesFromZeroToken("vm0_sandbox_only-one-part"),
    ).toBeNull();
  });

  it("should return null for non-zero scope", () => {
    const token = buildZeroToken({
      scope: "sandbox",
      capabilities: ["agent:read"],
    });
    expect(decodeCapabilitiesFromZeroToken(token)).toBeNull();
  });

  it("should return null when capabilities is not an array", () => {
    const token = buildZeroToken({
      scope: "zero",
      capabilities: "not-an-array",
    });
    expect(decodeCapabilitiesFromZeroToken(token)).toBeNull();
  });

  it("should return null for invalid base64 payload", () => {
    expect(
      decodeCapabilitiesFromZeroToken("vm0_sandbox_a.!!!invalid.c"),
    ).toBeNull();
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
