/**
 * Tests for zero generate website command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none for the source-selection path
 * - Real (internal): prompt parsing and authoring packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { generateCommand } from "../index";
import { websiteCommand } from "../website";

describe("zero generate website command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("should print source selection instructions for website", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "observability launch site",
      "--title",
      "Clearpath",
      "--site-slug",
      "clearpath-demo",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Zero generate website");
    expect(stdout).toContain("federated generation source-selection packet");
    expect(stdout).toContain("## Stage 1: Resource Selection");
    expect(stdout).toContain("## Candidate Registry Slice");
    expect(stdout).toContain("observability launch site");
    expect(stdout).toContain("template:black-slabs");
    expect(stdout).toContain("template:web-prototype-taste-editorial");
    expect(stdout).toContain(
      "For landing pages, marketing sites, official brand or product websites, and product launch pages, select a vm0 built-in website template.",
    );
    expect(stdout).toContain(
      "For documentation, blogs, dashboards, app or tool surfaces, email, generic prototypes, and other non-marketing HTML or website requests, select an Open Design template that matches the user's intent.",
    );
    expect(stdout).toContain(
      "When the request is ambiguous or does not clearly describe a marketing or official website, prefer an Open Design template.",
    );
    expect(stdout).not.toContain("template:html-ppt-pitch-deck");
    expect(stdout).toContain(
      "Write the artifact under `./generated/mockups/clearpath-demo/`.",
    );
    expect(stdout).toContain(
      "zero host ./generated/mockups/clearpath-demo --site clearpath-demo --spa",
    );
  });

  it("should use the generated base slug when no stable site slug is provided", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "observability launch site",
      "--title",
      "Clearpath",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "zero host ./generated/mockups/clearpath --site clearpath --spa",
    );
  });

  it("should accept a restored Open Design website template", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "A documentation page for a developer tool",
      "--template",
      "web-prototype",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "Selected template: template:web-prototype (Web Prototype)",
    );
    expect(stdout).toContain(
      "Honor the explicitly selected template; do not substitute a different template based on website intent.",
    );
    expect(stdout).not.toContain(
      "For landing pages, marketing sites, official brand or product websites, and product launch pages, select a vm0 built-in website template.",
    );
    expect(stdout).not.toContain(
      "Selected template package: zero resource pull template:web-prototype",
    );
  });

  it("should accept the built-in R2 website template package", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "Kinetic onchain brand studio",
      "--template",
      "dot-matrix",
      "--design-system",
      "stripe",
      "--site-slug",
      "dot-matrix-demo",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "Selected template: template:dot-matrix (Dot Matrix)",
    );
    expect(stdout).toContain(
      "Selected design system: design-system:stripe (Stripe)",
    );
    expect(stdout).toContain(
      "Selected template package: zero resource pull template:dot-matrix --dir ./generated/resources",
    );
    expect(stdout).toContain('"id": "template:dot-matrix"');
    expect(stdout).toContain('"type": "tar.gz"');
    expect(stdout).toContain(
      '"sha256": "f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2"',
    );
  });

  it("should accept the built-in website picker id for --template", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "High contrast launch page",
      "--template",
      "website-template:black-slabs",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "Selected template: template:black-slabs (Black Slabs)",
    );
  });

  it("should reject a template that does not target website", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "website",
        "--prompt",
        "Pricing page for a SaaS",
        "--template",
        "html-ppt-pitch-deck",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown template for website");
  });

  it("should reject an unknown design system", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "website",
        "--prompt",
        "Pricing page for a SaaS",
        "--design-system",
        "definitely-not-a-design-system",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown design system");
  });

  it("should expose the shared HTML artifact flags in help", () => {
    let helpOutput = "";
    websiteCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    websiteCommand.outputHelp();

    expect(helpOutput).toContain("--prompt <text>");
    expect(helpOutput).toContain("--site-slug <slug>");
    expect(helpOutput).toContain("--title <text>");
    expect(helpOutput).toContain("--design-system <id>");
    expect(helpOutput).toContain("--template <id>");
    expect(helpOutput).not.toContain("--json");
    expect(helpOutput).not.toContain("--provider");
    expect(helpOutput).not.toContain("--all");
    expect(helpOutput).not.toContain("--images");
    expect(helpOutput).not.toContain("--image-model");
    expect(helpOutput).not.toContain("--template-direction");
    expect(helpOutput).not.toContain("--audience");
    expect(helpOutput).not.toContain("--site <slug>");
  });
});
