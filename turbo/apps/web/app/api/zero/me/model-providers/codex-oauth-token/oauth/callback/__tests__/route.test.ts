import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { GET } from "../route";
import { GET as listProviders } from "../../../../route";
import { http } from "../../../../../../../../../src/__tests__/msw";
import { createTestRequest } from "../../../../../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../../../../../src/mocks/server";
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
const TOKEN_URL = "https://auth.openai.com/oauth/token";

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createJwt(payload: Record<string, unknown>): string {
  return [
    base64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64Url(JSON.stringify(payload)),
    "",
  ].join(".");
}

describe("GET /api/zero/me/model-providers/codex-oauth-token/oauth/callback", () => {
  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const orgId = randomUUID();
    mockClerk({ userId: user.userId, orgId });
    await ensureOrgRow(orgId);
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("rejects mismatched state and clears OAuth cookies", async () => {
    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/callback?code=code-1&state=wrong-state",
        {
          headers: {
            cookie:
              "model_provider_oauth_state=expected-state; model_provider_oauth_pkce=verifier-1",
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/connector/error");
    expect(location).toContain("Invalid+state");
    const cookies = response.headers.getSetCookie();
    expect(
      cookies.find((cookie) => {
        return cookie.startsWith("model_provider_oauth_state=;");
      }),
    ).toContain("Max-Age=0");
    expect(
      cookies.find((cookie) => {
        return cookie.startsWith("model_provider_oauth_pkce=;");
      }),
    ).toContain("Max-Age=0");
  });

  it("exchanges the code and persists the personal ChatGPT provider", async () => {
    const accessToken = createJwt({ exp: 1_900_000_000 });
    const idToken = createJwt({
      sub: "user-1",
      email: "user@example.com",
      name: "Test User",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "plus",
        workspace: { name: "Personal Workspace" },
      },
    });
    const { handler } = http.post(TOKEN_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.client_id).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("code-1");
      expect(body.redirect_uri).toBe(
        "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
      );
      expect(body.code_verifier).toBe("verifier-1");
      return HttpResponse.json({
        access_token: accessToken,
        refresh_token: "refresh-1",
        id_token: idToken,
        expires_in: 3600,
      });
    });
    server.use(handler);

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/callback?code=code-1&state=state-1",
        {
          headers: {
            cookie:
              "model_provider_oauth_state=state-1; model_provider_oauth_pkce=verifier-1",
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/connector/success");
    expect(location).toContain("type=openai");
    expect(location).toContain("Personal+Workspace");

    const listResponse = await listProviders(
      createTestRequest("http://localhost:3000/api/zero/me/model-providers"),
    );
    expect(listResponse.status).toBe(200);
    const data = await listResponse.json();
    expect(data.modelProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "codex-oauth-token",
          authMethod: "oauth",
          workspaceName: "Personal Workspace",
          planType: "plus",
          needsReconnect: false,
        }),
      ]),
    );
  });

  it("redirects with an error when Codex OAuth is disabled", async () => {
    mockIsFeatureEnabled.mockImplementation((key) => {
      return key !== FeatureSwitchKey.CodexOauthProvider;
    });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/callback?code=code-1&state=state-1",
        {
          headers: {
            cookie:
              "model_provider_oauth_state=state-1; model_provider_oauth_pkce=verifier-1",
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/connector/error");
    expect(location).toContain("OpenAI+OAuth+is+not+available");
  });
});
