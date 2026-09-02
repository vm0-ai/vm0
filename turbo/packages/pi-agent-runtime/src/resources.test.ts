import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFauxCore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { piPreheatedResourceLoaderOptions } from "./resources";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("preheated Pi resources", () => {
  it("lets Pi build its native prompt without reading discovery files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resource-snapshot-"));
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
      ...piPreheatedResourceLoaderOptions({
        appendSystemPrompt: ["Appended by the run"],
        snapshot: {
          schemaVersion: 1,
          agentsFiles: [
            {
              path: agentsPath,
              content: "Use the repository-native validation workflow.",
            },
          ],
          skills: [
            {
              name: "release-check",
              description: "Inspect a release before deployment.",
              filePath: skillPath,
              baseDir: join(agentDir, "skills", "release-check"),
              scope: "user",
              disableModelInvocation: false,
            },
            {
              name: "manual-only",
              description: "Only available through explicit invocation.",
              filePath: join(agentDir, "skills", "manual-only", "SKILL.md"),
              baseDir: join(agentDir, "skills", "manual-only"),
              scope: "user",
              disableModelInvocation: true,
            },
          ],
        },
      }),
    });
    await loader.reload();
    const faux = createFauxCore({
      api: "resource-test",
      provider: "resource-test",
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: faux.getModel(),
      tools: ["read"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });

    expect(session.systemPrompt).toContain(
      `<project_instructions path="${agentsPath}">\nUse the repository-native validation workflow.`,
    );
    expect(session.systemPrompt).toContain("<name>release-check</name>");
    expect(session.systemPrompt).toContain(
      "<description>Inspect a release before deployment.</description>",
    );
    expect(session.systemPrompt).toContain(`<location>${skillPath}</location>`);
    expect(session.systemPrompt).not.toContain("manual-only");
    expect(session.systemPrompt).toContain("Appended by the run");
    expect(session.sessionManager.getSessionFile()).toBeUndefined();
    session.dispose();

    await expect(access(agentsPath)).rejects.toThrow();
    await expect(access(skillPath)).rejects.toThrow();
  });
});
