import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { exchangeSupabaseCode } from "../supabase/oauth";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

function authCodeGrant() {
  return authCodeGrantFixture(["all"]);
}

describe("connector/providers/supabase", () => {
  it("uses the current profile identity instead of the first organization", async () => {
    const tokenHandler = http.post(
      "https://api.supabase.com/v1/oauth/token",
      () => {
        return HttpResponse.json({
          access_token: "supabase-test-token",
          refresh_token: "supabase-refresh-token",
          scope: "all",
        });
      },
    );
    const profileHandler = http.get(
      "https://api.supabase.com/v1/profile",
      () => {
        return HttpResponse.json({
          gotrue_id: "supabase-user-123",
          primary_email: "user@example.com",
          username: "test-user",
        });
      },
    );
    server.use(tokenHandler, profileHandler);

    const result = await exchangeSupabaseCode(
      authCodeGrant(),
      "client-id",
      "client-secret",
      "test-code",
      "https://example.com/callback",
      "test-state",
    );

    expect(result.userInfo).toEqual({
      id: "supabase-user-123",
      username: "test-user",
      email: "user@example.com",
    });
  });
});
