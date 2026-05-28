import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { generateCommand } from "../index";
import { selectResourceCandidates } from "../../shared/resource-registry";

describe("zero generate source-backed artifact commands", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  it.each([
    {
      command: "report",
      prompt: "Q2 generation usage report",
      template: "template:finance-report",
    },
    {
      command: "docs-design",
      prompt: "Docs for adding built-in artifact targets",
      template: "template:docs-page",
    },
    {
      command: "poster",
      prompt: "A poster for source-backed generation",
      template: "template:html-ppt-zhangzara-retro-zine",
    },
    {
      command: "dashboard-design",
      prompt: "A dashboard for generation run health",
      template: "template:dashboard",
    },
    {
      command: "mobile-app-design",
      prompt: "A mobile app design for reviewing generated artifacts",
      template: "template:mobile-app",
    },
  ])(
    "prints a source selection packet for $command",
    async ({ command, prompt, template }) => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        command,
        "--prompt",
        prompt,
        "--site",
        `${command}-demo`,
        "--title",
        `${command} demo`,
        "--audience",
        "internal product team",
      ]);

      const stdout = output();
      expect(stdout).toContain(`# Zero generate ${command}`);
      expect(stdout).toContain("federated generation source-selection packet");
      expect(stdout).toContain(prompt);
      expect(stdout).toContain(template);
      expect(stdout).toContain(`Artifact kind: ${command}`);
      expect(stdout).toContain("## Artifact Output Model");
      expect(stdout).toContain(
        `Primary artifact: \`${command}\` at \`./generated/mockups/${command}-demo/index.html\`.`,
      );
      expect(stdout).toContain(
        `Write the artifact under \`./generated/mockups/${command}-demo/\`.`,
      );
      expect(stdout).toContain(
        `zero host ./generated/mockups/${command}-demo --site ${command}-demo`,
      );
    },
  );

  it("prints JSON metadata for mobile-app-design", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "mobile-app-design",
      "--prompt",
      "A mobile review screen",
      "--site",
      "mobile-review",
      "--json",
    ]);

    const parsed = JSON.parse(output()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      type: "generation-source-selection",
      kind: "mobile-app-design",
      prompt: "A mobile review screen",
      outputDir: "./generated/mockups/mobile-review",
      site: "mobile-review",
      artifact: {
        outputMode: "primary-artifact-with-supporting-assets",
        primaryArtifact: {
          kind: "mobile-app-design",
          path: "./generated/mockups/mobile-review/index.html",
        },
      },
    });
  });

  it("returns every registered skill grouped by kind", () => {
    const selection = selectResourceCandidates();

    expect(selection.candidates.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "skill:theme-factory",
          description: expect.stringContaining(
            "Apply professional font and color themes",
          ),
          source: expect.objectContaining({
            path: "skills/theme-factory/SKILL.md",
          }),
        }),
      ]),
    );
  });

  it("returns every registered template and design system", () => {
    const selection = selectResourceCandidates();

    expect(selection.candidates.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "template:saas-landing",
          description: expect.stringContaining("Single-page SaaS landing"),
        }),
      ]),
    );
    expect(selection.candidates.designSystems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "design-system:shopify",
          description: expect.stringContaining("E-commerce platform"),
        }),
      ]),
    );
  });

  it("attributes every vm0 image style to the vm0-skills repo", () => {
    const selection = selectResourceCandidates();
    const vm0ImageStyles = selection.candidates.imageStyles.filter((entry) => {
      return entry.id.startsWith("image-style:");
    });

    expect(vm0ImageStyles.length).toBeGreaterThan(0);
    for (const entry of vm0ImageStyles) {
      expect(entry.source.repo).toBe("vm0-ai/vm0-skills");
      expect(entry.source.ref).toBe("main");
    }
  });
});
