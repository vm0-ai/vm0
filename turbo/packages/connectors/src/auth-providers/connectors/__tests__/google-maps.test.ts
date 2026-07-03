import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  connectorAuthClientIdentity,
  getConnectorAuthMethodAccessMetadata,
  getConnectorAuthMethodAuthCodeGrantConfig,
  getConnectorRefreshOutputTarget,
  resolveConnectorAuthClientForMethod,
  type StaticConfidentialConnectorAuthClient,
} from "../../../connector-utils";
import { googleMapsProvider } from "../google-maps/provider";
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

describe("connector/providers/google-maps", () => {
  describe("googleMapsProvider", () => {
    it("buildAuthUrl builds Google OAuth URL with Google Maps scopes", () => {
      const url = googleMapsProvider.grant.buildAuthUrl({
        authCodeGrant: getConnectorAuthMethodAuthCodeGrantConfig(
          "google-maps",
          "oauth",
        ),
        authClient: connectorAuthClientIdentity(testAuthClient),
        redirectUri: "https://example.com/callback",
        state: "test-state",
      });
      if (typeof url !== "string") {
        throw new Error("Expected Google Maps auth URL to be a string");
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
      expect(scopes.has("https://www.googleapis.com/auth/cloud-platform")).toBe(
        true,
      );
      expect(scopes.has("https://www.googleapis.com/auth/userinfo.email")).toBe(
        true,
      );
      expect(scopes.size).toBe(2);
    });

    it("resolves the OAuth client from Google env names", () => {
      const env: Record<string, string> = {
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
      };

      expect(
        resolveConnectorAuthClientForMethod("google-maps", "oauth", (name) => {
          return env[name];
        }),
      ).toMatchObject({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
    });

    it("declares GOOGLE_MAPS_ACCESS_TOKEN as the refresh access output", () => {
      const accessMetadata = getConnectorAuthMethodAccessMetadata(
        "google-maps",
        "oauth",
      );

      expect(
        getConnectorRefreshOutputTarget(accessMetadata, "accessToken"),
      ).toStrictEqual({
        kind: "connector-secret",
        name: "GOOGLE_MAPS_ACCESS_TOKEN",
      });
    });

    it("declares GOOGLE_MAPS_REFRESH_TOKEN as the refresh token input and output", () => {
      const accessMetadata = getConnectorAuthMethodAccessMetadata(
        "google-maps",
        "oauth",
      );

      expect(accessMetadata.inputs.refreshToken).toStrictEqual({
        valueRef: "$secrets.GOOGLE_MAPS_REFRESH_TOKEN",
        source: {
          kind: "connector-secret",
          name: "GOOGLE_MAPS_REFRESH_TOKEN",
        },
      });
      expect(
        getConnectorRefreshOutputTarget(accessMetadata, "refreshToken"),
      ).toStrictEqual({
        kind: "connector-secret",
        name: "GOOGLE_MAPS_REFRESH_TOKEN",
      });
    });

    it("exchangeCode maps Google token and user info response", async () => {
      const tokenHandler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "google-maps-access-token",
          refresh_token: "google-maps-refresh-token",
          expires_in: 3600,
          scope:
            "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email",
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

      const result = await googleMapsProvider.grant.exchangeCode({
        authCodeGrant: getConnectorAuthMethodAuthCodeGrantConfig(
          "google-maps",
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
          accessToken: "google-maps-access-token",
          refreshToken: "google-maps-refresh-token",
        },
        expiresIn: 3600,
        scopes: [
          "https://www.googleapis.com/auth/cloud-platform",
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
          access_token: "refreshed-google-maps-token",
          expires_in: 3600,
        });
      });
      server.use(handler);

      const result = await googleMapsProvider.access.refresh({
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
          accessToken: "refreshed-google-maps-token",
        },
        expiresIn: 3600,
      });
    });
  });
});
