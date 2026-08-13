import { Buffer } from "node:buffer";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { resolveConnectorAuthClient } from "../../../connector-auth-method";
import { isOAuthProviderHttpError } from "../../oauth/error";
import { server } from "../../__tests__/test-server";
import {
  PLAYSTATION_AUTH_BASE_URL,
  PLAYSTATION_NPSSO_URL,
  PLAYSTATION_PROFILE_USERS_URL,
  PLAYSTATION_REDIRECT_URI,
  PLAYSTATION_WEB_SESSION_CALLBACK_URL,
  PLAYSTATION_WEB_SESSION_SIGNIN_URL,
} from "../playstation/api";
import { PLAYSTATION_PROVIDER_METHOD } from "./provider-method-fixtures";
import { providerOperationFixture } from "./provider-operation-fixture";

const PLAYSTATION_TOKEN_URL = `${PLAYSTATION_AUTH_BASE_URL}/token`;
const PLAYSTATION_AUTHORIZE_URL = `${PLAYSTATION_AUTH_BASE_URL}/authorize`;
const PLAYSTATION_CLIENT_ID = "09515159-7237-4370-9b40-3806e67c0891";
const PLAYSTATION_CLIENT_SECRET = "ucPjka5tntB2KqsP";
const PLAYSTATION_CLIENT_BASIC_AUTH = `Basic ${Buffer.from(
  `${PLAYSTATION_CLIENT_ID}:${PLAYSTATION_CLIENT_SECRET}`,
).toString("base64")}`;
const {
  completeConnectorExternalCodeAuthorization,
  refreshConnectorAuthProviderAccessToken,
  startConnectorExternalCodeAuthorization,
} = providerOperationFixture({
  connectorSlug: "playstation",
  authMethodId: "api",
  method: PLAYSTATION_PROVIDER_METHOD,
});

function playstationAuthClient() {
  const authClient = resolveConnectorAuthClient(
    PLAYSTATION_PROVIDER_METHOD.client,
    () => {
      throw new Error("PlayStation auth client should not read env");
    },
  );
  if (
    !authClient ||
    authClient.clientRegistration !== "static" ||
    authClient.clientType !== "public" ||
    !("clientId" in authClient)
  ) {
    throw new Error("Missing PlayStation public auth client");
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

function mockPlaystationProfile(): void {
  server.use(
    http.get(
      `${PLAYSTATION_PROFILE_USERS_URL}/psn-account-123/profiles`,
      ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer playstation-access-token",
        );
        return HttpResponse.json({
          accountId: "psn-account-123",
          onlineId: "vm0-player",
        });
      },
    ),
  );
}

function playstationWebAuthorizeUrl(): string {
  const url = new URL(PLAYSTATION_AUTHORIZE_URL);
  url.searchParams.set("client_id", "playstation-web-client");
  url.searchParams.set("redirect_uri", PLAYSTATION_WEB_SESSION_CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "web:core");
  return url.toString();
}

function mockPlaystationWebSession(args?: {
  readonly mobileAuthorize?: (request: Request) => Response;
  readonly finalWebSessionToken?: string | null;
}): void {
  server.use(
    http.get(PLAYSTATION_WEB_SESSION_SIGNIN_URL, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://store.playstation.com/",
      );
      expect(url.searchParams.get("smcid")).toBe("web:store");
      expect(request.headers.get("user-agent")).toContain("Chrome/");
      const headers = new Headers({ location: playstationWebAuthorizeUrl() });
      headers.append(
        "set-cookie",
        "pdccws_p=playstation-web-session-initial; Path=/; HttpOnly; Secure",
      );
      headers.append("set-cookie", "bm_sz=playstation-edge-cookie; Path=/");
      return new HttpResponse(null, { status: 302, headers });
    }),
    http.get(PLAYSTATION_AUTHORIZE_URL, ({ request }) => {
      const url = new URL(request.url);
      if (
        url.searchParams.get("redirect_uri") ===
        PLAYSTATION_WEB_SESSION_CALLBACK_URL
      ) {
        expect(request.headers.get("cookie")).toBe("npsso=test-npsso");
        const callbackUrl = new URL(PLAYSTATION_WEB_SESSION_CALLBACK_URL);
        callbackUrl.searchParams.set("code", "playstation-web-access-code");
        callbackUrl.searchParams.set("state", "playstation-web-state");
        return new HttpResponse(null, {
          status: 302,
          headers: { location: callbackUrl.toString() },
        });
      }
      if (!args?.mobileAuthorize) {
        throw new Error("Unexpected PlayStation mobile authorization request");
      }
      return args.mobileAuthorize(request);
    }),
    http.get(PLAYSTATION_WEB_SESSION_CALLBACK_URL, ({ request }) => {
      const cookie = request.headers.get("cookie");
      expect(cookie).toContain("pdccws_p=playstation-web-session-initial");
      expect(cookie).toContain("bm_sz=playstation-edge-cookie");
      const headers = new Headers();
      const finalWebSessionToken =
        args?.finalWebSessionToken === undefined
          ? "playstation-web-session-token"
          : args.finalWebSessionToken;
      if (finalWebSessionToken !== null) {
        headers.append(
          "set-cookie",
          `pdccws_p=${finalWebSessionToken}; Path=/; HttpOnly; Secure`,
        );
      }
      return new HttpResponse(null, { status: 200, headers });
    }),
  );
}

function mockPlaystationGrant(args?: {
  readonly finalWebSessionToken?: string | null;
}): void {
  mockPlaystationWebSession({
    finalWebSessionToken: args?.finalWebSessionToken,
    mobileAuthorize: () => {
      return new HttpResponse(null, {
        status: 302,
        headers: {
          location:
            "com.playstation.PlayStationApp://redirect/?code=psn-access-code&cid=cid",
        },
      });
    },
  });
  server.use(
    http.post(PLAYSTATION_TOKEN_URL, () => {
      return HttpResponse.json({
        access_token: "playstation-access-token",
        expires_in: 3600,
        id_token: jwtPayload({ sub: "psn-account-123" }),
        refresh_token: "playstation-refresh-token",
        refresh_token_expires_in: 5184000,
        scope: "psn:mobile.v2.core psn:clientapp",
        token_type: "bearer",
      });
    }),
  );
  mockPlaystationProfile();
}

async function expectInvalidPlaystationNpssoCodeRejected(
  code: string,
): Promise<void> {
  let authorizeRequestCount = 0;
  server.use(
    http.get(PLAYSTATION_AUTHORIZE_URL, () => {
      authorizeRequestCount += 1;
      return new HttpResponse(null, { status: 302 });
    }),
  );

  await expect(
    completeConnectorExternalCodeAuthorization({
      connectorSlug: "playstation",
      authMethod: "api",
      authClient: playstationAuthClient(),
      providerState: JSON.stringify({ version: 1 }),
      code,
      signal: testSignal(),
    }),
  ).rejects.toSatisfy((error: unknown) => {
    return (
      isOAuthProviderHttpError(error) &&
      error.status === 400 &&
      error.oauthError === "invalid_grant"
    );
  });
  expect(authorizeRequestCount).toBe(0);
}

describe("PlayStation external-code provider", () => {
  it("starts by opening the PlayStation NPSSO cookie page", async () => {
    const result = await startConnectorExternalCodeAuthorization({
      connectorSlug: "playstation",
      authMethod: "api",
      authClient: playstationAuthClient(),
    });

    expect(result).toStrictEqual({
      authorizationUrl: PLAYSTATION_NPSSO_URL,
      providerState: JSON.stringify({ version: 1 }),
      expiresIn: 600,
    });
  });

  it("exchanges NPSSO for tokens and maps PlayStation identity", async () => {
    const captured: {
      authorizeUrl?: URL;
      tokenRequestAuthorization?: string | null;
      tokenRequestBody?: URLSearchParams;
    } = {};
    mockPlaystationWebSession({
      mobileAuthorize: (request) => {
        captured.authorizeUrl = new URL(request.url);
        expect(request.headers.get("cookie")).toBe("npsso=test-npsso");
        return new HttpResponse(null, {
          status: 302,
          headers: {
            location:
              "com.playstation.PlayStationApp://redirect/?code=psn-access-code&cid=cid",
          },
        });
      },
    });
    server.use(
      http.post(PLAYSTATION_TOKEN_URL, async ({ request }) => {
        captured.tokenRequestAuthorization =
          request.headers.get("authorization");
        captured.tokenRequestBody = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: "playstation-access-token",
          expires_in: 3600,
          id_token: jwtPayload({ sub: "psn-account-123" }),
          refresh_token: "playstation-refresh-token",
          refresh_token_expires_in: 5184000,
          scope: "psn:mobile.v2.core psn:clientapp",
          token_type: "bearer",
        });
      }),
    );
    mockPlaystationProfile();

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "playstation",
        authMethod: "api",
        authClient: playstationAuthClient(),
        providerState: JSON.stringify({ version: 1 }),
        code: " test-npsso ",
        signal: testSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "playstation-access-token",
        refreshToken: "playstation-refresh-token",
        idToken: jwtPayload({ sub: "psn-account-123" }),
        npsso: "test-npsso",
        webSessionToken: "playstation-web-session-token",
        accountId: "psn-account-123",
        onlineId: "vm0-player",
      },
      expiresIn: 3600,
      scopes: ["psn:mobile.v2.core", "psn:clientapp"],
      userInfo: {
        id: "psn-account-123",
        username: "vm0-player",
        email: null,
      },
    });

    expect(captured.authorizeUrl?.searchParams.get("access_type")).toBe(
      "offline",
    );
    expect(captured.authorizeUrl?.searchParams.get("client_id")).toBe(
      PLAYSTATION_CLIENT_ID,
    );
    expect(captured.authorizeUrl?.searchParams.get("redirect_uri")).toBe(
      PLAYSTATION_REDIRECT_URI,
    );
    expect(captured.authorizeUrl?.searchParams.get("response_type")).toBe(
      "code",
    );
    expect(captured.authorizeUrl?.searchParams.get("scope")).toBe(
      "psn:mobile.v2.core psn:clientapp",
    );
    expect(captured.tokenRequestAuthorization).toBe(
      PLAYSTATION_CLIENT_BASIC_AUTH,
    );
    expect(captured.tokenRequestBody?.get("grant_type")).toBe(
      "authorization_code",
    );
    expect(captured.tokenRequestBody?.get("code")).toBe("psn-access-code");
    expect(captured.tokenRequestBody?.get("redirect_uri")).toBe(
      PLAYSTATION_REDIRECT_URI,
    );
    expect(captured.tokenRequestBody?.get("token_format")).toBe("jwt");
  });

  it("accepts the full NPSSO JSON response", async () => {
    let cookieHeader: string | null = null;
    mockPlaystationWebSession({
      mobileAuthorize: (request) => {
        cookieHeader = request.headers.get("cookie");
        return new HttpResponse(null, {
          status: 302,
          headers: {
            location:
              "com.playstation.PlayStationApp://redirect/?code=psn-access-code&cid=cid",
          },
        });
      },
    });
    server.use(
      http.post(PLAYSTATION_TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "playstation-access-token",
          expires_in: 3600,
          id_token: jwtPayload({ sub: "psn-account-123" }),
          refresh_token: "playstation-refresh-token",
          refresh_token_expires_in: 5184000,
          scope: "psn:mobile.v2.core psn:clientapp",
          token_type: "bearer",
        });
      }),
    );
    mockPlaystationProfile();

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "playstation",
        authMethod: "api",
        authClient: playstationAuthClient(),
        providerState: JSON.stringify({ version: 1 }),
        code: '{ "npsso": "test-npsso" }',
        signal: testSignal(),
      }),
    ).resolves.toMatchObject({
      userInfo: {
        id: "psn-account-123",
        username: "vm0-player",
      },
    });
    expect(cookieHeader).toBe("npsso=test-npsso");
  });

  it("rejects NPSSO responses without an authorization code", async () => {
    mockPlaystationWebSession({
      mobileAuthorize: () => {
        return new HttpResponse(null, { status: 401 });
      },
    });

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "playstation",
        authMethod: "api",
        authClient: playstationAuthClient(),
        providerState: JSON.stringify({ version: 1 }),
        code: "bad-npsso",
        signal: testSignal(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 401 &&
        error.oauthError === "invalid_grant"
      );
    });
  });

  it("rejects invalid NPSSO input before building a cookie header", async () => {
    await expectInvalidPlaystationNpssoCodeRejected("bad\nnpsso");
    await expectInvalidPlaystationNpssoCodeRejected("bad\u0000npsso");
  });

  it("rejects NPSSO JSON without an NPSSO value", async () => {
    await expectInvalidPlaystationNpssoCodeRejected('{"notNpsso":"value"}');
  });

  it("rejects an untrusted web session redirect", async () => {
    mockPlaystationGrant();
    server.use(
      http.get(PLAYSTATION_WEB_SESSION_SIGNIN_URL, () => {
        return new HttpResponse(null, {
          status: 302,
          headers: {
            location: "https://attacker.example/api/authz/v3/oauth/authorize",
            "set-cookie":
              "pdccws_p=playstation-web-session-initial; Path=/; HttpOnly; Secure",
          },
        });
      }),
    );

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "playstation",
        authMethod: "api",
        authClient: playstationAuthClient(),
        providerState: JSON.stringify({ version: 1 }),
        code: "test-npsso",
        signal: testSignal(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 302 &&
        error.oauthError === "invalid_grant"
      );
    });
  });

  it("rejects a web session response without its session cookie", async () => {
    mockPlaystationGrant();
    server.use(
      http.get(PLAYSTATION_WEB_SESSION_SIGNIN_URL, () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { location: playstationWebAuthorizeUrl() },
        });
      }),
    );

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "playstation",
        authMethod: "api",
        authClient: playstationAuthClient(),
        providerState: JSON.stringify({ version: 1 }),
        code: "test-npsso",
        signal: testSignal(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 302 &&
        error.oauthError === "invalid_grant"
      );
    });
  });

  it("keeps the initial web session token when the callback does not rotate it", async () => {
    mockPlaystationGrant({ finalWebSessionToken: null });

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "playstation",
        authMethod: "api",
        authClient: playstationAuthClient(),
        providerState: JSON.stringify({ version: 1 }),
        code: "test-npsso",
        signal: testSignal(),
      }),
    ).resolves.toMatchObject({
      outputs: {
        webSessionToken: "playstation-web-session-initial",
      },
    });
  });

  it("refreshes PlayStation access tokens", async () => {
    const captured: { tokenRequestBody?: URLSearchParams } = {};
    mockPlaystationWebSession();
    server.use(
      http.post(PLAYSTATION_TOKEN_URL, async ({ request }) => {
        captured.tokenRequestBody = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: "playstation-access-token-refreshed",
          expires_in: 1800,
          id_token: jwtPayload({ sub: "psn-account-123" }),
          refresh_token: "playstation-refresh-token-rotated",
          refresh_token_expires_in: 5184000,
          scope: "psn:mobile.v2.core psn:clientapp",
          token_type: "bearer",
        });
      }),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        connectorSlug: "playstation",
        authMethod: "api",
        authClient: playstationAuthClient(),
        inputs: {
          refreshToken: "playstation-refresh-token",
          npsso: "test-npsso",
        },
        signal: testSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "playstation-access-token-refreshed",
        refreshToken: "playstation-refresh-token-rotated",
        idToken: jwtPayload({ sub: "psn-account-123" }),
        webSessionToken: "playstation-web-session-token",
      },
      expiresIn: 1800,
    });

    expect(captured.tokenRequestBody?.get("grant_type")).toBe("refresh_token");
    expect(captured.tokenRequestBody?.get("refresh_token")).toBe(
      "playstation-refresh-token",
    );
    expect(captured.tokenRequestBody?.get("scope")).toBe(
      "psn:mobile.v2.core psn:clientapp",
    );
    expect(captured.tokenRequestBody?.get("token_format")).toBe("jwt");
  });
});
