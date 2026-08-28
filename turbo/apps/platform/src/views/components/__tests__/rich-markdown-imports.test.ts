import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function platformSource(relativePath: string): string {
  const path = [
    join(process.cwd(), "src", relativePath),
    join(process.cwd(), "apps/platform/src", relativePath),
  ].find((candidate) => {
    return existsSync(candidate);
  });
  if (path === undefined) {
    throw new Error(`Unable to locate platform source: ${relativePath}`);
  }
  return readFileSync(path, "utf8");
}

describe("rich Markdown import boundary", () => {
  it("keeps the heavy implementation behind one dynamic module", () => {
    const facade = platformSource("views/components/markdown.tsx");
    const loader = platformSource("signals/rich-markdown-module.ts");

    expect(facade).not.toMatch(/from ["']\.\/rich-markdown\.tsx["']/u);
    expect(loader).toMatch(
      /import\(["']\.\.\/views\/components\/rich-markdown\.tsx["']\)/u,
    );
  });

  it.each([
    "signals/chat-page/create-chat-thread.ts",
    "signals/markdown-preview-tree.ts",
    "signals/shared-thread-page/shared-thread-page-setup.ts",
  ])("removes the static parser edge from %s", (relativePath) => {
    expect(platformSource(relativePath)).not.toMatch(
      /from ["'][^"']*markdown\/pipeline\.ts["']/u,
    );
  });
});
