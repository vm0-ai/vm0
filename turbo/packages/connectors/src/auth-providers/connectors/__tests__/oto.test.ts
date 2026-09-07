import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import { refreshConnectorAuthProviderAccessTokenWithMethod } from "../../connector-auth";
import { CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS } from "../../provider-capabilities";
import { ProviderResponseError } from "../../provider-error";
import { server } from "../../__tests__/test-server";
import { fetchOtoAccessToken } from "../oto/api-token";

const OTO_REFRESH_TOKEN_URL = "https://api.tryoto.com/rest/v2/refreshToken";

const OTO_PROVIDER_METHOD = {
  storage: {
    version: 1,
    secrets: ["OTO_REFRESH_TOKEN", "OTO_ACCESS_TOKEN"],
    variables: [],
  },
  grant: {
    kind: "manual",
    fields: {
      refreshToken: {
        publicId: "refreshToken",
        label: "Refresh Token",
        required: true,
        storage: "secret",
      },
    },
  },
  access: {
    kind: "refresh-token",
    envBindings: {
      OTO_TOKEN: "$secrets.OTO_ACCESS_TOKEN",
    },
    inputs: {
      refreshToken: "$secrets.OTO_REFRESH_TOKEN",
    },
    outputs: {
      accessToken: "$secrets.OTO_ACCESS_TOKEN",
      refreshToken: "$secrets.OTO_REFRESH_TOKEN",
    },
    refreshableSecrets: ["OTO_ACCESS_TOKEN"],
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodRuntimeConfig;

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("connector/providers/oto", () => {
  it("exchanges the official refresh token JSON contract", async () => {
    let contentType: string | null = null;
    let accept: string | null = null;
    let body = "";
    server.use(
      http.post(OTO_REFRESH_TOKEN_URL, async ({ request }) => {
        contentType = request.headers.get("content-type");
        accept = request.headers.get("accept");
        body = await request.text();
        return HttpResponse.json({
          access_token: "oto-access-token",
          refresh_token: "oto-rotated-refresh-token",
          success: true,
          token_type: "Bearer",
          expires_in: "3600",
        });
      }),
    );

    await expect(
      fetchOtoAccessToken(
        { refreshToken: "oto-refresh-token" },
        testRefreshSignal(),
      ),
    ).resolves.toEqual({
      accessToken: "oto-access-token",
      refreshToken: "oto-rotated-refresh-token",
      expiresIn: 3600,
    });
    expect(contentType).toContain("application/json");
    expect(accept).toBe("application/json");
    expect(JSON.parse(body)).toEqual({ refresh_token: "oto-refresh-token" });
  });

  it("is registered as an executable refresh-token provider", async () => {
    let requestCount = 0;
    server.use(
      http.post(OTO_REFRESH_TOKEN_URL, () => {
        requestCount += 1;
        return HttpResponse.json({
          access_token: "oto-access-token",
          success: true,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }),
    );

    const registration = CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS.find(
      (entry) => {
        return (
          entry.connectorSlug === "oto" && entry.authMethodId === "api-token"
        );
      },
    );
    expect(registration?.contract.access).toEqual({
      kind: "refresh-token",
      inputNames: ["refreshToken"],
      outputNames: ["accessToken", "refreshToken"],
      platformSecrets: [],
    });

    await expect(
      refreshConnectorAuthProviderAccessTokenWithMethod(
        {
          connectorSlug: "oto",
          authMethodId: "api-token",
          method: OTO_PROVIDER_METHOD,
          inputs: { refreshToken: "oto-refresh-token" },
        },
        testRefreshSignal(),
      ),
    ).resolves.toEqual({
      outputs: {
        accessToken: "oto-access-token",
        refreshToken: "oto-refresh-token",
      },
      expiresIn: 3600,
    });
    expect(requestCount).toBe(1);
  });

  it("rejects malformed successful responses without exposing credentials", async () => {
    server.use(
      http.post(OTO_REFRESH_TOKEN_URL, () => {
        return HttpResponse.json({
          success: true,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }),
    );

    await expect(
      fetchOtoAccessToken(
        { refreshToken: "oto-refresh-token" },
        testRefreshSignal(),
      ),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });
});
