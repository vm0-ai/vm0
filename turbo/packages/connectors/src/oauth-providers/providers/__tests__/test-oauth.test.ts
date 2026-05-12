import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestOAuthAuthorizationUrl } from "../test-oauth";

describe("test-oauth provider URLs", () => {
  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", undefined);
    vi.stubEnv("VM0_WEB_URL", undefined);
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("VERCEL_URL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the concrete API URL when the configured app URL is a PR placeholder", () => {
    vi.stubEnv("APP_URL", "https://{pr}.vm6.ai");
    vi.stubEnv("VM0_API_URL", "https://pr-12962-www.vm6.ai");
    vi.stubEnv("VERCEL_URL", "pr-12962-app.vm6.ai");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        "test-client",
        "https://app.vm0.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://pr-12962-www.vm6.ai");
    expect(authorizationUrl.pathname).toBe(
      "/api/test/oauth-provider/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe("test-client");
    expect(authorizationUrl.searchParams.get("state")).toBe("state-123");
  });

  it("uses the concrete Vercel preview URL when only placeholder config is available", () => {
    vi.stubEnv("APP_URL", "https://{pr}.vm6.ai");
    vi.stubEnv("VERCEL_URL", "pr-12962-www.vm6.ai");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        "test-client",
        "https://app.vm0.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://pr-12962-www.vm6.ai");
  });

  it("keeps a concrete configured app URL ahead of VERCEL_URL", () => {
    vi.stubEnv("APP_URL", "https://app.vm0.ai");
    vi.stubEnv("VERCEL_URL", "pr-12962-www.vm6.ai");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        "test-client",
        "https://app.vm0.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://app.vm0.ai");
  });

  it("fails fast when a PR placeholder has no concrete Vercel URL", () => {
    vi.stubEnv("APP_URL", "https://{pr}.vm6.ai");

    expect(() => {
      buildTestOAuthAuthorizationUrl(
        "test-client",
        "https://app.vm0.ai/callback",
        "state-123",
      );
    }).toThrow("A concrete test-oauth app URL is required");
  });
});
