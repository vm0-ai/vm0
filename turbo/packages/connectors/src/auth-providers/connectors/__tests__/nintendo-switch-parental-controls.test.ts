import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { resolveConnectorAuthClient } from "../../../connector-auth-method";
import { server } from "../../__tests__/test-server";
import {
  NINTENDO_SWITCH_PARENTAL_CONTROLS_APP,
  NINTENDO_SWITCH_PARENTAL_CONTROLS_AUTHORIZATION_URL,
  NINTENDO_SWITCH_PARENTAL_CONTROLS_FEDERATION_URL,
  NINTENDO_SWITCH_PARENTAL_CONTROLS_LOGOUT_URL,
  NINTENDO_SWITCH_PARENTAL_CONTROLS_OWNED_DEVICES_URL,
  NINTENDO_SWITCH_PARENTAL_CONTROLS_PROFILE_URL,
  NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN_URL,
  NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN_URL,
} from "../nintendo-switch-parental-controls/api";
import { NINTENDO_SWITCH_PARENTAL_CONTROLS_PROVIDER_METHOD } from "./provider-method-fixtures";
import { providerOperationFixture } from "./provider-operation-fixture";

const NINTENDO_SESSION_TOKEN_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token";
const {
  completeConnectorExternalCodeAuthorization,
  refreshConnectorAuthProviderAccessToken,
  revokeConnectorAuthMethodAccessToken,
  startConnectorExternalCodeAuthorization,
} = providerOperationFixture({
  connectorSlug: "nintendo-switch-parental-controls",
  authMethodId: "api",
  method: NINTENDO_SWITCH_PARENTAL_CONTROLS_PROVIDER_METHOD,
});

function nintendoSwitchParentalControlsAuthClient() {
  const authClient = resolveConnectorAuthClient(
    NINTENDO_SWITCH_PARENTAL_CONTROLS_PROVIDER_METHOD.client,
    () => {
      throw new Error(
        "Nintendo Switch Parental Controls auth client should not read env",
      );
    },
  );
  if (
    !authClient ||
    authClient.clientRegistration !== "static" ||
    authClient.clientType !== "public"
  ) {
    throw new Error(
      "Missing Nintendo Switch Parental Controls public auth client",
    );
  }
  return authClient;
}

function testSignal(): AbortSignal {
  return new AbortController().signal;
}

function jwtPayload(payload: Readonly<Record<string, string>>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function startNintendoSwitchParentalControlsSession() {
  const result = await startConnectorExternalCodeAuthorization({
    connectorSlug: "nintendo-switch-parental-controls",
    authMethod: "api",
    authClient: nintendoSwitchParentalControlsAuthClient(),
  });
  const providerState = JSON.parse(result.providerState) as {
    readonly version: 1;
    readonly state: string;
    readonly codeVerifier: string;
  };
  return { result, providerState };
}

describe("Nintendo Switch Parental Controls external-code provider", () => {
  it("starts with the app client, redirect, scopes, state, and PKCE", async () => {
    const { result, providerState } =
      await startNintendoSwitchParentalControlsSession();
    const authorizationUrl = new URL(result.authorizationUrl);

    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_AUTHORIZATION_URL,
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.clientId,
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.redirectUri,
    );
    expect(authorizationUrl.searchParams.get("response_type")).toBe(
      "session_token_code",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.scopes.join(" "),
    );
    expect(authorizationUrl.searchParams.get("state")).toBe(
      providerState.state,
    );
    expect(
      authorizationUrl.searchParams.get("session_token_code_challenge"),
    ).toBe(sha256Base64Url(providerState.codeVerifier));
    expect(
      authorizationUrl.searchParams.get("session_token_code_challenge_method"),
    ).toBe("S256");
    expect(result.expiresIn).toBe(600);
  });

  it("federates a stable smart device and stores only a safe device projection", async () => {
    const { result: started, providerState } =
      await startNintendoSwitchParentalControlsSession();
    const idToken = jwtPayload({
      sub: "nintendo-account-123",
      email: "parent@example.com",
      name: "Nintendo Parent",
    });
    const captured: {
      sessionBody?: URLSearchParams;
      tokenBody?: unknown;
      profileHeaders?: Headers;
      federationBody?: unknown;
      federationHeaders?: Headers;
    } = {};

    server.use(
      http.post(
        NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN_URL,
        async ({ request }) => {
          captured.sessionBody = new URLSearchParams(await request.text());
          return HttpResponse.json({ session_token: "session-token" });
        },
      ),
      http.post(
        NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN_URL,
        async ({ request }) => {
          captured.tokenBody = await request.json();
          return HttpResponse.json({
            access_token: "account-access-token",
            expires_in: 3600,
            id_token: idToken,
            scope: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.scopes.join(" "),
            token_type: "Bearer",
          });
        },
      ),
      http.get(NINTENDO_SWITCH_PARENTAL_CONTROLS_PROFILE_URL, ({ request }) => {
        captured.profileHeaders = request.headers;
        return HttpResponse.json({ country: "US", language: "en" });
      }),
      http.post(
        NINTENDO_SWITCH_PARENTAL_CONTROLS_FEDERATION_URL,
        async ({ request }) => {
          captured.federationHeaders = request.headers;
          captured.federationBody = await request.json();
          return HttpResponse.json({
            loginInfo: {
              user: { id: "user-id" },
              smartDevice: { notificationToken: "must-not-leak" },
              ownedDevices: [
                {
                  deviceId: "switch-z",
                  label: "Bedroom",
                  device: {
                    serialNumber: "serial-must-not-leak",
                    synchronizedUnlockCode: "1111",
                  },
                  parentalControlSettingStatus: {
                    unlockCode: "2222",
                  },
                },
                {
                  deviceId: "switch-a",
                  label: "Family room",
                  pairingCode: "333333",
                },
              ],
              unconfirmedAllCopiedDevicesInfo: null,
            },
            nextStep: "COMPLETED",
          });
        },
      ),
    );

    const completed = await completeConnectorExternalCodeAuthorization({
      connectorSlug: "nintendo-switch-parental-controls",
      authMethod: "api",
      authClient: nintendoSwitchParentalControlsAuthClient(),
      providerState: started.providerState,
      code: `${NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.redirectUri}#session_token_code=session-code&state=${providerState.state}`,
      signal: testSignal(),
    });

    expect(completed).toMatchObject({
      outputs: {
        sessionToken: "session-token",
        accessToken: "account-access-token",
        idToken,
        accountId: "nintendo-account-123",
        language: "en",
      },
      expiresIn: 3600,
      scopes: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.scopes,
      userInfo: {
        id: "nintendo-account-123",
        username: "Nintendo Parent",
        email: "parent@example.com",
      },
    });
    const deviceCatalog = completed.outputs.deviceCatalog;
    const smartDeviceId = completed.outputs.smartDeviceId;
    if (
      typeof deviceCatalog !== "string" ||
      typeof smartDeviceId !== "string"
    ) {
      throw new Error("Missing Nintendo Switch Parental Controls outputs");
    }
    expect(JSON.parse(deviceCatalog)).toStrictEqual({
      version: 1,
      devices: [
        { deviceId: "switch-a", label: "Family room" },
        { deviceId: "switch-z", label: "Bedroom" },
      ],
    });
    expect(deviceCatalog).not.toMatch(
      /serial|unlock|pairing|notification|1111|2222|333333|must-not-leak/iu,
    );
    expect(smartDeviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    expect(captured.sessionBody?.get("client_id")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.clientId,
    );
    expect(captured.sessionBody?.get("session_token_code")).toBe(
      "session-code",
    );
    expect(captured.sessionBody?.get("session_token_code_verifier")).toBe(
      providerState.codeVerifier,
    );
    expect(captured.tokenBody).toStrictEqual({
      client_id: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.clientId,
      session_token: "session-token",
      grant_type: NINTENDO_SESSION_TOKEN_GRANT_TYPE,
    });
    expect(captured.profileHeaders?.get("authorization")).toBe(
      "Bearer account-access-token",
    );
    expect(captured.federationHeaders?.get("authorization")).toBe(
      `Bearer ${idToken}`,
    );
    expect(captured.federationHeaders?.get("user-agent")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.userAgent,
    );
    expect(captured.federationHeaders?.get("x-moon-app-id")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.packageId,
    );
    expect(captured.federationHeaders?.get("x-moon-os")).toBe("ANDROID");
    expect(captured.federationHeaders?.get("x-moon-timezone")).toBe("Etc/UTC");
    expect(captured.federationHeaders?.get("x-moon-smart-device-id")).toBe(
      smartDeviceId,
    );
    expect(captured.federationBody).toStrictEqual({
      smartDeviceInfo: {
        id: smartDeviceId,
        bundleId: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.packageId,
        os: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.os,
        osVersion: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.osVersion,
        modelName: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.modelName,
        timeZone: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.timeZone,
        appVersion: {
          displayedVersion:
            NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.displayedVersion,
          internalVersion:
            NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.internalVersion,
        },
        osLanguage: "en",
        appLanguage: "en",
        notificationToken: null,
      },
    });
  });

  it("refreshes both tokens and omits only a transiently unavailable catalog", async () => {
    let catalogRequests = 0;
    let tokenRequests = 0;
    let catalogHeaders: Headers | undefined;
    server.use(
      http.post(NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN_URL, () => {
        tokenRequests += 1;
        return HttpResponse.json({
          access_token: `access-token-${tokenRequests}`,
          expires_in: 1800,
          id_token: `id-token-${tokenRequests}`,
          token_type: "Bearer",
        });
      }),
      http.get(
        NINTENDO_SWITCH_PARENTAL_CONTROLS_OWNED_DEVICES_URL,
        ({ request }) => {
          catalogRequests += 1;
          catalogHeaders = request.headers;
          if (catalogRequests === 2) {
            return HttpResponse.json(
              { error: "temporarily unavailable" },
              {
                status: 503,
              },
            );
          }
          return HttpResponse.json({
            ownedDevices: [
              {
                deviceId: "switch-1",
                label: "Living room",
                device: { synchronizedUnlockCode: "must-not-leak" },
              },
            ],
          });
        },
      ),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        connectorSlug: "nintendo-switch-parental-controls",
        authMethod: "api",
        authClient: nintendoSwitchParentalControlsAuthClient(),
        inputs: {
          sessionToken: "stored-session-token",
          smartDeviceId: "stored-smart-device-id",
          language: "fr",
        },
        signal: testSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "access-token-1",
        idToken: "id-token-1",
        deviceCatalog: JSON.stringify({
          version: 1,
          devices: [{ deviceId: "switch-1", label: "Living room" }],
        }),
      },
      expiresIn: 1800,
    });
    expect(catalogHeaders?.get("authorization")).toBe("Bearer id-token-1");
    expect(catalogHeaders?.get("x-moon-app-language")).toBe("fr");
    expect(catalogHeaders?.get("x-moon-smart-device-id")).toBe(
      "stored-smart-device-id",
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        connectorSlug: "nintendo-switch-parental-controls",
        authMethod: "api",
        authClient: nintendoSwitchParentalControlsAuthClient(),
        inputs: {
          sessionToken: "stored-session-token",
          smartDeviceId: "stored-smart-device-id",
          language: "fr",
        },
        signal: testSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "access-token-2",
        idToken: "id-token-2",
      },
      expiresIn: 1800,
    });
    expect(catalogRequests).toBe(2);
  });

  it("revokes a static public client by logging out the stored smart device", async () => {
    let logoutBody: unknown;
    let logoutHeaders: Headers | undefined;
    server.use(
      http.post(NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "fresh-account-token",
          id_token: "fresh-id-token",
          token_type: "Bearer",
        });
      }),
      http.post(
        NINTENDO_SWITCH_PARENTAL_CONTROLS_LOGOUT_URL,
        async ({ request }) => {
          logoutBody = await request.json();
          logoutHeaders = request.headers;
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    await expect(
      revokeConnectorAuthMethodAccessToken({
        connectorSlug: "nintendo-switch-parental-controls",
        authMethod: "api",
        readEnv: () => {
          throw new Error("Static public revoke must not read env");
        },
        signal: testSignal(),
        loadInputs: () => {
          return {
            sessionToken: "stored-session-token",
            smartDeviceId: "stored-smart-device-id",
          };
        },
      }),
    ).resolves.toStrictEqual({ status: "revoked" });
    expect(logoutBody).toStrictEqual({
      smartDeviceId: "stored-smart-device-id",
    });
    expect(logoutHeaders?.get("authorization")).toBe("Bearer fresh-id-token");
    expect(logoutHeaders?.get("x-moon-smart-device-id")).toBe(
      "stored-smart-device-id",
    );
  });
});
