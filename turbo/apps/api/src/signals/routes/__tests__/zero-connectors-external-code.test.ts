import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { zeroConnectorExternalCodeSessionContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectorExternalCodeSessions } from "@vm0/db/schema/connector-external-code-session";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { completeConnectorExternalCodeSession$ } from "../../services/connector-external-code.service";
import {
  decryptPersistentSecretValue,
  decryptStoredSecretValue,
  encryptPersistentSecretValue,
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { fakeKmsClient } from "./helpers/fake-kms-client";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const AWS_TOKEN_URL = "https://us-east-1.signin.aws.amazon.com/v1/token";
const AWS_STS_URL = "https://sts.us-east-1.amazonaws.com/";
const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const AWS_EXTERNAL_CODE_CREDENTIAL_ID = [
  "aws",
  "external-code",
  "credential",
  "id",
].join("-");

const awsTokenRequestSchema = z.object({
  clientId: z.literal("arn:aws:signin:::devtools/cross-device"),
  grantType: z.enum(["authorization_code", "refresh_token"]),
  code: z.string().optional(),
  codeVerifier: z.string().optional(),
  redirectUri: z.string().optional(),
  refreshToken: z.string().optional(),
});

function sessionTokenHash(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
}

function awsVerificationCode(
  authorizationUrl: string,
  code = "AWS-CODE",
): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected AWS authorization URL state");
  }
  return Buffer.from(new URLSearchParams({ state, code }).toString()).toString(
    "base64",
  );
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Failed to create deferred promise");
  }
  return { promise, resolve: resolvePromise };
}

async function cleanupUser(userId: string, orgId: string) {
  const db = store.set(writeDb$);
  await db
    .delete(connectorExternalCodeSessions)
    .where(
      and(
        eq(connectorExternalCodeSessions.userId, userId),
        eq(connectorExternalCodeSessions.orgId, orgId),
      ),
    );
  await db
    .delete(connectors)
    .where(and(eq(connectors.userId, userId), eq(connectors.orgId, orgId)));
  await db
    .delete(secrets)
    .where(and(eq(secrets.userId, userId), eq(secrets.orgId, orgId)));
}

async function storedSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}): Promise<string | null> {
  const [secret] = await store
    .set(writeDb$)
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, args.name),
      ),
    );
  return secret ? await decryptStoredSecretValue(secret.encryptedValue) : null;
}

function awsTokenEndpointResponseBody() {
  return {
    accessToken: {
      accessKeyId: AWS_EXTERNAL_CODE_CREDENTIAL_ID,
      secretAccessKey: "aws-secret-access-key",
      sessionToken: "aws-session-token",
    },
    expiresIn: 900,
    refreshToken: "aws-login-refresh-token",
    tokenType: "aws_sigv4",
    idToken: "aws-id-token",
  };
}

function mockAwsProvider(): z.infer<typeof awsTokenRequestSchema>[] {
  const tokenRequests: z.infer<typeof awsTokenRequestSchema>[] = [];
  server.use(
    http.post(AWS_TOKEN_URL, async ({ request }) => {
      const body = awsTokenRequestSchema.parse(await request.json());
      expect(request.headers.get("dpop")).toBeTruthy();
      tokenRequests.push(body);
      return HttpResponse.json({ tokenOutput: awsTokenEndpointResponseBody() });
    }),
    http.get(AWS_STS_URL, () => {
      return HttpResponse.xml(
        [
          "<GetCallerIdentityResponse>",
          "<GetCallerIdentityResult>",
          "<UserId>AIDAEXTERNALUSER</UserId>",
          "<Account>123456789012</Account>",
          "<Arn>arn:aws:iam::123456789012:user/external-code</Arn>",
          "</GetCallerIdentityResult>",
          "</GetCallerIdentityResponse>",
        ].join(""),
      );
    }),
  );
  return tokenRequests;
}

function kmsClientThatAbortsOnTokenSecretEncryption(args: {
  readonly controller: AbortController;
}) {
  const kms = fakeKmsClient();
  let aborted = false;

  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | DecryptCommandOutput> {
    if (command instanceof GenerateDataKeyCommand && !aborted) {
      aborted = true;
      const error = new Error("Request aborted after AWS code exchange");
      error.name = "AbortError";
      args.controller.abort(error);
    }

    if (command instanceof GenerateDataKeyCommand) {
      return kms.client.send(command);
    }
    return kms.client.send(command);
  }

  return { send };
}

describe("external-code connector routes", () => {
  const users: { readonly userId: string; readonly orgId: string }[] = [];

  afterEach(async () => {
    clearMockedEnv();
    resetSecretKmsClientForTests();
    while (users.length > 0) {
      const user = users.pop();
      if (user) {
        await cleanupUser(user.userId, user.orgId);
      }
    }
  });

  function setupUser(args: { readonly enableAws?: boolean } = {}) {
    const userId = `user_${randomUUID()}`;
    const orgId = args.enableAws ? STAFF_ORG_ID : `org_${randomUUID()}`;
    users.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    const kms = fakeKmsClient();
    setSecretKmsClientForTests(kms.client);
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");
    return { userId, orgId };
  }

  it("rejects AWS start when the connector switch is disabled", async () => {
    setupUser();
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );

    const response = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "External-code authorization is not enabled for this connector",
    );
  });

  it("starts a session with hashed token storage and encrypted provider state", async () => {
    const { userId, orgId } = setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );

    const response = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    const authorizationUrl = new URL(response.body.authorizationUrl);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "arn:aws:signin:::devtools/cross-device",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/sessions/confirmation",
    );

    const [session] = await store
      .set(writeDb$)
      .select()
      .from(connectorExternalCodeSessions)
      .where(eq(connectorExternalCodeSessions.id, response.body.sessionId))
      .limit(1);
    expect(session).toBeDefined();
    expect(session?.sessionTokenHash).toBe(
      sessionTokenHash(response.body.sessionToken),
    );
    expect(session?.sessionTokenHash).not.toBe(response.body.sessionToken);
    expect(session?.authorizationUrl).toBe(response.body.authorizationUrl);
    expect(session?.status).toBe("pending");

    const decryptedProviderState = session
      ? await decryptPersistentSecretValue(session.encryptedProviderState, {
          orgId,
          userId,
        })
      : null;
    expect(decryptedProviderState).not.toContain(response.body.sessionToken);
    expect(decryptedProviderState).toContain('"connectorType":"aws"');
    expect(decryptedProviderState).toContain('"authMethod":"cli"');
  });

  it("rejects complete with the wrong session token", async () => {
    const tokenRequests = mockAwsProvider();
    setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    const complete = await accept(
      client.complete({
        params: { type: "aws", sessionId: start.body.sessionId },
        body: {
          sessionToken: `wrong-${start.body.sessionToken}`,
          code: awsVerificationCode(start.body.authorizationUrl),
        },
        headers: AUTH_HEADERS,
      }),
      [404],
    );

    expect(complete.body.error.message).toBe(
      "External-code authorization session not found",
    );
    expect(tokenRequests).toStrictEqual([]);
  });

  it("rejects cross-user and cross-org session completion", async () => {
    const tokenRequests = mockAwsProvider();
    setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    setupUser();
    const complete = await accept(
      client.complete({
        params: { type: "aws", sessionId: start.body.sessionId },
        body: {
          sessionToken: start.body.sessionToken,
          code: awsVerificationCode(start.body.authorizationUrl),
        },
        headers: AUTH_HEADERS,
      }),
      [404],
    );

    expect(complete.body.error.message).toBe(
      "External-code authorization session not found",
    );
    expect(tokenRequests).toStrictEqual([]);
  });

  it("supersedes older pending sessions when a new session starts", async () => {
    const { userId, orgId } = setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const firstStart = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    const secondStart = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    const firstComplete = await accept(
      client.complete({
        params: { type: "aws", sessionId: firstStart.body.sessionId },
        body: {
          sessionToken: firstStart.body.sessionToken,
          code: awsVerificationCode(firstStart.body.authorizationUrl),
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    const sessionRows = await store
      .set(writeDb$)
      .select({
        id: connectorExternalCodeSessions.id,
        status: connectorExternalCodeSessions.status,
        errorCode: connectorExternalCodeSessions.errorCode,
      })
      .from(connectorExternalCodeSessions)
      .where(
        and(
          eq(connectorExternalCodeSessions.userId, userId),
          eq(connectorExternalCodeSessions.orgId, orgId),
        ),
      );

    expect(firstComplete.body.error.message).toBe(
      "External-code authorization session was superseded",
    );
    expect(sessionRows).toStrictEqual(
      expect.arrayContaining([
        {
          id: firstStart.body.sessionId,
          status: "error",
          errorCode: "session_superseded",
        },
        {
          id: secondStart.body.sessionId,
          status: "pending",
          errorCode: null,
        },
      ]),
    );
  });

  it("completes a session, stores AWS secrets, and returns the connector on replay", async () => {
    const tokenRequests = mockAwsProvider();
    const { userId, orgId } = setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    const beforeComplete = now();
    const complete = await accept(
      client.complete({
        params: { type: "aws", sessionId: start.body.sessionId },
        body: {
          sessionToken: start.body.sessionToken,
          code: ` ${awsVerificationCode(start.body.authorizationUrl)} \n`,
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    const afterComplete = now();

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatchObject({
      grantType: "authorization_code",
      code: "AWS-CODE",
      redirectUri:
        "https://us-east-1.signin.aws.amazon.com/v1/sessions/confirmation",
    });
    expect(complete.body.connector).toMatchObject({
      type: "aws",
      authMethod: "cli",
      externalId: "123456789012",
      externalUsername:
        "arn:aws:iam::123456789012:user/external-code (AIDAEXTERNALUSER)",
      oauthScopes: ["openid"],
    });
    expect(complete.body.connector.tokenExpiresAt).not.toBeNull();
    const tokenExpiresAtMs = Date.parse(
      complete.body.connector.tokenExpiresAt ?? "",
    );
    expect(tokenExpiresAtMs).toBeGreaterThanOrEqual(beforeComplete + 899_000);
    expect(tokenExpiresAtMs).toBeLessThanOrEqual(afterComplete + 901_000);

    await expect(
      storedSecret({ orgId, userId, name: "AWS_LOGIN_REFRESH_TOKEN" }),
    ).resolves.toBe("aws-login-refresh-token");
    await expect(
      storedSecret({ orgId, userId, name: "AWS_LOGIN_DPOP_KEY" }),
    ).resolves.toContain("BEGIN EC PRIVATE KEY");
    await expect(
      storedSecret({ orgId, userId, name: "AWS_ACCESS_KEY_ID" }),
    ).resolves.toBe(AWS_EXTERNAL_CODE_CREDENTIAL_ID);
    await expect(
      storedSecret({ orgId, userId, name: "AWS_SECRET_ACCESS_KEY" }),
    ).resolves.toBe("aws-secret-access-key");
    await expect(
      storedSecret({ orgId, userId, name: "AWS_SESSION_TOKEN" }),
    ).resolves.toBe("aws-session-token");
    await expect(
      storedSecret({ orgId, userId, name: "AWS_SIGNIN_REGION" }),
    ).resolves.toBe("us-east-1");
    await expect(
      storedSecret({ orgId, userId, name: "AWS_REGION" }),
    ).resolves.toBe("us-east-1");

    const replay = await accept(
      client.complete({
        params: { type: "aws", sessionId: start.body.sessionId },
        body: {
          sessionToken: start.body.sessionToken,
          code: awsVerificationCode(start.body.authorizationUrl),
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    expect(tokenRequests).toHaveLength(1);
    expect(replay.body.connector).toStrictEqual(
      expect.objectContaining({
        id: complete.body.connector.id,
        type: "aws",
        authMethod: "cli",
        externalId: "123456789012",
      }),
    );
  });

  it("commits a completed AWS session when the request aborts after provider success", async () => {
    const tokenRequests = mockAwsProvider();
    const { userId, orgId } = setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    const controller = new AbortController();
    setSecretKmsClientForTests(
      kmsClientThatAbortsOnTokenSecretEncryption({ controller }),
    );

    const complete = await store.set(
      completeConnectorExternalCodeSession$,
      {
        orgId,
        userId,
        type: "aws",
        sessionId: start.body.sessionId,
        sessionToken: start.body.sessionToken,
        code: awsVerificationCode(start.body.authorizationUrl),
      },
      controller.signal,
    );

    expect(controller.signal.aborted).toBeTruthy();
    expect(complete.status).toBe(200);
    expect(tokenRequests).toHaveLength(1);
    await expect(
      storedSecret({ orgId, userId, name: "AWS_ACCESS_KEY_ID" }),
    ).resolves.toBe(AWS_EXTERNAL_CODE_CREDENTIAL_ID);

    const [session] = await store
      .set(writeDb$)
      .select({
        status: connectorExternalCodeSessions.status,
        completedAt: connectorExternalCodeSessions.completedAt,
      })
      .from(connectorExternalCodeSessions)
      .where(eq(connectorExternalCodeSessions.id, start.body.sessionId))
      .limit(1);
    expect(session).toMatchObject({ status: "complete" });
    expect(session?.completedAt).toBeInstanceOf(Date);
  });

  it("does not supersede an in-flight completion when a new session starts", async () => {
    const tokenRequestStarted = deferred();
    const releaseTokenResponse = deferred();
    const tokenRequests: z.infer<typeof awsTokenRequestSchema>[] = [];
    server.use(
      http.post(AWS_TOKEN_URL, async ({ request }) => {
        const body = awsTokenRequestSchema.parse(await request.json());
        expect(request.headers.get("dpop")).toBeTruthy();
        tokenRequests.push(body);
        tokenRequestStarted.resolve();
        await releaseTokenResponse.promise;
        return HttpResponse.json({
          tokenOutput: awsTokenEndpointResponseBody(),
        });
      }),
      http.get(AWS_STS_URL, () => {
        return HttpResponse.xml(
          [
            "<GetCallerIdentityResponse>",
            "<GetCallerIdentityResult>",
            "<UserId>AIDAEXTERNALUSER</UserId>",
            "<Account>123456789012</Account>",
            "<Arn>arn:aws:iam::123456789012:user/external-code</Arn>",
            "</GetCallerIdentityResult>",
            "</GetCallerIdentityResponse>",
          ].join(""),
        );
      }),
    );
    const { userId, orgId } = setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const firstStart = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    const firstComplete = accept(
      client.complete({
        params: { type: "aws", sessionId: firstStart.body.sessionId },
        body: {
          sessionToken: firstStart.body.sessionToken,
          code: awsVerificationCode(firstStart.body.authorizationUrl),
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    await tokenRequestStarted.promise;

    const secondStart = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    releaseTokenResponse.resolve();

    const complete = await firstComplete;

    expect(tokenRequests).toHaveLength(1);
    expect(complete.body.connector).toMatchObject({
      type: "aws",
      authMethod: "cli",
      externalId: "123456789012",
    });
    const sessionRows = await store
      .set(writeDb$)
      .select({
        id: connectorExternalCodeSessions.id,
        status: connectorExternalCodeSessions.status,
      })
      .from(connectorExternalCodeSessions)
      .where(
        and(
          eq(connectorExternalCodeSessions.userId, userId),
          eq(connectorExternalCodeSessions.orgId, orgId),
        ),
      );
    expect(sessionRows).toStrictEqual(
      expect.arrayContaining([
        { id: firstStart.body.sessionId, status: "complete" },
        { id: secondStart.body.sessionId, status: "pending" },
      ]),
    );
  });

  it("restores a rejected AWS code session to pending and records the provider error", async () => {
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Rejected authorization code",
          },
          { status: 400 },
        );
      }),
    );
    setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    const complete = await accept(
      client.complete({
        params: { type: "aws", sessionId: start.body.sessionId },
        body: {
          sessionToken: start.body.sessionToken,
          code: awsVerificationCode(start.body.authorizationUrl),
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );

    expect(complete.body.error.message).toBe(
      "External-code authorization code was rejected. Check the code and try again.",
    );
    const [session] = await store
      .set(writeDb$)
      .select({
        status: connectorExternalCodeSessions.status,
        errorCode: connectorExternalCodeSessions.errorCode,
        errorMessage: connectorExternalCodeSessions.errorMessage,
      })
      .from(connectorExternalCodeSessions)
      .where(eq(connectorExternalCodeSessions.id, start.body.sessionId))
      .limit(1);
    expect(session).toMatchObject({
      status: "pending",
      errorCode: "provider_rejected",
    });
    expect(session?.errorMessage).toContain(
      "AWS Sign-In token exchange failed: 400",
    );
    expect(session?.errorMessage).toContain("invalid_grant");
  });

  it("rejects complete when the AWS connector is not available", async () => {
    const { userId, orgId } = setupUser();
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const sessionId = randomUUID();
    const sessionToken = `aws-external-code-session-token-${randomUUID()}`;
    const nowDate = new Date(now());
    await store
      .set(writeDb$)
      .insert(connectorExternalCodeSessions)
      .values({
        id: sessionId,
        orgId,
        userId,
        connectorType: "aws",
        authMethod: "cli",
        status: "pending",
        sessionTokenHash: sessionTokenHash(sessionToken),
        encryptedProviderState: await encryptPersistentSecretValue("{}", {
          orgId,
          userId,
        }),
        authorizationUrl:
          "https://us-east-1.signin.aws.amazon.com/v1/authorize",
        createdAt: nowDate,
        updatedAt: nowDate,
        expiresAt: new Date(now() + 600_000),
      });

    const complete = await accept(
      client.complete({
        params: { type: "aws", sessionId },
        body: {
          sessionToken,
          code: "AWS-CODE",
        },
        headers: AUTH_HEADERS,
      }),
      [403],
    );

    expect(complete.body.error.message).toBe(
      "External-code authorization is not enabled for this connector",
    );
  });

  it("expires a stale completing session", async () => {
    setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    const expiredAt = new Date(now() - 1000);
    const staleCompletingUpdatedAt = new Date(now() - 31 * 60_000);
    await store
      .set(writeDb$)
      .update(connectorExternalCodeSessions)
      .set({
        status: "completing",
        updatedAt: staleCompletingUpdatedAt,
        expiresAt: expiredAt,
      })
      .where(eq(connectorExternalCodeSessions.id, start.body.sessionId));

    const complete = await accept(
      client.complete({
        params: { type: "aws", sessionId: start.body.sessionId },
        body: {
          sessionToken: start.body.sessionToken,
          code: "AWS-CODE",
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );

    expect(complete.body.error.message).toBe(
      "External-code authorization session expired",
    );
    const [session] = await store
      .set(writeDb$)
      .select({
        status: connectorExternalCodeSessions.status,
        errorCode: connectorExternalCodeSessions.errorCode,
        completedAt: connectorExternalCodeSessions.completedAt,
      })
      .from(connectorExternalCodeSessions)
      .where(eq(connectorExternalCodeSessions.id, start.body.sessionId))
      .limit(1);
    expect(session).toMatchObject({
      status: "expired",
      errorCode: "expired_token",
    });
    expect(session?.completedAt).toBeInstanceOf(Date);
  });

  it("does not expire an active completing session after the original session expiry", async () => {
    setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    const activeCompletingUpdatedAt = new Date(now());
    await store
      .set(writeDb$)
      .update(connectorExternalCodeSessions)
      .set({
        status: "completing",
        updatedAt: activeCompletingUpdatedAt,
        expiresAt: new Date(now() - 1000),
      })
      .where(eq(connectorExternalCodeSessions.id, start.body.sessionId));

    const complete = await accept(
      client.complete({
        params: { type: "aws", sessionId: start.body.sessionId },
        body: {
          sessionToken: start.body.sessionToken,
          code: "AWS-CODE",
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );

    expect(complete.body.error.message).toBe(
      "External-code authorization session is already completing",
    );
    const [session] = await store
      .set(writeDb$)
      .select({
        status: connectorExternalCodeSessions.status,
        updatedAt: connectorExternalCodeSessions.updatedAt,
        completedAt: connectorExternalCodeSessions.completedAt,
      })
      .from(connectorExternalCodeSessions)
      .where(eq(connectorExternalCodeSessions.id, start.body.sessionId))
      .limit(1);
    expect(session).toMatchObject({
      status: "completing",
      completedAt: null,
    });
    expect(session?.updatedAt.getTime()).toBe(
      activeCompletingUpdatedAt.getTime(),
    );
  });

  it("marks the session as error when stored provider state is invalid", async () => {
    const { userId, orgId } = setupUser({ enableAws: true });
    const client = setupApp({ context })(
      zeroConnectorExternalCodeSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "aws" },
        body: { authMethod: "cli" },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    await store
      .set(writeDb$)
      .update(connectorExternalCodeSessions)
      .set({
        encryptedProviderState: await encryptPersistentSecretValue("not-json", {
          orgId,
          userId,
        }),
      })
      .where(eq(connectorExternalCodeSessions.id, start.body.sessionId));

    const complete = await accept(
      client.complete({
        params: { type: "aws", sessionId: start.body.sessionId },
        body: {
          sessionToken: start.body.sessionToken,
          code: "AWS-CODE",
        },
        headers: AUTH_HEADERS,
      }),
      [500],
    );
    expect(complete.body).toStrictEqual({ error: "Internal server error" });

    const [session] = await store
      .set(writeDb$)
      .select({
        status: connectorExternalCodeSessions.status,
        errorCode: connectorExternalCodeSessions.errorCode,
        completedAt: connectorExternalCodeSessions.completedAt,
      })
      .from(connectorExternalCodeSessions)
      .where(eq(connectorExternalCodeSessions.id, start.body.sessionId))
      .limit(1);
    expect(session).toMatchObject({
      status: "error",
      errorCode: "complete_failed",
    });
    expect(session?.completedAt).toBeInstanceOf(Date);
  });
});
