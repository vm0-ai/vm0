import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import { server } from "../../__tests__/test-server";
import { exchangeStravaCode } from "../strava/oauth";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

describe("connector/providers/strava", () => {
  it("returns the granted scopes reported by Strava", async () => {
    server.use(
      http.post("https://www.strava.com/oauth/token", () => {
        return HttpResponse.json({
          access_token: "strava-access-token",
          refresh_token: "strava-refresh-token",
          scope: "read,activity:read",
          athlete: { id: 42 },
        });
      }),
      http.get("https://www.strava.com/api/v3/athlete", () => {
        return HttpResponse.json({ id: 42, firstname: "Ada" });
      }),
    );

    const result = await exchangeStravaCode(
      authCodeGrantFixture(["read", "activity:read_all"]),
      "client-id",
      "client-secret",
      "authorization-code",
    );

    expect(result.scopes).toEqual(["read", "activity:read"]);
  });
});
