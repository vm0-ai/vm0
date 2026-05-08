import { describe, expect, it } from "vitest";
import { resolveVolumes } from "../storage-resolver";
import type { AgentVolumeConfig } from "../types";

describe("resolveVolumes", () => {
  const config: AgentVolumeConfig = {
    agents: {
      "test-agent": {
        framework: "claude-code",
        instructions: "CLAUDE.md",
      },
    },
  };

  it("mounts instructions using the compose framework by default", () => {
    const result = resolveVolumes(config);

    expect(result.errors).toEqual([]);
    expect(result.volumes).toEqual([
      expect.objectContaining({
        name: "agent-instructions@test-agent",
        mountPath: "/home/user/.claude",
      }),
    ]);
  });

  it("mounts instructions using the runtime framework override", () => {
    const result = resolveVolumes(config, {}, undefined, "codex");

    expect(result.errors).toEqual([]);
    expect(result.volumes).toEqual([
      expect.objectContaining({
        name: "agent-instructions@test-agent",
        mountPath: "/home/user/.codex",
      }),
    ]);
  });
});
