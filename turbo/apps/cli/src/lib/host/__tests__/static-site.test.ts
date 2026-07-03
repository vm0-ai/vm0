import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HOSTED_SITE_ROBOTS_TXT,
  readStaticSiteFile,
  scanStaticSite,
} from "../static-site";

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

  it("adds a default robots.txt when requested and missing", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<main>Hosted site</main>");

    const result = await scanStaticSite(root, {
      defaultRobots: "disallow-all",
    });

    const robots = result.files.find((file) => {
      return file.path === "/robots.txt";
    });

    expect(robots).toMatchObject({
      path: "/robots.txt",
      contentType: "text/plain; charset=utf-8",
      size: Buffer.byteLength(DEFAULT_HOSTED_SITE_ROBOTS_TXT),
    });
    if (!robots) {
      throw new Error("Expected generated robots.txt");
    }
    expect(new TextDecoder().decode(await readStaticSiteFile(robots))).toBe(
      DEFAULT_HOSTED_SITE_ROBOTS_TXT,
    );
  });

  it("keeps an existing robots.txt when present", async () => {
    const root = await tempRoot();
    const customRobots = "User-agent: *\nAllow: /\n";
    await writeFile(join(root, "index.html"), "<main>Hosted site</main>");
    await writeFile(join(root, "robots.txt"), customRobots);

    const result = await scanStaticSite(root, {
      defaultRobots: "disallow-all",
    });
    const robotsFiles = result.files.filter((file) => {
      return file.path === "/robots.txt";
    });

    expect(robotsFiles).toHaveLength(1);
    const robots = robotsFiles[0];
    if (!robots) {
      throw new Error("Expected existing robots.txt");
    }
    expect(new TextDecoder().decode(await readStaticSiteFile(robots))).toBe(
      customRobots,
    );
  });
});
