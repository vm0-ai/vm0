/**
 * Tests for zero generate presentation command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none for the source-selection path
 * - Real (internal): prompt parsing and authoring packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { generateCommand } from "../index";
import { presentationCommand } from "../presentation";

describe("zero generate presentation command", () => {
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

  it("should print source selection instructions for presentation", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
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
    expect(stdout).toContain("# Zero generate presentation");
    expect(stdout).toContain("federated generation source-selection packet");
    expect(stdout).toContain("## Stage 1: Resource Selection");
    expect(stdout).toContain("## Candidate Registry Slice");
    expect(stdout).toContain("API migration plan");
    expect(stdout).toContain("od:skill:article-magazine");
    expect(stdout).toContain("od:template:html-ppt-graphify-dark-graph");
    expect(stdout).toContain(
      "Write the artifact under `./generated/mockups/api-migration-plan/`.",
    );
    expect(stdout).toContain(
      "zero host ./generated/mockups/api-migration-plan --site api-migration-plan",
    );
    expect(stdout).toContain("Style: swiss");
    expect(stdout).toContain("Slide count: 10");
    expect(stdout).toContain("Theme: ikb");
    expect(stdout).toContain("Audience: engineering leadership");
    expect(stdout).toContain("Use a fixed 1920x1080 slide canvas");
  });

  it("should print JSON resource selection metadata when --json is provided", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
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
      type: "generation-source-selection",
      kind: "presentation",
      prompt: "JSON please",
      outputDir: "./generated/mockups/api-migration-plan",
      site: "api-migration-plan",
      hostCommand:
        "zero host ./generated/mockups/api-migration-plan --site api-migration-plan",
    });
    expect(parsed.registryVersion).toEqual(
      expect.stringContaining("nexu-io/open-design@"),
    );
    expect(parsed.selection).toEqual(
      expect.objectContaining({
        candidates: expect.objectContaining({
          skills: expect.arrayContaining([
            expect.objectContaining({ id: "od:skill:article-magazine" }),
          ]),
          templates: expect.any(Array),
          designSystems: expect.any(Array),
        }),
      }),
    );
    expect(parsed.instructions).toEqual(
      expect.stringContaining("## Stage 2: Resolve Selected Resources"),
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
});
