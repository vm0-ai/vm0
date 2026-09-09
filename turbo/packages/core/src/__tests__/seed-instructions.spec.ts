import { describe, expect, it } from "vitest";
import { SEED_INSTRUCTIONS } from "../seed-instructions";

describe("SEED_INSTRUCTIONS", () => {
  it("uses Okou for self-management", () => {
    expect(SEED_INSTRUCTIONS).toContain(
      "- **Okou**: Inspect and update your own skills, instructions, and environment via the Okou platform",
    );
  });
});
