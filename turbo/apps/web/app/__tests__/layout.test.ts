import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

describe("web root layout", () => {
  it("includes instatus status widget script", () => {
    const layout = readFileSync(join(__dirname, "../layout.tsx"), "utf-8");
    expect(layout).toContain(
      "https://api.dashboard.instatus.com/widget?host=status.vm0.ai&code=02c0ef5a&locale=en",
    );
  });
});
