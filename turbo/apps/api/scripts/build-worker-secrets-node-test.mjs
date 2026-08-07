import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkerSecrets } from "./build-worker-secrets.mjs";

test("writes every shard and excludes Sentry runtime settings", () => {
  const secrets = buildWorkerSecrets(
    [
      "DATABASE_URL=postgres://example",
      "ENV=preview",
      "SENTRY_DSN=https://example@sentry.io/1",
      "VERCEL_AUTOMATION_BYPASS_SECRET=vercel-only",
    ].join("\n"),
  );
  assert.equal(Object.keys(secrets).length, 32);
  const decoded = Object.values(secrets).flatMap((value) => {
    return Object.entries(JSON.parse(value));
  });
  assert.deepEqual(Object.fromEntries(decoded), {
    DATABASE_URL: "postgres://example",
    ENV: "preview",
    VERCEL_AUTOMATION_BYPASS_SECRET: "vercel-only",
  });
});

test("rejects configuration outside the explicit Worker allowlist", () => {
  assert.throws(() => {
    buildWorkerSecrets("DATABASE_URL=postgres://example\nSURPRISE_SECRET=nope");
  }, /allowlist is missing: SURPRISE_SECRET/u);
});
