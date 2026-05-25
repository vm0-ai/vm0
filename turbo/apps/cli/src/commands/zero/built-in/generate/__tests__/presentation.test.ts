/**
 * Tests for zero built-in generate presentation command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none; presentation is now an agent-authored HTML workflow
 * - Real (internal): prompt parsing and authoring packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zeroBuiltInCommand } from "../../index";
import { presentationCommand } from "../presentation";

describe("zero built-in generate presentation command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should print OpenDesign-style presentation authoring instructions", async () => {
    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "presentation",
      "--prompt",
      "API migration plan",
      "--style",
      "swiss",
      "--slides",
      "10",
      "--images",
      "8",
      "--image-model",
      "gpt-image-1.5",
      "--theme",
      "ikb",
      "--audience",
      "engineering leadership",
      "--title",
      "API Migration Plan",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Zero built-in generate presentation");
    expect(stdout).toContain("You are the current agent");
    expect(stdout).toContain("API migration plan");
    expect(stdout).toContain(
      "Write the artifact under `./opendesign/mockups/api-migration-plan/`.",
    );
    expect(stdout).toContain(
      "zero host ./opendesign/mockups/api-migration-plan --site api-migration-plan",
    );
    expect(stdout).toContain("Style: swiss");
    expect(stdout).toContain("Slide count: 10");
    expect(stdout).toContain("Theme: ikb");
    expect(stdout).toContain("Audience: engineering leadership");
    expect(stdout).toContain("Use a fixed 1920x1080 slide canvas");
  });

  it("should print JSON authoring metadata when --json is provided", async () => {
    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "presentation",
      "--prompt",
      "JSON please",
      "--title",
      "API Migration Plan",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      type: "html-artifact-authoring",
      kind: "presentation",
      prompt: "JSON please",
      outputDir: "./opendesign/mockups/api-migration-plan",
      site: "api-migration-plan",
      hostCommand:
        "zero host ./opendesign/mockups/api-migration-plan --site api-migration-plan",
    });
    expect(parsed.instructions).toEqual(
      expect.stringContaining("Think like a presentation designer"),
    );
  });

  it("should describe the default image model in help", () => {
    let helpOutput = "";
    presentationCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    presentationCommand.outputHelp();

    expect(helpOutput).toContain("Image model for generated visuals (default:");
    expect(helpOutput).toContain("gpt-image-1): gpt-image-2");
  });

  it("should require a prompt", async () => {
    await expect(async () => {
      await zeroBuiltInCommand.parseAsync([
        "node",
        "cli",
        "generate",
        "presentation",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--prompt is required"),
    );
  });
});
