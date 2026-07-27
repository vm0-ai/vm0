import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  connectorAuthClientIdentity,
  type StaticConfidentialConnectorAuthClient,
} from "../../../connector-auth-method";
import { youtubeProvider } from "../youtube/provider";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const YOUTUBE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;
const testAuthClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-client",
  clientSecret: "test-client-secret",
} satisfies StaticConfidentialConnectorAuthClient;
const AUTH_CODE_GRANT = authCodeGrantFixture(YOUTUBE_OAUTH_SCOPES);

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("connector/providers/youtube", () => {
  describe("youtubeProvider", () => {
    it("buildAuthUrl builds Google OAuth URL with YouTube scopes", () => {
      const url = youtubeProvider.grant.buildAuthUrl({
        authCodeGrant: AUTH_CODE_GRANT,
        authClient: connectorAuthClientIdentity(testAuthClient),
        redirectUri: "https://example.com/callback",
        state: "test-state",
      });
      if (typeof url !== "string") {
        throw new Error("Expected YouTube auth URL to be a string");
      }
      const params = new URL(url).searchParams;

      expect(url).toContain("client_id=test-client");
      expect(url).toContain(
        "redirect_uri=" + encodeURIComponent("https://example.com/callback"),
      );
      expect(url).toContain("state=test-state");
      expect(url).toContain("response_type=code");
      expect(url).toContain("access_type=offline");
      expect(url).toContain("prompt=consent");
      expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
      expect(params.get("scope")?.split(" ")).toStrictEqual([
        ...YOUTUBE_OAUTH_SCOPES,
      ]);
    });

    it("exchangeCode maps Google token and user info response", async () => {
      const tokenHandler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "youtube-access-token",
          refresh_token: "youtube-refresh-token",
          expires_in: 3600,
          scope: YOUTUBE_OAUTH_SCOPES.join(" "),
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

      const result = await youtubeProvider.grant.exchangeCode({
        authCodeGrant: AUTH_CODE_GRANT,
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
          accessToken: "youtube-access-token",
          refreshToken: "youtube-refresh-token",
        },
        expiresIn: 3600,
        scopes: [...YOUTUBE_OAUTH_SCOPES],
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
          access_token: "refreshed-youtube-token",
          expires_in: 3600,
        });
      });
      server.use(handler);

      const result = await youtubeProvider.access.refresh({
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
          accessToken: "refreshed-youtube-token",
        },
        expiresIn: 3600,
      });
    });

    it("revokes the stored refresh token with Google", async () => {
      let requestBody = "";
      const handler = http.post(REVOKE_URL, async ({ request }) => {
        requestBody = await request.text();
        return new HttpResponse(null, { status: 200 });
      });
      server.use(handler);

      await youtubeProvider.revoke.revokeToken({
        authClient: {
          ...testAuthClient,
          clientId: "client-id",
          clientSecret: "client-secret",
        },
        inputs: {
          refreshToken: "youtube-refresh-token",
        },
        signal: testRefreshSignal(),
      });

      expect(new URLSearchParams(requestBody).get("token")).toBe(
        "youtube-refresh-token",
      );
    });
  });
});
