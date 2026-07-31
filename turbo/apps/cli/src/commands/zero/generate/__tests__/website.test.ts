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
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { generateCommand } from "../index";
import { websiteCommand } from "../website";

function buildZeroToken(
  featureSwitchOverrides: Partial<Record<FeatureSwitchKey, boolean>>,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "zero",
      capabilities: [],
      featureSwitchOverrides,
      iat: 1000,
      exp: 2000,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${payload}.test-signature`;
}

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
    expect(stdout).toContain("generation source-selection packet");
    expect(stdout).not.toContain("federated");
    expect(stdout).toContain("## Stage 1: Resource Selection");
    expect(stdout).toContain("## Candidate Registry Slice");
    expect(stdout).toContain(
      "Default Git Source: `nexu-io/open-design@3fb620af423534643677c7c6fae76be088fa770a`",
    );
    expect(stdout).not.toContain("Sources:");
    expect(stdout).not.toContain("vm0-ai/vm0-skills");
    expect(stdout).toContain(
      "For a candidate without `source.archive`, resolve `source.path` only from the pinned Git Source above. Do not run `zero resource pull` for it.",
    );
    expect(stdout).toContain(
      "For a candidate with `source.archive`, run `zero resource pull <candidate-id> --dir ./generated/resources` with that candidate's `id`, then resolve it at `./generated/resources/<source.path>`. Do not look for it in the Git Source.",
    );
    expect(stdout).toContain("observability launch site");
    expect(stdout).toContain("template:black-slabs");
    expect(stdout).toContain("template:web-prototype-taste-editorial");
    expect(stdout).toContain(
      "For landing, marketing, official brand or product, and launch pages, select a vm0 built-in website template.",
    );
    expect(stdout).toContain(
      "For other HTML or website requests, select an Open Design template based on intent; when ambiguous, prefer Open Design.",
    );
    expect(stdout).toContain(
      "Built-in website candidates have `source.archive`; candidates without it are Open Design templates.",
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

  it("should use the static website resource index when enabled", async () => {
    vi.stubEnv(
      "ZERO_TOKEN",
      buildZeroToken({
        [FeatureSwitchKey.HtmlResourceIndex]: true,
      }),
    );

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
      "https://static.vm0.io/html-resources/9e005c4ace807d67338dfa701877df10175a4d2a1c677dea1414aba76867493d/website.json",
    );
    expect(stdout).not.toContain("## Candidate Registry Slice");
    expect(stdout).not.toContain('"id": "template:black-slabs"');
    expect(stdout).toContain(
      "There is no fixed selection count for any resource type.",
    );
    expect(stdout).toContain(
      "The Website index includes vm0 built-in R2 template packages as template entries with `source.archive`.",
    );
    expect(stdout).toContain(
      "Each built-in Website template entry includes the exact pull command and extracted package path in `source.pull`.",
    );
    expect(stdout).toContain(
      "run its exact `source.pull.command`, then use `source.pull.resolvedPath`.",
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
      "For landing, marketing, official brand or product, and launch pages, select a vm0 built-in website template.",
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
