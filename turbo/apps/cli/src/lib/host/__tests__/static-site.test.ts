import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { scanStaticSite } from "../static-site";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zero-host-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("scanStaticSite", () => {
  it("scans files and marks hashed assets immutable", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "assets"));
    await writeFile(
      join(root, "index.html"),
      '<script type="module" src="/assets/index-a1b2c3d4.js"></script>',
    );
    await writeFile(
      join(root, "assets", "index-a1b2c3d4.js"),
      "console.log(1)",
    );

    const result = await scanStaticSite(root);

    expect(
      result.files.map((file) => {
        return file.path;
      }),
    ).toEqual(["/assets/index-a1b2c3d4.js", "/index.html"]);
    expect(result.files[0]).toMatchObject({
      path: "/assets/index-a1b2c3d4.js",
      contentType: "application/javascript; charset=utf-8",
      immutable: true,
    });
  });

  it("rejects missing local assets referenced by HTML", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "index.html"),
      '<link rel="stylesheet" href="/assets/missing.css">',
    );

    await expect(scanStaticSite(root)).rejects.toThrow(
      "Missing asset referenced by /index.html",
    );
  });
});
