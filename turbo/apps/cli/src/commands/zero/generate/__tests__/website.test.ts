/**
 * Tests for okou generate website command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none for the source-selection path
 * - Real (internal): prompt parsing and authoring packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { WEBSITE_TEMPLATE_ARCHIVE_VERSION_ENV } from "@vm0/core/resource-registry";
import { generateCommand } from "../index";
import { websiteCommand } from "../website";

describe("okou generate website command", () => {
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
    expect(stdout).toContain("# Okou generate website");
    expect(stdout).toContain("generation source-selection packet");
    expect(stdout).not.toContain("federated");
    expect(stdout).toContain("## Stage 1: Resource Selection");
    expect(stdout).toContain(
      "https://static.vm0.io/html-resources/9e005c4ace807d67338dfa701877df10175a4d2a1c677dea1414aba76867493d/website.json",
    );
    expect(stdout).not.toContain("Sources:");
    expect(stdout).not.toContain("vm0-ai/vm0-skills");
    expect(stdout).toContain(
      "There is no fixed selection count for any resource type.",
    );
    expect(stdout).toContain(
      "For a selected entry without `source.archive`, resolve its `source.path` from the index's pinned `source.repo@source.ref`. Do not run `okou resource pull` for it.",
    );
    expect(stdout).toContain(
      "run its exact `source.pull.command`, then use `source.pull.resolvedPath`.",
    );
    expect(stdout).toContain(
      "The Website index includes Okou built-in R2 template packages as template entries with `source.archive`.",
    );
    expect(stdout).toContain(
      "Each built-in Website template entry includes the exact pull command and extracted package path in `source.pull`.",
    );
    expect(stdout).toContain("observability launch site");
    expect(stdout).toContain(
      "For landing, marketing, official brand or product, and launch pages, select an Okou built-in website template.",
    );
    expect(stdout).toContain(
      "For other HTML or website requests, select an Open Design template based on intent; when ambiguous, prefer Open Design.",
    );
    expect(stdout).toContain(
      "Built-in website candidates have `source.archive`; candidates without it are Open Design templates.",
    );
    expect(stdout).toContain("Built-in Website template release: previous");
    expect(stdout).not.toContain("use `seedream4` by default");
    expect(stdout).toContain(
      "Write the artifact under `./generated/mockups/clearpath-demo/`.",
    );
    expect(stdout).toContain(
      "okou host ./generated/mockups/clearpath-demo --site clearpath-demo --spa",
    );
  });

  it("should expose the latest independent registry inside the rollout", async () => {
    vi.stubEnv(WEBSITE_TEMPLATE_ARCHIVE_VERSION_ENV, "latest");

    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "observability launch site",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "https://static.vm0.io/html-resources/website/v1/f0ad1af26306b7cbd9e4e1505a9991e8e9330ca507d5890245553c760878be04/website.json",
    );
    expect(stdout).toContain("Built-in Website template release: latest");
    expect(stdout).toContain(
      "use `seedream4` by default unless the user specifies another image model",
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
      "okou host ./generated/mockups/clearpath --site clearpath --spa",
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
    expect(stdout).toContain("Use the explicitly selected template.");
    expect(stdout).not.toContain(
      "For landing, marketing, official brand or product, and launch pages, select an Okou built-in website template.",
    );
    expect(stdout).not.toContain(
      "Selected template package: okou resource pull template:web-prototype",
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
      "Selected template package: okou resource pull template:dot-matrix --dir ./generated/resources",
    );
    expect(stdout).toContain(
      "Selected template archive SHA-256: f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2",
    );
  });

  it("should pin the latest built-in package inside the rollout", async () => {
    vi.stubEnv(WEBSITE_TEMPLATE_ARCHIVE_VERSION_ENV, "latest");

    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "Kinetic onchain brand studio",
      "--template",
      "dot-matrix",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "Selected template archive SHA-256: cfb8f891fa77eca2c3a58f1d95f046f873136f85c9c4a83400cba3a2ccca4ad9",
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
