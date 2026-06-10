/**
 * CONN-02: AWS external-code authorization sessions through public APIs.
 *
 * The AWS connector is feature-switched (awsConnector) and enabled per test
 * actor through POST /api/zero/feature-switches. Only the AWS Sign-In token
 * exchange and STS GetCallerIdentity endpoints are mocked (MSW).
 *
 * Not rebuilt here:
 * - The legacy corrupted-provider-state trigger (direct ciphertext UPDATE) is
 *   not API-constructible; the same markClaimError/terminal-error statements
 *   are reached through an STS identity-lookup failure instead.
 * - The legacy abort-after-provider-success commit race drove the service
 *   command directly with a custom aborting KMS client; its persistence path
 *   is statement-identical to the happy-path completion covered here.
 */

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsDeferredTokenExchange,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const connectorsApi = createConnectorBddApi(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);

const AWS_REDIRECT_URI =
  "https://us-east-1.signin.aws.amazon.com/v1/sessions/confirmation";

async function awsActor(): Promise<ApiTestUser> {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  await connectorsApi.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.AwsConnector]: true,
  });
  return actor;
}

function expectNoVisibleSecret(value: unknown, secret: string): void {
  expect(JSON.stringify(value)).not.toContain(secret);
}

describe("CONN-02: AWS external-code session lifecycle", () => {
  it("starts, completes, replays, and protects an AWS external-code session through public APIs", async () => {
    const provider = mockAwsExternalCodeProvider();
    const actor = await awsActor();
    const bdd = createBddApi(context);

    const session = await connectorsApi.startExternalCode(actor, "aws", "cli");
    expect(session).toMatchObject({
      type: "aws",
      status: "pending",
      expiresIn: 600,
    });
    const authorizationUrl = new URL(session.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "arn:aws:signin:::devtools/cross-device",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      AWS_REDIRECT_URI,
    );

    const wrongToken = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: `wrong-${session.sessionToken}`,
        code: awsVerificationCode(session.authorizationUrl),
      },
      [404],
    );
    expectApiError(wrongToken.body);
    expect(wrongToken.body.error.message).toBe(
      "External-code authorization session not found",
    );
    expect(provider.tokenRequests).toStrictEqual([]);

    const stranger = bdd.user();
    const crossUser = await connectorsApi.requestExternalCodeComplete(
      stranger,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      },
      [404],
    );
    expectApiError(crossUser.body);
    expect(crossUser.body.error.code).toBe("NOT_FOUND");
    expect(provider.tokenRequests).toStrictEqual([]);

    const beforeComplete = now();
    const complete = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      code: ` ${awsVerificationCode(session.authorizationUrl)} \n`,
    });
    const afterComplete = now();

    expect(provider.tokenRequests).toHaveLength(1);
    expect(provider.tokenRequests[0]).toMatchObject({
      grantType: "authorization_code",
      code: "AWS-CODE",
      redirectUri: AWS_REDIRECT_URI,
    });
    expect(complete.connector).toMatchObject({
      type: "aws",
      authMethod: "cli",
      externalId: "123456789012",
      externalUsername:
        "arn:aws:iam::123456789012:user/external-code (AIDAEXTERNALUSER)",
      oauthScopes: ["openid"],
    });
    expect(complete.connector.tokenExpiresAt).not.toBeNull();
    const tokenExpiresAtMs = Date.parse(
      complete.connector.tokenExpiresAt ?? "",
    );
    expect(tokenExpiresAtMs).toBeGreaterThanOrEqual(beforeComplete + 899_000);
    expect(tokenExpiresAtMs).toBeLessThanOrEqual(afterComplete + 901_000);
    expectNoVisibleSecret(complete, "aws-secret-access-key");
    expectNoVisibleSecret(complete, "aws-login-refresh-token");
    expectNoVisibleSecret(complete, "aws-session-token");

    const readBack = await connectorsApi.readConnectorByType(actor, "aws");
    expect(readBack.id).toBe(complete.connector.id);
    expect(readBack.connectionStatus).toBe("connected");

    const listed = await connectorsApi.listConnectors(actor);
    expect(
      listed.connectors.find((connector) => {
        return connector.type === "aws";
      })?.id,
    ).toBe(complete.connector.id);
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]) {
      expect(listed.connectorProvidedBindings).toContainEqual(
        expect.objectContaining({
          connectorType: "aws",
          authMethod: "cli",
          namespace: "secrets",
          name,
        }),
      );
    }
    for (const name of ["AWS_REGION", "AWS_DEFAULT_REGION"]) {
      expect(listed.connectorProvidedBindings).toContainEqual(
        expect.objectContaining({
          connectorType: "aws",
          authMethod: "cli",
          namespace: "vars",
          name,
        }),
      );
    }

    const secretList = await authOrgApi.listSecrets(actor);
    const connectorSecretNames = secretList.secrets
      .filter((secret) => {
        return secret.type === "connector";
      })
      .map((secret) => {
        return secret.name;
      });
    expect(connectorSecretNames.sort()).toStrictEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_LOGIN_DPOP_KEY",
      "AWS_LOGIN_REFRESH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]);
    expectNoVisibleSecret(secretList, "aws-secret-access-key");
    expectNoVisibleSecret(secretList, "aws-login-refresh-token");

    const replay = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      code: awsVerificationCode(session.authorizationUrl),
    });
    expect(replay.connector.id).toBe(complete.connector.id);
    expect(replay.connector).toMatchObject({
      type: "aws",
      authMethod: "cli",
      externalId: "123456789012",
    });
    expect(provider.tokenRequests).toHaveLength(1);

    await connectorsApi.deleteConnectorByType(actor, "aws");
    const afterDelete = await connectorsApi.requestReadConnectorByType(
      actor,
      "aws",
      [404],
    );
    expectApiError(afterDelete.body);
    expect(afterDelete.body.error.code).toBe("NOT_FOUND");

    const secretsAfterDelete = await authOrgApi.listSecrets(actor);
    expect(
      secretsAfterDelete.secrets.filter((secret) => {
        return secret.type === "connector";
      }),
    ).toStrictEqual([]);

    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("supersedes pending sessions and restores provider-rejected sessions to pending", async () => {
    const provider = mockAwsExternalCodeProvider();
    const actor = await awsActor();

    const first = await connectorsApi.startExternalCode(actor, "aws", "cli");
    const second = await connectorsApi.startExternalCode(actor, "aws", "cli");

    const superseded = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: first.sessionId,
        sessionToken: first.sessionToken,
        code: awsVerificationCode(first.authorizationUrl),
      },
      [400],
    );
    expectApiError(superseded.body);
    expect(superseded.body.error.message).toBe(
      "External-code authorization session was superseded",
    );
    expect(provider.tokenRequests).toStrictEqual([]);

    const rejected = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: second.sessionId,
        sessionToken: second.sessionToken,
        code: awsVerificationCode(second.authorizationUrl, "AWS-BAD"),
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe(
      "External-code authorization code was rejected. Check the code and try again.",
    );

    const retried = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: second.sessionId,
      sessionToken: second.sessionToken,
      code: awsVerificationCode(second.authorizationUrl),
    });
    expect(retried.connector).toMatchObject({
      type: "aws",
      authMethod: "cli",
      externalId: "123456789012",
    });
    expect(provider.tokenRequests).toHaveLength(2);

    const readBack = await connectorsApi.readConnectorByType(actor, "aws");
    expect(readBack.id).toBe(retried.connector.id);

    await connectorsApi.deleteConnectorByType(actor, "aws");
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("rejects completion after the AWS connector switch is disabled", async () => {
    const provider = mockAwsExternalCodeProvider();
    const actor = await awsActor();

    const session = await connectorsApi.startExternalCode(actor, "aws", "cli");
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.AwsConnector]: false,
    });

    const disabled = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      },
      [403],
    );
    expectApiError(disabled.body);
    expect(disabled.body.error.message).toBe(
      "External-code authorization is not enabled for this connector",
    );
    expect(provider.tokenRequests).toStrictEqual([]);
  });

  it("keeps an in-flight completion exclusive without superseding it", async () => {
    const provider = mockAwsDeferredTokenExchange();
    const actor = await awsActor();

    const first = await connectorsApi.startExternalCode(actor, "aws", "cli");
    const heldCompletePromise = connectorsApi.completeExternalCode(
      actor,
      "aws",
      {
        sessionId: first.sessionId,
        sessionToken: first.sessionToken,
        code: awsVerificationCode(first.authorizationUrl),
      },
    );
    await provider.tokenRequestStarted;

    const alreadyCompleting = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: first.sessionId,
        sessionToken: first.sessionToken,
        code: awsVerificationCode(first.authorizationUrl),
      },
      [400],
    );
    expectApiError(alreadyCompleting.body);
    expect(alreadyCompleting.body.error.message).toBe(
      "External-code authorization session is already completing",
    );

    const second = await connectorsApi.startExternalCode(actor, "aws", "cli");
    expect(second.status).toBe("pending");

    provider.releaseTokenResponse();
    const heldComplete = await heldCompletePromise;
    expect(heldComplete.connector).toMatchObject({
      type: "aws",
      authMethod: "cli",
      externalId: "123456789012",
    });
    expect(provider.tokenRequests).toHaveLength(1);

    const secondComplete = await connectorsApi.completeExternalCode(
      actor,
      "aws",
      {
        sessionId: second.sessionId,
        sessionToken: second.sessionToken,
        code: awsVerificationCode(second.authorizationUrl),
      },
    );
    expect(secondComplete.connector.type).toBe("aws");
    expect(provider.tokenRequests).toHaveLength(2);

    await connectorsApi.deleteConnectorByType(actor, "aws");
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("expires external-code sessions past their deadline, including stale completing claims", async () => {
    const guardProvider = mockAwsExternalCodeProvider();
    const actor = await awsActor();

    const base = now();
    mockNow(base);
    const pending = await connectorsApi.startExternalCode(actor, "aws", "cli");
    mockNow(base + 601_000);

    const expired = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: pending.sessionId,
        sessionToken: pending.sessionToken,
        code: awsVerificationCode(pending.authorizationUrl),
      },
      [400],
    );
    expectApiError(expired.body);
    expect(expired.body.error.message).toBe(
      "External-code authorization session expired",
    );

    const expiredAgain = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: pending.sessionId,
        sessionToken: pending.sessionToken,
        code: awsVerificationCode(pending.authorizationUrl),
      },
      [400],
    );
    expectApiError(expiredAgain.body);
    expect(expiredAgain.body.error.message).toBe(
      "External-code authorization session expired",
    );
    expect(guardProvider.tokenRequests).toStrictEqual([]);

    const deferredProvider = mockAwsDeferredTokenExchange();
    const staleBase = base + 700_000;
    mockNow(staleBase);
    const completing = await connectorsApi.startExternalCode(
      actor,
      "aws",
      "cli",
    );
    const heldCompletePromise = connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: completing.sessionId,
        sessionToken: completing.sessionToken,
        code: awsVerificationCode(completing.authorizationUrl),
      },
      [500],
    );
    await deferredProvider.tokenRequestStarted;
    mockNow(staleBase + 31 * 60_000);

    const staleExpired = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: completing.sessionId,
        sessionToken: completing.sessionToken,
        code: awsVerificationCode(completing.authorizationUrl),
      },
      [400],
    );
    expectApiError(staleExpired.body);
    expect(staleExpired.body.error.message).toBe(
      "External-code authorization session expired",
    );

    deferredProvider.releaseTokenResponse();
    const heldComplete = await heldCompletePromise;
    expect(heldComplete.body).toStrictEqual({
      error: "Internal server error",
    });
    expect(deferredProvider.tokenRequests).toHaveLength(1);
  });

  it("marks a session failed when the provider identity lookup fails after token exchange", async () => {
    const provider = mockAwsExternalCodeProvider({ stsFailure: true });
    const actor = await awsActor();

    const session = await connectorsApi.startExternalCode(actor, "aws", "cli");
    const failed = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      },
      [500],
    );
    expect(failed.body).toStrictEqual({ error: "Internal server error" });
    expect(provider.tokenRequests).toHaveLength(1);

    const terminal = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      },
      [400],
    );
    expectApiError(terminal.body);
    expect(terminal.body.error.message).toContain("STS");
    expect(provider.tokenRequests).toHaveLength(1);

    const nothingPersisted = await connectorsApi.requestReadConnectorByType(
      actor,
      "aws",
      [404],
    );
    expectApiError(nothingPersisted.body);
    expect(nothingPersisted.body.error.code).toBe("NOT_FOUND");
  });
});
