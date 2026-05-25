import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import chalk from "chalk";
import { zeroBuiltInCommand } from "../../index";

function buildZeroToken(openDesignGenerate: boolean): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "zero",
      capabilities: ["host:write"],
      featureSwitches: {
        [FeatureSwitchKey.OpenDesignGenerate]: openDesignGenerate,
      },
      iat: 1_700_000_000,
      exp: 1_700_007_200,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

describe("zero built-in generate Open Design artifact commands", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(true));
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
      template: "od:template:finance-report",
    },
    {
      command: "docs-design",
      prompt: "Docs for adding built-in artifact targets",
      template: "od:template:docs-page",
    },
    {
      command: "poster",
      prompt: "A poster for Open Design generation",
      template: "od:template:html-ppt-zhangzara-retro-zine",
    },
    {
      command: "dashboard-design",
      prompt: "A dashboard for generation run health",
      template: "od:template:dashboard",
    },
    {
      command: "mobile-app-design",
      prompt: "A mobile app design for reviewing generated artifacts",
      template: "od:template:mobile-app",
    },
  ])(
    "prints an Open Design resource selection packet for $command",
    async ({ command, prompt, template }) => {
      await zeroBuiltInCommand.parseAsync([
        "node",
        "cli",
        "generate",
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
      expect(stdout).toContain(`# Zero built-in generate ${command}`);
      expect(stdout).toContain("Open Design resource-selection packet");
      expect(stdout).toContain(prompt);
      expect(stdout).toContain(template);
      expect(stdout).toContain(`Artifact kind: ${command}`);
      expect(stdout).toContain(
        `Write the artifact under \`./opendesign/mockups/${command}-demo/\`.`,
      );
      expect(stdout).toContain(
        `zero host ./opendesign/mockups/${command}-demo --site ${command}-demo`,
      );
    },
  );

  it("prints JSON metadata for mobile-app-design", async () => {
    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "mobile-app-design",
      "--prompt",
      "A mobile review screen",
      "--site",
      "mobile-review",
      "--json",
    ]);

    const parsed = JSON.parse(output()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      type: "open-design-resource-selection",
      kind: "mobile-app-design",
      prompt: "A mobile review screen",
      outputDir: "./opendesign/mockups/mobile-review",
      site: "mobile-review",
    });
  });

  it("rejects Open Design artifact generation when the feature is disabled", async () => {
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(false));

    await expect(async () => {
      await zeroBuiltInCommand.parseAsync([
        "node",
        "cli",
        "generate",
        "report",
        "--prompt",
        "Q2 report",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("requires the openDesignGenerate feature switch"),
    );
  });
});
