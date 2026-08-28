import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "vite";

import { createStableChunkName } from "../src/lib/stable-chunks.ts";

await test("groups cyclic startup vendors without absorbing lazy-only modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vm0-stable-chunks-"));
  const entryModuleId = path.join(root, "src/main.js");
  const startupA = path.join(root, "node_modules/react/a.js");
  const startupB = path.join(root, "node_modules/react-dom/b.js");
  const workspaceMermaid = path.join(
    root,
    "packages/mermaid-flowchart/dist/index.mjs",
  );
  const lazyRoute = path.join(root, "src/lazy-route.js");
  const lazyVendor = path.join(root, "node_modules/lucide-react/lazy.js");
  const fixtureModules = new Map([
    [startupA, 'import "fixture-startup-b"; console.log("startup-a");'],
    [startupB, 'import "fixture-startup-a"; console.log("startup-b");'],
    [workspaceMermaid, 'console.log("workspace-mermaid");'],
    [lazyRoute, 'import "fixture-lazy-vendor"; console.log("lazy-route");'],
    [lazyVendor, 'console.log("lazy-vendor");'],
  ]);
  const fixtureIds = new Map([
    ["fixture-startup-a", startupA],
    ["fixture-startup-b", startupB],
    ["fixture-workspace-mermaid", workspaceMermaid],
    ["fixture-lazy-route", lazyRoute],
    ["fixture-lazy-vendor", lazyVendor],
  ]);

  try {
    await mkdir(path.dirname(entryModuleId), { recursive: true });
    await writeFile(
      path.join(root, "index.html"),
      '<script type="module" src="/src/main.js"></script>',
    );
    await writeFile(
      entryModuleId,
      'import "fixture-startup-a"; import "fixture-workspace-mermaid"; import("fixture-lazy-route");',
    );

    const result = await build({
      configFile: false,
      logLevel: "silent",
      root,
      build: {
        minify: false,
        modulePreload: false,
        write: false,
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [{ name: createStableChunkName(entryModuleId) }],
            },
          },
        },
      },
      plugins: [
        {
          name: "stable-chunk-fixture",
          resolveId(source) {
            return fixtureIds.get(source) ?? null;
          },
          load(id) {
            return fixtureModules.get(id) ?? null;
          },
        },
      ],
    });

    if (Array.isArray(result) || !("output" in result)) {
      assert.fail("Expected one completed Vite build output");
    }
    const chunks = result.output.filter((item) => {
      return item.type === "chunk";
    });
    const vendorChunk = chunks.find((chunk) => {
      return chunk.name === "vendor-foundation";
    });
    assert.ok(vendorChunk, "expected the stable foundation chunk");
    assert.ok(vendorChunk.moduleIds.includes(startupA));
    assert.ok(vendorChunk.moduleIds.includes(startupB));
    assert.ok(!vendorChunk.moduleIds.includes(lazyVendor));
    const contentChunk = chunks.find((chunk) => {
      return chunk.name === "vendor-content";
    });
    assert.ok(contentChunk, "expected the stable content chunk");
    assert.ok(contentChunk.moduleIds.includes(workspaceMermaid));
    assert.ok(
      chunks.some((chunk) => {
        return (
          chunk.name !== "vendor-foundation" &&
          chunk.moduleIds.includes(lazyVendor)
        );
      }),
      "expected the lazy-only vendor to remain outside the startup chunk",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
