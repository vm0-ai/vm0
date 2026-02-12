import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";

const context = testContext();

describe("GET /api/connectors/:type/authorize - OAuth Authorize", () => {
  beforeEach(() => {
    context.setupMocks();
    // Set required OAuth environment variables
    vi.stubEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    vi.stubEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client-id");
    vi.stubEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-client-secret");
    reloadEnv();
  });

  it("should return 400 for unknown connector type", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/invalid/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "invalid" }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("Unknown connector type");
  });

  it("should redirect unauthenticated user to login", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/sign-in");
    expect(location).toContain("redirect_url");
  });

  it("should redirect to GitHub OAuth with correct parameters", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain("redirect_uri=");
    expect(location).toContain("scope=repo");
    expect(location).toContain("state=");
  });

  it("should set state cookie for CSRF protection", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    const cookies = response.headers.getSetCookie();
    const stateCookie = cookies.find((c) =>
      c.startsWith("connector_oauth_state="),
    );
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("SameSite=Lax");
  });

  it("should store session ID in cookie when provided", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize?session=test-session-id",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookies.find((c) =>
      c.startsWith("connector_oauth_session="),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("test-session-id");
  });

  it("should not set session cookie when session parameter is absent", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookies.find((c) =>
      c.startsWith("connector_oauth_session="),
    );
    expect(sessionCookie).toBeUndefined();
  });

  describe("Notion connector", () => {
    it("should redirect to Notion OAuth with correct parameters", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/notion/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "notion" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("https://api.notion.com/v1/oauth/authorize");
      expect(location).toContain("client_id=notion-test-client-id");
      expect(location).toContain("redirect_uri=");
      expect(location).toContain("response_type=code");
      expect(location).toContain("owner=user");
      expect(location).toContain("state=");
    });

    it("should set state cookie for CSRF protection", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/notion/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "notion" }),
      });

      const cookies = response.headers.getSetCookie();
      const stateCookie = cookies.find((c) =>
        c.startsWith("connector_oauth_state="),
      );
      expect(stateCookie).toBeDefined();
      expect(stateCookie).toContain("HttpOnly");
      expect(stateCookie).toContain("SameSite=Lax");
    });
  });
});
