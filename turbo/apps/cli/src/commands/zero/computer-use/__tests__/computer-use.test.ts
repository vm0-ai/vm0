/**
 * Tests for computer-use command registration and visibility.
 *
 * Entry point: registerZeroCommands()
 * Mock (external): none
 * Real (internal): Command registration, capability checking
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command, Help } from "commander";
import { registerZeroCommands } from "../../../../zero";

function buildZeroToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = "test-signature";
  return `vm0_sandbox_${header}.${body}.${signature}`;
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

describe("computer-use command visibility", () => {
  beforeEach(() => {
    vi.stubEnv("ZERO_TOKEN", "");
  });

  it("should be visible when no ZERO_TOKEN is set", () => {
    const prog = new Command();
    registerZeroCommands(prog);

    const cmd = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    expect(cmd).toBeDefined();
  });

  it("should be visible when ZERO_TOKEN includes computer-use:write", () => {
    const token = buildZeroToken({
      userId: "u1",
      runId: "r1",
      orgId: "o1",
      scope: "zero",
      capabilities: ["computer-use:write"],
      iat: 1000,
      exp: 2000,
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = new Command();
    registerZeroCommands(prog);

    expect(visibleCommandNames(prog)).toContain("computer-use");
  });

  it("should be hidden when ZERO_TOKEN lacks computer-use:write", () => {
    const token = buildZeroToken({
      userId: "u1",
      runId: "r1",
      orgId: "o1",
      scope: "zero",
      capabilities: ["agent:read"],
      iat: 1000,
      exp: 2000,
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = new Command();
    registerZeroCommands(prog);

    expect(hiddenCommandNames(prog)).toContain("computer-use");
  });

  it("should have Desktop-backed agent command subcommands", () => {
    const prog = new Command();
    registerZeroCommands(prog);

    const computerUse = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    expect(computerUse).toBeDefined();

    const subNames = computerUse!.commands.map((c) => {
      return c.name();
    });
    expect(subNames).toContain("list-apps");
    expect(subNames).toContain("get-app-state");
    expect(subNames).toContain("click");
    expect(subNames).toContain("scroll");
    expect(subNames).toContain("set-value");
    expect(subNames).toContain("type-text");
    expect(subNames).toContain("press-key");
    expect(subNames).toContain("perform-action");
    expect(subNames).toContain("open-app");
    expect(subNames).toContain("hosts");
    expect(subNames).toContain("revoke-host");
    expect(subNames).toContain("audit");
  });
});
