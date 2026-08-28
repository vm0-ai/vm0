import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "vite";

import { createStableChunkName } from "../src/lib/stable-chunks.ts";

function normalizeModuleId(moduleId: string): string {
  return moduleId.replaceAll("\\", "/");
}

function createLazyDiamond(root: string) {
  const graph = new Map<string, readonly string[]>();
  const modules = new Set<string>();
  const lazyRoot = `${root}/diamond-root.js`;
  let current = lazyRoot;
  modules.add(current);

  // Ten split/join layers form a 41-node fan-in diamond. A reverse path walk
  // revisits the shared suffix exponentially; the forward closure must never
  // enter this disconnected graph.
  for (let index = 0; index < 10; index += 1) {
    const left = `${root}/diamond-${index}-left.js`;
    const right = `${root}/diamond-${index}-right.js`;
    const join = `${root}/diamond-${index}-join.js`;
    const next = `${root}/diamond-${index}-next.js`;
    graph.set(current, [left, right]);
    graph.set(left, [join]);
    graph.set(right, [join]);
    graph.set(join, [next]);
    modules.add(left);
    modules.add(right);
    modules.add(join);
    modules.add(next);
    current = next;
  }

  const cycle = `${root}/cycle.js`;
  graph.set(current, [cycle]);
  graph.set(cycle, [current]);
  modules.add(cycle);
  return { cycle, graph, lazyRoot, modules };
}

for (const callbackOrder of ["startup-first", "lazy-first"] as const) {
  await test(`computes the static startup closure once (${callbackOrder})`, () => {
    const root = "/fixture";
    const entryModuleId = `${root}/src/main.ts`;
    const startupA = `${root}/node_modules/react/startup-a.js`;
    const startupB = `${root}/node_modules/react-dom/startup-b.js`;
    const sharedVendor = `${root}/node_modules/scheduler/shared.js`;
    const lazy = createLazyDiamond(`${root}/node_modules/lucide-react/lazy`);
    const graph = new Map<string, readonly string[]>([
      [entryModuleId, [startupA, startupB]],
      [startupA, [startupB, sharedVendor]],
      [startupB, [startupA, sharedVendor]],
      [sharedVendor, []],
      ...lazy.graph,
    ]);
    const visits = new Map<string, number>();
    const context = {
      getModuleInfo(moduleId: string) {
        const normalizedId = normalizeModuleId(moduleId);
        visits.set(normalizedId, (visits.get(normalizedId) ?? 0) + 1);
        const importedIds = graph.get(normalizedId);
        return importedIds ? { importedIds } : null;
      },
    };
    const stableChunkName = createStableChunkName(entryModuleId);
    const startupCallbacks = [startupA, startupB, sharedVendor];
    const lazyCallbacks = [lazy.lazyRoot, lazy.cycle];
    const callbacks =
      callbackOrder === "startup-first"
        ? [...startupCallbacks, ...lazyCallbacks]
        : [...lazyCallbacks, ...startupCallbacks];

    for (let repeat = 0; repeat < 3; repeat += 1) {
      for (const moduleId of callbacks) {
        assert.equal(
          stableChunkName(moduleId, context),
          startupCallbacks.includes(moduleId) ? "vendor-foundation" : null,
        );
      }
    }

    for (const moduleId of [entryModuleId, startupA, startupB, sharedVendor]) {
      assert.equal(visits.get(moduleId), 1, `${moduleId} visited once`);
    }
    for (const moduleId of lazy.modules) {
      assert.equal(
        visits.get(moduleId) ?? 0,
        0,
        `${moduleId} was not traversed`,
      );
    }
    assert.equal(visits.size, 4);
  });
}

await test("groups cyclic startup vendors without absorbing lazy-only modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vm0-stable-chunks-"));
  const entryModuleId = path.join(root, "src/main.js");
  const startupA = path.join(root, "node_modules/react/a.js");
  const startupB = path.join(root, "node_modules/react-dom/b.js");
  const lazyRoute = path.join(root, "src/lazy-route.js");
  const lazyVendor = path.join(root, "node_modules/lucide-react/lazy.js");
  const fixtureModules = new Map([
    [startupA, 'import "fixture-startup-b"; console.log("startup-a");'],
    [startupB, 'import "fixture-startup-a"; console.log("startup-b");'],
    [lazyRoute, 'import "fixture-lazy-vendor"; console.log("lazy-route");'],
    [lazyVendor, 'console.log("lazy-vendor");'],
  ]);
  const fixtureIds = new Map([
    ["fixture-startup-a", startupA],
    ["fixture-startup-b", startupB],
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
      'import "fixture-startup-a"; import("fixture-lazy-route");',
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
