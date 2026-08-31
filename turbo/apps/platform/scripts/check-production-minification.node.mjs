import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";

import { loadConfigFromFile } from "vite";

await test("production build emits one deterministic vendor group with isolated metadata", async () => {
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    new URL("../vite.config.ts", import.meta.url).pathname,
  );

  assert.ok(loaded);
  const codeSplitting =
    loaded.config.build?.rolldownOptions?.output?.codeSplitting;
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
  assert.equal(
    loaded.config.define?.__OKOU_APP_GIT_COMMIT_SHA__,
    JSON.stringify(process.env.OKOU_APP_GIT_COMMIT_SHA ?? ""),
  );
  assert.equal(
    typeof JSON.parse(loaded.config.define?.__OKOU_APP_VERSION__ ?? "null"),
    "string",
  );
});

await test("production shared worker stays on the app origin", async () => {
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    new URL("../vite.config.ts", import.meta.url).pathname,
  );

  assert.ok(loaded);
  const renderBuiltUrl = loaded.config.experimental?.renderBuiltUrl;
  assert.equal(typeof renderBuiltUrl, "function");
  const context = {
    hostId: "assets/index-AbCd1234.js",
    hostType: "js",
    ssr: false,
    type: "asset",
  };
  assert.deepEqual(
    renderBuiltUrl("assets/shared-database-worker-AbCd1234.js", context),
    {
      runtime:
        'location.origin + "/okou-app/assets/shared-database-worker-AbCd1234.js"',
    },
  );
  assert.equal(renderBuiltUrl("assets/index-AbCd1234.js", context), undefined);
});
