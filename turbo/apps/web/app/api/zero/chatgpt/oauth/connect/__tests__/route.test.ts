import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { CHATGPT_OAUTH_CLIENT_ID } from "../../../../../../../src/lib/zero/connector/providers/chatgpt-oauth";

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

const CONNECT_URL = "http://localhost:3000/api/zero/chatgpt/oauth/connect";

describe("GET /api/zero/chatgpt/oauth/connect", () => {
  let user: UserContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    user = await context.setupUser();
  });

  it("redirects to auth.openai.com authorize URL with PKCE params", async () => {
    const request = createTestRequest(CONNECT_URL);
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const locUrl = new URL(location!);
    expect(locUrl.origin).toBe("https://auth.openai.com");
    expect(locUrl.pathname).toBe("/oauth/authorize");
    expect(locUrl.searchParams.get("response_type")).toBe("code");
    expect(locUrl.searchParams.get("client_id")).toBe(CHATGPT_OAUTH_CLIENT_ID);
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
    const request = createTestRequest(CONNECT_URL);
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

    const request = createTestRequest(CONNECT_URL);
    const response = await GET(request);

    expect(response.status).toBe(404);
  });

  it("returns 401 when caller is not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(CONNECT_URL);
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("encodes orgId, vm0UserId, and flow=connect into the state JSON", async () => {
    const request = createTestRequest(CONNECT_URL);
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

  it("ignores client-supplied orgId/vm0UserId query params", async () => {
    const request = createTestRequest(
      `${CONNECT_URL}?orgId=attacker-org&vm0UserId=attacker-user`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    const stateRaw = new URL(location!).searchParams.get("state");
    const state = JSON.parse(stateRaw!) as {
      orgId: string;
      vm0UserId: string;
    };
    // Auth context wins: query params are ignored
    expect(state.orgId).toBe(user.orgId);
    expect(state.vm0UserId).toBe(user.userId);
  });
});
