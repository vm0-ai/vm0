import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTestOAuthAuthorizationUrl,
  refreshTestOAuthToken,
} from "../test-oauth";

describe("test-oauth provider URLs", () => {
  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", undefined);
    vi.stubEnv("VM0_WEB_URL", undefined);
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("VERCEL_URL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the API preview alias when the configured URL is a web preview alias", () => {
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

    expect(authorizationUrl.origin).toBe("https://pr-12962-api.vm6.ai");
    expect(authorizationUrl.pathname).toBe(
      "/api/test/oauth-provider/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe("test-client");
    expect(authorizationUrl.searchParams.get("state")).toBe("state-123");
  });

  it("uses the API preview alias when only placeholder config and web Vercel URL are available", () => {
    vi.stubEnv("APP_URL", "https://{pr}.vm6.ai");
    vi.stubEnv("VERCEL_URL", "pr-12962-www.vm6.ai");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        "test-client",
        "https://app.vm0.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://pr-12962-api.vm6.ai");
  });

  it("uses the current deployment URL when the API URL is a PR placeholder", () => {
    vi.stubEnv("VM0_API_URL", "https://{pr}.vm6.ai");
    vi.stubEnv("VM0_WEB_URL", "https://pr-12962-www.vm6.ai");
    vi.stubEnv("VERCEL_URL", "pr-12962-api.vm6.ai");

    const authorizationUrl = new URL(
      buildTestOAuthAuthorizationUrl(
        "test-client",
        "https://app.vm0.ai/callback",
        "state-123",
      ),
    );

    expect(authorizationUrl.origin).toBe("https://pr-12962-api.vm6.ai");
  });

  it("sends both Vercel and internal preview bypass headers on refresh", async () => {
    vi.stubEnv("VM0_API_URL", "https://pr-12962-www.vm6.ai");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: "refresh-2",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "read",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await refreshTestOAuthToken(
      "test-oauth-client",
      "test-oauth-secret",
      "refresh-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pr-12962-api.vm6.ai/api/test/oauth-provider/token",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-vercel-protection-bypass": "preview-secret",
          "x-vm0-test-endpoint-bypass": "preview-secret",
        }),
      }),
    );
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
