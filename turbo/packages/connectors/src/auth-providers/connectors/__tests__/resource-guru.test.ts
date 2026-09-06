import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import { server } from "../../__tests__/test-server";
import {
  buildResourceGuruAuthorizationUrl,
  exchangeResourceGuruCode,
  refreshResourceGuruToken,
} from "../resource-guru/oauth";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const TOKEN_URL = "https://api.resourceguruapp.com/oauth/token";
const USER_URL = "https://api.resourceguruapp.com/v1/me";

describe("connector/providers/resource-guru", () => {
  it("builds an authorization URL with the requested read scopes", () => {
    const url = buildResourceGuruAuthorizationUrl(
      authCodeGrantFixture(["users:read", "reports:read"]),
      "client-id",
      "https://app.vm0.ai/oauth/callback",
      "oauth-state",
    );
    const params = new URL(url).searchParams;

    expect(
      url.startsWith("https://api.resourceguruapp.com/oauth/authorize?"),
    ).toBe(true);
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("redirect_uri")).toBe(
      "https://app.vm0.ai/oauth/callback",
    );
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe("users:read reports:read");
    expect(params.get("state")).toBe("oauth-state");
  });

  it("exchanges a code and resolves the Resource Guru user", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("client_id")).toBe("client-id");
        expect(body.get("client_secret")).toBe("client-secret");
        expect(body.get("code")).toBe("authorization-code");
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("redirect_uri")).toBe(
          "https://app.vm0.ai/oauth/callback",
        );
        return HttpResponse.json({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 604800,
          scope: "users:read reports:read",
        });
      }),
      http.get(USER_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer access-token",
        );
        return HttpResponse.json({
          id: 42,
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com",
        });
      }),
    );

    await expect(
      exchangeResourceGuruCode(
        authCodeGrantFixture(["users:read", "reports:read"]),
        "client-id",
        "client-secret",
        "authorization-code",
        "https://app.vm0.ai/oauth/callback",
      ),
    ).resolves.toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 604800,
      scopes: ["users:read", "reports:read"],
      userInfo: {
        id: "42",
        username: "Ada Lovelace",
        email: "ada@example.com",
      },
    });
  });

  it("refreshes with the refresh token and preserves a rotated token", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("client_id")).toBe("client-id");
        expect(body.get("client_secret")).toBe("client-secret");
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh-token");
        return HttpResponse.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 604800,
          scope: "users:read",
        });
      }),
    );

    await expect(
      refreshResourceGuruToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 604800,
      scopes: ["users:read"],
    });
  });
});
