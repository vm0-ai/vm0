import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSyntheticSourceInfo,
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { formatPiSkillCatalogForPrompt } from "./resources";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("preheated Pi resource discovery", () => {
  it("formats the native discovery prompt from metadata without skill files", async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), "pi-skill-catalog-"));
    temporaryDirectories.push(skillRoot);
    const missingSkillFile = join(skillRoot, "release-check", "SKILL.md");
    await expect(access(missingSkillFile)).rejects.toThrow();

    const prompt = formatPiSkillCatalogForPrompt({
      skillRoot,
      skills: [
        {
          name: "release-check",
          slug: "release-check",
          description: "Inspect a release before deployment.",
        },
        {
          name: "manual-only",
          slug: "manual-only",
          description: "Only available through explicit invocation.",
          disableModelInvocation: true,
        },
      ],
    });

    expect(prompt).toContain("<name>release-check</name>");
    expect(prompt).toContain(
      "<description>Inspect a release before deployment.</description>",
    );
    expect(prompt).toContain(`<location>${missingSkillFile}</location>`);
    expect(prompt).not.toContain("manual-only");
    const officialSkills: Skill[] = [
      {
        name: "release-check",
        description: "Inspect a release before deployment.",
        filePath: missingSkillFile,
        baseDir: join(skillRoot, "release-check"),
        sourceInfo: createSyntheticSourceInfo(missingSkillFile, {
          source: "test",
        }),
        disableModelInvocation: false,
      },
      {
        name: "manual-only",
        description: "Only available through explicit invocation.",
        filePath: join(skillRoot, "manual-only", "SKILL.md"),
        baseDir: join(skillRoot, "manual-only"),
        sourceInfo: createSyntheticSourceInfo(
          join(skillRoot, "manual-only", "SKILL.md"),
          { source: "test" },
        ),
        disableModelInvocation: true,
      },
    ];
    expect(prompt).toBe(formatSkillsForPrompt(officialSkills));
    await expect(access(missingSkillFile)).rejects.toThrow();
  });
});
