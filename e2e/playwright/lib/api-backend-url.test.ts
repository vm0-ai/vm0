import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveApiBackendUrl } from "../api-backend-url";

const canonicalKey = "OKOU_API_BACKEND_URL";

test("resolves the canonical E2E API backend URL fail closed", async (context) => {
  const canonicalUrl =
    "https://canonical.example.test/Exact/Path/?query=a%20b#fragment";

  await context.test("rejects absent and empty inputs", () => {
    const expectedMessage = `E2E API backend URL is required: canonical_key=${canonicalKey} state=missing`;
    assert.throws(() => resolveApiBackendUrl({}), {
      message: expectedMessage,
    });
    assert.throws(() => resolveApiBackendUrl({ [canonicalKey]: "" }), {
      message: expectedMessage,
    });
  });

  await context.test("preserves the canonical value byte for byte", () => {
    assert.equal(
      resolveApiBackendUrl({ [canonicalKey]: canonicalUrl }),
      canonicalUrl,
    );
  });
});
