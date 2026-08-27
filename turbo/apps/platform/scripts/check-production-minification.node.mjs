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
