import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import {
  buildMercuryAuthorizationUrl,
  exchangeMercuryCode,
  refreshMercuryToken,
} from "../mercury/oauth";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const EXPECTED_CLIENT_AUTH = `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`;
const PKCE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

function authCodeGrant() {
  return authCodeGrantFixture(["read", "offline_access"]);
}

function useSandboxEnvironment(): void {
  vi.stubEnv("MERCURY_OAUTH_ENVIRONMENT", "sandbox");
}

/**
 * RFC 7636 S256 transform, so the test proves the verifier replayed at token
 * exchange is the one behind the challenge sent at authorization.
 */
async function s256Challenge(codeVerifier: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return Buffer.from(hash).toString("base64url");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connector/providers/mercury", () => {
  describe("buildMercuryAuthorizationUrl", () => {
    it("builds a production URL requesting every configured scope with a PKCE challenge", async () => {
      const url = await buildMercuryAuthorizationUrl(
        authCodeGrant(),
        "test-client-id",
        "https://example.com/callback",
        "test-state",
      );

      expect(url.startsWith("https://oauth2.mercury.com/oauth2/auth?")).toBe(
        true,
      );
      const params = new URL(url).searchParams;
      expect(params.get("client_id")).toBe("test-client-id");
      expect(params.get("redirect_uri")).toBe("https://example.com/callback");
      expect(params.get("response_type")).toBe("code");
      expect(params.get("state")).toBe("test-state");
      expect(params.get("scope")?.split(" ")).toEqual([
        ...authCodeGrant().scopes,
      ]);
      expect(params.get("code_challenge")).toMatch(PKCE_VALUE_PATTERN);
      expect(params.get("code_challenge_method")).toBe("S256");
    });

    it("builds a sandbox URL when MERCURY_OAUTH_ENVIRONMENT is sandbox", async () => {
      useSandboxEnvironment();

      const url = await buildMercuryAuthorizationUrl(
        authCodeGrant(),
        "test-client-id",
        "https://example.com/callback",
        "test-state",
      );

      expect(
        url.startsWith("https://oauth2-sandbox.mercury.com/oauth2/auth?"),
      ).toBe(true);
    });

    it("fails when MERCURY_OAUTH_ENVIRONMENT is not a known environment", async () => {
      vi.stubEnv("MERCURY_OAUTH_ENVIRONMENT", "snadbox");

      await expect(
        buildMercuryAuthorizationUrl(
          authCodeGrant(),
          "test-client-id",
          "https://example.com/callback",
          "test-state",
        ),
      ).rejects.toThrow(
        'MERCURY_OAUTH_ENVIRONMENT must be "sandbox" or "production"',
      );
    });
  });

  describe("exchangeMercuryCode", () => {
    it("authenticates with HTTP Basic, replays the PKCE verifier, and returns token plus organization identity", async () => {
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
            scope: "read offline_access",
          });
        },
      );
      const organizationHandler = http.get(
        "https://api.mercury.com/api/v1/organization",
        () => {
          return HttpResponse.json({
            organization: {
              id: "organization-123",
              legalBusinessName: "Max & Zoe, Inc.",
            },
          });
        },
      );
      server.use(tokenHandler, organizationHandler);
      const authorizationUrl = await buildMercuryAuthorizationUrl(
        authCodeGrant(),
        "client-id",
        "https://example.com/callback",
        "test-state",
      );

      const result = await exchangeMercuryCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
        "test-state",
      );

      expect(authorization).toBe(EXPECTED_CLIENT_AUTH);
      const tokenBody = new URLSearchParams(body);
      expect(tokenBody.get("client_secret")).toBeNull();
      expect(tokenBody.get("grant_type")).toBe("authorization_code");
      expect(tokenBody.get("code")).toBe("test-code");
      expect(tokenBody.get("redirect_uri")).toBe(
        "https://example.com/callback",
      );
      const codeVerifier = tokenBody.get("code_verifier");
      expect(codeVerifier).toMatch(PKCE_VALUE_PATTERN);
      expect(await s256Challenge(codeVerifier ?? "")).toBe(
        new URL(authorizationUrl).searchParams.get("code_challenge"),
      );
      expect(result.accessToken).toBe("mercury-access-token");
      expect(result.refreshToken).toBe("mercury-refresh-token");
      expect(result.expiresIn).toBe(3600);
      expect(result.scopes).toEqual(["read", "offline_access"]);
      expect(result.userInfo.id).toBe("organization-123");
      expect(result.userInfo.username).toBe("Max & Zoe, Inc.");
    });

    it("uses the sandbox token and organization endpoints in sandbox mode", async () => {
      useSandboxEnvironment();
      const tokenHandler = http.post(
        "https://oauth2-sandbox.mercury.com/oauth2/token",
        () => {
          return HttpResponse.json({
            access_token: "sandbox-access-token",
            scope: "read offline_access",
          });
        },
      );
      const organizationHandler = http.get(
        "https://api-sandbox.mercury.com/api/v1/organization",
        () => {
          return HttpResponse.json({
            organization: {
              id: "sandbox-organization",
              legalBusinessName: "Sandbox Co",
            },
          });
        },
      );
      server.use(tokenHandler, organizationHandler);

      const result = await exchangeMercuryCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
        "test-state",
      );

      expect(result.accessToken).toBe("sandbox-access-token");
      expect(result.userInfo.id).toBe("sandbox-organization");
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
          "test-state",
        ),
      ).rejects.toThrow("Client authentication failed");
    });
  });

  describe("refreshMercuryToken", () => {
    it("authenticates with HTTP Basic, repeats the granted scope, and returns the rotated tokens", async () => {
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
      const refreshBody = new URLSearchParams(body);
      expect(refreshBody.get("grant_type")).toBe("refresh_token");
      expect(refreshBody.get("refresh_token")).toBe("old-refresh-token");
      expect(refreshBody.get("scope")).toBe("read offline_access");
      expect(refreshBody.get("client_secret")).toBeNull();
      expect(result.accessToken).toBe("new-access-token");
      expect(result.refreshToken).toBe("new-refresh-token");
    });
  });
});
