import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkerSecrets } from "./build-worker-secrets.mjs";

test("writes every shard and excludes Sentry runtime settings", () => {
  const secrets = buildWorkerSecrets(
    [
      "DATABASE_URL=postgres://example",
      "ENV=preview",
      'CF_ACCESS_JWKS={"keys":[{"kty":"RSA"}]}',
      "CF_API_PUBLIC_ORIGIN=https://api.vm0.ai",
      "OKOU_HOST_DOMAIN=okou-sites.example",
      "OKOU_PRICE_PRO=price_okou_pro",
      "SENTRY_DSN=https://example@sentry.io/1",
      "TIKTOK_ADS_OAUTH_CLIENT_ID=tiktok-client",
      "TIKTOK_ADS_OAUTH_CLIENT_SECRET=tiktok-secret",
      "VERCEL_AUTOMATION_BYPASS_SECRET=vercel-only",
      "ZERO_SEO_DATAFORSEO_LOGIN=dataforseo-user",
      "ZERO_SEO_DATAFORSEO_PASSWORD=dataforseo-password",
      "ZERO_SEO_SERPAPI_TOKEN=serpapi-token",
    ].join("\n"),
  );
  assert.equal(Object.keys(secrets).length, 32);
  const decoded = Object.values(secrets).flatMap((value) => {
    return Object.entries(JSON.parse(value));
  });
  assert.deepEqual(Object.fromEntries(decoded), {
    CF_ACCESS_JWKS: '{"keys":[{"kty":"RSA"}]}',
    CF_API_PUBLIC_ORIGIN: "https://api.vm0.ai",
    DATABASE_URL: "postgres://example",
    ENV: "preview",
    OKOU_HOST_DOMAIN: "okou-sites.example",
    OKOU_PRICE_PRO: "price_okou_pro",
    TIKTOK_ADS_OAUTH_CLIENT_ID: "tiktok-client",
    TIKTOK_ADS_OAUTH_CLIENT_SECRET: "tiktok-secret",
    VERCEL_AUTOMATION_BYPASS_SECRET: "vercel-only",
    ZERO_SEO_DATAFORSEO_LOGIN: "dataforseo-user",
    ZERO_SEO_DATAFORSEO_PASSWORD: "dataforseo-password",
    ZERO_SEO_SERPAPI_TOKEN: "serpapi-token",
  });
});

test("rejects configuration outside the explicit Worker allowlist", () => {
  assert.throws(() => {
    buildWorkerSecrets("DATABASE_URL=postgres://example\nSURPRISE_SECRET=nope");
  }, /allowlist is missing: SURPRISE_SECRET/u);
});
