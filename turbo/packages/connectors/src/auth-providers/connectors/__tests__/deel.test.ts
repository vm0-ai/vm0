import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { exchangeDeelCode } from "../deel/oauth";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

function authCodeGrant() {
  return authCodeGrantFixture(["people:read"]);
}

function tokenHandler() {
  return http.post("https://app.deel.com/oauth2/tokens", () => {
    return HttpResponse.json({
      access_token: "deel-test-token",
      refresh_token: "deel-refresh-token",
      scope: "people:read",
    });
  });
}

describe("connector/providers/deel", () => {
  describe("exchangeDeelCode", () => {
    it("accepts the documented root profile with a numeric id", async () => {
      const profileHandler = http.get(
        "https://api.letsdeel.com/rest/people/me",
        () => {
          return HttpResponse.json({
            id: 12345,
            first_name: "Test",
            last_name: "Person",
            email: "test@example.com",
          });
        },
      );
      server.use(tokenHandler(), profileHandler);

      const result = await exchangeDeelCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
        "test-state",
      );

      expect(result.userInfo).toEqual({
        id: "12345",
        username: "Test Person",
        email: "test@example.com",
      });
    });

    it("tolerates the legacy wrapped profile shape", async () => {
      const profileHandler = http.get(
        "https://api.letsdeel.com/rest/people/me",
        () => {
          return HttpResponse.json({
            data: {
              id: "person-123",
              full_name: "Legacy Person",
              emails: [{ value: "legacy@example.com" }],
            },
          });
        },
      );
      server.use(tokenHandler(), profileHandler);

      const result = await exchangeDeelCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
        "test-state",
      );

      expect(result.userInfo).toEqual({
        id: "person-123",
        username: "Legacy Person",
        email: "legacy@example.com",
      });
    });
  });
});
