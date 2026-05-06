import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";

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

const BASE_URL = "http://localhost:3000/api/zero/chatgpt/oauth/connect";

function connectUrl(orgId: string, vm0UserId: string): string {
  return `${BASE_URL}?orgId=${encodeURIComponent(orgId)}&vm0UserId=${encodeURIComponent(vm0UserId)}`;
}

describe("GET /api/zero/chatgpt/oauth/connect", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    user = await context.setupUser();
  });

  it("redirects to auth.openai.com authorize URL with PKCE params", async () => {
    const request = createTestRequest(connectUrl(user.orgId, user.userId));
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const locUrl = new URL(location!);
    expect(locUrl.origin).toBe("https://auth.openai.com");
    expect(locUrl.pathname).toBe("/oauth/authorize");
    expect(locUrl.searchParams.get("response_type")).toBe("code");
    expect(locUrl.searchParams.get("client_id")).toBe(
      "app_EMoamEEZ73f0CkXaXp7hrann",
    );
    expect(locUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(locUrl.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect(locUrl.searchParams.get("state")).toBeTruthy();
    expect(locUrl.searchParams.get("redirect_uri")).toContain(
      "/api/zero/chatgpt/oauth/callback",
    );
    expect(locUrl.searchParams.get("scope")).toContain("openid");
  });

  it("sets state and PKCE cookies with HttpOnly + 15 min Max-Age", async () => {
    const request = createTestRequest(connectUrl(user.orgId, user.userId));
    const response = await GET(request);

    const cookies = response.headers.getSetCookie();
    const stateCookie = cookies.find((c) => {
      return c.startsWith("chatgpt_oauth_state=");
    });
    const pkceCookie = cookies.find((c) => {
      return c.startsWith("chatgpt_oauth_pkce=");
    });

    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("Max-Age=900");

    expect(pkceCookie).toBeDefined();
    expect(pkceCookie).toContain("HttpOnly");
    expect(pkceCookie).toContain("Max-Age=900");
  });

  it("returns 404 when feature switch is off (ineligible)", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);

    const request = createTestRequest(connectUrl(user.orgId, user.userId));
    const response = await GET(request);

    expect(response.status).toBe(404);
  });

  it("returns 400 when orgId is missing", async () => {
    const request = createTestRequest(
      `${BASE_URL}?vm0UserId=${encodeURIComponent(user.userId)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
  });

  it("returns 400 when vm0UserId is missing", async () => {
    const request = createTestRequest(
      `${BASE_URL}?orgId=${encodeURIComponent(user.orgId)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
  });

  it("encodes orgId, vm0UserId, and flow=connect into the state JSON", async () => {
    const request = createTestRequest(connectUrl(user.orgId, user.userId));
    const response = await GET(request);

    const location = response.headers.get("location");
    const stateRaw = new URL(location!).searchParams.get("state");
    expect(stateRaw).toBeTruthy();
    const state = JSON.parse(stateRaw!) as {
      orgId: string;
      vm0UserId: string;
      flow: string;
    };
    expect(state.orgId).toBe(user.orgId);
    expect(state.vm0UserId).toBe(user.userId);
    expect(state.flow).toBe("connect");
  });
});
