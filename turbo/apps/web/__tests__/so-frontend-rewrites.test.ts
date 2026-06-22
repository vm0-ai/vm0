import { describe, expect, it } from "vitest";
import {
  buildSoFrontendRewrites,
  matchesSoFrontendRewritePath,
  resolveSoFrontendRewritePath,
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

  it("rewrites marketing content to so in preview", () => {
    const rewrites = buildSoFrontendRewrites({
      PAID_ONBOARDING_URL: "https://pr-123-so.vm6.ai",
      VERCEL_ENV: "preview",
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
    expect(rewrites).not.toContainEqual({
      source: "/sign-in",
      destination: "https://pr-123-so.vm6.ai/sign-in",
    });
    expect(rewrites).not.toContainEqual({
      source: "/sign-up",
      destination: "https://pr-123-so.vm6.ai/sign-up",
    });
  });

  it("rewrites sign-in/sign-up to so only in production", () => {
    const rewrites = buildSoFrontendRewrites({
      PAID_ONBOARDING_URL: "https://so.vm0.ai",
      VERCEL_ENV: "production",
    });

    expect(rewrites).toContainEqual({
      source: "/sign-in/:path*",
      destination: "https://so.vm0.ai/sign-in/:path*",
    });
    expect(rewrites).toContainEqual({
      source: "/sign-up",
      destination: "https://so.vm0.ai/sign-up",
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
    expect(matchesSoFrontendRewritePath("/assets/vm0-logo.svg")).toBe(true);

    expect(matchesSoFrontendRewritePath("/sign-in/sso-callback")).toBe(false);
    expect(
      matchesSoFrontendRewritePath("/sign-in/sso-callback", {
        VERCEL_ENV: "production",
      }),
    ).toBe(true);
    expect(matchesSoFrontendRewritePath("/connector/success")).toBe(false);
    expect(matchesSoFrontendRewritePath("/desktop-auth/start")).toBe(false);
    expect(matchesSoFrontendRewritePath("/api/zero/billing/status")).toBe(
      false,
    );
  });

  it("resolves the matching so frontend destination path", () => {
    expect(resolveSoFrontendRewritePath("/")).toBe("/en");
    expect(resolveSoFrontendRewritePath("/report")).toBe("/en/report");
    expect(resolveSoFrontendRewritePath("/docs/reference/api")).toBe(
      "/en/docs/reference/api",
    );
    expect(resolveSoFrontendRewritePath("/en/docs/reference/api")).toBe(
      "/en/docs/reference/api",
    );
    expect(resolveSoFrontendRewritePath("/sign-in/factor-one")).toBeUndefined();
    expect(
      resolveSoFrontendRewritePath("/sign-in/factor-one", {
        VERCEL_ENV: "production",
      }),
    ).toBe("/sign-in/factor-one");
    expect(resolveSoFrontendRewritePath("/connector/success")).toBeUndefined();
  });
});
