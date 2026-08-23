/**
 * Tests for okou generate presentation command
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

describe("okou generate presentation command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
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
    expect(stdout).toContain("# Okou generate presentation");
    expect(stdout).toContain("direct HTML presentation authoring packet");
    expect(stdout).not.toContain("generation source-selection packet");
    expect(stdout).not.toContain("## Stage 1: Resource Selection");
    expect(stdout).not.toContain("## Candidate Registry Slice");
    expect(stdout).toContain("API migration plan");
    expect(stdout).not.toContain("skill:article-magazine");
    expect(stdout).not.toContain("design-system:");
    expect(stdout).not.toContain("Selected design system");
    expect(stdout).toContain("Selected template: agent decides");
    expect(stdout).not.toContain("template:html-ppt-graphify-dark-graph");
    expect(stdout).not.toContain("template:saas-landing");
    expect(stdout).not.toContain("## Output Contract");
    expect(stdout).not.toContain("```bash");
    expect(stdout).not.toContain("okou host ./generated/mockups");
    expect(stdout).toContain("Slide count: 10");
    expect(stdout).toContain("Use a fixed 1920x1080 slide canvas");
    expect(stdout).toContain(
      "all user-visible slide content, with the first slide visible before JavaScript runs",
    );
    expect(stdout).toContain("Do not store slide content in JavaScript data");
    expect(stdout).toContain("Produce exactly the requested slide count");
    expect(stdout).toContain("make an internal slide plan");
    expect(stdout).toContain(
      "Adapt the selected template to the requested slide count",
    );
    expect(stdout).toContain(
      "Use selected template references only for structure, layout devices, spacing, and visual language",
    );
    expect(stdout).toContain(
      "Derive every presentation image/media choice from the user's requested topic",
    );
    expect(stdout).toContain("Vary slide forms across the deck");
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
    expect(helpOutput).toContain("Templates (presentation):");
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
    expect(stdout).toContain("# Presentation Generation (template)");
    expect(stdout).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(stdout).toContain(
      "okou resource pull template:html-ppt-playful-launch-runbook --dir ./generated/resources",
    );
    expect(stdout).toContain(
      "./generated/resources/playful-launch/AGENT_RUNBOOK.md",
    );
    expect(stdout).toContain('"colorSystem": "carnival"');
    expect(stdout).toContain(
      "every slide and all visible content in final index.html; the first slide must render before JavaScript",
    );
    expect(stdout).toContain(
      "JavaScript may only enhance navigation, controls, themes, or animation",
    );
    expect(stdout).toContain("User request: create a 15-slide launch deck");
    expect(stdout).not.toContain("Selected design system:");
    expect(stdout).not.toContain("design-system:");
    expect(stdout).not.toContain("presentation-images.sh");
  });

  it("resolves --template to direct-HTML instructions when the run carries the latest archives", async () => {
    vi.stubEnv("OKOU_PRESENTATION_RUNBOOK_ARCHIVE_VERSION", "latest");

    await generateCommand.parseAsync([
      "node",
      "cli",
      "presentation",
      "--prompt",
      "create a 15-slide launch deck",
      "--template",
      "html-ppt-playful-launch",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "okou resource pull template:html-ppt-playful-launch-runbook --dir ./generated/resources",
    );
    expect(stdout).toContain("./generated/resources/playful-launch/SKILL.md");
    expect(stdout).toContain(
      "./generated/resources/playful-launch/color-systems/carnival.css",
    );
    expect(stdout).toContain("then batch-read chosen layouts");
    expect(stdout).toContain(
      "okou generate image-batch start <manifest.tsv> <state-dir>",
    );
    expect(stdout).toContain("okou generate image-batch wait <state-dir>");
    expect(stdout).toContain("manifest before HTML");
    expect(stdout).toContain("No manifest: skip start and wait");
    expect(stdout).toContain(
      "The command owns generation settings, concurrency, and retry",
    );
    expect(stdout).toContain("this list owns execution order and stopping");
    expect(stdout).toContain("run the opaque");
    expect(stdout).toContain("full-deck screenshots or contact sheets");
    expect(stdout).toContain("visually review unflagged slides");
    expect(stdout).toContain("fix only named blockers or advisories");
    expect(stdout).toContain("On pass, publish once");
    expect(
      stdout.indexOf("okou generate image-batch start <manifest.tsv>"),
    ).toBeLessThan(stdout.indexOf("author the final semantic HTML/CSS/SVG"));
    expect(
      stdout.indexOf("okou generate image-batch wait <state-dir>"),
    ).toBeLessThan(stdout.indexOf("run the opaque"));
    expect(stdout).not.toContain("AGENT_RUNBOOK.md");
    expect(stdout).not.toContain('"colorSystem"');
    expect(stdout).not.toContain("presentation-images.sh");
  });

  it("rejects an unknown presentation template id with available templates", async () => {
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      await expect(async () => {
        await generateCommand.parseAsync([
          "node",
          "cli",
          "presentation",
          "--prompt",
          "launch plan",
          "--template",
          "not-a-real-template",
        ]);
      }).rejects.toThrow("process.exit called");

      const stderr = mockConsoleError.mock.calls.flat().join("\n");
      expect(stderr).toContain(
        "Unknown template for presentation: not-a-real-template",
      );
      expect(stderr).toContain("Available templates for presentation:");
      expect(stderr).toContain("template:html-ppt-playful-launch");
      expect(stderr).toContain(
        'okou generate presentation --template template:html-ppt-playful-launch --prompt "..."',
      );
      expect(stderr).not.toContain("Available design systems");
    } finally {
      mockConsoleError.mockRestore();
    }
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
