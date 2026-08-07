import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PI_SKILLS_ROOT,
  type RunSkillSnapshot,
} from "@vm0/api-contracts/contracts/runners";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  createPiReadTool,
  formatPiUserPrompt,
  loadPiRunSkills,
  NodeExecutionEnv,
  piMessageRequiresSandbox,
  renderPiSystemPrompt,
} from "./node";

const SHA256_ZERO = `sha256:${"0".repeat(64)}`;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantToolCall(name: string): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `${name}_1`,
        name,
        arguments: {},
      },
    ],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-chat",
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

async function writeSkill(
  directory: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
}

describe("Pi run Skill runtime", () => {
  it("routes only sandbox-dependent tool batches out of the API loop", () => {
    expect(piMessageRequiresSandbox(assistantToolCall("read"))).toBe(false);
    expect(piMessageRequiresSandbox(assistantToolCall("bash"))).toBe(true);
  });

  it("falls back to Okou when the agent name is blank", () => {
    const systemPrompt = renderPiSystemPrompt({
      agentName: " \n ",
      skills: [],
    });
    expect(systemPrompt).toContain("You are Okou, an AI agent.");
    expect(systemPrompt).toContain(
      "As Okou, you are an excellent communicator",
    );
  });

  it("loads only snapshot Skills and preserves prompt and read semantics", async () => {
    await mkdir(PI_SKILLS_ROOT, { recursive: true });
    const testRoot = await mkdtemp(join(PI_SKILLS_ROOT, "vm0-runtime-test-"));
    const skillDirectory = join(testRoot, "pinned-skill");
    const ambientDirectory = join(testRoot, "ambient-skill");
    const referencePath = join(skillDirectory, "references", "answer.txt");
    await writeSkill(
      skillDirectory,
      "pinned-skill",
      "Use for pinned runtime tests.",
      "Read references/answer.txt before answering.",
    );
    await mkdir(join(skillDirectory, "references"), { recursive: true });
    await writeFile(referencePath, "snapshot bytes\n");
    await writeSkill(
      ambientDirectory,
      "ambient-skill",
      "Must remain invisible.",
      "ambient body",
    );

    const snapshot: RunSkillSnapshot = {
      schemaVersion: 1,
      policyVersion: 1,
      root: PI_SKILLS_ROOT,
      digest: SHA256_ZERO,
      entries: [
        {
          logicalDir: skillDirectory,
          skillFile: join(skillDirectory, "SKILL.md"),
          orgId: "org_test",
          userId: "user_test",
          storageName: "pinned-skill",
          storageId: "storage_test",
          versionId: "version_test",
        },
      ],
    };
    const env = new NodeExecutionEnv({ cwd: "/home/user/workspace" });

    try {
      const resources = await loadPiRunSkills(env, snapshot);
      expect(resources.diagnostics).toEqual([]);
      expect(
        resources.skills.map(({ name }) => {
          return name;
        }),
      ).toEqual(["pinned-skill"]);

      const systemPrompt = renderPiSystemPrompt({
        agentName: "Test Pi Agent",
        appendSystemPrompt: "vm0 append prompt",
        agentInstructions: "Pi agent instructions",
        skills: resources.skills,
      });
      expect(systemPrompt).toContain("You are Test Pi Agent, an AI agent.");
      expect(systemPrompt).toContain(
        "As Test Pi Agent, you are an excellent communicator",
      );
      expect(systemPrompt).not.toContain("{{agent_name}}");
      expect(systemPrompt).toContain("<name>pinned-skill</name>");
      expect(systemPrompt).toContain(
        `<location>${skillDirectory}/SKILL.md</location>`,
      );
      expect(systemPrompt).not.toContain("ambient-skill");
      expect(systemPrompt).not.toContain("Read references/answer.txt");
      expect(
        renderPiSystemPrompt({
          agentName: "Test Pi Agent",
          appendSystemPrompt: "vm0 append prompt",
          agentInstructions: "Pi agent instructions",
          skills: resources.skills,
        }),
      ).toBe(systemPrompt);

      const explicitPrompt = formatPiUserPrompt(
        "/skill:pinned-skill finish the task",
        resources.skills,
      );
      expect(explicitPrompt).toContain(
        `<skill name="pinned-skill" location="${skillDirectory}/SKILL.md">`,
      );
      expect(explicitPrompt).toContain("Read references/answer.txt");
      expect(explicitPrompt).toContain("finish the task");

      const readResult = await createPiReadTool(env).execute("read_1", {
        path: referencePath,
      });
      expect(readResult.content).toEqual([
        { type: "text", text: "snapshot bytes\n" },
      ]);
    } finally {
      await env.cleanup();
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
