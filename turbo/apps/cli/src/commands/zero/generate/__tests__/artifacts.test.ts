import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import chalk from "chalk";
import { generateCommand } from "../index";
import { reportCommand } from "../artifacts";
import { selectResourceCandidates } from "../../shared/resource-registry";

function zeroToken(registrySearchEnabled: boolean): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user-123",
      runId: "run-123",
      orgId: "org-123",
      scope: "zero",
      capabilities: [],
      featureSwitchOverrides: {
        [FeatureSwitchKey.ArtifactResourceRegistrySearch]:
          registrySearchEnabled,
      },
      iat: 1,
      exp: 4_102_444_800,
    }),
  ).toString("base64url");
  return `vm0_sandbox_header.${payload}.signature`;
}

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
    vi.stubEnv("ZERO_TOKEN", zeroToken(true));
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
    },
    {
      command: "docs-design",
      prompt: "Docs for adding built-in artifact targets",
    },
    {
      command: "poster",
      prompt: "A poster for source-backed generation",
    },
    {
      command: "dashboard-design",
      prompt: "A dashboard for generation run health",
    },
    {
      command: "mobile-app-design",
      prompt: "A mobile app design for reviewing generated artifacts",
    },
  ])(
    "prints a static Registry search packet for $command",
    async ({ command, prompt }) => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        command,
        "--prompt",
        prompt,
        "--site-slug",
        `${command}-demo`,
        "--title",
        `${command} demo`,
      ]);

      const stdout = output();
      expect(stdout).toContain(`# Zero generate ${command}`);
      expect(stdout).toContain("generation resource-selection packet");
      expect(stdout).not.toContain("federated");
      expect(stdout).toContain(prompt);
      expect(stdout).toContain("## Stage 1: Search Resource Registry");
      expect(stdout).toContain(
        "Derive 3-8 concise English keywords and synonyms from the user prompt.",
      );
      expect(stdout).toContain(
        "matching keywords against each resource's `name`, `description`, and `tags`.",
      );
      expect(stdout).toContain(
        "https://static.vm0.io/vm0/html-resource-registry/v2/0899a14208b6a4775b326ebbaf08cf76973ebdb99fbb2fb6eb3a9f23be3f8c58/registry.json",
      );
      expect(stdout).toContain(
        "0899a14208b6a4775b326ebbaf08cf76973ebdb99fbb2fb6eb3a9f23be3f8c58  /tmp/vm0-html-resource-registry-v2.json",
      );
      expect(stdout).toContain(`jq -r --arg target "${command}"`);
      expect(stdout).toContain("| rg -i '<keyword|synonym>'");
      expect(stdout).toContain('"resource": "string"');
      expect(stdout).toContain(
        "For `openDesign`, follow the Registry's three Git sparse-checkout steps",
      );
      expect(stdout).toContain(
        "For `websiteR2`, run the Registry's authenticated `zero resource pull` command.",
      );
      expect(stdout).not.toContain("## Candidate Registry Slice");
      expect(stdout).not.toContain('"id": "skill:article-magazine"');
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
      expect(stdout).toContain(
        "The hosted URL is the preview and user-accessible view for this static HTML artifact.",
      );
      expect(stdout).toContain(
        "Check that shapes, charts, images, or decorative graphics do not cover readable text",
      );
    },
  );

  it("exposes the shared HTML artifact flags in report help", () => {
    let helpOutput = "";
    reportCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    reportCommand.outputHelp();

    expect(helpOutput).toContain("--prompt <text>");
    expect(helpOutput).toContain("--site-slug <slug>");
    expect(helpOutput).toContain("--title <text>");
    expect(helpOutput).toContain("--design-system <id>");
    expect(helpOutput).toContain("--template <id>");
    expect(helpOutput).not.toContain("--json");
    expect(helpOutput).not.toContain("--provider");
    expect(helpOutput).not.toContain("--all");
    expect(helpOutput).not.toContain("--audience");
    expect(helpOutput).not.toContain("--site <slug>");
  });

  it("returns every registered skill when no target is requested", () => {
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

  it("filters skill candidates by target when requested", () => {
    const websiteSkillIds = selectResourceCandidates(
      "website",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const reportSkillIds = selectResourceCandidates(
      "report",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const posterSkillIds = selectResourceCandidates(
      "poster",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const presentationSkillIds = selectResourceCandidates(
      "presentation",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const imageSkillIds = selectResourceCandidates(
      "image",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const videoSkillIds = selectResourceCandidates(
      "intro-video",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });

    expect(websiteSkillIds).toHaveLength(23);
    expect(reportSkillIds).toHaveLength(23);
    expect(posterSkillIds).toHaveLength(28);
    expect(presentationSkillIds).toHaveLength(6);
    expect(imageSkillIds).toHaveLength(5);
    expect(videoSkillIds).toHaveLength(18);

    expect(websiteSkillIds).toContain("skill:article-magazine");
    expect(reportSkillIds).toContain("skill:article-magazine");
    expect(reportSkillIds).not.toContain("skill:design-brief");
    expect(reportSkillIds).not.toContain("skill:algorithmic-art");
    expect(reportSkillIds).not.toContain("skill:slides");
    expect(reportSkillIds).not.toContain("skill:video-hyperframes");
    expect(reportSkillIds).not.toContain("skill:8-bit-orbit-video-template");

    expect(posterSkillIds).toContain("skill:article-magazine");
    expect(posterSkillIds).toContain("skill:algorithmic-art");
    expect(presentationSkillIds).toContain("skill:slides");
    expect(imageSkillIds).toContain("skill:algorithmic-art");
    expect(videoSkillIds).toContain("skill:video-hyperframes");
    expect(videoSkillIds).toContain("skill:8-bit-orbit-video-template");
  });

  it("returns every registered template and design system", () => {
    const selection = selectResourceCandidates();

    expect(selection.candidates.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "template:finance-report",
          description: expect.stringContaining("financial report"),
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

  it("omits unnecessary candidate groups from the generated packet", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "report",
      "--prompt",
      "Q2 generation usage report",
      "--site-slug",
      "report-demo",
    ]);

    const stdout = output();
    expect(stdout).not.toContain('"imageStyles"');
    expect(stdout).not.toContain('"audioStyles"');
    expect(stdout).not.toContain('"videoTemplates"');
    expect(stdout).not.toContain('"bundleTemplates"');
    expect(stdout).not.toContain('"imageStyle"');
    expect(stdout).not.toContain('"audioStyle"');
    expect(stdout).not.toContain('"videoTemplate"');
    expect(stdout).not.toContain('"bundleTemplate"');
    expect(stdout).not.toContain('"kind": "skill"');
    expect(stdout).not.toContain('"kind": "design-system"');
  });

  it("keeps the legacy full candidate slice when Registry search is disabled", async () => {
    vi.stubEnv("ZERO_TOKEN", zeroToken(false));

    await generateCommand.parseAsync([
      "node",
      "cli",
      "report",
      "--prompt",
      "Q2 generation usage report",
      "--site-slug",
      "report-demo",
    ]);

    const stdout = output();
    const legacySelection = selectResourceCandidates("report");
    expect(stdout).toContain("federated generation source-selection packet");
    expect(stdout).toContain("## Candidate Registry Slice");
    expect(stdout).not.toContain("## Static Resource Registry");
    expect(stdout).not.toContain("| rg -i '<keyword|synonym>'");
    expect(stdout).toContain('"skills": "string[]"');
    expect(stdout.match(/"kind": "skill"/gu)).toHaveLength(
      legacySelection.candidates.skills.length,
    );
    expect(stdout.match(/"kind": "design-system"/gu)).toHaveLength(
      legacySelection.candidates.designSystems.length,
    );
  });

  it("filters template candidates by target when requested", () => {
    const websiteSelection = selectResourceCandidates("website");
    const presentationSelection = selectResourceCandidates("presentation");

    expect(websiteSelection.candidates.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "template:warm-cards",
          source: expect.objectContaining({
            path: "warm-cards",
            archive: expect.objectContaining({ type: "tar.gz" }),
          }),
        }),
      ]),
    );
    expect(websiteSelection.candidates.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "template:saas-landing" }),
        expect.objectContaining({ id: "template:web-prototype" }),
      ]),
    );
    expect(websiteSelection.candidates.templates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "template:html-ppt-pitch-deck" }),
      ]),
    );
    expect(presentationSelection.candidates.templates).toHaveLength(0);
  });

  it("annotates every template entry with at least one target", () => {
    const selection = selectResourceCandidates();
    for (const template of selection.candidates.templates) {
      expect(
        template.targets,
        `${template.id} is missing the targets field`,
      ).toBeDefined();
      expect(
        template.targets?.length,
        `${template.id} has an empty targets array`,
      ).toBeGreaterThan(0);
    }
  });

  it("annotates every skill entry with targets", () => {
    const selection = selectResourceCandidates();
    for (const skill of selection.candidates.skills) {
      expect(
        skill.targets,
        `${skill.id} is missing the targets field`,
      ).toBeDefined();
    }
  });

  it("accepts --design-system and --template on report", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "report",
      "--prompt",
      "Q2 finance report",
      "--site-slug",
      "q2-finance-demo",
      "--design-system",
      "apple",
      "--template",
      "finance-report",
    ]);

    const stdout = output();
    expect(stdout).toContain(
      "Selected design system: design-system:apple (Apple)",
    );
    expect(stdout).toContain(
      "Selected template: template:finance-report (Finance Report)",
    );
  });

  it("rejects an unknown template id on dashboard-design", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "dashboard-design",
        "--prompt",
        "a dashboard",
        "--template",
        "not-a-real-template",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown template for dashboard-design");
  });

  it("rejects a template that does not target the requested kind", async () => {
    // finance-report only targets report and should fail for dashboard-design
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "dashboard-design",
        "--prompt",
        "a dashboard",
        "--template",
        "finance-report",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown template for dashboard-design");
  });
});
