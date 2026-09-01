import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { build, loadConfigFromFile } from "vite";

import { applicationResourcePriorityHtmlPlugin } from "./app-resource-priority-html.ts";
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

const productionConfigPromise = loadConfigFromFile(
  { command: "build", mode: "production" },
  new URL("../vite.config.ts", import.meta.url).pathname,
);

await test("production build emits one deterministic vendor group with a compiled app version", async () => {
  const loaded = await productionConfigPromise;

  assert.ok(loaded);
  const output = loaded.config.build?.rolldownOptions?.output;
  assert.ok(output && !Array.isArray(output));
  const codeSplitting = output.codeSplitting;
  assert.equal(typeof codeSplitting, "object");
  assert.ok(codeSplitting && typeof codeSplitting === "object");
  assert.equal(codeSplitting.groups?.length, 1);
  const vendorGroup = codeSplitting.groups?.[0];
  assert.equal(vendorGroup?.name, "vendor");
  assert.ok(vendorGroup?.test instanceof RegExp);
  assert.equal(
    vendorGroup.test.test("/repo/node_modules/react/index.js"),
    true,
  );
  assert.equal(
    vendorGroup.test.test(
      "/repo/packages/mermaid-lite/dist/mermaid.esm.min.mjs",
    ),
    true,
  );
  assert.equal(
    vendorGroup.test.test("/repo/packages/mermaid-lite/src/index.ts"),
    false,
  );
  assert.equal(
    vendorGroup.test.test("/repo/packages/core/src/resource-registry.ts"),
    false,
  );
  assert.equal(vendorGroup.test.test("/repo/src/main.ts"), false);
  assert.equal(loaded.config.define?.__OKOU_APP_GIT_COMMIT_SHA__, undefined);
  assert.equal(
    typeof JSON.parse(loaded.config.define?.__OKOU_APP_VERSION__ ?? "null"),
    "string",
  );
  assert.ok(
    loaded.config.plugins?.some((plugin) => {
      return (
        typeof plugin === "object" &&
        plugin !== null &&
        "name" in plugin &&
        plugin.name === "platform-runtime-build-info-html"
      );
    }),
  );
});

await test("production shared worker stays on the app origin", async () => {
  const loaded = await productionConfigPromise;

  assert.ok(loaded);
  const renderBuiltUrl = loaded.config.experimental?.renderBuiltUrl;
  assert.equal(typeof renderBuiltUrl, "function");
  assert.ok(renderBuiltUrl);
  const context = {
    hostId: "assets/index-AbCd1234.js",
    hostType: "js",
    ssr: false,
    type: "asset",
  } satisfies Parameters<typeof renderBuiltUrl>[1];
  assert.deepEqual(
    renderBuiltUrl("assets/shared-database-worker-AbCd1234.js", context),
    {
      runtime:
        'location.origin + "/okou-app/assets/shared-database-worker-AbCd1234.js"',
    },
  );
  assert.equal(renderBuiltUrl("assets/index-AbCd1234.js", context), undefined);
});

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

function clerkDiscoveryFixture(): string {
  return [
    "<!doctype html><html><head>",
    '<style id="app-bootstrap-critical-styles">body { color: black; }</style>',
    '<script id="vm0-clerk-core-script" src="https://cdn.example.test/clerk.js" defer></script>',
    '<script data-vm0-clerk-bootstrap="">window.__clerkConfigured = true;</script>',
    "</head><body>",
    '<div id="app-bootstrap-skeleton"></div>',
    '<script type="module" src="/src/main.js"></script>',
    "</body></html>",
  ].join("");
}

function assertClerkDiscoveryOrder(htmlSource: string): void {
  const clerkCoreIndex = htmlSource.indexOf('id="vm0-clerk-core-script"');
  const clerkBootstrapIndex = htmlSource.indexOf('data-vm0-clerk-bootstrap=""');
  const appModuleIndex = htmlSource.indexOf('<script type="module"');
  assert.notEqual(clerkCoreIndex, -1);
  assert.ok(clerkBootstrapIndex > clerkCoreIndex);
  assert.ok(appModuleIndex > clerkBootstrapIndex);
}

function assertApplicationResourcePriority(htmlSource: string): void {
  const criticalStyleIndex = htmlSource.indexOf(
    '<style id="app-bootstrap-critical-styles">',
  );
  const stylesheetIndex = htmlSource.indexOf('rel="stylesheet"');
  const runtimePreloadIndex = htmlSource.indexOf("assets/rolldown-runtime-");
  const vendorPreloadIndex = htmlSource.indexOf("assets/vendor-");
  const clerkCoreIndex = htmlSource.indexOf('id="vm0-clerk-core-script"');
  const skeletonIndex = htmlSource.indexOf('id="app-bootstrap-skeleton"');
  const appModuleIndex = htmlSource.indexOf('<script type="module"');
  const bodyEndIndex = htmlSource.indexOf("</body>");

  assert.ok(criticalStyleIndex !== -1);
  assert.ok(stylesheetIndex > criticalStyleIndex);
  assert.ok(runtimePreloadIndex > stylesheetIndex);
  assert.ok(vendorPreloadIndex > runtimePreloadIndex);
  assert.ok(clerkCoreIndex > vendorPreloadIndex);
  assert.ok(appModuleIndex > skeletonIndex);
  assert.ok(bodyEndIndex > appModuleIndex);
  assert.match(
    htmlSource,
    /<link rel="stylesheet"[^>]*fetchpriority="high"[^>]*>/u,
  );
  assert.equal(
    (
      htmlSource.match(
        /<link rel="modulepreload"[^>]*fetchpriority="low"[^>]*>/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.match(
    htmlSource,
    /<script type="module"[^>]*fetchpriority="low"[^>]*><\/script>/u,
  );
}

await test("emits the fixed page topology and one external worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okou-app-bundles-"));
  const sourceDirectory = path.join(root, "src");
  const vendorDirectory = path.join(root, "node_modules", "fixture-vendor");
  const mermaidDirectory = path.join(root, "packages", "mermaid-lite", "dist");

  try {
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(vendorDirectory, { recursive: true });
    await mkdir(mermaidDirectory, { recursive: true });
    await writeFile(path.join(root, "index.html"), clerkDiscoveryFixture());
    await writeFile(
      path.join(sourceDirectory, "main.js"),
      'import "./main.css"; import SharedDatabaseWorker from "./shared-database-worker.js?sharedworker"; import localeUrl from "./locale.json?url"; import mermaid from "../packages/mermaid-lite/dist/mermaid.esm.min.mjs"; import vendor from "fixture-vendor"; new SharedDatabaseWorker({ name: "test" }); console.log(localeUrl, mermaid.value, vendor.value);',
    );
    await writeFile(
      path.join(sourceDirectory, "main.css"),
      "body { color: red; }",
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
      plugins: [
        applicationJavaScriptBundlePlugin(),
        applicationResourcePriorityHtmlPlugin(),
      ],
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
    assertClerkDiscoveryOrder(htmlSource);
    assert.equal((htmlSource.match(/<script type="module"/gu) ?? []).length, 1);
    assert.equal((htmlSource.match(/rel="modulepreload"/gu) ?? []).length, 2);
    assertApplicationResourcePriority(htmlSource);
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
