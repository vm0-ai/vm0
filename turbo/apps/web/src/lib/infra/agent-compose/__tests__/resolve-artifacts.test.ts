import { describe, it, expect } from "vitest";
import { MOUNT_PATH_TEMPLATE } from "@vm0/core/contracts/composes";
import { resolveComposeArtifacts } from "../resolve-artifacts";
import type { AgentComposeYaml } from "../types";

const claudeCodeWorkingDir = "/home/user/workspace";

function baseCompose(
  artifacts?: AgentComposeYaml["artifacts"],
): AgentComposeYaml {
  return {
    version: "1",
    agents: {
      "my-agent": { framework: "claude-code" },
    },
    artifacts,
  };
}

describe("resolveComposeArtifacts", () => {
  it("returns [] when compose has no artifacts", () => {
    expect(resolveComposeArtifacts(baseCompose())).toEqual([]);
  });

  it("returns [] when artifacts is an empty array", () => {
    expect(resolveComposeArtifacts(baseCompose([]))).toEqual([]);
  });

  it("passes through an explicit absolute mount_path", () => {
    const result = resolveComposeArtifacts(
      baseCompose([{ name: "a", version: "v1", mount_path: "/custom/path" }]),
    );
    expect(result).toEqual([
      { name: "a", version: "v1", mountPath: "/custom/path" },
    ]);
  });

  it("substitutes the ${{ working_dir }} template with the framework working_dir", () => {
    const result = resolveComposeArtifacts(
      baseCompose([{ name: "a", mount_path: MOUNT_PATH_TEMPLATE }]),
    );
    expect(result).toEqual([
      { name: "a", version: undefined, mountPath: claudeCodeWorkingDir },
    ]);
  });

  it("defaults missing mount_path to working_dir (backward compat)", () => {
    const result = resolveComposeArtifacts(
      baseCompose([{ name: "a", version: "v1" }]),
    );
    expect(result).toEqual([
      { name: "a", version: "v1", mountPath: claudeCodeWorkingDir },
    ]);
  });

  it("resolves multiple entries independently", () => {
    const result = resolveComposeArtifacts(
      baseCompose([
        { name: "a", mount_path: "/x" },
        { name: "b", mount_path: MOUNT_PATH_TEMPLATE },
        { name: "c" },
      ]),
    );
    expect(result).toEqual([
      { name: "a", version: undefined, mountPath: "/x" },
      { name: "b", version: undefined, mountPath: claudeCodeWorkingDir },
      { name: "c", version: undefined, mountPath: claudeCodeWorkingDir },
    ]);
  });

  it("throws when framework is missing (no working_dir to resolve)", () => {
    const compose: AgentComposeYaml = {
      version: "1",
      agents: {
        "my-agent": {} as AgentComposeYaml["agents"][string],
      },
      artifacts: [{ name: "a" }],
    };
    expect(() => {
      return resolveComposeArtifacts(compose);
    }).toThrow();
  });

  it("throws when framework is unsupported", () => {
    const compose: AgentComposeYaml = {
      version: "1",
      agents: {
        "my-agent": { framework: "not-a-real-framework" },
      },
      artifacts: [{ name: "a", mount_path: MOUNT_PATH_TEMPLATE }],
    };
    expect(() => {
      return resolveComposeArtifacts(compose);
    }).toThrow();
  });
});
