import { describe, it, expect } from "vitest";
import { buildAutoSkillGuidance } from "../agent-prompt";

describe("buildAutoSkillGuidance", () => {
  it("should return guidance containing key CLI commands", () => {
    const guidance = buildAutoSkillGuidance();
    expect(guidance).toContain("zero skill create");
    expect(guidance).toContain("zero skill edit");
    expect(guidance).toContain("zero agent edit");
  });

  it("should return guidance with section header", () => {
    const guidance = buildAutoSkillGuidance();
    expect(guidance).toContain("# Skill Management Guidance");
  });

  it("should include when-to and when-not-to sections", () => {
    const guidance = buildAutoSkillGuidance();
    expect(guidance).toContain("## When to Create a Skill");
    expect(guidance).toContain("## When NOT to Create a Skill");
    expect(guidance).toContain("## When to Update a Skill");
  });
});
