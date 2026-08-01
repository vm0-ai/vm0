import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { exchangeAirtableCode } from "../airtable/oauth";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

function authCodeGrant() {
  return authCodeGrantFixture(["data.records:read"]);
}

describe("connector/providers/airtable", () => {
  describe("exchangeAirtableCode", () => {
    it("exchanges code for access token and user info", async () => {
      const tokenHandler = http.post(
        "https://airtable.com/oauth2/v1/token",
        () => {
          return HttpResponse.json({
            access_token: "airtable-test-token",
            refresh_token: "airtable-refresh-token",
            expires_in: 3600,
            scope: "data.records:read",
          });
        },
      );
      const whoamiHandler = http.get(
        "https://api.airtable.com/v0/meta/whoami",
        () => {
          return HttpResponse.json({
            id: "airtable-user-123",
            email: "test@example.com",
          });
        },
      );
      server.use(tokenHandler, whoamiHandler);

      const result = await exchangeAirtableCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
        "test-code-verifier",
      );

      expect(result.accessToken).toBe("airtable-test-token");
      expect(result.refreshToken).toBe("airtable-refresh-token");
      expect(result.expiresIn).toBe(3600);
      expect(result.scopes).toEqual(["data.records:read"]);
      expect(result.userInfo).toEqual({
        id: "airtable-user-123",
        username: "test@example.com",
        email: "test@example.com",
      });
    });

    it("rejects user info without the required Airtable user id", async () => {
      const tokenHandler = http.post(
        "https://airtable.com/oauth2/v1/token",
        () => {
          return HttpResponse.json({
            access_token: "airtable-test-token",
            refresh_token: "airtable-refresh-token",
            expires_in: 3600,
            scope: "data.records:read",
          });
        },
      );
      const whoamiHandler = http.get(
        "https://api.airtable.com/v0/meta/whoami",
        () => {
          return HttpResponse.json({ email: "test@example.com" });
        },
      );
      server.use(tokenHandler, whoamiHandler);

      await expect(
        exchangeAirtableCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
          "test-code-verifier",
        ),
      ).rejects.toThrow("No user id in Airtable user info response");
    });
  });
});
