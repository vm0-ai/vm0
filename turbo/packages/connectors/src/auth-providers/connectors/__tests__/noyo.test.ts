import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import { refreshConnectorAuthProviderAccessTokenWithMethod } from "../../connector-auth";
import { ProviderResponseError } from "../../provider-error";
import { server } from "../../__tests__/test-server";

const NOYO_PROVIDER_METHOD = {
  storage: {
    version: 1,
    secrets: ["NOYO_CLIENT_SECRET", "NOYO_ACCESS_TOKEN"],
    variables: [
      "NOYO_FULFILLMENT_HOST",
      "NOYO_TRACKING_HOST",
      "NOYO_CLIENT_ID",
    ],
  },
  grant: {
    kind: "manual",
    fields: {
      NOYO_FULFILLMENT_HOST: {
        publicId: "fulfillmentHost",
        label: "Fulfillment API host",
        required: true,
        storage: "variable",
      },
      NOYO_TRACKING_HOST: {
        publicId: "trackingHost",
        label: "Tracking API host",
        required: true,
        storage: "variable",
      },
      NOYO_CLIENT_ID: {
        publicId: "clientId",
        label: "Client ID",
        required: true,
        storage: "variable",
      },
      NOYO_CLIENT_SECRET: {
        publicId: "clientSecret",
        label: "Client Secret",
        required: true,
        storage: "secret",
      },
    },
  },
  access: {
    kind: "refresh-token",
    envBindings: {
      NOYO_ACCESS_TOKEN: "$secrets.NOYO_ACCESS_TOKEN",
      NOYO_FULFILLMENT_HOST: "$vars.NOYO_FULFILLMENT_HOST",
      NOYO_TRACKING_HOST: "$vars.NOYO_TRACKING_HOST",
    },
    inputs: {
      clientId: "$vars.NOYO_CLIENT_ID",
      clientSecret: "$secrets.NOYO_CLIENT_SECRET",
    },
    outputs: { accessToken: "$secrets.NOYO_ACCESS_TOKEN" },
    refreshableSecrets: ["NOYO_ACCESS_TOKEN"],
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodRuntimeConfig;

describe("connector/providers/noyo", () => {
  it("refreshes through the catalog contract with expiry in seconds", async () => {
    let authorization: string | null = null;
    let contentType: string | null = null;
    let body: unknown;
    server.use(
      http.post(
        "https://accounts.noyo.com/auth/public/token",
        async ({ request }) => {
          authorization = request.headers.get("authorization");
          contentType = request.headers.get("content-type");
          body = await request.json();
          return HttpResponse.json({
            access_token: "noyo-token",
            expires_in: 864000,
            token_type: "Bearer",
          });
        },
      ),
    );

    await expect(
      refreshConnectorAuthProviderAccessTokenWithMethod(
        {
          connectorSlug: "noyo",
          authMethodId: "api-token",
          method: NOYO_PROVIDER_METHOD,
          inputs: { clientId: "client-id", clientSecret: "client-secret" },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      outputs: { accessToken: "noyo-token" },
      expiresIn: 864,
    });
    expect(authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(contentType).toBe("application/json");
    expect(body).toEqual({ grant_type: "client_credentials" });
  });

  it.each([
    { label: "malformed JSON", body: "private-provider-response" },
    {
      label: "an invalid token payload",
      body: JSON.stringify({ access_token: "private-provider-token" }),
    },
  ])("classifies $label as an upstream response failure", async ({ body }) => {
    server.use(
      http.post("https://accounts.noyo.com/auth/public/token", () => {
        return new HttpResponse(body, {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const refresh = refreshConnectorAuthProviderAccessTokenWithMethod(
      {
        connectorSlug: "noyo",
        authMethodId: "api-token",
        method: NOYO_PROVIDER_METHOD,
        inputs: { clientId: "client-id", clientSecret: "client-secret" },
      },
      new AbortController().signal,
    );
    await expect(refresh).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(refresh).rejects.toHaveProperty(
      "message",
      "Invalid Noyo access token response",
    );
  });
});
