import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ESLint } from "eslint";

const platformRoot = path.resolve(import.meta.dirname, "..");

await test("Platform runtime import boundary", async (t) => {
  const eslint = new ESLint({
    cwd: platformRoot,
    allowInlineConfig: false,
  });

  // Exercise the developer-facing lint boundary with the real Platform config,
  // rather than asserting its internal rule representation.
  async function importViolations(source, filePath) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.ok(result);
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
    return result.messages.filter(({ ruleId }) => {
      return ruleId === "no-restricted-imports";
    });
  }

  await t.test(
    "the independent Clerk UI entry passes without lint suppressions",
    async () => {
      const [result] = await eslint.lintFiles(["src/clerk-ui.ts"]);
      assert.ok(result);
      assert.deepEqual(result.messages, []);
    },
  );

  await t.test(
    "other app entries cannot import Clerk UI at runtime",
    async () => {
      for (const filePath of [
        "src/main.ts",
        "src/lib/clerk-runtime.ts",
        "src/lib/clerk-ui.ts",
        "src/views/auth-v1/clerk-ui.tsx",
      ]) {
        for (const source of [
          'import { ui } from "@clerk/ui"; export { ui };',
          'export { ui } from "@clerk/ui";',
        ]) {
          const messages = await importViolations(source, filePath);
          assert.equal(messages.length, 1, `${filePath}: ${source}`);
        }
      }
    },
  );

  await t.test(
    "the UI entry retains the shared Ably and Clerk core import restrictions",
    async () => {
      for (const filePath of ["src/clerk-ui.ts", "src/main.ts"]) {
        for (const packageName of ["ably", "@clerk/clerk-js"]) {
          const messages = await importViolations(
            `import * as runtime from "${packageName}"; export { runtime };`,
            filePath,
          );
          assert.equal(messages.length, 1, `${filePath}: ${packageName}`);
        }
      }
    },
  );

  await t.test(
    "type-only imports remain allowed for Clerk UI and Ably",
    async () => {
      for (const filePath of ["src/clerk-ui.ts", "src/lib/clerk-runtime.ts"]) {
        for (const packageName of ["@clerk/ui", "ably"]) {
          const messages = await importViolations(
            `import type * as runtime from "${packageName}"; export type Runtime = typeof runtime;`,
            filePath,
          );
          assert.deepEqual(messages, [], `${filePath}: ${packageName}`);
        }
      }
    },
  );
});
