import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "vite";

import {
  RAW_JAVASCRIPT_BUNDLE_LIMIT_BYTES,
  singleBundleViolations,
  singleJavaScriptBundlePlugin,
} from "./single-bundle.ts";

await test("rejects extra JavaScript chunks and raw-size regressions", () => {
  assert.deepEqual(
    singleBundleViolations([
      { code: "entry", fileName: "assets/index.js", type: "chunk" },
      { code: "lazy", fileName: "assets/lazy.js", type: "chunk" },
    ]),
    [
      "Expected exactly one JavaScript bundle, but generated 2: assets/index.js, assets/lazy.js",
    ],
  );
  assert.deepEqual(
    singleBundleViolations([
      {
        code: "x".repeat(RAW_JAVASCRIPT_BUNDLE_LIMIT_BYTES + 1),
        fileName: "assets/index.js",
        type: "chunk",
      },
    ]),
    [
      `assets/index.js: ${RAW_JAVASCRIPT_BUNDLE_LIMIT_BYTES + 1} raw bytes exceeds ${RAW_JAVASCRIPT_BUNDLE_LIMIT_BYTES}`,
    ],
  );
});

await test("rejects JavaScript imports and forbidden bundled packages", () => {
  assert.deepEqual(
    singleBundleViolations([
      {
        code: "entry",
        dynamicImports: ["assets/lazy.js"],
        fileName: "assets/index.js",
        type: "chunk",
      },
    ]),
    ["assets/index.js: expected no JavaScript imports, found assets/lazy.js"],
  );
  assert.deepEqual(
    singleBundleViolations([
      {
        code: "entry",
        fileName: "assets/index.js",
        moduleIds: [
          "/repo/node_modules/@clerk/clerk-js/dist/clerk.mjs",
          "/repo/node_modules/katex/dist/katex.mjs",
        ],
        type: "chunk",
      },
    ]),
    [
      "assets/index.js: forbidden packages reached the bundle: @clerk/clerk-js, katex",
    ],
  );
});

await test("bundles static JavaScript while preserving locale JSON as an asset", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okou-single-bundle-"));
  const sourceDirectory = path.join(root, "src");

  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      path.join(root, "index.html"),
      '<script type="module" src="/src/main.js"></script>',
    );
    await writeFile(
      path.join(sourceDirectory, "main.js"),
      'import localeUrl from "./locale.json?url"; import { value } from "./dependency.js"; console.log(localeUrl, value);',
    );
    await writeFile(
      path.join(sourceDirectory, "dependency.js"),
      'export const value = "static";',
    );
    await writeFile(
      path.join(sourceDirectory, "locale.json"),
      JSON.stringify({ greeting: "hello" }),
    );

    const result = await build({
      configFile: false,
      logLevel: "silent",
      root,
      build: {
        assetsInlineLimit: 0,
        minify: false,
        write: false,
        rolldownOptions: {
          output: { codeSplitting: false },
        },
      },
      plugins: [singleJavaScriptBundlePlugin()],
    });

    if (Array.isArray(result) || !("output" in result)) {
      assert.fail("Expected one completed Vite build output");
    }
    const chunks = result.output.filter((item) => {
      return item.type === "chunk";
    });
    assert.equal(chunks.length, 1);
    assert.match(chunks[0]?.code ?? "", /static/u);
    assert.ok(
      result.output.some((item) => {
        return item.type === "asset" && item.fileName.endsWith(".json");
      }),
      "expected the locale JSON to remain a separate asset",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
