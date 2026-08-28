import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "vite";

import {
  RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES,
  applicationBundleViolations,
  applicationJavaScriptBundlePlugin,
  singleWorkerBundleViolations,
  singleWorkerJavaScriptBundlePlugin,
} from "./single-bundle.ts";

function applicationChunk() {
  return {
    code: "entry",
    fileName: "assets/index.js",
    type: "chunk" as const,
  };
}

function workerAsset() {
  return {
    fileName: "assets/shared-database-worker-hash.js",
    source: "worker",
    type: "asset" as const,
  };
}

await test("rejects missing or extra JavaScript outputs", () => {
  assert.deepEqual(applicationBundleViolations([applicationChunk()]), [
    "Expected exactly one application JavaScript chunk and one shared database worker JavaScript asset, but generated: assets/index.js (chunk)",
  ]);
  assert.deepEqual(
    applicationBundleViolations([
      applicationChunk(),
      workerAsset(),
      { code: "lazy", fileName: "assets/lazy.js", type: "chunk" },
    ]),
    [
      "Expected exactly one application JavaScript chunk and one shared database worker JavaScript asset, but generated: assets/index.js (chunk), assets/shared-database-worker-hash.js (asset), assets/lazy.js (chunk)",
    ],
  );
});

await test("rejects raw-size regressions", () => {
  const worker = workerAsset();
  assert.deepEqual(
    applicationBundleViolations([
      {
        code: "x".repeat(RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES),
        fileName: "assets/index.js",
        type: "chunk",
      },
      worker,
    ]),
    [
      `JavaScript output: ${RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES + worker.source.length} raw bytes exceeds ${RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES}`,
    ],
  );
});

await test("rejects JavaScript imports and forbidden bundled packages", () => {
  assert.deepEqual(
    applicationBundleViolations([
      {
        code: "entry",
        dynamicImports: ["assets/lazy.js"],
        fileName: "assets/index.js",
        type: "chunk",
      },
      workerAsset(),
    ]),
    ["assets/index.js: expected no JavaScript imports, found assets/lazy.js"],
  );
  assert.deepEqual(
    applicationBundleViolations([
      {
        code: "entry",
        fileName: "assets/index.js",
        moduleIds: [
          "/repo/node_modules/@clerk/clerk-js/dist/clerk.mjs",
          "/repo/node_modules/katex/dist/katex.mjs",
        ],
        type: "chunk",
      },
      workerAsset(),
    ]),
    [
      "assets/index.js: forbidden packages reached the bundle: @clerk/clerk-js, katex",
    ],
  );
});

await test("rejects worker chunks with imports or forbidden packages", () => {
  assert.deepEqual(
    singleWorkerBundleViolations([
      {
        code: "worker",
        fileName: "assets/shared-database-worker.js",
        type: "chunk",
      },
      {
        code: "dependency",
        fileName: "assets/worker-dependency.js",
        type: "chunk",
      },
    ]),
    [
      "Expected exactly one worker JavaScript bundle, but generated 2: assets/shared-database-worker.js, assets/worker-dependency.js",
    ],
  );
  assert.deepEqual(
    singleWorkerBundleViolations([
      {
        code: "worker",
        fileName: "assets/shared-database-worker.js",
        imports: ["assets/worker-dependency.js"],
        moduleIds: ["/repo/node_modules/lowlight/lib/index.js"],
        type: "chunk",
      },
    ]),
    [
      "assets/shared-database-worker.js: expected no JavaScript imports, found assets/worker-dependency.js",
      "assets/shared-database-worker.js: forbidden packages reached the bundle: lowlight",
    ],
  );
});

await test("emits one app bundle and one worker bundle while preserving locale JSON", async () => {
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
      'import SharedDatabaseWorker from "./shared-database-worker.js?sharedworker"; import localeUrl from "./locale.json?url"; import { value } from "./dependency.js"; new SharedDatabaseWorker({ name: "test" }); console.log(localeUrl, value);',
    );
    await writeFile(
      path.join(sourceDirectory, "dependency.js"),
      'export const value = "static";',
    );
    await writeFile(
      path.join(sourceDirectory, "shared-database-worker.js"),
      'self.addEventListener("connect", () => undefined);',
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
      plugins: [applicationJavaScriptBundlePlugin()],
      worker: {
        plugins: () => {
          return [singleWorkerJavaScriptBundlePlugin()];
        },
      },
    });

    if (Array.isArray(result) || !("output" in result)) {
      assert.fail("Expected one completed Vite build output");
    }
    const javaScriptOutputs = result.output.filter((item) => {
      return item.fileName.endsWith(".js");
    });
    assert.equal(javaScriptOutputs.length, 2);
    const applicationOutput = javaScriptOutputs.find((item) => {
      return item.type === "chunk";
    });
    assert.ok(applicationOutput?.type === "chunk");
    assert.match(applicationOutput.code, /static/u);
    assert.ok(
      javaScriptOutputs.some((item) => {
        return (
          item.type === "asset" &&
          item.fileName.startsWith("assets/shared-database-worker-")
        );
      }),
      "expected one external shared database worker JavaScript asset",
    );
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
