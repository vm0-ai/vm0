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
  it("keeps mermaid behind the diagram render boundary", () => {
    expect(source).not.toMatch(/^import mermaid from "mermaid";$/m);
    expect(source).toMatch(/\bimport\s*\(\s*["']mermaid["']\s*\)/);
  });
});
