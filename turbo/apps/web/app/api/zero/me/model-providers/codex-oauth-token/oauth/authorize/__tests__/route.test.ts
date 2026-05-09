import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../../../../src/__tests__/api-test-helpers";
import {
  ensureOrgRow,
  testContext,
} from "../../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../../src/__tests__/clerk-mock";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const context = testContext();

describe("GET /api/zero/me/model-providers/codex-oauth-token/oauth/authorize", () => {
  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const orgId = randomUUID();
    mockClerk({ userId: user.userId, orgId });
    await ensureOrgRow(orgId);
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("redirects unauthenticated users to sign in", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
      ),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/sign-in");
    expect(location).toContain("redirect_url");
  });

  it("returns 404 when Codex OAuth is disabled", async () => {
    mockIsFeatureEnabled.mockImplementation((key) => {
      return key !== FeatureSwitchKey.CodexOauthProvider;
    });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
      ),
    );

    expect(response.status).toBe(404);
  });

  it("redirects to OpenAI OAuth with state and PKCE cookies", async () => {
    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
      ),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("https://auth.openai.com/oauth/authorize");
    const url = new URL(location!);
    expect(url.searchParams.get("client_id")).toBe(
      "app_EMoamEEZ73f0CkXaXp7hrann",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.find((cookie) => {
        return cookie.startsWith("model_provider_oauth_state=");
      }),
    ).toContain("HttpOnly");
    expect(
      cookies.find((cookie) => {
        return cookie.startsWith("model_provider_oauth_pkce=");
      }),
    ).toContain("HttpOnly");
  });
});
