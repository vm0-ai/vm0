import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { exchangeMailchimpCode } from "../mailchimp/oauth";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

function authCodeGrant() {
  return authCodeGrantFixture([]);
}

describe("connector/providers/mailchimp", () => {
  it("falls back to the documented API root when OAuth metadata omits user_id", async () => {
    const tokenHandler = http.post(
      "https://login.mailchimp.com/oauth2/token",
      () => {
        return HttpResponse.json({ access_token: "mailchimp-test-token" });
      },
    );
    const metadataHandler = http.get(
      "https://login.mailchimp.com/oauth2/metadata",
      () => {
        return HttpResponse.json({
          api_endpoint: "https://us1.api.mailchimp.com",
          accountname: "Test Account",
        });
      },
    );
    const rootHandler = http.get(
      "https://us1.api.mailchimp.com/3.0/",
      ({ request }) => {
        expect(request.headers.get("Authorization")).toBe(
          "Bearer mailchimp-test-token",
        );
        return HttpResponse.json({
          login_id: "login-12345",
          account_name: "Root Account",
          email: "owner@example.com",
        });
      },
    );
    server.use(tokenHandler, metadataHandler, rootHandler);

    const result = await exchangeMailchimpCode(
      authCodeGrant(),
      "client-id",
      "client-secret",
      "test-code",
      "https://example.com/callback",
    );

    expect(result.apiEndpoint).toBe("https://us1.api.mailchimp.com");
    expect(result.userInfo).toEqual({
      id: "login-12345",
      username: "Test Account",
      email: "owner@example.com",
    });
  });
});
