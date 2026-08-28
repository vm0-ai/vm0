import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sourcePath = [
  join(process.cwd(), "src/signals/mermaid-diagram.ts"),
  join(process.cwd(), "apps/platform/src/signals/mermaid-diagram.ts"),
].find((candidate) => {
  return existsSync(candidate);
});
if (sourcePath === undefined) {
  throw new Error("Unable to locate mermaid-diagram.ts");
}
const source = readFileSync(sourcePath, "utf8");

describe("mermaid diagram imports", () => {
  it("keeps flowchart-only Mermaid in the static import graph", () => {
    expect(source).toMatch(
      /^import mermaid from "@okouai\/mermaid-flowchart";$/m,
    );
    expect(source).not.toMatch(
      /\bimport\s*\(\s*["']@okouai\/mermaid-flowchart["']\s*\)/,
    );
  });
});
