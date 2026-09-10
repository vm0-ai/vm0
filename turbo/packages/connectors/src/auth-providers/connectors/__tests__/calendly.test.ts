import { createHash } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import {
  buildConnectorAuthCodeAuthorizationUrlWithMethod,
  exchangeConnectorAuthCodeWithMethod,
  refreshConnectorAuthProviderAccessTokenWithMethod,
  revokeConnectorAuthMethodAccessTokenWithMethod,
} from "../../connector-auth";
import { server } from "../../__tests__/test-server";

const method = {
  client: {
    clientRegistration: "static",
    clientType: "confidential",
    clientIdEnv: "CALENDLY_OAUTH_CLIENT_ID",
    clientSecretEnv: "CALENDLY_OAUTH_CLIENT_SECRET",
  },
  storage: {
    version: 1,
    secrets: ["CALENDLY_ACCESS_TOKEN", "CALENDLY_REFRESH_TOKEN"],
    variables: [],
  },
  grant: {
    kind: "auth-code",
    callbackOrigin: "web",
    scopes: ["users:read", "scheduled_events:write"],
    outputs: {
      accessToken: "$secrets.CALENDLY_ACCESS_TOKEN",
      refreshToken: "$secrets.CALENDLY_REFRESH_TOKEN",
    },
  },
  access: {
    kind: "refresh-token",
    envBindings: { CALENDLY_TOKEN: "$secrets.CALENDLY_ACCESS_TOKEN" },
    inputs: { refreshToken: "$secrets.CALENDLY_REFRESH_TOKEN" },
    outputs: {
      accessToken: "$secrets.CALENDLY_ACCESS_TOKEN",
      refreshToken: "$secrets.CALENDLY_REFRESH_TOKEN",
    },
    refreshableSecrets: ["CALENDLY_ACCESS_TOKEN"],
  },
  revoke: {
    kind: "token-revoke",
    revokePreviousOnReplace: false,
    inputs: { refreshToken: "$secrets.CALENDLY_REFRESH_TOKEN" },
  },
} as const satisfies ConnectorAuthMethodRuntimeConfig;
const selection = { connectorSlug: "calendly", authMethodId: "oauth", method };
const authClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-calendly-client",
  clientSecret: "test-calendly-secret",
} as const;
const redirectUri = "https://app.okou.ai/connectors/calendly/callback";
const tokenResponse = {
  token_type: "Bearer",
  access_token: "test-calendly-access",
  refresh_token: "test-calendly-refresh-1",
  expires_in: 7200,
  created_at: 1789000000,
  owner: "https://api.calendly.com/users/test-user",
  organization: "https://api.calendly.com/organizations/test-org",
};

async function authorize() {
  const result = await buildConnectorAuthCodeAuthorizationUrlWithMethod({
    ...selection,
    authClient,
    redirectUri,
    state: "test-state",
  });
  if (typeof result === "string" || result.codeVerifier === undefined) {
    throw new Error("Calendly must preserve a PKCE verifier");
  }
  return { url: result.url, codeVerifier: result.codeVerifier };
}
function exchange(codeVerifier: string | undefined, authorizationUrl: string) {
  return exchangeConnectorAuthCodeWithMethod({
    ...selection,
    authClient,
    authorizationUrl,
    code: "test-authorization-code",
    redirectUri,
    state: "test-state",
    codeVerifier,
    oauthContext: undefined,
  });
}
function refresh(refreshToken: string) {
  return refreshConnectorAuthProviderAccessTokenWithMethod(
    { ...selection, authClient, inputs: { refreshToken } },
    new AbortController().signal,
  );
}

describe("Calendly registered OAuth provider", () => {
  it.each(["users:read", undefined])(
    "preserves PKCE and resolves reported scopes (%s)",
    async (scope) => {
      const authorization = await authorize();
      const url = new URL(authorization.url);
      expect(url.origin + url.pathname).toBe(
        "https://auth.calendly.com/oauth/authorize",
      );
      expect(url.searchParams.get("client_id")).toBe(authClient.clientId);
      expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
      expect(url.searchParams.get("scope")).toBe(
        "users:read scheduled_events:write",
      );
      expect(url.searchParams.get("state")).toBe("test-state");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBe(
        createHash("sha256")
          .update(authorization.codeVerifier)
          .digest("base64url"),
      );
      server.use(
        http.post(
          "https://auth.calendly.com/oauth/token",
          async ({ request }) => {
            expect(request.headers.get("authorization")).toBe(
              `Basic ${btoa(`${authClient.clientId}:${authClient.clientSecret}`)}`,
            );
            expect(await request.json()).toStrictEqual({
              grant_type: "authorization_code",
              code: "test-authorization-code",
              redirect_uri: redirectUri,
              code_verifier: authorization.codeVerifier,
            });
            return HttpResponse.json({ ...tokenResponse, scope });
          },
        ),
        http.get("https://api.calendly.com/users/me", ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-calendly-access",
          );
          return HttpResponse.json({
            resource: {
              uri: tokenResponse.owner,
              name: "Calendly User",
              email: "user@example.com",
            },
          });
        }),
      );
      expect(
        await exchange(authorization.codeVerifier, authorization.url),
      ).toMatchObject({
        outputs: {
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token,
        },
        expiresIn: 7200,
        scopes:
          scope === undefined
            ? ["users:read", "scheduled_events:write"]
            : ["users:read"],
        userInfo: {
          id: tokenResponse.owner,
          username: "Calendly User",
          email: "user@example.com",
        },
      });
    },
  );

  it("rejects exchange without the saved PKCE verifier", async () => {
    const authorization = await authorize();
    await expect(exchange(undefined, authorization.url)).rejects.toThrow(
      "original PKCE code verifier",
    );
  });

  it("returns each rotated token for the next refresh and rejects a reused token", async () => {
    const responses: Record<string, string> = {
      "test-calendly-refresh-1": "test-calendly-refresh-2",
      "test-calendly-refresh-2": "test-calendly-refresh-3",
    };
    server.use(
      http.post(
        "https://auth.calendly.com/oauth/token",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            `Basic ${btoa(`${authClient.clientId}:${authClient.clientSecret}`)}`,
          );
          const body = await request.json();
          expect(body).toMatchObject({ grant_type: "refresh_token" });
          if (
            typeof body !== "object" ||
            body === null ||
            !("refresh_token" in body) ||
            typeof body.refresh_token !== "string"
          ) {
            throw new Error("Expected a refresh token request");
          }
          const next = responses[body.refresh_token];
          if (next === undefined) {
            return HttpResponse.json(
              { error: "invalid_grant" },
              { status: 400 },
            );
          }
          delete responses[body.refresh_token];
          return HttpResponse.json({ ...tokenResponse, refresh_token: next });
        },
      ),
    );
    const first = await refresh("test-calendly-refresh-1");
    expect(first.outputs.refreshToken).toBe("test-calendly-refresh-2");
    expect(first.scopes).toBeUndefined();
    const second = await refresh(first.outputs.refreshToken!);
    expect(second.outputs.refreshToken).toBe("test-calendly-refresh-3");
    await expect(refresh("test-calendly-refresh-1")).rejects.toMatchObject({
      status: 400,
      oauthError: "invalid_grant",
    });
  });

  it("rejects refresh without a replacement refresh token", async () => {
    server.use(
      http.post("https://auth.calendly.com/oauth/token", () => {
        return HttpResponse.json({
          ...tokenResponse,
          refresh_token: undefined,
        });
      }),
    );
    await expect(refresh("test-calendly-refresh-1")).rejects.toThrow();
  });

  it("preserves an explicitly empty scope grant when refreshing", async () => {
    server.use(
      http.post("https://auth.calendly.com/oauth/token", () => {
        return HttpResponse.json({ ...tokenResponse, scope: "" });
      }),
    );
    expect((await refresh("test-calendly-refresh-1")).scopes).toStrictEqual([]);
  });

  it("revokes the saved refresh token when disconnecting", async () => {
    server.use(
      http.post(
        "https://auth.calendly.com/oauth/revoke",
        async ({ request }) => {
          expect(await request.json()).toStrictEqual({
            client_id: authClient.clientId,
            client_secret: authClient.clientSecret,
            token: "test-calendly-refresh-1",
          });
          return new HttpResponse(null, { status: 200 });
        },
      ),
    );
    await expect(
      revokeConnectorAuthMethodAccessTokenWithMethod(
        {
          ...selection,
          readEnv: (name) => {
            return name === "CALENDLY_OAUTH_CLIENT_ID"
              ? authClient.clientId
              : name === "CALENDLY_OAUTH_CLIENT_SECRET"
                ? authClient.clientSecret
                : undefined;
          },
          loadInputs: () => {
            return { refreshToken: "test-calendly-refresh-1" };
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toStrictEqual({ status: "revoked" });
  });
});
