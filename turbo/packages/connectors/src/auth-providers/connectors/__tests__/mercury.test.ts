import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { getConnectorAuthMethodAuthCodeGrantConfig } from "../../../connector-utils";
import {
  buildMercuryAuthorizationUrl,
  exchangeMercuryCode,
  refreshMercuryToken,
} from "../mercury/oauth";
import { server } from "../../__tests__/test-server";

const EXPECTED_CLIENT_AUTH = `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`;

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

function authCodeGrant() {
  return getConnectorAuthMethodAuthCodeGrantConfig("mercury", "oauth");
}

function useSandboxEnvironment(): void {
  vi.stubEnv("MERCURY_OAUTH_ENVIRONMENT", "sandbox");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connector/providers/mercury", () => {
  describe("buildMercuryAuthorizationUrl", () => {
    it("builds a production URL requesting every granted scope", () => {
      const url = buildMercuryAuthorizationUrl(
        authCodeGrant(),
        "test-client-id",
        "https://example.com/callback",
        "test-state",
      );

      expect(url.startsWith("https://oauth2.mercury.com/oauth2/auth?")).toBe(
        true,
      );
      expect(url).toContain("client_id=test-client-id");
      expect(url).toContain(
        "redirect_uri=" + encodeURIComponent("https://example.com/callback"),
      );
      expect(url).toContain("response_type=code");
      expect(url).toContain("state=test-state");
      expect(url).toContain("scope=openid+read+offline_access");
    });

    it("builds a sandbox URL when MERCURY_OAUTH_ENVIRONMENT is sandbox", () => {
      useSandboxEnvironment();

      const url = buildMercuryAuthorizationUrl(
        authCodeGrant(),
        "test-client-id",
        "https://example.com/callback",
        "test-state",
      );

      expect(
        url.startsWith("https://oauth2-sandbox.mercury.com/oauth2/auth?"),
      ).toBe(true);
    });
  });

  describe("exchangeMercuryCode", () => {
    it("authenticates with HTTP Basic and returns token plus account identity", async () => {
      let authorization: string | null = null;
      let body = "";
      const tokenHandler = http.post(
        "https://oauth2.mercury.com/oauth2/token",
        async ({ request }) => {
          authorization = request.headers.get("Authorization");
          body = await request.text();
          return HttpResponse.json({
            access_token: "mercury-access-token",
            refresh_token: "mercury-refresh-token",
            expires_in: 3600,
            scope: "openid read offline_access",
          });
        },
      );
      const accountsHandler = http.get(
        "https://api.mercury.com/api/v1/accounts",
        () => {
          return HttpResponse.json({
            accounts: [{ id: "account-123", name: "Max & Zoe, Inc." }],
          });
        },
      );
      server.use(tokenHandler, accountsHandler);

      const result = await exchangeMercuryCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
      );

      expect(authorization).toBe(EXPECTED_CLIENT_AUTH);
      expect(body).not.toContain("client_secret");
      expect(result.accessToken).toBe("mercury-access-token");
      expect(result.refreshToken).toBe("mercury-refresh-token");
      expect(result.expiresIn).toBe(3600);
      expect(result.scopes).toEqual(["openid", "read", "offline_access"]);
      expect(result.userInfo.id).toBe("account-123");
      expect(result.userInfo.username).toBe("Max & Zoe, Inc.");
    });

    it("uses the sandbox token and accounts endpoints in sandbox mode", async () => {
      useSandboxEnvironment();
      const tokenHandler = http.post(
        "https://oauth2-sandbox.mercury.com/oauth2/token",
        () => {
          return HttpResponse.json({
            access_token: "sandbox-access-token",
            scope: "openid read offline_access",
          });
        },
      );
      const accountsHandler = http.get(
        "https://api-sandbox.mercury.com/api/v1/accounts",
        () => {
          return HttpResponse.json({
            accounts: [{ id: "sandbox-account", name: "Sandbox Co" }],
          });
        },
      );
      server.use(tokenHandler, accountsHandler);

      const result = await exchangeMercuryCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
      );

      expect(result.accessToken).toBe("sandbox-access-token");
      expect(result.userInfo.id).toBe("sandbox-account");
    });

    it("throws when Mercury rejects the client credentials", async () => {
      const handler = http.post(
        "https://oauth2.mercury.com/oauth2/token",
        () => {
          return HttpResponse.json({
            error: "invalid_client",
            error_description: "Client authentication failed",
          });
        },
      );
      server.use(handler);

      await expect(
        exchangeMercuryCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Client authentication failed");
    });
  });

  describe("refreshMercuryToken", () => {
    it("authenticates with HTTP Basic and returns the rotated tokens", async () => {
      let authorization: string | null = null;
      let body = "";
      const handler = http.post(
        "https://oauth2.mercury.com/oauth2/token",
        async ({ request }) => {
          authorization = request.headers.get("Authorization");
          body = await request.text();
          return HttpResponse.json({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          });
        },
      );
      server.use(handler);

      const result = await refreshMercuryToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
        testRefreshSignal(),
      );

      expect(authorization).toBe(EXPECTED_CLIENT_AUTH);
      expect(body).toContain("refresh_token=old-refresh-token");
      expect(body).not.toContain("client_secret");
      expect(result.accessToken).toBe("new-access-token");
      expect(result.refreshToken).toBe("new-refresh-token");
    });
  });
});
