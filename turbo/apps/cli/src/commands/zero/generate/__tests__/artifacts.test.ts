import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import chalk from "chalk";
import { generateCommand } from "../index";
import { reportCommand } from "../artifacts";
import {
  buildResourceCandidateSlice,
  listDesignSystems,
  listSkills,
  listTemplates,
} from "../../shared/resource-registry";

function zeroToken(sampleCandidates: boolean): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user-123",
      runId: "run-123",
      orgId: "org-123",
      scope: "zero",
      capabilities: [],
      featureSwitchOverrides: {
        [FeatureSwitchKey.ArtifactResourceCandidateSampling]: sampleCandidates,
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

  function pickFirst(): number {
    return 0;
  }

  function pickLast(): number {
    return 0.999_999;
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
      expect(stdout).toContain(template);
      expect(stdout).toContain('"type": "git"');
      expect(stdout).not.toContain("vm0-ai/vm0-skills");
      expect(stdout).toContain(
        "Source: `nexu-io/open-design@3fb620af423534643677c7c6fae76be088fa770a`",
      );
      expect(stdout).not.toContain("Sources:");
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
    expect(listSkills()).toEqual(
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
    const websiteSkillIds = listSkills("website").map((skill) => {
      return skill.id;
    });
    const reportSkillIds = listSkills("report").map((skill) => {
      return skill.id;
    });
    const posterSkillIds = listSkills("poster").map((skill) => {
      return skill.id;
    });
    const presentationSkillIds = listSkills("presentation").map((skill) => {
      return skill.id;
    });
    const imageSkillIds = listSkills("image").map((skill) => {
      return skill.id;
    });
    const videoSkillIds = listSkills("intro-video").map((skill) => {
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

  it("samples five target-compatible skills and design systems without replacement", () => {
    const first = buildResourceCandidateSlice("report", {
      samplingEnabled: true,
      random: pickFirst,
    });
    const repeated = buildResourceCandidateSlice("report", {
      samplingEnabled: true,
      random: pickFirst,
    });
    const alternate = buildResourceCandidateSlice("report", {
      samplingEnabled: true,
      random: pickLast,
    });
    const skillIds = first.candidates.skills.items.map((skill) => {
      return skill.id;
    });
    const designSystemIds = first.candidates.designSystems.items.map(
      (designSystem) => {
        return designSystem.id;
      },
    );

    expect(skillIds).toHaveLength(5);
    expect(new Set(skillIds).size).toBe(5);
    expect(first.candidates.skills.source).toEqual({
      type: "git",
      repo: "nexu-io/open-design",
      ref: "3fb620af423534643677c7c6fae76be088fa770a",
    });
    expect(
      first.candidates.skills.items.every((skill) => {
        return skill.targets?.includes("report") ?? false;
      }),
    ).toBe(true);
    expect(designSystemIds).toHaveLength(5);
    expect(new Set(designSystemIds).size).toBe(5);
    expect(repeated.candidates.skills.items).toEqual(
      first.candidates.skills.items,
    );
    expect(repeated.candidates.designSystems.items).toEqual(
      first.candidates.designSystems.items,
    );
    expect(alternate.candidates.skills.items).not.toEqual(
      first.candidates.skills.items,
    );
    expect(alternate.candidates.designSystems.items).not.toEqual(
      first.candidates.designSystems.items,
    );
  });

  it("returns every registered template and design system", () => {
    expect(listTemplates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "template:finance-report",
          description: expect.stringContaining("financial report"),
        }),
      ]),
    );
    expect(listDesignSystems()).toEqual(
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
    expect(stdout).not.toContain('"websiteR2"');
    expect(stdout).not.toContain('"type": "r2-archive"');
    expect(stdout.match(/"kind": "skill"/gu)).toHaveLength(5);
    expect(stdout.match(/"kind": "design-system"/gu)).toHaveLength(5);
  });

  it("keeps full candidate pools when candidate sampling is disabled", async () => {
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
    expect(stdout.match(/"kind": "skill"/gu)).toHaveLength(
      listSkills("report").length,
    );
    expect(stdout.match(/"kind": "design-system"/gu)).toHaveLength(
      listDesignSystems().length,
    );
  });

  it("keeps filtered Open Design templates and samples five R2 website templates", () => {
    const websiteSelection = buildResourceCandidateSlice("website", {
      samplingEnabled: true,
      random: pickFirst,
    });
    const repeatedWebsiteSelection = buildResourceCandidateSlice("website", {
      samplingEnabled: true,
      random: pickFirst,
    });
    const alternateWebsiteSelection = buildResourceCandidateSlice("website", {
      samplingEnabled: true,
      random: pickLast,
    });
    const fullWebsiteSelection = buildResourceCandidateSlice("website", {
      samplingEnabled: false,
      random: pickFirst,
    });
    const presentationSelection = buildResourceCandidateSlice("presentation", {
      samplingEnabled: true,
      random: pickFirst,
    });
    const websiteR2 = websiteSelection.candidates.templates.websiteR2;
    const expectedOpenDesignTemplates = listTemplates("website").filter(
      (template) => {
        return template.source.archive === undefined;
      },
    );

    expect(websiteSelection.candidates.templates.openDesign.items).toEqual(
      expectedOpenDesignTemplates,
    );
    expect(websiteSelection.candidates.templates.openDesign.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "template:saas-landing" }),
        expect.objectContaining({ id: "template:web-prototype" }),
      ]),
    );
    expect(websiteSelection.candidates.templates.openDesign.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "template:html-ppt-pitch-deck" }),
      ]),
    );
    expect(websiteR2?.source).toEqual({
      type: "r2-archive",
      resolver: "zero-resource-pull",
    });
    expect(websiteR2?.items).toHaveLength(5);
    expect(
      new Set(
        websiteR2?.items.map((template) => {
          return template.id;
        }),
      ).size,
    ).toBe(5);
    expect(
      websiteR2?.items.every((template) => {
        return template.source.archive?.type === "tar.gz";
      }),
    ).toBe(true);
    expect(
      repeatedWebsiteSelection.candidates.templates.websiteR2?.items,
    ).toEqual(websiteR2?.items);
    expect(
      alternateWebsiteSelection.candidates.templates.websiteR2?.items,
    ).not.toEqual(websiteR2?.items);
    expect(fullWebsiteSelection.candidates.templates.websiteR2?.items).toEqual(
      listTemplates("website").filter((template) => {
        return template.source.archive !== undefined;
      }),
    );
    expect(
      presentationSelection.candidates.templates.openDesign.items,
    ).toHaveLength(0);
    expect(
      presentationSelection.candidates.templates.websiteR2,
    ).toBeUndefined();
  });

  it("annotates every template entry with at least one target", () => {
    for (const template of listTemplates()) {
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
    for (const skill of listSkills()) {
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
