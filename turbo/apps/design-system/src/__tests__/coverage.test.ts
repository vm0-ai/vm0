import { describe, expect, it } from "vitest";

import { orphaned, undocumented } from "../coverage";

describe("catalogue coverage", () => {
  it("documents every component that ships in @okouai/ui", () => {
    expect(undocumented()).toEqual([]);
  });

  it("has no demo for a component that no longer exists", () => {
    expect(orphaned()).toEqual([]);
  });
});
