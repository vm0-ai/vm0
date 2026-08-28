import assert from "node:assert/strict";
import { test } from "node:test";
import { URL } from "node:url";

import { loadConfigFromFile } from "vite";

await test("production minification mangles identifiers while preserving names", async () => {
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    new URL("../vite.config.ts", import.meta.url).pathname,
  );

  assert.ok(loaded);
  const output = loaded.config.build?.rolldownOptions?.output;
  assert.equal(output?.keepNames, true);
  assert.equal(output?.minify?.mangle, true);
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
