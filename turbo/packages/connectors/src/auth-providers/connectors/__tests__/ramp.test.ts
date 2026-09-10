import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import {
  buildConnectorAuthCodeAuthorizationUrlWithMethod,
  exchangeConnectorAuthCodeWithMethod,
  refreshConnectorAuthProviderAccessTokenWithMethod,
  revokeConnectorAuthMethodAccessTokenWithMethod,
} from "../../connector-auth";
import { ProviderHttpError, ProviderResponseError } from "../../provider-error";
import { server } from "../../__tests__/test-server";

const API = "https://api.ramp.com/developer/v1";
const SCOPES = [
  "business:read",
  "transactions:read",
  "offline_access",
  "openid",
];
const outputs = {
  accessToken: "$secrets.RAMP_ACCESS_TOKEN",
  refreshToken: "$secrets.RAMP_REFRESH_TOKEN",
} as const;
const method: ConnectorAuthMethodRuntimeConfig = {
  client: {
    clientRegistration: "static",
    clientType: "confidential",
    clientIdEnv: "RAMP_OAUTH_CLIENT_ID",
    clientSecretEnv: "RAMP_OAUTH_CLIENT_SECRET",
  },
  storage: {
    version: 1,
    secrets: ["RAMP_ACCESS_TOKEN", "RAMP_REFRESH_TOKEN"],
    variables: [],
  },
  grant: { kind: "auth-code", callbackOrigin: "web", scopes: SCOPES, outputs },
  access: {
    kind: "refresh-token",
    inputs: { refreshToken: "$secrets.RAMP_REFRESH_TOKEN" },
    outputs,
    refreshableSecrets: ["RAMP_ACCESS_TOKEN"],
    envBindings: { RAMP_TOKEN: "$secrets.RAMP_ACCESS_TOKEN" },
  },
  revoke: {
    kind: "token-revoke",
    inputs: outputs,
    revokePreviousOnReplace: true,
  },
};
const selection = { connectorSlug: "ramp", authMethodId: "oauth", method };
const authClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
} as const;
const redirectUri = "https://app.example.test/connectors/ramp/callback";
const token = {
  access_token: "ramp_business_tok_synthetic_access",
  refresh_token: "ramp_business_tok_synthetic_refresh",
  expires_in: 7200,
  token_type: "Bearer",
  scope: "business:read offline_access",
};
const basic = `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`;
function exchange() {
  return exchangeConnectorAuthCodeWithMethod({
    ...selection,
    authClient,
    authorizationUrl: null,
    code: "test-code",
    redirectUri,
    state: "test-state",
    codeVerifier: undefined,
    oauthContext: undefined,
  });
}
function refresh(signal = new AbortController().signal) {
  return refreshConnectorAuthProviderAccessTokenWithMethod(
    { ...selection, authClient, inputs: { refreshToken: token.refresh_token } },
    signal,
  );
}

describe("Ramp OAuth through the executable provider registry", () => {
  it("builds interactive consent from the selected scopes and callback", async () => {
    const result = await buildConnectorAuthCodeAuthorizationUrlWithMethod({
      ...selection,
      authClient,
      redirectUri,
      state: "test-state",
    });
    if (typeof result !== "string") throw new Error("Expected consent URL");
    const url = new URL(result);
    expect(url.origin + url.pathname).toBe("https://app.ramp.com/v1/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: authClient.clientId,
      redirect_uri: redirectUri,
      state: "test-state",
      scope: SCOPES.join(" "),
    });
  });
  it("exchanges with Basic auth and identifies the connected business", async () => {
    server.use(
      http.post(`${API}/token`, async ({ request }) => {
        expect(request.headers.get("Authorization")).toBe(basic);
        expect(request.headers.get("Content-Type")).toBe(
          "application/x-www-form-urlencoded",
        );
        expect(
          Object.fromEntries(new URLSearchParams(await request.text())),
        ).toEqual({
          grant_type: "authorization_code",
          code: "test-code",
          redirect_uri: redirectUri,
        });
        return HttpResponse.json(token);
      }),
      http.get(`${API}/business`, ({ request }) => {
        expect(request.headers.get("Authorization")).toBe(
          `Bearer ${token.access_token}`,
        );
        return HttpResponse.json({
          id: "business-123",
          business_name_legal: "Example Company",
        });
      }),
    );
    await expect(exchange()).resolves.toMatchObject({
      outputs: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
      },
      expiresIn: 7200,
      scopes: ["business:read", "offline_access"],
      userInfo: {
        id: "business-123",
        username: "Example Company",
        email: null,
      },
    });
  });
  it("preserves the original refresh token and scopes when Ramp omits them", async () => {
    server.use(
      http.post(`${API}/token`, async ({ request }) => {
        expect(request.headers.get("Authorization")).toBe(basic);
        expect(
          Object.fromEntries(new URLSearchParams(await request.text())),
        ).toEqual({
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
        });
        return HttpResponse.json({
          access_token: "renewed-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }),
    );
    await expect(refresh()).resolves.toEqual({
      outputs: { accessToken: "renewed-token" },
      expiresIn: 3600,
    });
  });
  it("stores rotated tokens and provider-reported scopes when returned", async () => {
    server.use(
      http.post(`${API}/token`, () => {
        return HttpResponse.json({ ...token, refresh_token: "rotated-token" });
      }),
    );
    await expect(refresh()).resolves.toMatchObject({
      outputs: {
        accessToken: token.access_token,
        refreshToken: "rotated-token",
      },
      scopes: ["business:read", "offline_access"],
    });
  });
  it.each([
    ["invalid JSON", "PRIVATE123"],
    [
      "missing access token",
      JSON.stringify({ expires_in: 3600, token_type: "Bearer" }),
    ],
    ["invalid expiry", JSON.stringify({ ...token, expires_in: 0 })],
    ["invalid token type", JSON.stringify({ ...token, token_type: "Other" })],
  ])("rejects %s without exposing provider bodies", async (_name, body) => {
    server.use(
      http.post(`${API}/token`, () => {
        return new HttpResponse(body);
      }),
    );
    await expect(refresh()).rejects.toThrow(ProviderResponseError);
    await expect(refresh()).rejects.not.toThrow("PRIVATE123");
  });
  it("rejects a grant without its refresh token", async () => {
    server.use(
      http.post(`${API}/token`, () => {
        return HttpResponse.json({ ...token, refresh_token: undefined });
      }),
    );
    await expect(exchange()).rejects.toThrow(ProviderResponseError);
  });
  it("reports provider authorization failures without the response body", async () => {
    server.use(
      http.post(`${API}/token`, () => {
        return new HttpResponse("PRIVATE123", { status: 401 });
      }),
    );
    await expect(refresh()).rejects.toThrow(ProviderHttpError);
    await expect(exchange()).rejects.toThrow("Ramp token exchange failed: 401");
  });
  it("honors cancellation during refresh", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(refresh(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("revokes both tokens using deployment client credentials", async () => {
    const revoked: string[] = [];
    server.use(
      http.post(`${API}/token/revoke`, async ({ request }) => {
        expect(request.headers.get("Authorization")).toBe(basic);
        revoked.push(
          new URLSearchParams(await request.text()).get("token") ?? "",
        );
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const env: Readonly<Record<string, string>> = {
      RAMP_OAUTH_CLIENT_ID: authClient.clientId,
      RAMP_OAUTH_CLIENT_SECRET: authClient.clientSecret,
    };
    await expect(
      revokeConnectorAuthMethodAccessTokenWithMethod(
        {
          ...selection,
          readEnv: (name) => {
            return env[name];
          },
          loadInputs: () => {
            return {
              accessToken: token.access_token,
              refreshToken: token.refresh_token,
            };
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "revoked" });
    expect(revoked).toEqual([token.access_token, token.refresh_token]);
  });
});
