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

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("should print direct authoring instructions for presentation", async () => {
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
    expect(stdout).toContain("direct HTML presentation authoring packet");
    expect(stdout).not.toContain(
      "federated generation source-selection packet",
    );
    expect(stdout).not.toContain("## Stage 1: Resource Selection");
    expect(stdout).not.toContain("## Candidate Registry Slice");
    expect(stdout).toContain("API migration plan");
    expect(stdout).not.toContain("skill:article-magazine");
    expect(stdout).not.toContain("design-system:");
    expect(stdout).not.toContain("Selected design system");
    expect(stdout).not.toContain("Selected template");
    expect(stdout).not.toContain("template:html-ppt-graphify-dark-graph");
    expect(stdout).not.toContain("template:saas-landing");
    expect(stdout).toContain(
      "Write the artifact under `./generated/mockups/api-migration-plan/`.",
    );
    expect(stdout).toContain(
      "zero host ./generated/mockups/api-migration-plan --site api-migration-plan --artifact-kind presentation-html",
    );
    expect(stdout).toContain("Slide count: 10");
    expect(stdout).toContain("Use a fixed 1920x1080 slide canvas");
    expect(stdout).toContain("Produce exactly the requested slide count");
    expect(stdout).toContain("make an internal slide plan");
    expect(stdout).toContain("Adapt layout patterns");
    expect(stdout).toContain(
      "Use reference materials only for structure, spacing, and visual language",
    );
    expect(stdout).toContain(
      "Derive every presentation image/media choice from the user's requested topic",
    );
    expect(stdout).toContain(
      "Do not add decorative, duplicate, or empty filler slides",
    );
    expect(stdout).toContain("establish the deck's arc");
    expect(stdout).toContain("Vary slide forms across the deck");
    expect(stdout).toContain("Each slide carries one idea");
    expect(stdout).toContain(
      "Check that shapes, charts, images, or decorative graphics do not cover readable text",
    );
  });

  it("should reject slide counts outside the supported range", async () => {
    const mockStderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => {
        return true;
      }) as never);

    try {
      await expect(async () => {
        await generateCommand.parseAsync([
          "node",
          "cli",
          "presentation",
          "--prompt",
          "launch plan",
          "--slides",
          "3",
        ]);
      }).rejects.toThrow("process.exit called");

      const stderr = mockStderrWrite.mock.calls
        .map(([chunk]) => {
          return String(chunk);
        })
        .join("");
      expect(stderr).toContain("slides must be between 4 and 20");
    } finally {
      mockStderrWrite.mockRestore();
    }
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
    expect(helpOutput).not.toContain("--runbook <id>");
    expect(helpOutput).not.toContain("--design-system <id>");
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

  it("should list presentation templates but not design systems in help", () => {
    let helpOutput = "";
    presentationCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    presentationCommand.outputHelp();

    expect(helpOutput).not.toContain("Design Systems:");
    expect(helpOutput).not.toContain("design-system:apple");
    expect(helpOutput).toContain("Templates (presentation runbook):");
    expect(helpOutput).toContain("template:html-ppt-playful-launch");
    expect(helpOutput).not.toContain("Templates (presentation registry):");
    expect(helpOutput).not.toContain("(no presentation templates registered)");
    expect(helpOutput).not.toContain("template:html-ppt-pitch-deck");
    expect(helpOutput).not.toContain("template:saas-landing");
  });

  it("resolves --template to runbook instructions", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "presentation",
      "--prompt",
      "create a 15-slide launch deck",
      "--template",
      "html-ppt-playful-launch",
      "--title",
      "Launch",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Presentation Generation (runbook)");
    expect(stdout).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(stdout).toContain(
      "zero resource pull template:html-ppt-playful-launch-runbook --dir ./generated/resources",
    );
    expect(stdout).toContain(
      "./generated/resources/playful-launch/AGENT_RUNBOOK.md",
    );
    expect(stdout).toContain('"colorSystem": "carnival"');
    expect(stdout).toContain("User request: create a 15-slide launch deck");
    expect(stdout).not.toContain("Selected design system:");
    expect(stdout).not.toContain("design-system:");
  });

  it.each(["--design-system", "--runbook"])(
    "should reject removed presentation selector flag %s",
    async (flag) => {
      const mockStderrWrite = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((() => {
          return true;
        }) as never);

      try {
        await expect(async () => {
          await generateCommand.parseAsync([
            "node",
            "cli",
            "presentation",
            "--prompt",
            "investor pitch",
            flag,
            "html-ppt-playful-launch",
          ]);
        }).rejects.toThrow("process.exit called");

        const stderr = mockStderrWrite.mock.calls
          .map(([chunk]) => {
            return String(chunk);
          })
          .join("");
        expect(stderr).toContain(`unknown option '${flag}'`);
      } finally {
        mockStderrWrite.mockRestore();
      }
    },
  );
});
