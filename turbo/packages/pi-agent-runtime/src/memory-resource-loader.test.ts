import { createReadTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  PiMemoryFileStore,
  PiMemoryResourceLoader,
} from "./memory-resource-loader";
import {
  createPiNativeSessionFixture,
  measurePiMemoryPreparation,
} from "./preparation-probe";

describe("Pi memory resource loader", () => {
  it("projects native resources and serves skill bodies from logical paths", async () => {
    const skillPath = "/virtual/agent/skills/probe/SKILL.md";
    const fileStore = new PiMemoryFileStore([
      {
        content: Buffer.from("# Probe\n\nMEMORY_SKILL_BODY\n"),
        path: skillPath,
      },
    ]);
    const loader = new PiMemoryResourceLoader({
      agentsFiles: [
        { content: "MEMORY_AGENTS", path: "/virtual/workspace/AGENTS.md" },
      ],
      skills: [
        {
          baseDir: "/virtual/agent/skills/probe",
          description: "Probe memory-backed resources",
          filePath: skillPath,
          name: "probe",
        },
      ],
    });

    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      { content: "MEMORY_AGENTS", path: "/virtual/workspace/AGENTS.md" },
    ]);
    expect(loader.getSkills().skills[0]).toMatchObject({
      description: "Probe memory-backed resources",
      filePath: skillPath,
      name: "probe",
    });

    const read = createReadTool("/virtual/workspace", {
      operations: fileStore.readOperations(),
    });
    const result = await read.execute("probe-call", { path: skillPath });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("MEMORY_SKILL_BODY"),
        type: "text",
      }),
    ]);
  });

  it("hydrates native Pi JSONL without creating a persisted session", async () => {
    const cwd = "/virtual/workspace";
    const agentDir = "/virtual/agent";
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const skillPath = `${agentDir}/skills/probe/SKILL.md`;
    const measured = await measurePiMemoryPreparation({
      agentDir,
      cwd,
      files: [
        {
          content: Buffer.from("# Probe\n\nMEMORY_SKILL_BODY\n"),
          path: skillPath,
        },
      ],
      logicalCwd: cwd,
      resources: {
        agentsFiles: [{ content: "MEMORY_AGENTS", path: `${cwd}/AGENTS.md` }],
        skills: [
          {
            baseDir: `${agentDir}/skills/probe`,
            description: "Probe memory-backed resources",
            filePath: skillPath,
            name: "probe",
          },
        ],
      },
      sessionId,
      sessionJsonl: createPiNativeSessionFixture({
        logicalCwd: cwd,
        sessionId,
        targetBytes: 1024,
      }),
    });

    expect(measured.official).toMatchObject({
      agentsFileCount: 1,
      diagnosticCount: 0,
      discoveredSkillCount: 1,
      sessionHeaderCwd: cwd,
      sessionListMs: 0,
      sessionPersisted: false,
    });
    expect(measured.checkpoint.toString("utf8")).toContain(sessionId);
  });
});
