import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  SessionManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore } from "@earendil-works/pi-ai";
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

  it("lets Pi build its system prompt from preheated metadata and context", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resource-loader-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const agentsPath = join(cwd, "AGENTS.md");
    const skillPath = join(agentDir, "skills", "release-check", "SKILL.md");
    await expect(access(agentsPath)).rejects.toThrow();
    await expect(access(skillPath)).rejects.toThrow();

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "preheated Pi base prompt",
      appendSystemPrompt: [],
      agentsFilesOverride() {
        return {
          agentsFiles: [
            {
              path: agentsPath,
              content: "Use the repository-native validation workflow.",
            },
          ],
        };
      },
      skillsOverride() {
        return {
          skills: [
            {
              name: "release-check",
              description: "Inspect a release before deployment.",
              filePath: skillPath,
              baseDir: join(agentDir, "skills", "release-check"),
              sourceInfo: createSyntheticSourceInfo(skillPath, {
                source: "preheated",
              }),
              disableModelInvocation: false,
            },
          ],
          diagnostics: [],
        };
      },
    });
    await loader.reload();
    const faux = createFauxCore({
      api: "pi-resource-spike",
      provider: "pi-resource-spike",
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: faux.getModel(),
      tools: ["read"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });

    expect(session.systemPrompt).toContain("preheated Pi base prompt");
    expect(session.systemPrompt).toContain(
      `<project_instructions path="${agentsPath}">\nUse the repository-native validation workflow.`,
    );
    expect(session.systemPrompt).toContain("<name>release-check</name>");
    expect(session.systemPrompt).toContain(
      "<description>Inspect a release before deployment.</description>",
    );
    expect(session.systemPrompt).toContain(`<location>${skillPath}</location>`);
    expect(session.systemPrompt).toContain(`Current working directory: ${cwd}`);
    expect(session.getActiveToolNames()).toStrictEqual(["read"]);
    expect(session.sessionManager.getSessionFile()).toBeUndefined();
    session.dispose();

    await expect(access(agentsPath)).rejects.toThrow();
    await expect(access(skillPath)).rejects.toThrow();
  });
});
