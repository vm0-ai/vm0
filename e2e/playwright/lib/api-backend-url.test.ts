import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveApiBackendUrl } from "../api-backend-url";

const canonicalKey = "OKOU_API_BACKEND_URL";
const legacyKey = "VM0_API_BACKEND_URL";

test("resolves the E2E API backend URL aliases fail closed", async (context) => {
  const canonicalUrl =
    "https://canonical.example.test/Exact/Path/?query=a%20b#fragment";
  const legacyUrl =
    "https://legacy.example.test/Exact/Path/?query=a%20b#fragment";

  await context.test("rejects absent and empty inputs", () => {
    const expectedMessage = `E2E API backend URL is required: canonical_key=${canonicalKey} legacy_key=${legacyKey} state=missing`;
    assert.throws(() => resolveApiBackendUrl({}), {
      message: expectedMessage,
    });
    assert.throws(
      () =>
        resolveApiBackendUrl({
          [canonicalKey]: "",
          [legacyKey]: "",
        }),
      { message: expectedMessage },
    );
  });

  await context.test("preserves a canonical-only value byte for byte", () => {
    assert.equal(
      resolveApiBackendUrl({ [canonicalKey]: canonicalUrl }),
      canonicalUrl,
    );
  });

  await context.test("preserves a legacy-only value byte for byte", () => {
    assert.equal(resolveApiBackendUrl({ [legacyKey]: legacyUrl }), legacyUrl);
  });

  await context.test("accepts equal aliases", () => {
    assert.equal(
      resolveApiBackendUrl({
        [canonicalKey]: canonicalUrl,
        [legacyKey]: canonicalUrl,
      }),
      canonicalUrl,
    );
  });

  await context.test("rejects unequal aliases without exposing values", () => {
    assert.throws(
      () =>
        resolveApiBackendUrl({
          [canonicalKey]: canonicalUrl,
          [legacyKey]: legacyUrl,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(
          error.message,
          `E2E API backend URL aliases conflict: canonical_key=${canonicalKey} legacy_key=${legacyKey} state=conflict`,
        );
        assert.doesNotMatch(error.message, /canonical\.example/u);
        assert.doesNotMatch(error.message, /legacy\.example/u);
        return true;
      },
    );
  });
});
