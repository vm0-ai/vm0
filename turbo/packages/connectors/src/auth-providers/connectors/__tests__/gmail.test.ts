import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { buildGmailAuthorizationUrl, exchangeGmailCode } from "../gmail/oauth";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

function authCodeGrant() {
  return authCodeGrantFixture(["https://www.googleapis.com/auth/gmail.modify"]);
}

describe("connector/providers/gmail", () => {
  it("adds Google identity scopes to the Gmail authorization URL", () => {
    const url = new URL(
      buildGmailAuthorizationUrl(
        authCodeGrant(),
        "client-id",
        "https://example.com/callback",
        "test-state",
      ),
    );

    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "openid",
      "email",
      "profile",
    ]);
  });

  it("uses the immutable OpenID subject as the grant identity", async () => {
    const tokenHandler = http.post(
      "https://oauth2.googleapis.com/token",
      () => {
        return HttpResponse.json({
          access_token: "gmail-test-token",
          refresh_token: "gmail-refresh-token",
          scope: "openid email profile",
        });
      },
    );
    const userInfoHandler = http.get(
      "https://openidconnect.googleapis.com/v1/userinfo",
      () => {
        return HttpResponse.json({
          sub: "google-user-123",
          email: "renamable@example.com",
          name: "Test User",
        });
      },
    );
    server.use(tokenHandler, userInfoHandler);

    const result = await exchangeGmailCode(
      authCodeGrant(),
      "client-id",
      "client-secret",
      "test-code",
      "https://example.com/callback",
    );

    expect(result.userInfo).toEqual({
      id: "google-user-123",
      email: "renamable@example.com",
      name: "Test User",
    });
  });

  it("uses all requested scopes when Google omits scope", async () => {
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        return HttpResponse.json({ access_token: "gmail-test-token" });
      }),
      http.get("https://openidconnect.googleapis.com/v1/userinfo", () => {
        return HttpResponse.json({ sub: "google-user-123" });
      }),
    );
    const authorizationUrl = new URL(
      buildGmailAuthorizationUrl(
        authCodeGrant(),
        "client-id",
        "https://example.com/callback",
        "test-state",
      ),
    );
    const authorizationScopes =
      authorizationUrl.searchParams.get("scope")?.split(" ") ?? [];

    const result = await exchangeGmailCode(
      authCodeGrantFixture(authorizationScopes),
      "client-id",
      "client-secret",
      "test-code",
      "https://example.com/callback",
    );

    expect(result.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "openid",
      "email",
      "profile",
    ]);
  });
});
