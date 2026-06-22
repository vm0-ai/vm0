import { describe, expect, it } from "vitest";
import {
  buildSoFrontendRewrites,
  matchesSoFrontendRewritePath,
  resolveSoFrontendUrl,
} from "../so-frontend-rewrites";

describe("so frontend rewrites", () => {
  it("uses PAID_ONBOARDING_URL as the target origin", () => {
    expect(
      resolveSoFrontendUrl({
        PAID_ONBOARDING_URL: "https://staging-so.vm6.ai/",
      }),
    ).toBe("https://staging-so.vm6.ai");
  });

  it("falls back to production so.vm0.ai only for production", () => {
    expect(resolveSoFrontendUrl({ VERCEL_ENV: "production" })).toBe(
      "https://so.vm0.ai",
    );
    expect(resolveSoFrontendUrl({ VERCEL_ENV: "preview" })).toBeUndefined();
  });

  it("rewrites marketing content and sign-in/sign-up to so", () => {
    const rewrites = buildSoFrontendRewrites({
      PAID_ONBOARDING_URL: "https://pr-123-so.vm6.ai",
    });

    expect(rewrites).toContainEqual({
      source: "/",
      destination: "https://pr-123-so.vm6.ai/en",
    });
    expect(rewrites).toContainEqual({
      source: "/report",
      destination: "https://pr-123-so.vm6.ai/en/report",
    });
    expect(rewrites).toContainEqual({
      source: "/docs",
      destination: "https://pr-123-so.vm6.ai/en/docs",
    });
    expect(rewrites).toContainEqual({
      source: "/docs/:path*",
      destination: "https://pr-123-so.vm6.ai/en/docs/:path*",
    });
    expect(rewrites).toContainEqual({
      source: "/en/models/:path*",
      destination: "https://pr-123-so.vm6.ai/en/models/:path*",
    });
    expect(rewrites).toContainEqual({
      source: "/sign-in/:path*",
      destination: "https://pr-123-so.vm6.ai/sign-in/:path*",
    });
    expect(rewrites).toContainEqual({
      source: "/sign-up",
      destination: "https://pr-123-so.vm6.ai/sign-up",
    });
  });

  it("does not rewrite app-only functional routes", () => {
    const rewrites = buildSoFrontendRewrites({
      PAID_ONBOARDING_URL: "https://so.vm0.ai",
    });
    const sources = new Set(
      rewrites.map((rewrite: { source: string }) => {
        return rewrite.source;
      }),
    );

    expect(sources.has("/api/:path*")).toBe(false);
    expect(sources.has("/desktop-auth/:path*")).toBe(false);
    expect(sources.has("/connector/:path*")).toBe(false);
    expect(sources.has("/export")).toBe(false);
    expect(sources.has("/sign-in-token")).toBe(false);
  });

  it("matches configured so frontend rewrite paths", () => {
    expect(matchesSoFrontendRewritePath("/pricing")).toBe(true);
    expect(matchesSoFrontendRewritePath("/en/pricing")).toBe(true);
    expect(matchesSoFrontendRewritePath("/en/blog/posts/example")).toBe(true);
    expect(matchesSoFrontendRewritePath("/docs/getting-started")).toBe(true);
    expect(matchesSoFrontendRewritePath("/sign-in/sso-callback")).toBe(true);
    expect(matchesSoFrontendRewritePath("/assets/vm0-logo.svg")).toBe(true);

    expect(matchesSoFrontendRewritePath("/connector/success")).toBe(false);
    expect(matchesSoFrontendRewritePath("/desktop-auth/start")).toBe(false);
    expect(matchesSoFrontendRewritePath("/api/zero/billing/status")).toBe(false);
  });
});
