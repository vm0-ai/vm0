import { describe, expect, it } from "vitest";

import { parseSkillFrontmatter } from "../skill-frontmatter";

describe("parseSkillFrontmatter", () => {
  it("preserves Pi's model-invocation discovery flag", () => {
    expect(
      parseSkillFrontmatter(
        "---\nname: manual-only\ndescription: Explicit invocation only.\ndisable-model-invocation: true\n---\n",
      ),
    ).toStrictEqual({
      name: "manual-only",
      description: "Explicit invocation only.",
      disableModelInvocation: true,
    });
  });
});
