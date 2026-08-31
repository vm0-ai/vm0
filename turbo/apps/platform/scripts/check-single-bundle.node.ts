import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "vite";

import {
  deferApplicationEntryResources,
  extractAfterFirstPaintBootstrap,
} from "./deferred-entry-html.ts";
import {
  RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES,
  VENDOR_MODULE_PATTERN,
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

await test("defers app execution and resource discovery until first paint", () => {
  const html = deferApplicationEntryResources(`
    <link rel="stylesheet" crossorigin href="/assets/app-AppHash1.css">
    <link rel="stylesheet" href="https://fonts.example/font.css">
    <link rel="modulepreload" crossorigin href="/assets/vendor-Vendor01.js">
    <script data-vm0-app-entry="" type="module" crossorigin src="/assets/app-AppHash1.js"></script>
  `);

  assert.match(
    html,
    /<link crossorigin href="\/assets\/app-AppHash1\.js" data-vm0-app-entry="">/u,
  );
  assert.match(
    html,
    /<link crossorigin href="\/assets\/app-AppHash1\.css" data-vm0-app-stylesheet="">/u,
  );
  assert.match(
    html,
    /<link crossorigin href="\/assets\/vendor-Vendor01\.js" data-vm0-app-module-preload="">/u,
  );
  assert.match(
    html,
    /<link rel="stylesheet" href="https:\/\/fonts\.example\/font\.css">/u,
  );
  assert.doesNotMatch(html, /<script[^>]+src="\/assets\/app-AppHash1\.js"/u);
});

await test("fails closed when the deferred app entry is missing", () => {
  assert.throws(() => {
    deferApplicationEntryResources("<main>missing app entry</main>");
  }, /Expected exactly one deferred app entry, found 0/u);
});

await test("extracts post-paint callbacks behind one preloaded entry", () => {
  const extracted = extractAfterFirstPaintBootstrap(`
    <script>window.__vm0AfterFirstPaint(function () { window.first = true; });</script>
    <main>skeleton</main>
    <script>window.__vm0AfterFirstPaint(function () { window.second = true; });</script>
  `);

  assert.match(
    extracted.html,
    /<link crossorigin href="__VM0_AFTER_FIRST_PAINT_ENTRY_URL__" data-vm0-after-first-paint-entry="">/u,
  );
  assert.match(extracted.html, /data-vm0-after-first-paint-loader=""/u);
  assert.match(
    extracted.html,
    /modulePreloads\[index\]\.rel = "modulepreload"/u,
  );
  assert.match(extracted.html, /appStylesheet\.rel = "preload"/u);
  assert.doesNotMatch(extracted.html, /window\.first = true/u);
  assert.doesNotMatch(extracted.html, /window\.second = true/u);
  assert.match(extracted.source, /window\.first = true/u);
  assert.match(extracted.source, /window\.second = true/u);
});

await test("fails closed when post-paint callbacks are missing", () => {
  assert.throws(() => {
    extractAfterFirstPaintBootstrap("<main>missing callbacks</main>");
  }, /Expected deferred after-first-paint bootstrap callbacks/u);
});

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
    moduleIds: [
      "/repo/node_modules/react/index.js",
      "/repo/node_modules/rehype-prism-plus/dist/common.es.js",
      "/repo/node_modules/refractor/lib/common.js",
      "/repo/packages/mermaid-lite/dist/mermaid.esm.min.mjs",
    ],
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

function afterFirstPaintBootstrapAsset() {
  return {
    fileName: "assets/bootstrap-after-first-paint-123456789abc.js",
    source: "bootstrap",
    type: "asset" as const,
  };
}

function validApplicationOutputs() {
  return [applicationChunk(), vendorChunk(), runtimeChunk(), workerAsset()];
}

await test("requires the fixed app, vendor, runtime, and worker layout", () => {
  assert.deepEqual(applicationBundleViolations(validApplicationOutputs()), []);
  assert.deepEqual(
    applicationBundleViolations([
      ...validApplicationOutputs(),
      afterFirstPaintBootstrapAsset(),
    ]),
    [],
  );
  assert.deepEqual(
    applicationBundleViolations(validApplicationOutputs().slice(0, 3)),
    [
      `Expected exactly one app entry, one vendor chunk, one Rolldown runtime chunk, one shared database worker asset, and at most one after-first-paint bootstrap asset, but generated: ${APP_FILE} (chunk), ${VENDOR_FILE} (chunk), ${RUNTIME_FILE} (chunk)`,
    ],
  );
  assert.deepEqual(
    applicationBundleViolations([
      ...validApplicationOutputs(),
      { code: "lazy", fileName: "assets/lazy-Extra001.js", type: "chunk" },
    ]),
    [
      `Expected exactly one app entry, one vendor chunk, one Rolldown runtime chunk, one shared database worker asset, and at most one after-first-paint bootstrap asset, but generated: ${APP_FILE} (chunk), ${VENDOR_FILE} (chunk), ${RUNTIME_FILE} (chunk), assets/shared-database-worker-Worker01.js (asset), assets/lazy-Extra001.js (chunk)`,
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

await test("keeps only the generated Mermaid workspace module in vendor", () => {
  const missingMermaid = applicationBundleViolations([
    applicationChunk(),
    {
      ...vendorChunk(),
      moduleIds: vendorChunk().moduleIds.filter((moduleId) => {
        return !moduleId.includes("/packages/mermaid-lite/");
      }),
    },
    runtimeChunk(),
    workerAsset(),
  ]);
  assert.ok(
    missingMermaid.some((violation) => {
      return violation.includes("expected exactly one /packages/mermaid-lite/");
    }),
  );

  const unrelatedWorkspaceModule =
    "/repo/packages/core/src/presentation-template-items.ts";
  assert.deepEqual(
    applicationBundleViolations([
      applicationChunk(),
      {
        ...vendorChunk(),
        moduleIds: [...vendorChunk().moduleIds, unrelatedWorkspaceModule],
      },
      runtimeChunk(),
      workerAsset(),
    ]),
    [
      `${VENDOR_FILE}: only node_modules and /packages/mermaid-lite/dist/mermaid.esm.min.mjs may be emitted in the vendor chunk: ${unrelatedWorkspaceModule}`,
    ],
  );
});

await test("allows Prism common and rejects non-common entries", () => {
  assert.deepEqual(applicationBundleViolations(validApplicationOutputs()), []);

  assert.deepEqual(
    applicationBundleViolations([
      applicationChunk(),
      {
        ...vendorChunk(),
        moduleIds: [
          ...vendorChunk().moduleIds,
          "/repo/node_modules/rehype-prism-plus/dist/index.es.js",
          "/repo/node_modules/rehype-prism-plus/dist/all.es.js",
          "/repo/node_modules/rehype-prism-plus/dist/generator.es.js",
          "/repo/node_modules/refractor/lib/all.js",
        ],
      },
      runtimeChunk(),
      workerAsset(),
    ]),
    [
      `${VENDOR_FILE}: forbidden non-common Prism modules reached the bundle: rehype-prism-plus (root entry), rehype-prism-plus/all, rehype-prism-plus/generator, refractor/all`,
    ],
  );
});

await test("rejects server-only contracts from the eager platform graph", () => {
  assert.deepEqual(
    applicationBundleViolations([
      {
        ...applicationChunk(),
        moduleIds: [
          "/repo/apps/platform/src/main.ts",
          "/repo/packages/api-contracts/src/contracts/runners.ts",
          "/repo/packages/api-contracts/src/contracts/webhooks.ts",
        ],
      },
      vendorChunk(),
      runtimeChunk(),
      workerAsset(),
    ]),
    [
      `${APP_FILE}: server-only API contract modules reached the eager platform graph: /packages/api-contracts/src/contracts/runners.ts, /packages/api-contracts/src/contracts/webhooks.ts`,
    ],
  );

  assert.deepEqual(
    singleWorkerBundleViolations([
      {
        code: "worker",
        fileName: "assets/shared-database-worker.js",
        moduleIds: ["/repo/packages/api-contracts/src/contracts/runners.ts"],
        type: "chunk",
      },
    ]),
    [
      "assets/shared-database-worker.js: server-only API contract modules reached the eager platform graph: /packages/api-contracts/src/contracts/runners.ts",
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
  const mermaidDirectory = path.join(root, "packages", "mermaid-lite", "dist");

  try {
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(vendorDirectory, { recursive: true });
    await mkdir(mermaidDirectory, { recursive: true });
    await writeFile(
      path.join(root, "index.html"),
      '<script type="module" src="/src/main.js"></script>',
    );
    await writeFile(
      path.join(sourceDirectory, "main.js"),
      'import SharedDatabaseWorker from "./shared-database-worker.js?sharedworker"; import localeUrl from "./locale.json?url"; import mermaid from "../packages/mermaid-lite/dist/mermaid.esm.min.mjs"; import vendor from "fixture-vendor"; new SharedDatabaseWorker({ name: "test" }); console.log(localeUrl, mermaid.value, vendor.value);',
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
    await writeFile(
      path.join(mermaidDirectory, "mermaid.esm.min.mjs"),
      'export default { value: "mermaid-static" };',
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
              groups: [{ name: "vendor", test: VENDOR_MODULE_PATTERN }],
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
    const emittedVendorChunk = javaScriptOutputs.find((item) => {
      return (
        item.type === "chunk" &&
        /^assets\/vendor-[^/]+\.js$/u.test(item.fileName)
      );
    });
    assert.ok(emittedVendorChunk?.type === "chunk");
    assert.ok(
      emittedVendorChunk.moduleIds.some((moduleId) => {
        return moduleId.endsWith(
          "/packages/mermaid-lite/dist/mermaid.esm.min.mjs",
        );
      }),
    );
    assert.ok(
      emittedVendorChunk.moduleIds.every((moduleId) => {
        return !moduleId.endsWith("/src/main.js");
      }),
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
