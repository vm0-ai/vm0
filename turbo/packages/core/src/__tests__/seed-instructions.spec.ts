import { describe, expect, it } from "vitest";
import { SEED_INSTRUCTIONS } from "../seed-instructions";

describe("SEED_INSTRUCTIONS", () => {
  it("uses Okou for self-management", () => {
    expect(SEED_INSTRUCTIONS).toContain(
      "- **Okou**: Inspect and update your own skills, instructions, and environment via the Okou platform",
    );
  });

  it("does not contain VM0 or Zero product branding", () => {
    expect(SEED_INSTRUCTIONS).not.toMatch(/\b(?:vm0|zero)\b/iu);
  });
});
