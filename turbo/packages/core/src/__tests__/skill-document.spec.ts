import { describe, expect, it } from "vitest";
import {
  extractInstructionFromSkillMd,
  synthesizeSkillMd,
  synthesizeWorkflowSkillMd,
} from "../skill-document";

describe("skill document helpers", () => {
  it("synthesizes frontmatter and instruction content", () => {
    expect(
      synthesizeSkillMd({
        name: "daily-report",
        description: "Generate a daily report",
        instruction: "  # Daily Report\n\nGenerate the report.  ",
      }),
    ).toBe(
      "---\nname: daily-report\ndescription: Generate a daily report\n---\n\n# Daily Report\n\nGenerate the report.\n",
    );
  });

  it("uses the skill name as the description fallback", () => {
    expect(
      synthesizeSkillMd({
        name: "daily-report",
        description: null,
        instruction: null,
      }),
    ).toBe("---\nname: daily-report\ndescription: daily-report\n---\n");
  });

  it("keeps workflow synthesis identical to generic skill synthesis", () => {
    const args = {
      name: "daily-report",
      description: "Generate a daily report",
      instruction: "Generate the report.",
    };

    expect(synthesizeWorkflowSkillMd(args)).toBe(synthesizeSkillMd(args));
  });

  it("extracts instruction content after LF or CRLF frontmatter", () => {
    expect(
      extractInstructionFromSkillMd(
        "---\nname: daily-report\ndescription: Daily report\n---\n\nGenerate it.\n",
      ),
    ).toBe("Generate it.");
    expect(
      extractInstructionFromSkillMd(
        "---\r\nname: daily-report\r\ndescription: Daily report\r\n---\r\n\r\nGenerate it.\r\n",
      ),
    ).toBe("Generate it.");
  });

  it("trims content without frontmatter", () => {
    expect(extractInstructionFromSkillMd("\nGenerate it.\n")).toBe(
      "Generate it.",
    );
  });
});
