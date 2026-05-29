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
      "--slides",
      "10",
      "--title",
      "API Migration Plan",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Zero generate presentation");
    expect(stdout).toContain("federated generation source-selection packet");
    expect(stdout).toContain("## Stage 1: Resource Selection");
    expect(stdout).toContain("## Candidate Registry Slice");
    expect(stdout).toContain("API migration plan");
    expect(stdout).toContain("skill:article-magazine");
    expect(stdout).toContain("template:html-ppt-graphify-dark-graph");
    expect(stdout).not.toContain("template:saas-landing");
    expect(stdout).toContain(
      "Write the artifact under `./generated/mockups/api-migration-plan/`.",
    );
    expect(stdout).toContain(
      "zero host ./generated/mockups/api-migration-plan --site api-migration-plan",
    );
    expect(stdout).toContain("Slide count: 10");
    expect(stdout).toContain("Use a fixed 1920x1080 slide canvas");
  });

  it("should expose only base artifact flags plus slides in help", () => {
    let helpOutput = "";
    presentationCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    presentationCommand.outputHelp();

    expect(helpOutput).toContain("--prompt <text>");
    expect(helpOutput).toContain("--site-slug <slug>");
    expect(helpOutput).toContain("--title <text>");
    expect(helpOutput).toContain("--design-system <id>");
    expect(helpOutput).toContain("--template <id>");
    expect(helpOutput).toContain("--slides <count>");
    expect(helpOutput).not.toContain("--json");
    expect(helpOutput).not.toContain("--provider");
    expect(helpOutput).not.toContain("--all");
    expect(helpOutput).not.toContain("--images");
    expect(helpOutput).not.toContain("--image-model");
    expect(helpOutput).not.toContain("--style");
    expect(helpOutput).not.toContain("--theme");
  });

  it("should list presentation templates and design systems in help", () => {
    let helpOutput = "";
    presentationCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    presentationCommand.outputHelp();

    expect(helpOutput).toContain("Design Systems:");
    expect(helpOutput).toContain("design-system:apple");
    expect(helpOutput).toContain("Templates (presentation):");
    expect(helpOutput).toContain("template:html-ppt-pitch-deck");
    // Website-only template should NOT appear in presentation help
    expect(helpOutput).not.toContain("template:saas-landing");
  });

  it("should accept --design-system and --template from the registry", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "presentation",
      "--prompt",
      "investor pitch",
      "--design-system",
      "apple",
      "--template",
      "html-ppt-pitch-deck",
      "--title",
      "Pitch",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "Selected design system: design-system:apple (Apple)",
    );
    expect(stdout).toContain(
      "Selected template: template:html-ppt-pitch-deck (HTML PPT Pitch Deck)",
    );
  });

  it("should reject a template that does not target presentation", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "presentation",
        "--prompt",
        "investor pitch",
        "--template",
        "saas-landing",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown template for presentation");
  });
});
