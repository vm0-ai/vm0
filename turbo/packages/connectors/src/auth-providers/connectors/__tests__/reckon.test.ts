import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { refreshReckonAccessToken } from "../reckon/api-token";
import { server } from "../../__tests__/test-server";

const RECKON_TOKEN_URL = "https://identity.reckon.com/connect/token";
const EXPECTED_AUTHORIZATION = `Basic ${Buffer.from(
  "client-id:client-secret",
).toString("base64")}`;

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("connector/providers/reckon", () => {
  it("refreshes a token with Basic auth and the registered redirect URI", async () => {
    let authorization: string | null = null;
    let contentType: string | null = null;
    let body = "";
    server.use(
      http.post(RECKON_TOKEN_URL, async ({ request }) => {
        authorization = request.headers.get("authorization");
        contentType = request.headers.get("content-type");
        body = await request.text();
        return HttpResponse.json({
          access_token: "new-reckon-access-token",
          refresh_token: "new-reckon-refresh-token",
          expires_in: 10800,
          token_type: "Bearer",
        });
      }),
    );

    await expect(
      refreshReckonAccessToken(
        {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/reckon/callback",
          refreshToken: "old-refresh-token",
        },
        testRefreshSignal(),
      ),
    ).resolves.toEqual({
      accessToken: "new-reckon-access-token",
      refreshToken: "new-reckon-refresh-token",
      expiresIn: 10800,
    });
    expect(authorization).toBe(EXPECTED_AUTHORIZATION);
    expect(contentType).toContain("application/x-www-form-urlencoded");
    const parameters = new URLSearchParams(body);
    expect(parameters.get("grant_type")).toBe("refresh_token");
    expect(parameters.get("refresh_token")).toBe("old-refresh-token");
    expect(parameters.get("redirect_uri")).toBe(
      "https://example.com/reckon/callback",
    );
    expect(body).not.toContain("client_secret");
  });

  it("rejects an HTTP error without exposing credentials", async () => {
    server.use(
      http.post(RECKON_TOKEN_URL, () => {
        return new HttpResponse(null, { status: 401 });
      }),
    );

    await expect(
      refreshReckonAccessToken(
        {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/reckon/callback",
          refreshToken: "old-refresh-token",
        },
        testRefreshSignal(),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an OAuth error response", async () => {
    server.use(
      http.post(RECKON_TOKEN_URL, () => {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: "Refresh token expired",
        });
      }),
    );

    await expect(
      refreshReckonAccessToken(
        {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/reckon/callback",
          refreshToken: "old-refresh-token",
        },
        testRefreshSignal(),
      ),
    ).rejects.toThrow("Refresh token expired");
  });

  it("rejects a successful response without an access token", async () => {
    server.use(
      http.post(RECKON_TOKEN_URL, () => {
        return HttpResponse.json({});
      }),
    );

    await expect(
      refreshReckonAccessToken(
        {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/reckon/callback",
          refreshToken: "old-refresh-token",
        },
        testRefreshSignal(),
      ),
    ).rejects.toThrow("No access token in Reckon token response");
  });

  it("rejects an invalid token response shape", async () => {
    server.use(
      http.post(RECKON_TOKEN_URL, () => {
        return HttpResponse.json({ access_token: 17 });
      }),
    );

    await expect(
      refreshReckonAccessToken(
        {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/reckon/callback",
          refreshToken: "old-refresh-token",
        },
        testRefreshSignal(),
      ),
    ).rejects.toThrow("Invalid Reckon token response");
  });
});
