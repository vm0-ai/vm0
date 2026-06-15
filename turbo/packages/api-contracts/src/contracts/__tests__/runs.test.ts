import { describe, expect, it } from "vitest";

import { claudeToolEntrySchema } from "../runs";

describe("Claude tool entry contract", () => {
  it("accepts single Claude tool names", () => {
    expect(claudeToolEntrySchema.safeParse("Bash").success).toBe(true);
    expect(claudeToolEntrySchema.safeParse("mcp__github__search").success).toBe(
      true,
    );
  });

  it("rejects ambiguous Claude tool entries", () => {
    for (const tool of ["", "   ", "Bash,Read", "--help", " -x"]) {
      expect(claudeToolEntrySchema.safeParse(tool).success).toBe(false);
    }
  });
});
