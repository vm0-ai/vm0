import { describe, expect, it } from "vitest";

import { claudeToolEntrySchema, unifiedRunRequestSchema } from "../runs";

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

describe("unified run request contract", () => {
  it("rejects checkpoint resume requests", () => {
    expect(
      unifiedRunRequestSchema.safeParse({
        checkpointId: "11111111-1111-4111-8111-111111111111",
        prompt: "resume from checkpoint",
      }).success,
    ).toBe(false);
  });
});
