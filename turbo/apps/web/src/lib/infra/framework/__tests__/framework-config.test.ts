import { describe, it, expect } from "vitest";
import {
  resolveFrameworkWorkingDir,
  resolveFrameworkInstructionsMountPath,
  resolveFrameworkSkillsMountPath,
  resolveFrameworkApiKeyEnvVar,
} from "../framework-config";

describe("framework-config", () => {
  describe("resolveFrameworkInstructionsMountPath", () => {
    it("returns /home/user/.claude for claude-code", () => {
      expect(resolveFrameworkInstructionsMountPath("claude-code")).toBe(
        "/home/user/.claude",
      );
    });
    it("returns /home/user/.codex for codex", () => {
      expect(resolveFrameworkInstructionsMountPath("codex")).toBe(
        "/home/user/.codex",
      );
    });
  });

  describe("resolveFrameworkSkillsMountPath", () => {
    it("returns /home/user/.claude/skills for claude-code", () => {
      expect(resolveFrameworkSkillsMountPath("claude-code")).toBe(
        "/home/user/.claude/skills",
      );
    });
    it("returns /home/user/.codex/skills for codex", () => {
      expect(resolveFrameworkSkillsMountPath("codex")).toBe(
        "/home/user/.codex/skills",
      );
    });
  });

  describe("resolveFrameworkApiKeyEnvVar", () => {
    it("returns ANTHROPIC_API_KEY for claude-code", () => {
      expect(resolveFrameworkApiKeyEnvVar("claude-code")).toBe(
        "ANTHROPIC_API_KEY",
      );
    });
    it("returns OPENAI_API_KEY for codex", () => {
      expect(resolveFrameworkApiKeyEnvVar("codex")).toBe("OPENAI_API_KEY");
    });
  });

  describe("resolveFrameworkWorkingDir (regression)", () => {
    it("returns /home/user/workspace for claude-code", () => {
      expect(resolveFrameworkWorkingDir("claude-code")).toBe(
        "/home/user/workspace",
      );
    });
    it("returns /home/user/workspace for codex", () => {
      expect(resolveFrameworkWorkingDir("codex")).toBe("/home/user/workspace");
    });
  });
});
