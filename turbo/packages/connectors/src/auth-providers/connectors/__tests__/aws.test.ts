import { createHash } from "node:crypto";

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  completeConnectorExternalCodeAuthorization,
  refreshConnectorAuthProviderAccessToken,
  startConnectorExternalCodeAuthorization,
} from "../../connector-auth";
import { isOAuthProviderHttpError } from "../../oauth/error";
import { resolveConnectorAuthClientForMethod } from "../../../connector-utils";

const AWS_TOKEN_URL = "https://us-east-1.signin.aws.amazon.com/v1/token";
const AWS_STS_URL = "https://sts.us-east-1.amazonaws.com/";
const AWS_EXCHANGE_CREDENTIAL_ID = ["aws", "exchange", "credential", "id"].join(
  "-",
);
const AWS_REFRESH_CREDENTIAL_ID = ["aws", "refresh", "credential", "id"].join(
  "-",
);

const awsTokenRequestSchema = z.object({
  clientId: z.literal("arn:aws:signin:::devtools/cross-device"),
  grantType: z.enum(["authorization_code", "refresh_token"]),
  code: z.string().optional(),
  codeVerifier: z.string().optional(),
  redirectUri: z.string().optional(),
  refreshToken: z.string().optional(),
});

const awsProviderStateSchema = z.object({
  version: z.literal(1),
  state: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
  signinRegion: z.string(),
  runtimeRegion: z.string(),
});

const server = setupServer();
const tokenRequests: z.infer<typeof awsTokenRequestSchema>[] = [];
let stsCalls = 0;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  tokenRequests.length = 0;
  stsCalls = 0;
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function awsAuthClient() {
  const authClient = resolveConnectorAuthClientForMethod("aws", "cli", () => {
    return undefined;
  });
  if (!authClient) {
    throw new Error("Expected AWS auth client");
  }
  return authClient;
}

function codeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function mockAwsTokenEndpoint(): void {
  server.use(
    http.post(AWS_TOKEN_URL, async ({ request }) => {
      const body = awsTokenRequestSchema.parse(await request.json());
      tokenRequests.push(body);
      return HttpResponse.json({
        accessToken: {
          accessKeyId:
            body.grantType === "refresh_token"
              ? AWS_REFRESH_CREDENTIAL_ID
              : AWS_EXCHANGE_CREDENTIAL_ID,
          secretAccessKey:
            body.grantType === "refresh_token"
              ? "refresh-secret-access-key"
              : "exchange-secret-access-key",
          sessionToken:
            body.grantType === "refresh_token"
              ? "refresh-session-token"
              : "exchange-session-token",
        },
        expiresIn: 900,
        refreshToken:
          body.grantType === "refresh_token"
            ? "aws-refresh-token-rotated"
            : "aws-refresh-token",
        tokenType: "urn:aws:params:oauth:token-type:access_token_sigv4",
        ...(body.grantType === "authorization_code"
          ? { idToken: "aws-id-token" }
          : {}),
      });
    }),
    http.get(AWS_STS_URL, ({ request }) => {
      stsCalls += 1;
      expect(request.headers.get("authorization")).toContain(
        "AWS4-HMAC-SHA256",
      );
      expect(request.headers.get("x-amz-security-token")).toBe(
        "exchange-session-token",
      );
      return HttpResponse.xml(
        [
          "<GetCallerIdentityResponse>",
          "<GetCallerIdentityResult>",
          "<UserId>AIDAEXAMPLEUSER</UserId>",
          "<Account>123456789012</Account>",
          "<Arn>arn:aws:iam::123456789012:user/test-user</Arn>",
          "</GetCallerIdentityResult>",
          "</GetCallerIdentityResponse>",
        ].join(""),
      );
    }),
  );
}

describe("AWS external-code provider", () => {
  it("starts AWS remote sign-in with cross-device PKCE parameters", async () => {
    const result = await startConnectorExternalCodeAuthorization({
      type: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });

    const providerState = awsProviderStateSchema.parse(
      JSON.parse(result.providerState) as unknown,
    );
    const url = new URL(result.authorizationUrl);

    expect(url.origin + url.pathname).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(
      "arn:aws:signin:::devtools/cross-device",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("code_challenge_method")).toBe("SHA-256");
    expect(url.searchParams.get("code_challenge")).toBe(
      codeChallenge(providerState.codeVerifier),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/sessions/confirmation",
    );
    expect(url.searchParams.get("state")).toBe(providerState.state);
    expect(result.expiresIn).toBe(600);
  });

  it("exchanges the pasted code, preserves expiresIn, and maps STS identity", async () => {
    mockAwsTokenEndpoint();
    const start = await startConnectorExternalCodeAuthorization({
      type: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });

    const result = await completeConnectorExternalCodeAuthorization({
      type: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
      code: "AWS-CODE",
      providerState: start.providerState,
      signal: new AbortController().signal,
    });

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatchObject({
      grantType: "authorization_code",
      code: "AWS-CODE",
      redirectUri:
        "https://us-east-1.signin.aws.amazon.com/v1/sessions/confirmation",
    });
    expect(tokenRequests[0]?.codeVerifier).toBe(
      awsProviderStateSchema.parse(JSON.parse(start.providerState) as unknown)
        .codeVerifier,
    );
    expect(stsCalls).toBe(1);
    expect(result).toStrictEqual({
      outputs: {
        refreshToken: "aws-refresh-token",
        accessKeyId: AWS_EXCHANGE_CREDENTIAL_ID,
        secretAccessKey: "exchange-secret-access-key",
        sessionToken: "exchange-session-token",
        signinRegion: "us-east-1",
        runtimeRegion: "us-east-1",
      },
      expiresIn: 900,
      scopes: ["openid"],
      userInfo: {
        id: "123456789012",
        username: "arn:aws:iam::123456789012:user/test-user (AIDAEXAMPLEUSER)",
        email: null,
      },
    });
  });

  it("aborts AWS code exchange without sending the token request", async () => {
    mockAwsTokenEndpoint();
    const start = await startConnectorExternalCodeAuthorization({
      type: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      completeConnectorExternalCodeAuthorization({
        type: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        code: "AWS-CODE",
        providerState: start.providerState,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(tokenRequests).toStrictEqual([]);
    expect(stsCalls).toBe(0);
  });

  it("propagates aborts while reading the AWS token response body", async () => {
    let resolveTokenResponseStarted: (() => void) | undefined;
    const tokenResponseStarted = new Promise<void>((resolve) => {
      resolveTokenResponseStarted = resolve;
    });
    let abortTokenResponseBody: ((error: DOMException) => void) | undefined;
    server.use(
      http.post(AWS_TOKEN_URL, async ({ request }) => {
        const body = awsTokenRequestSchema.parse(await request.json());
        tokenRequests.push(body);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            abortTokenResponseBody = (error) => {
              controller.error(error);
            };
            resolveTokenResponseStarted?.();
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const start = await startConnectorExternalCodeAuthorization({
      type: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });
    const controller = new AbortController();

    const complete = completeConnectorExternalCodeAuthorization({
      type: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
      code: "AWS-CODE",
      providerState: start.providerState,
      signal: controller.signal,
    });

    await tokenResponseStarted;
    const abortError = new DOMException(
      "The operation was aborted",
      "AbortError",
    );
    controller.abort(abortError);
    if (!abortTokenResponseBody) {
      throw new Error("Expected AWS token response body to start");
    }
    abortTokenResponseBody(abortError);

    await expect(complete).rejects.toMatchObject({ name: "AbortError" });
    expect(tokenRequests).toHaveLength(1);
    expect(stsCalls).toBe(0);
  });

  it("refreshes AWS credentials and returns a rotated refresh token", async () => {
    mockAwsTokenEndpoint();

    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        inputs: {
          refreshToken: "aws-refresh-token",
          signinRegion: "us-east-1",
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toStrictEqual({
      outputs: {
        refreshToken: "aws-refresh-token-rotated",
        accessKeyId: AWS_REFRESH_CREDENTIAL_ID,
        secretAccessKey: "refresh-secret-access-key",
        sessionToken: "refresh-session-token",
      },
      expiresIn: 900,
    });
    expect(tokenRequests).toStrictEqual([
      {
        clientId: "arn:aws:signin:::devtools/cross-device",
        grantType: "refresh_token",
        refreshToken: "aws-refresh-token",
      },
    ]);
  });

  it("maps terminal AWS refresh failures to invalid_grant", async () => {
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json(
          {
            __type: "AccessDeniedException",
            message: "Refresh token expired",
          },
          { status: 400 },
        );
      }),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        inputs: {
          refreshToken: "aws-refresh-token",
          signinRegion: "us-east-1",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 400 &&
        error.oauthError === "invalid_grant"
      );
    });
  });

  it("redacts AWS token exchange sensitive values from provider errors", async () => {
    const start = await startConnectorExternalCodeAuthorization({
      type: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });
    const providerState = awsProviderStateSchema.parse(
      JSON.parse(start.providerState) as unknown,
    );
    const errorAccessKeyId = ["aws", "error", "access", "key"].join("-");
    const errorSecretAccessKey = ["aws", "error", "secret"].join("-");
    const errorSessionToken = ["aws", "error", "session"].join("-");
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: [
              "Rejected",
              "AWS-CODE",
              providerState.codeVerifier,
              `accessKeyId=${errorAccessKeyId}`,
              `secretAccessKey=${errorSecretAccessKey}`,
              `sessionToken=${errorSessionToken}`,
            ].join(" "),
          },
          { status: 400 },
        );
      }),
    );

    await expect(
      completeConnectorExternalCodeAuthorization({
        type: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        code: "AWS-CODE",
        providerState: start.providerState,
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        !error.message.includes("AWS-CODE") &&
        !error.message.includes(providerState.codeVerifier) &&
        !error.message.includes(errorAccessKeyId) &&
        !error.message.includes(errorSecretAccessKey) &&
        !error.message.includes(errorSessionToken)
      );
    });
  });

  it("redacts AWS refresh tokens echoed by provider errors", async () => {
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Refresh token aws-refresh-token expired",
          },
          { status: 400 },
        );
      }),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        inputs: {
          refreshToken: "aws-refresh-token",
          signinRegion: "us-east-1",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        !error.message.includes("aws-refresh-token")
      );
    });
  });

  it("keeps AWS token throttling as an upstream OAuth HTTP error", async () => {
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json(
          { __type: "TooManyRequestsError", message: "Rate limited" },
          { status: 429 },
        );
      }),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        inputs: {
          refreshToken: "aws-refresh-token",
          signinRegion: "us-east-1",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 429 &&
        error.oauthError === undefined
      );
    });
  });
});
