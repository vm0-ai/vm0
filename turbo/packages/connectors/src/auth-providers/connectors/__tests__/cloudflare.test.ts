import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { getConnectorAuthMethodAuthCodeGrantConfig } from "../../../connector-utils";
import { server } from "../../__tests__/test-server";
import {
  buildCloudflareAuthorizationUrl,
  exchangeCloudflareCode,
  getCloudflareSecretName,
  refreshCloudflareToken,
  revokeCloudflareRefreshToken,
} from "../cloudflare/oauth";

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

function authCodeGrant() {
  return getConnectorAuthMethodAuthCodeGrantConfig("cloudflare", "oauth");
}

describe("connector/providers/cloudflare", () => {
  describe("buildCloudflareAuthorizationUrl", () => {
    it("uses the connector configured scopes", () => {
      const grant = authCodeGrant();
      const url = new URL(
        buildCloudflareAuthorizationUrl(
          grant,
          "cloudflare-client-id",
          "https://api.vm0.ai/api/connectors/cloudflare/callback",
          "test-state",
        ),
      );

      expect(`${url.origin}${url.pathname}`).toBe(
        "https://dash.cloudflare.com/oauth2/auth",
      );
      expect(url.searchParams.get("client_id")).toBe("cloudflare-client-id");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://api.vm0.ai/api/connectors/cloudflare/callback",
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("state")).toBe("test-state");
      expect(url.searchParams.get("scope")?.split(" ")).toStrictEqual(
        grant.scopes,
      );
      expect(grant.scopes).toContain("offline_access");
    });

    it("uses explicit scopes when a connector explicitly configures scopes", () => {
      const url = new URL(
        buildCloudflareAuthorizationUrl(
          {
            kind: "auth-code",
            scopes: ["workers-platform.read", "workers-platform.write"],
            outputs: {
              accessToken: "$secrets.CLOUDFLARE_ACCESS_TOKEN",
              refreshToken: "$secrets.CLOUDFLARE_REFRESH_TOKEN",
            },
          },
          "cloudflare-client-id",
          "https://api.vm0.ai/api/connectors/cloudflare/callback",
          "test-state",
        ),
      );

      expect(url.searchParams.get("scope")).toBe(
        "workers-platform.read workers-platform.write",
      );
      expect(url.searchParams.get("scope")).not.toContain("user-details.read");
    });
  });

  describe("exchangeCloudflareCode", () => {
    it("exchanges code using Basic auth and fetches user info", async () => {
      let tokenRequestAuthorization: string | null = null;
      let tokenRequestBody: URLSearchParams | undefined;
      server.use(
        http.post(
          "https://dash.cloudflare.com/oauth2/token",
          async ({ request }) => {
            tokenRequestAuthorization = request.headers.get("authorization");
            tokenRequestBody = new URLSearchParams(await request.text());
            return HttpResponse.json({
              access_token: "cloudflare-access-token",
              refresh_token: "cloudflare-refresh-token",
              expires_in: 7200,
              scope: "workers-platform.read workers-platform.write",
            });
          },
        ),
        http.get(
          "https://dash.cloudflare.com/oauth2/userinfo",
          ({ request }) => {
            expect(request.headers.get("authorization")).toBe(
              "Bearer cloudflare-access-token",
            );
            return HttpResponse.json({
              sub: "cloudflare-user-123",
              email: "cloudflare@example.com",
              name: "Cloudflare User",
            });
          },
        ),
      );

      const result = await exchangeCloudflareCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://api.vm0.ai/api/connectors/cloudflare/callback",
      );

      expect(tokenRequestAuthorization).toBe(
        `Basic ${btoa("client-id:client-secret")}`,
      );
      expect(tokenRequestBody?.get("client_secret")).toBeNull();
      expect(tokenRequestBody?.get("code")).toBe("test-code");
      expect(tokenRequestBody?.get("redirect_uri")).toBe(
        "https://api.vm0.ai/api/connectors/cloudflare/callback",
      );
      expect(result).toStrictEqual({
        accessToken: "cloudflare-access-token",
        refreshToken: "cloudflare-refresh-token",
        expiresIn: 7200,
        scopes: ["workers-platform.read", "workers-platform.write"],
        userInfo: {
          id: "cloudflare-user-123",
          username: "Cloudflare User",
          email: "cloudflare@example.com",
        },
      });
    });

    it("throws when the exchange response omits refresh token", async () => {
      server.use(
        http.post("https://dash.cloudflare.com/oauth2/token", () => {
          return HttpResponse.json({
            access_token: "cloudflare-access-token",
          });
        }),
      );

      await expect(
        exchangeCloudflareCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "test-code",
          "https://api.vm0.ai/api/connectors/cloudflare/callback",
        ),
      ).rejects.toThrow("No refresh token in Cloudflare response");
    });
  });

  describe("refreshCloudflareToken", () => {
    it("refreshes access token using Basic auth without body client secret", async () => {
      let tokenRequestAuthorization: string | null = null;
      let tokenRequestBody: URLSearchParams | undefined;
      server.use(
        http.post(
          "https://dash.cloudflare.com/oauth2/token",
          async ({ request }) => {
            tokenRequestAuthorization = request.headers.get("authorization");
            tokenRequestBody = new URLSearchParams(await request.text());
            return HttpResponse.json({
              access_token: "new-cloudflare-access-token",
              refresh_token: "new-cloudflare-refresh-token",
              expires_in: 7200,
            });
          },
        ),
      );

      const result = await refreshCloudflareToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
        testRefreshSignal(),
      );

      expect(tokenRequestAuthorization).toBe(
        `Basic ${btoa("client-id:client-secret")}`,
      );
      expect(tokenRequestBody?.get("client_secret")).toBeNull();
      expect(tokenRequestBody?.get("refresh_token")).toBe("old-refresh-token");
      expect(result).toStrictEqual({
        accessToken: "new-cloudflare-access-token",
        refreshToken: "new-cloudflare-refresh-token",
        expiresIn: 7200,
      });
    });

    it("returns null refresh token when Cloudflare does not rotate it", async () => {
      server.use(
        http.post("https://dash.cloudflare.com/oauth2/token", () => {
          return HttpResponse.json({
            access_token: "new-cloudflare-access-token",
            expires_in: 7200,
          });
        }),
      );

      await expect(
        refreshCloudflareToken(
          "client-id",
          "client-secret",
          "old-refresh-token",
          testRefreshSignal(),
        ),
      ).resolves.toStrictEqual({
        accessToken: "new-cloudflare-access-token",
        refreshToken: null,
        expiresIn: 7200,
      });
    });
  });

  describe("revokeCloudflareRefreshToken", () => {
    it("revokes the refresh token using Basic auth", async () => {
      let revokeRequestAuthorization: string | null = null;
      let revokeRequestBody: URLSearchParams | undefined;
      server.use(
        http.post(
          "https://dash.cloudflare.com/oauth2/revoke",
          async ({ request }) => {
            revokeRequestAuthorization = request.headers.get("authorization");
            revokeRequestBody = new URLSearchParams(await request.text());
            return new HttpResponse(null, { status: 200 });
          },
        ),
      );

      await revokeCloudflareRefreshToken(
        "client-id",
        "client-secret",
        "cloudflare-refresh-token",
      );

      expect(revokeRequestAuthorization).toBe(
        `Basic ${btoa("client-id:client-secret")}`,
      );
      expect(revokeRequestBody?.get("client_secret")).toBeNull();
      expect(revokeRequestBody?.get("token")).toBe("cloudflare-refresh-token");
      expect(revokeRequestBody?.get("token_type_hint")).toBe("refresh_token");
    });
  });

  describe("getCloudflareSecretName", () => {
    it("returns the expected secret name", () => {
      expect(getCloudflareSecretName()).toBe("CLOUDFLARE_ACCESS_TOKEN");
    });
  });
});
