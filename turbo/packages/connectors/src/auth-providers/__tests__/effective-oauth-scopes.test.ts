import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";

import type { ConnectorAuthMethodRuntimeConfig } from "../../connector-config";
import {
  exchangeConnectorAuthCodeWithMethod,
  refreshConnectorAuthProviderAccessTokenWithMethod,
} from "../connector-auth";
import { server } from "./test-server";

const AUTH_CLIENT = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-oauth-client",
  clientSecret: "test-oauth-secret",
} as const;

function authMethod(
  scopes: readonly string[],
): ConnectorAuthMethodRuntimeConfig {
  return {
    client: AUTH_CLIENT,
    storage: {
      version: 1,
      secrets: ["TEST_ACCESS_TOKEN", "TEST_REFRESH_TOKEN"],
      variables: ["TEST_TENANT_ID"],
    },
    grant: {
      kind: "auth-code",
      callbackOrigin: "api",
      scopes: [...scopes],
      outputs: {
        accessToken: "$secrets.TEST_ACCESS_TOKEN",
        refreshToken: "$secrets.TEST_REFRESH_TOKEN",
        tenantId: "$vars.TEST_TENANT_ID",
      },
    },
    access: {
      kind: "refresh-token",
      inputs: { refreshToken: "$secrets.TEST_REFRESH_TOKEN" },
      outputs: {
        accessToken: "$secrets.TEST_ACCESS_TOKEN",
        refreshToken: "$secrets.TEST_REFRESH_TOKEN",
      },
      refreshableSecrets: ["TEST_ACCESS_TOKEN"],
      envBindings: {},
    },
    revoke: { kind: "none" },
  };
}

function mockTestOAuthProvider(scope?: string): void {
  server.use(
    http.post("https://provider.example/api/test/oauth-provider/token", () => {
      return HttpResponse.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        ...(scope === undefined ? {} : { scope }),
      });
    }),
    http.get(
      "https://provider.example/api/test/oauth-provider/userinfo",
      () => {
        return HttpResponse.json({
          id: "user-id",
          username: "Test User",
          email: "test@example.com",
        });
      },
    ),
  );
}

async function exchangeWithAuthorizationUrl(
  authorizationUrl: string | null,
  reportedScope?: string,
) {
  vi.stubEnv("OKOU_API_BACKEND_URL", "https://provider.example");
  mockTestOAuthProvider(reportedScope);
  return await exchangeConnectorAuthCodeWithMethod({
    connectorSlug: "test-oauth",
    authMethodId: "oauth",
    method: authMethod(["catalog-changed"]),
    authClient: AUTH_CLIENT,
    authorizationUrl,
    code: "authorization-code",
    redirectUri: "https://app.example/callback",
    state: "state",
    codeVerifier: undefined,
    oauthContext: undefined,
  });
}

async function refreshWithReportedScope(reportedScope?: string) {
  vi.stubEnv("OKOU_API_BACKEND_URL", "https://provider.example");
  mockTestOAuthProvider(reportedScope);
  return await refreshConnectorAuthProviderAccessTokenWithMethod(
    {
      connectorSlug: "test-oauth",
      authMethodId: "oauth",
      method: authMethod(["catalog-changed"]),
      authClient: AUTH_CLIENT,
      inputs: { refreshToken: "refresh-token" },
    },
    new AbortController().signal,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("effective OAuth scopes", () => {
  it("uses the original authorization request when the token omits scope", async () => {
    const result = await exchangeWithAuthorizationUrl(
      "https://provider.example/authorize?scope=started+supplemental",
    );

    expect(result.scopes).toEqual(["started", "supplemental"]);
  });

  it("uses a reported partial and supplemental grant exactly", async () => {
    const result = await exchangeWithAuthorizationUrl(
      "https://provider.example/authorize?scope=started+second",
      "started provider-added",
    );

    expect(result.scopes).toEqual(["started", "provider-added"]);
  });

  it("preserves an explicitly reported empty grant", async () => {
    const result = await exchangeWithAuthorizationUrl(
      "https://provider.example/authorize?scope=started",
      "",
    );

    expect(result.scopes).toEqual([]);
  });

  it("parses Slack-style user_scope requests", async () => {
    const result = await exchangeWithAuthorizationUrl(
      "https://provider.example/authorize?user_scope=users%3Aread%2Cchat%3Awrite",
    );

    expect(result.scopes).toEqual(["users:read", "chat:write"]);
  });

  it("keeps catalog scopes for legacy state without an authorization URL", async () => {
    const result = await exchangeWithAuthorizationUrl(null);

    expect(result.scopes).toEqual(["catalog-changed"]);
  });

  it("keeps provider-registered scopes when the URL has no scope parameter", async () => {
    const result = await exchangeWithAuthorizationUrl(
      "https://provider.example/authorize?state=state",
    );

    expect(result.scopes).toEqual(["catalog-changed"]);
  });
});

describe("reported OAuth refresh scopes", () => {
  it("preserves a reported refresh grant", async () => {
    const result = await refreshWithReportedScope("read provider-added");

    expect(result.scopes).toEqual(["read", "provider-added"]);
  });

  it("preserves an explicitly reported empty refresh grant", async () => {
    const result = await refreshWithReportedScope("");

    expect(result.scopes).toEqual([]);
  });

  it("omits refresh scope metadata when the provider omits scope", async () => {
    const result = await refreshWithReportedScope();

    expect(result).not.toHaveProperty("scopes");
  });
});
