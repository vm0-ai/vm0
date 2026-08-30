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
import {
  domGlobalUsageCounts,
  workerDomGlobalsMessage,
} from "./worker-dom-globals.ts";

const APP_FILE = "assets/index-AppHash1.js";
const VENDOR_FILE = "assets/vendor-Vendor01.js";
const RUNTIME_FILE = "assets/rolldown-runtime-Runtime1.js";

function applicationChunk() {
  return {
    code: "entry",
    fileName: APP_FILE,
    imports: [RUNTIME_FILE, VENDOR_FILE],
    isEntry: true,
    moduleIds: ["/repo/apps/platform/src/main.ts"],
    type: "chunk" as const,
  };
}

function vendorChunk() {
  return {
    code: "vendor",
    fileName: VENDOR_FILE,
    imports: [RUNTIME_FILE],
    moduleIds: ["/repo/node_modules/react/index.js"],
    type: "chunk" as const,
  };
}

function runtimeChunk() {
  return {
    code: "runtime",
    fileName: RUNTIME_FILE,
    moduleIds: ["\0rolldown:runtime"],
    type: "chunk" as const,
  };
}

function workerAsset() {
  return {
    fileName: "assets/shared-database-worker-Worker01.js",
    source: "worker",
    type: "asset" as const,
  };
}

function validApplicationOutputs() {
  return [applicationChunk(), vendorChunk(), runtimeChunk(), workerAsset()];
}

await test("requires the fixed app, vendor, runtime, and worker layout", () => {
  assert.deepEqual(applicationBundleViolations(validApplicationOutputs()), []);
  assert.deepEqual(
    applicationBundleViolations(validApplicationOutputs().slice(0, 3)),
    [
      `Expected exactly one app entry, one vendor chunk, one Rolldown runtime chunk, and one shared database worker asset, but generated: ${APP_FILE} (chunk), ${VENDOR_FILE} (chunk), ${RUNTIME_FILE} (chunk)`,
    ],
  );
  assert.deepEqual(
    applicationBundleViolations([
      ...validApplicationOutputs(),
      { code: "lazy", fileName: "assets/lazy-Extra001.js", type: "chunk" },
    ]),
    [
      `Expected exactly one app entry, one vendor chunk, one Rolldown runtime chunk, and one shared database worker asset, but generated: ${APP_FILE} (chunk), ${VENDOR_FILE} (chunk), ${RUNTIME_FILE} (chunk), assets/shared-database-worker-Worker01.js (asset), assets/lazy-Extra001.js (chunk)`,
    ],
  );
});

await test("rejects raw-size regressions", () => {
  const violations = applicationBundleViolations([
    {
      ...applicationChunk(),
      code: "x".repeat(RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES),
    },
    vendorChunk(),
    runtimeChunk(),
    workerAsset(),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /raw bytes exceeds/u);
});

await test("keeps third-party modules only in vendor and rejects extra edges", () => {
  const violations = applicationBundleViolations([
    {
      ...applicationChunk(),
      dynamicImports: ["assets/lazy-Extra001.js"],
      moduleIds: [
        "/repo/apps/platform/src/main.ts",
        "/repo/node_modules/react/index.js",
      ],
    },
    {
      ...vendorChunk(),
      moduleIds: [
        "/repo/node_modules/react/index.js",
        "/repo/node_modules/@clerk/clerk-js/dist/clerk.mjs",
      ],
    },
    runtimeChunk(),
    workerAsset(),
  ]);
  assert.ok(
    violations.some((violation) => {
      return violation.includes("expected no dynamic JavaScript imports");
    }),
  );
  assert.ok(
    violations.some((violation) => {
      return violation.includes("third-party modules must be emitted only");
    }),
  );
  assert.ok(
    violations.some((violation) => {
      return violation.includes(
        "forbidden packages reached the bundle: @clerk/clerk-js",
      );
    }),
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
        moduleIds: ["/repo/node_modules/katex/dist/katex.mjs"],
        type: "chunk",
      },
    ]),
    [
      "assets/shared-database-worker.js: unexpected JavaScript imports: assets/worker-dependency.js",
      "assets/shared-database-worker.js: forbidden packages reached the bundle: katex",
    ],
  );
});

await test("emits the fixed page topology and one external worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okou-app-bundles-"));
  const sourceDirectory = path.join(root, "src");
  const vendorDirectory = path.join(root, "node_modules", "fixture-vendor");

  try {
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(vendorDirectory, { recursive: true });
    await writeFile(
      path.join(root, "index.html"),
      '<script type="module" src="/src/main.js"></script>',
    );
    await writeFile(
      path.join(sourceDirectory, "main.js"),
      'import SharedDatabaseWorker from "./shared-database-worker.js?sharedworker"; import localeUrl from "./locale.json?url"; import vendor from "fixture-vendor"; new SharedDatabaseWorker({ name: "test" }); console.log(localeUrl, vendor.value);',
    );
    await writeFile(
      path.join(sourceDirectory, "shared-database-worker.js"),
      'self.addEventListener("connect", () => undefined);',
    );
    await writeFile(
      path.join(sourceDirectory, "locale.json"),
      JSON.stringify({ greeting: "hello" }),
    );
    await writeFile(
      path.join(vendorDirectory, "package.json"),
      JSON.stringify({ exports: "./index.cjs", name: "fixture-vendor" }),
    );
    await writeFile(
      path.join(vendorDirectory, "index.cjs"),
      'module.exports = { value: "vendor-static" };',
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
          output: {
            codeSplitting: {
              groups: [{ name: "vendor", test: /[\\/]node_modules[\\/]/u }],
            },
          },
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
    assert.equal(javaScriptOutputs.length, 4);
    assert.equal(
      javaScriptOutputs.filter((item) => {
        return item.type === "chunk" && item.isEntry;
      }).length,
      1,
    );
    for (const pattern of [
      /^assets\/vendor-[^/]+\.js$/u,
      /^assets\/rolldown-runtime-[^/]+\.js$/u,
      /^assets\/shared-database-worker-[^/]+\.js$/u,
    ]) {
      assert.ok(
        javaScriptOutputs.some((item) => {
          return pattern.test(item.fileName);
        }),
        `expected JavaScript output matching ${pattern}`,
      );
    }
    const html = result.output.find((item) => {
      return item.type === "asset" && item.fileName === "index.html";
    });
    assert.ok(html?.type === "asset");
    const htmlSource = String(html.source);
    assert.equal((htmlSource.match(/<script type="module"/gu) ?? []).length, 1);
    assert.equal((htmlSource.match(/rel="modulepreload"/gu) ?? []).length, 2);
    assert.match(htmlSource, /assets\/vendor-[^/]+\.js/u);
    assert.match(htmlSource, /assets\/rolldown-runtime-[^/]+\.js/u);
    assert.ok(
      result.output.some((item) => {
        return item.type === "asset" && item.fileName.endsWith(".json");
      }),
      "expected locale JSON to remain a separate asset",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("counts window-only globals but ignores properties and typeof", () => {
  assert.deepEqual(
    [...domGlobalUsageCounts("export const a = document.title;").entries()],
    [["document", 1]],
  );
  assert.deepEqual(
    [
      ...domGlobalUsageCounts(
        "export const a = globalThis.document ?? scope.window;",
      ).entries(),
    ],
    [],
  );
  assert.deepEqual(
    [
      ...domGlobalUsageCounts(
        'export const a = typeof window === "undefined";',
      ).entries(),
    ],
    [],
  );
  // A local shadow is reported too: the check has no scope analysis, and a
  // module the worker imports has no reason to reuse the name.
  assert.deepEqual(
    [
      ...domGlobalUsageCounts(
        "export function f(x) { const document = x; return document.a; }",
      ).entries(),
    ],
    [["document", 2]],
  );
});

await test("names the offending module and globals", () => {
  const message = workerDomGlobalsMessage(
    "/repo/apps/platform/src/lib/platform-host.ts",
    new Map([["document", 2]]),
  );
  assert.match(message, /platform-host\.ts/u);
  assert.match(message, /document \(2x\)/u);
});
