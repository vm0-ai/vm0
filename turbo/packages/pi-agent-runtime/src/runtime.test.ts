import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  PI_SKILLS_ROOT,
  type RunSkillSnapshot,
} from "@vm0/api-contracts/contracts/runners";
import type {
  FileError,
  FileInfo,
  Result,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import {
  formatPiUserPrompt,
  loadPiRunSkills,
  renderPiSystemPrompt,
} from "./runtime";
import { createPiReadTool, piMessageRequiresSandbox } from "./tools";

const SHA256_ZERO = `sha256:${"0".repeat(64)}`;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class GuestSkillsExecutionEnv extends NodeExecutionEnv {
  constructor(private readonly hostSkillsRoot: string) {
    super({ cwd: "/home/user/workspace" });
  }

  private hostPath(path: string): string {
    const suffix =
      path === PI_SKILLS_ROOT ? "" : path.slice(`${PI_SKILLS_ROOT}/`.length);
    return join(this.hostSkillsRoot, suffix);
  }

  private guestPath(path: string): string {
    const suffix = relative(this.hostSkillsRoot, path);
    return suffix ? join(PI_SKILLS_ROOT, suffix) : PI_SKILLS_ROOT;
  }

  private guestFileInfo(info: FileInfo): FileInfo {
    return { ...info, path: this.guestPath(info.path) };
  }

  override readTextFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    return super.readTextFile(this.hostPath(path), abortSignal);
  }

  override readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>> {
    return super.readBinaryFile(this.hostPath(path), abortSignal);
  }

  override async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    const result = await super.fileInfo(this.hostPath(path));
    return result.ok
      ? { ok: true, value: this.guestFileInfo(result.value) }
      : result;
  }

  override async listDir(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<FileInfo[], FileError>> {
    const result = await super.listDir(this.hostPath(path), abortSignal);
    return result.ok
      ? {
          ok: true,
          value: result.value.map((info) => {
            return this.guestFileInfo(info);
          }),
        }
      : result;
  }

  override async canonicalPath(
    path: string,
  ): Promise<Result<string, FileError>> {
    const result = await super.canonicalPath(this.hostPath(path));
    return result.ok
      ? { ok: true, value: this.guestPath(result.value) }
      : result;
  }
}

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
  it("routes every tool batch out of the API edge loop to the sandbox", () => {
    expect(piMessageRequiresSandbox(assistantToolCall("read"))).toBe(true);
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
    const hostSkillsRoot = await mkdtemp(join(tmpdir(), "vm0-runtime-test-"));
    const skillDirectory = join(PI_SKILLS_ROOT, "pinned-skill");
    const referencePath = join(skillDirectory, "references", "answer.txt");
    const hostSkillDirectory = join(hostSkillsRoot, "pinned-skill");
    const env = new GuestSkillsExecutionEnv(hostSkillsRoot);

    try {
      await writeSkill(
        hostSkillDirectory,
        "pinned-skill",
        "Use for pinned runtime tests.",
        "Read references/answer.txt before answering.",
      );
      await mkdir(join(hostSkillDirectory, "references"), { recursive: true });
      await writeFile(
        join(hostSkillDirectory, "references", "answer.txt"),
        "snapshot bytes\n",
      );
      await writeSkill(
        join(hostSkillsRoot, "ambient-skill"),
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
      await rm(hostSkillsRoot, { recursive: true, force: true });
    }
  });
});
