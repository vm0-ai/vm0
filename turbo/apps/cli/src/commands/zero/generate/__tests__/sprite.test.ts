/**
 * Tests for zero generate sprite command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none for the source-selection path
 * - Real (internal): prompt parsing, enum validation, and packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { generateCommand } from "../index";
import { spriteCommand } from "../sprite";

describe("zero generate sprite command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("should print a source selection packet with the resolved plan", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "sprite",
      "--prompt",
      "A green slime monster idle loop",
      "--asset-type",
      "creature",
      "--action",
      "idle",
      "--sheet",
      "3x3",
      "--name",
      "green-slime",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Zero generate sprite");
    expect(stdout).toContain("federated generation source-selection packet");
    expect(stdout).toContain("A green slime monster idle loop");
    expect(stdout).toContain("- Asset type: creature");
    expect(stdout).toContain("- Action: idle");
    expect(stdout).toContain("- Sheet / grid: 3x3");
    expect(stdout).toContain("Output name: green-slime");
    expect(stdout).toContain("0x0funky/agent-sprite-forge@main");
    expect(stdout).toContain(
      "Write the bundle under `./generated/sprites/green-slime/`.",
    );
  });

  it("should default unset flags to agent decides and recommend gpt-image-2", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "sprite",
      "--prompt",
      "A fireball projectile",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("- Asset type: agent decides");
    expect(stdout).toContain("- Sheet / grid: auto");
    expect(stdout).toContain("Use `gpt-image-2`");
  });

  it("should reject an unknown asset type", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "sprite",
        "--prompt",
        "A thing",
        "--asset-type",
        "definitely-not-an-asset-type",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("--asset-type must be one of");
  });

  it("should reject an invalid frame count", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "sprite",
        "--prompt",
        "A thing",
        "--frames",
        "999",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("--frames must be 'auto' or an integer");
  });

  it("should expose the sprite-specific flags in help", () => {
    let helpOutput = "";
    spriteCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    spriteCommand.outputHelp();

    expect(helpOutput).toContain("--prompt <text>");
    expect(helpOutput).toContain("--asset-type <type>");
    expect(helpOutput).toContain("--action <action>");
    expect(helpOutput).toContain("--view <view>");
    expect(helpOutput).toContain("--sheet <grid>");
    expect(helpOutput).toContain("--bundle <preset>");
    expect(helpOutput).toContain("--art-style <style>");
    expect(helpOutput).not.toContain("--provider");
    expect(helpOutput).not.toContain("--all");
  });
});
