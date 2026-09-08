import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";
import {
  buildOptimizelyCmpAuthorizationUrl,
  exchangeOptimizelyCmpCode,
  refreshOptimizelyCmpToken,
  revokeOptimizelyCmpRefreshToken,
} from "../optimizely-cmp/oauth";

const AUTHORIZATION_URL =
  "https://accounts.cmp.optimizely.com/o/oauth2/v1/auth";
const TOKEN_URL = "https://accounts.cmp.optimizely.com/o/oauth2/v1/token";
const USERINFO_URL = "https://accounts.cmp.optimizely.com/o/oauth2/v1/userinfo";
const REVOKE_URL = "https://accounts.welcomesoftware.com/o/oauth2/v1/revoke";

function authCodeGrant() {
  return authCodeGrantFixture(["openid", "profile", "offline_access"]);
}

describe("connector/providers/optimizely-cmp", () => {
  it("builds the documented authorization URL", () => {
    const url = new URL(
      buildOptimizelyCmpAuthorizationUrl(
        authCodeGrant(),
        "client-id",
        "https://app.okou.ai/connectors/optimizely-cmp/callback",
        "oauth-state",
      ),
    );

    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZATION_URL);
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/optimizely-cmp/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile offline_access");
    expect(url.searchParams.get("state")).toBe("oauth-state");
  });

  it("exchanges a code and resolves the CMP user", async () => {
    let tokenBody: Record<string, unknown> | undefined;
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        expect(request.headers.get("content-type")).toContain(
          "application/json",
        );
        tokenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3599,
          token_type: "Bearer",
        });
      }),
      http.get(USERINFO_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer access-token",
        );
        return HttpResponse.json({
          sub: "cmp-user-123",
          name: "CMP User",
          email: "cmp@example.com",
        });
      }),
    );

    await expect(
      exchangeOptimizelyCmpCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "authorization-code",
        "https://app.okou.ai/connectors/optimizely-cmp/callback",
      ),
    ).resolves.toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3599,
      scopes: ["openid", "profile", "offline_access"],
      userInfo: {
        id: "cmp-user-123",
        username: "CMP User",
        email: "cmp@example.com",
      },
    });
    expect(tokenBody).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      code: "authorization-code",
      grant_type: "authorization_code",
      redirect_uri: "https://app.okou.ai/connectors/optimizely-cmp/callback",
    });
  });

  it("refreshes the single-use token and returns the rotated refresh token", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        expect(await request.json()).toEqual({
          client_id: "client-id",
          client_secret: "client-secret",
          grant_type: "refresh_token",
          refresh_token: "old-refresh-token",
        });
        return HttpResponse.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3599,
        });
      }),
    );

    await expect(
      refreshOptimizelyCmpToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 3599,
      scopes: null,
    });
  });

  it("rejects a refresh response without the rotated refresh token", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({ access_token: "new-access-token" });
      }),
    );

    await expect(
      refreshOptimizelyCmpToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "No rotated refresh token in Optimizely CMP refresh response",
    );
  });

  it("revokes the refresh token using the documented legacy endpoint", async () => {
    let revokeBody: Record<string, unknown> | undefined;
    server.use(
      http.post(REVOKE_URL, async ({ request }) => {
        revokeBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ msg: "success" });
      }),
    );

    await expect(
      revokeOptimizelyCmpRefreshToken(
        "client-id",
        "client-secret",
        "refresh-token",
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(revokeBody).toEqual({
      token: "refresh-token",
      token_type_hint: "refresh_token",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });
});
