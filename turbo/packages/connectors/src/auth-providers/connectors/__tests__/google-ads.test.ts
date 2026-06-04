import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  connectorAuthClientIdentity,
  getConnectorAuthMethodAuthCodeGrantConfig,
  getConnectorAuthMethodAccessMetadata,
  getConnectorRefreshOutputSecretName,
  resolveConnectorAuthClientForMethod,
  type StaticConfidentialConnectorAuthClient,
} from "../../../connector-utils";
import { googleAdsProvider } from "../google-ads/provider";
import { server } from "../../__tests__/test-server";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const testAuthClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-client",
  clientSecret: "test-client-secret",
} satisfies StaticConfidentialConnectorAuthClient;

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("connector/providers/google-ads", () => {
  describe("googleAdsProvider", () => {
    it("buildAuthUrl builds Google OAuth URL with Google Ads and userinfo scopes", () => {
      const url = googleAdsProvider.grant.buildAuthUrl({
        authCodeGrant: getConnectorAuthMethodAuthCodeGrantConfig(
          "google-ads",
          "oauth",
        ),
        authClient: connectorAuthClientIdentity(testAuthClient),
        redirectUri: "https://example.com/callback",
        state: "test-state",
      });
      if (typeof url !== "string") {
        throw new Error("Expected Google Ads auth URL to be a string");
      }
      const params = new URL(url).searchParams;
      const scopes = new Set(params.get("scope")?.split(" ") ?? []);

      expect(url).toContain("client_id=test-client");
      expect(url).toContain(
        "redirect_uri=" + encodeURIComponent("https://example.com/callback"),
      );
      expect(url).toContain("state=test-state");
      expect(url).toContain("response_type=code");
      expect(url).toContain("access_type=offline");
      expect(url).toContain("prompt=consent");
      expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
      expect(scopes.has("https://www.googleapis.com/auth/adwords")).toBe(true);
      expect(scopes.has("https://www.googleapis.com/auth/userinfo.email")).toBe(
        true,
      );
    });

    it("resolves the OAuth client from Google env names", () => {
      const env: Record<string, string> = {
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
      };

      expect(
        resolveConnectorAuthClientForMethod("google-ads", "oauth", (name) => {
          return env[name];
        }),
      ).toMatchObject({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
    });

    it("declares GOOGLE_ADS_ACCESS_TOKEN as the refresh access output", () => {
      const accessMetadata = getConnectorAuthMethodAccessMetadata(
        "google-ads",
        "oauth",
      );

      expect(
        getConnectorRefreshOutputSecretName(accessMetadata, "accessToken"),
      ).toBe("GOOGLE_ADS_ACCESS_TOKEN");
    });

    it("declares GOOGLE_ADS_REFRESH_TOKEN as the refresh token input and output", () => {
      const accessMetadata = getConnectorAuthMethodAccessMetadata(
        "google-ads",
        "oauth",
      );

      expect(accessMetadata.inputs.refreshToken).toStrictEqual({
        valueRef: "$secrets.GOOGLE_ADS_REFRESH_TOKEN",
        source: {
          kind: "connector-secret",
          name: "GOOGLE_ADS_REFRESH_TOKEN",
        },
      });
      expect(
        getConnectorRefreshOutputSecretName(accessMetadata, "refreshToken"),
      ).toBe("GOOGLE_ADS_REFRESH_TOKEN");
    });

    it("refreshToken is defined (uses shared Google token refresh)", () => {
      expect(googleAdsProvider.access.kind).toBe("refresh-token");
    });

    it("exchangeCode maps Google token and user info response", async () => {
      const tokenHandler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "google-ads-access-token",
          refresh_token: "google-ads-refresh-token",
          expires_in: 3600,
          scope:
            "https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/userinfo.email",
        });
      });
      const userInfoHandler = http.get(USER_INFO_URL, () => {
        return HttpResponse.json({
          id: "google-user-123",
          name: "Ada Lovelace",
          email: "ada@example.com",
        });
      });
      server.use(tokenHandler, userInfoHandler);

      const result = await googleAdsProvider.grant.exchangeCode({
        authCodeGrant: getConnectorAuthMethodAuthCodeGrantConfig(
          "google-ads",
          "oauth",
        ),
        authClient: {
          ...testAuthClient,
          clientId: "client-id",
          clientSecret: "client-secret",
        },
        code: "auth-code",
        redirectUri: "https://example.com/callback",
      });

      expect(result).toEqual({
        outputs: {
          accessToken: "google-ads-access-token",
          refreshToken: "google-ads-refresh-token",
        },
        expiresIn: 3600,
        scopes: [
          "https://www.googleapis.com/auth/adwords",
          "https://www.googleapis.com/auth/userinfo.email",
        ],
        userInfo: {
          id: "google-user-123",
          username: "Ada Lovelace",
          email: "ada@example.com",
        },
      });
    });

    it("refresh delegates to the shared Google refresh flow", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "refreshed-google-ads-token",
          expires_in: 3600,
        });
      });
      server.use(handler);

      const { access } = googleAdsProvider;

      const result = await access.refresh({
        authClient: {
          ...testAuthClient,
          clientId: "client-id",
          clientSecret: "client-secret",
        },
        inputs: {
          refreshToken: "refresh-token",
        },
        signal: testRefreshSignal(),
      });

      expect(result).toEqual({
        outputs: {
          accessToken: "refreshed-google-ads-token",
        },
        expiresIn: 3600,
      });
    });
  });
});
