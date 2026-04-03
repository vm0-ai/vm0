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

  it("should have host and client subcommands", () => {
    const prog = new Command();
    registerZeroCommands(prog);

    const computerUse = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    expect(computerUse).toBeDefined();

    const subNames = computerUse!.commands.map((c) => {
      return c.name();
    });
    expect(subNames).toContain("host");
    expect(subNames).toContain("client");
  });

  it("should have start under host subcommand", () => {
    const prog = new Command();
    registerZeroCommands(prog);

    const computerUse = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    const host = computerUse!.commands.find((c) => {
      return c.name() === "host";
    });
    expect(host).toBeDefined();

    const hostSubs = host!.commands.map((c) => {
      return c.name();
    });
    expect(hostSubs).toContain("start");
  });

  it("should have screenshot, info, mouse, scroll, and clipboard commands under client subcommand", () => {
    const prog = new Command();
    registerZeroCommands(prog);

    const computerUse = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    const client = computerUse!.commands.find((c) => {
      return c.name() === "client";
    });
    expect(client).toBeDefined();

    const clientSubs = client!.commands.map((c) => {
      return c.name();
    });
    expect(clientSubs).toContain("screenshot");
    expect(clientSubs).toContain("zoom");
    expect(clientSubs).toContain("info");
    expect(clientSubs).toContain("left-click-drag");
    expect(clientSubs).toContain("left-mouse-down");
    expect(clientSubs).toContain("left-mouse-up");
    expect(clientSubs).toContain("scroll");
    expect(clientSubs).toContain("read-clipboard");
    expect(clientSubs).toContain("write-clipboard");
  });

  it("should have mouse click commands under client subcommand", () => {
    const prog = new Command();
    registerZeroCommands(prog);

    const computerUse = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    const client = computerUse!.commands.find((c) => {
      return c.name() === "client";
    });
    expect(client).toBeDefined();

    const clientSubs = client!.commands.map((c) => {
      return c.name();
    });
    expect(clientSubs).toContain("left-click");
    expect(clientSubs).toContain("right-click");
    expect(clientSubs).toContain("middle-click");
    expect(clientSubs).toContain("double-click");
    expect(clientSubs).toContain("triple-click");
  });
});
