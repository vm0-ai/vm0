import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { resolveConnectorAuthClientForMethod } from "../../../connector-utils";
import {
  completeConnectorExternalCodeAuthorization,
  refreshConnectorAuthProviderAccessToken,
  startConnectorExternalCodeAuthorization,
} from "../../connector-auth";
import { isOAuthProviderHttpError } from "../../oauth/error";
import { server } from "../../__tests__/test-server";
import {
  NINTENDO_PLAY_ACTIVITY_AUTHORIZATION_URL,
  NINTENDO_PLAY_ACTIVITY_PROFILE_URL,
  NINTENDO_PLAY_ACTIVITY_SESSION_TOKEN_URL,
  NINTENDO_PLAY_ACTIVITY_TOKEN_URL,
  NINTENDO_PLAY_ACTIVITY_USER_AGENT,
} from "../nintendo-play-activity/api";

const NINTENDO_PLAY_ACTIVITY_CLIENT_ID = "5c38e31cd085304b";
const NINTENDO_PLAY_ACTIVITY_REDIRECT_URI = "npf5c38e31cd085304b://auth";
const NINTENDO_SESSION_TOKEN_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token";

function nintendoPlayActivityAuthClient() {
  const authClient = resolveConnectorAuthClientForMethod(
    "nintendo-play-activity",
    "api",
    () => {
      throw new Error("Nintendo Play Activity auth client should not read env");
    },
  );
  if (
    !authClient ||
    authClient.clientRegistration !== "static" ||
    authClient.clientType !== "public" ||
    !("clientId" in authClient)
  ) {
    throw new Error("Missing Nintendo Play Activity public auth client");
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

async function startNintendoPlayActivitySession() {
  const result = await startConnectorExternalCodeAuthorization({
    type: "nintendo-play-activity",
    authMethod: "api",
    authClient: nintendoPlayActivityAuthClient(),
  });
  const providerState = JSON.parse(result.providerState) as {
    readonly version: 1;
    readonly state: string;
    readonly codeVerifier: string;
  };
  return { result, providerState };
}

function mockNintendoPlayActivityTokenExchange(args?: {
  readonly accessToken?: string;
  readonly idToken?: string;
}) {
  const captured: {
    profileRequestHeaders?: Headers;
    sessionRequestHeaders?: Headers;
    sessionRequestBody?: URLSearchParams;
    tokenRequestHeaders?: Headers;
    tokenRequestBody?: unknown;
  } = {};
  server.use(
    http.post(NINTENDO_PLAY_ACTIVITY_SESSION_TOKEN_URL, async ({ request }) => {
      captured.sessionRequestHeaders = request.headers;
      captured.sessionRequestBody = new URLSearchParams(await request.text());
      return HttpResponse.json({
        session_token: "nintendo-session-token",
      });
    }),
    http.post(NINTENDO_PLAY_ACTIVITY_TOKEN_URL, async ({ request }) => {
      captured.tokenRequestHeaders = request.headers;
      captured.tokenRequestBody = await request.json();
      return HttpResponse.json({
        access_token: args?.accessToken ?? "nintendo-access-token",
        expires_in: 3600,
        id_token:
          args?.idToken ??
          jwtPayload({
            sub: "nintendo-account-123",
            email: "player@example.com",
            name: "Nintendo Player",
          }),
        scope: "openid user user.mii user.email user.links[].id",
        token_type: "Bearer",
      });
    }),
    http.get(NINTENDO_PLAY_ACTIVITY_PROFILE_URL, ({ request }) => {
      captured.profileRequestHeaders = request.headers;
      return HttpResponse.json({
        country: "HK",
        language: "zh-TW",
      });
    }),
  );
  return captured;
}

describe("Nintendo Play Activity external-code provider", () => {
  it("starts by building a Nintendo session-token-code authorization URL", async () => {
    const { result, providerState } = await startNintendoPlayActivitySession();
    const authorizationUrl = new URL(result.authorizationUrl);

    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      NINTENDO_PLAY_ACTIVITY_AUTHORIZATION_URL,
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      NINTENDO_PLAY_ACTIVITY_CLIENT_ID,
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      NINTENDO_PLAY_ACTIVITY_REDIRECT_URI,
    );
    expect(authorizationUrl.searchParams.get("response_type")).toBe(
      "session_token_code",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "openid user user.mii user.email user.links[].id",
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
    expect(authorizationUrl.searchParams.get("theme")).toBe("login_form");
    expect(result).toMatchObject({
      providerState: expect.any(String),
      expiresIn: 600,
    });
  });

  it("exchanges a pasted Nintendo redirect URL for connector credentials", async () => {
    const { result, providerState } = await startNintendoPlayActivitySession();
    const captured = mockNintendoPlayActivityTokenExchange();

    await expect(
      completeConnectorExternalCodeAuthorization({
        type: "nintendo-play-activity",
        authMethod: "api",
        authClient: nintendoPlayActivityAuthClient(),
        providerState: result.providerState,
        code: `${NINTENDO_PLAY_ACTIVITY_REDIRECT_URI}#session_token_code=nintendo-session-code&state=${providerState.state}`,
        signal: testSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        sessionToken: "nintendo-session-token",
        accessToken: "nintendo-access-token",
        idToken: jwtPayload({
          sub: "nintendo-account-123",
          email: "player@example.com",
          name: "Nintendo Player",
        }),
        accountId: "nintendo-account-123",
        locale: "zh-TW-HK",
      },
      expiresIn: 3600,
      scopes: ["openid", "user", "user.mii", "user.email", "user.links[].id"],
      userInfo: {
        id: "nintendo-account-123",
        username: "Nintendo Player",
        email: "player@example.com",
      },
    });

    expect(captured.sessionRequestHeaders?.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(captured.sessionRequestHeaders?.get("user-agent")).toBe(
      NINTENDO_PLAY_ACTIVITY_USER_AGENT,
    );
    expect(captured.sessionRequestBody?.get("client_id")).toBe(
      NINTENDO_PLAY_ACTIVITY_CLIENT_ID,
    );
    expect(captured.sessionRequestBody?.get("session_token_code")).toBe(
      "nintendo-session-code",
    );
    expect(
      captured.sessionRequestBody?.get("session_token_code_verifier"),
    ).toBe(providerState.codeVerifier);

    expect(captured.tokenRequestHeaders?.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(captured.tokenRequestHeaders?.get("user-agent")).toBe(
      NINTENDO_PLAY_ACTIVITY_USER_AGENT,
    );
    expect(captured.tokenRequestBody).toStrictEqual({
      client_id: NINTENDO_PLAY_ACTIVITY_CLIENT_ID,
      session_token: "nintendo-session-token",
      grant_type: NINTENDO_SESSION_TOKEN_GRANT_TYPE,
    });
    expect(captured.profileRequestHeaders?.get("authorization")).toBe(
      "Bearer nintendo-access-token",
    );
    expect(captured.profileRequestHeaders?.get("user-agent")).toBe(
      NINTENDO_PLAY_ACTIVITY_USER_AGENT,
    );
  });

  it("accepts a raw Nintendo session token code", async () => {
    const { result } = await startNintendoPlayActivitySession();
    const captured = mockNintendoPlayActivityTokenExchange({
      accessToken: "raw-code-access-token",
    });

    await expect(
      completeConnectorExternalCodeAuthorization({
        type: "nintendo-play-activity",
        authMethod: "api",
        authClient: nintendoPlayActivityAuthClient(),
        providerState: result.providerState,
        code: " raw-session-code ",
        signal: testSignal(),
      }),
    ).resolves.toMatchObject({
      outputs: {
        accessToken: "raw-code-access-token",
      },
      userInfo: {
        id: "nintendo-account-123",
      },
    });
    expect(captured.sessionRequestBody?.get("session_token_code")).toBe(
      "raw-session-code",
    );
  });

  it("rejects a Nintendo redirect URL with the wrong state before exchange", async () => {
    const { result } = await startNintendoPlayActivitySession();
    let sessionExchangeCount = 0;
    server.use(
      http.post(NINTENDO_PLAY_ACTIVITY_SESSION_TOKEN_URL, () => {
        sessionExchangeCount += 1;
        return HttpResponse.json({ session_token: "should-not-happen" });
      }),
    );

    await expect(
      completeConnectorExternalCodeAuthorization({
        type: "nintendo-play-activity",
        authMethod: "api",
        authClient: nintendoPlayActivityAuthClient(),
        providerState: result.providerState,
        code: `${NINTENDO_PLAY_ACTIVITY_REDIRECT_URI}#session_token_code=nintendo-session-code&state=wrong-state`,
        signal: testSignal(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 400 &&
        error.oauthError === "invalid_grant"
      );
    });
    expect(sessionExchangeCount).toBe(0);
  });

  it("rejects a pasted redirect URL without a session token code before exchange", async () => {
    const { result, providerState } = await startNintendoPlayActivitySession();
    let sessionExchangeCount = 0;
    server.use(
      http.post(NINTENDO_PLAY_ACTIVITY_SESSION_TOKEN_URL, () => {
        sessionExchangeCount += 1;
        return HttpResponse.json({ session_token: "should-not-happen" });
      }),
    );

    await expect(
      completeConnectorExternalCodeAuthorization({
        type: "nintendo-play-activity",
        authMethod: "api",
        authClient: nintendoPlayActivityAuthClient(),
        providerState: result.providerState,
        code: `${NINTENDO_PLAY_ACTIVITY_REDIRECT_URI}#state=${providerState.state}`,
        signal: testSignal(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 400 &&
        error.oauthError === "invalid_grant"
      );
    });
    expect(sessionExchangeCount).toBe(0);
  });

  it("refreshes the Nintendo Play Activity access token from the session token", async () => {
    let profileRequestHeaders: Headers | undefined;
    let tokenRequestBody: unknown;
    const refreshedIdToken = jwtPayload({ sub: "nintendo-account-123" });
    server.use(
      http.post(NINTENDO_PLAY_ACTIVITY_TOKEN_URL, async ({ request }) => {
        tokenRequestBody = await request.json();
        return HttpResponse.json({
          access_token: "refreshed-nintendo-access-token",
          expires_in: 1800,
          id_token: refreshedIdToken,
          token_type: "Bearer",
        });
      }),
      http.get(NINTENDO_PLAY_ACTIVITY_PROFILE_URL, ({ request }) => {
        profileRequestHeaders = request.headers;
        return HttpResponse.json({
          country: "US",
          language: "en",
        });
      }),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "nintendo-play-activity",
        authMethod: "api",
        authClient: nintendoPlayActivityAuthClient(),
        inputs: {
          sessionToken: "stored-nintendo-session-token",
        },
        signal: testSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "refreshed-nintendo-access-token",
        idToken: refreshedIdToken,
        locale: "en-US",
      },
      expiresIn: 1800,
    });
    expect(tokenRequestBody).toStrictEqual({
      client_id: NINTENDO_PLAY_ACTIVITY_CLIENT_ID,
      session_token: "stored-nintendo-session-token",
      grant_type: NINTENDO_SESSION_TOKEN_GRANT_TYPE,
    });
    expect(profileRequestHeaders?.get("authorization")).toBe(
      "Bearer refreshed-nintendo-access-token",
    );
  });
});
