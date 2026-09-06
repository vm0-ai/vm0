import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import { server } from "../../__tests__/test-server";
import { ProviderResponseError } from "../../provider-error";
import { fetchProcountorAccessToken } from "../procountor/api-token";

const PROCOUNTOR_TOKEN_URL = "https://api.procountor.com/api/oauth/token";

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("connector/providers/procountor", () => {
  it("exchanges the M2M API key with the official client-credentials form", async () => {
    let contentType: string | null = null;
    let body = "";
    server.use(
      http.post(PROCOUNTOR_TOKEN_URL, async ({ request }) => {
        contentType = request.headers.get("content-type");
        body = await request.text();
        return HttpResponse.json({
          access_token: "procountor-access-token",
          expires_in: 3600,
        });
      }),
    );

    await expect(
      fetchProcountorAccessToken(
        {
          apiKey: "api-key",
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/procountor/callback",
        },
        testRefreshSignal(),
      ),
    ).resolves.toEqual({
      accessToken: "procountor-access-token",
      expiresIn: 3600,
    });
    expect(contentType).toContain("application/x-www-form-urlencoded");
    const parameters = new URLSearchParams(body);
    expect(parameters.get("grant_type")).toBe("client_credentials");
    expect(parameters.get("api_key")).toBe("api-key");
    expect(parameters.get("client_id")).toBe("client-id");
    expect(parameters.get("client_secret")).toBe("client-secret");
    expect(parameters.get("redirect_uri")).toBe(
      "https://example.com/procountor/callback",
    );
    expect(body).not.toContain("Authorization");
  });

  it("rejects an HTTP error without exposing credentials", async () => {
    server.use(
      http.post(PROCOUNTOR_TOKEN_URL, () => {
        return new HttpResponse(null, { status: 401 });
      }),
    );

    await expect(
      fetchProcountorAccessToken(
        {
          apiKey: "api-key",
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/procountor/callback",
        },
        testRefreshSignal(),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects malformed JSON responses", async () => {
    server.use(
      http.post(PROCOUNTOR_TOKEN_URL, () => {
        return new HttpResponse("not-json", {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await expect(
      fetchProcountorAccessToken(
        {
          apiKey: "api-key",
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/procountor/callback",
        },
        testRefreshSignal(),
      ),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("rejects a successful response without a complete token", async () => {
    server.use(
      http.post(PROCOUNTOR_TOKEN_URL, () => {
        return HttpResponse.json({ access_token: "token" });
      }),
    );

    await expect(
      fetchProcountorAccessToken(
        {
          apiKey: "api-key",
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/procountor/callback",
        },
        testRefreshSignal(),
      ),
    ).rejects.toThrow("Invalid Procountor access token response");
  });
});
