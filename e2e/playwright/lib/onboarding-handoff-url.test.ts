import assert from "node:assert/strict";
import { test } from "node:test";

import { rewritePreviewAppFallbackUrl } from "./onboarding-handoff-url";

const previewAppOrigin = "https://pr-22231-app.omby.ai";
const previewOnboardingOrigin = "https://pr-22231-www.omby.ai";

test("rewrites the standing app handoff to a cross-domain preview app", () => {
  const rewrittenUrl = rewritePreviewAppFallbackUrl(
    new URL("https://staging-app.vm6.ai/agents/agent-1/chat?source=e2e#run"),
    previewAppOrigin,
    previewOnboardingOrigin,
  );

  assert.equal(
    rewrittenUrl,
    "https://pr-22231-app.omby.ai/agents/agent-1/chat?source=e2e#run",
  );
});

test("preserves the same-domain preview handoff", () => {
  const rewrittenUrl = rewritePreviewAppFallbackUrl(
    new URL("https://staging-app.vm6.ai/prompt"),
    "https://pr-22231-app.vm6.ai",
    "https://pr-22231-www.vm6.ai",
  );

  assert.equal(rewrittenUrl, "https://pr-22231-app.vm6.ai/prompt");
});

test("rewrites a nested Clerk redirect to the preview app", () => {
  const authUrl = new URL("https://staging-app.vm6.ai/sign-in");
  authUrl.searchParams.set(
    "redirect_url",
    "https://staging-app.vm6.ai/prompt?source=clerk",
  );

  const rewrittenUrl = rewritePreviewAppFallbackUrl(
    authUrl,
    previewAppOrigin,
    previewOnboardingOrigin,
  );

  assert.ok(rewrittenUrl);
  const rewrittenAuthUrl = new URL(rewrittenUrl);
  assert.equal(rewrittenAuthUrl.origin, previewAppOrigin);

  const redirectUrl = rewrittenAuthUrl.searchParams.get("redirect_url");
  assert.ok(redirectUrl);
  assert.equal(redirectUrl, "https://pr-22231-app.omby.ai/prompt?source=clerk");
});

test("keeps an unrelated app origin unchanged", () => {
  const rewrittenUrl = rewritePreviewAppFallbackUrl(
    new URL("https://staging-app.example.com/prompt"),
    previewAppOrigin,
    previewOnboardingOrigin,
  );

  assert.equal(rewrittenUrl, null);
});

test("rewrites the staging app handoff to the Cloudflare staging app", () => {
  const rewrittenUrl = rewritePreviewAppFallbackUrl(
    new URL("https://staging-app.vm6.ai/prompt"),
    "https://staging-app.omby.ai",
    "https://staging-www.vm6.ai",
  );

  assert.equal(rewrittenUrl, "https://staging-app.omby.ai/prompt");
});
