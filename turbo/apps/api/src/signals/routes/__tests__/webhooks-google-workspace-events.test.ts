import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomUUID, sign as signData } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { testGoogleMeetSubscriptionRenewalContract } from "@okouai/api-contracts/contracts/test-google-meet-subscription-renewal";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import { testGoogleMeetSubscriptionRenewalRoutes } from "../test-google-meet-subscription-renewal";
import { webhooksGoogleWorkspaceEventsRoutes } from "../webhooks-google-workspace-events";
import { workflowAutomationsRoutes } from "../workflow-automations";

const context = testContext();
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);
const workflows = createWorkflowsBddApi(context);

const PUSH_AUDIENCE = "https://api.vm0.ai/api/webhooks/google-workspace-events";
const PUSH_SERVICE_ACCOUNT =
  "google-workspace-events-push@vm0-ai-488909.iam.gserviceaccount.com";
const OIDC_CERT_KID = "google-workspace-events-test-key";
const oidcKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const oidcPublicKeyPem = oidcKeyPair.publicKey.export({
  type: "spki",
  format: "pem",
});

type OrgActor = ApiTestUser & { readonly orgId: string };

interface GoogleMeetProviderOptions {
  readonly createStatus?: number;
  readonly deleteStatus?: number;
  readonly expireTime?: string;
  readonly tokenExpiresInSeconds?: number;
  readonly onDelete?: () => Promise<void>;
}

interface GoogleMeetProviderRecorder {
  readonly createdNames: string[];
  readonly deletedUrls: string[];
  readonly operations: string[];
  readonly topicName: string;
  readonly externalId: string;
  renewCalls: number;
  reactivateCalls: number;
}

interface GoogleMeetFixture {
  readonly actor: OrgActor;
  readonly workflowId: string;
  readonly connectorId: string;
  readonly provider: GoogleMeetProviderRecorder;
}

function authHeaders(actor: OrgActor) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

function connectorAccountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function renewalClient() {
  return setupApp({
    context,
    routes: testGoogleMeetSubscriptionRenewalRoutes,
  })(testGoogleMeetSubscriptionRenewalContract);
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signedGoogleIdToken(): string {
  const issuedAt = Math.floor(now() / 1000);
  const header = { alg: "RS256", kid: OIDC_CERT_KID, typ: "JWT" };
  const payload = {
    aud: PUSH_AUDIENCE,
    email: PUSH_SERVICE_ACCOUNT,
    email_verified: true,
    exp: issuedAt + 600,
    iat: issuedAt,
    iss: "https://accounts.google.com",
    sub: "google-workspace-events-test-subject",
  };
  const signedContent = `${encodeJwtPart(header)}.${encodeJwtPart(payload)}`;
  const signature = signData(
    "RSA-SHA256",
    Buffer.from(signedContent, "utf8"),
    oidcKeyPair.privateKey,
  );
  return `${signedContent}.${signature.toString("base64url")}`;
}

function configureGoogleMeetBoundaries(
  options: GoogleMeetProviderOptions = {},
): GoogleMeetProviderRecorder {
  const testId = randomUUID();
  const accessToken = `google-meet-access-${testId}`;
  const recorder: GoogleMeetProviderRecorder = {
    createdNames: [],
    deletedUrls: [],
    operations: [],
    topicName: `projects/vm0-ai-488909/topics/google-workspace-events-${testId}`,
    externalId: `google-meet-user-${testId}`,
    renewCalls: 0,
    reactivateCalls: 0,
  };

  mockEnv("OKOU_WEB_URL", "https://www.vm0.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  mockOptionalEnv(
    "RUNNER_DEFAULT_GROUP",
    `vm0/google-workspace-events-${testId}`,
  );
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME",
    recorder.topicName,
  );
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE",
    PUSH_AUDIENCE,
  );
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    PUSH_SERVICE_ACCOUNT,
  );

  server.use(
    http.post("https://oauth2.googleapis.com/token", () => {
      return HttpResponse.json({
        access_token: accessToken,
        refresh_token: `google-meet-refresh-${testId}`,
        expires_in: options.tokenExpiresInSeconds ?? 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get("https://www.googleapis.com/oauth2/v2/userinfo", () => {
      return HttpResponse.json({
        id: recorder.externalId,
        email: `meet-${testId}@example.test`,
        name: "Google Meet User",
      });
    }),
    http.post(
      "https://workspaceevents.googleapis.com/v1/subscriptions",
      async ({ request }) => {
        const requestText = await request.text();
        if (
          !requestText.includes(recorder.topicName) ||
          !requestText.includes(recorder.externalId)
        ) {
          return HttpResponse.text("unowned test subscription", {
            status: 503,
          });
        }
        const call = recorder.createdNames.length + 1;
        const subscriptionName = `subscriptions/google-meet-${testId}-${call}`;
        recorder.createdNames.push(subscriptionName);
        recorder.operations.push(`create:${subscriptionName}`);
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${accessToken}`,
        );
        const body: unknown = JSON.parse(requestText);
        expect(body).toStrictEqual({
          targetResource: `//cloudidentity.googleapis.com/users/${recorder.externalId}`,
          eventTypes: ["google.workspace.meet.transcript.v2.fileGenerated"],
          notificationEndpoint: { pubsubTopic: recorder.topicName },
          ttl: "604800s",
        });
        if (options.createStatus !== undefined) {
          return HttpResponse.text("create failed", {
            status: options.createStatus,
          });
        }
        return HttpResponse.json({
          response: {
            name: subscriptionName,
            targetResource: `//cloudidentity.googleapis.com/users/${recorder.externalId}`,
            eventTypes: ["google.workspace.meet.transcript.v2.fileGenerated"],
            notificationEndpoint: { pubsubTopic: recorder.topicName },
            state: "ACTIVE",
            expireTime: options.expireTime ?? "2099-08-14T00:00:00.000Z",
          },
        });
      },
    ),
    http.patch(
      /^https:\/\/workspaceevents\.googleapis\.com\/v1\/subscriptions\/[^/]+$/,
      async ({ request }) => {
        const subscriptionName = new URL(request.url).pathname.slice(
          "/v1/".length,
        );
        if (!subscriptionName.includes(testId)) {
          return HttpResponse.text("unowned test subscription", {
            status: 503,
          });
        }
        recorder.renewCalls += 1;
        recorder.operations.push(`renew:${subscriptionName}`);
        expect(new URL(request.url).searchParams.get("updateMask")).toBe("ttl");
        await expect(request.json()).resolves.toStrictEqual({
          name: subscriptionName,
          ttl: "604800s",
        });
        return HttpResponse.json({
          response: {
            name: subscriptionName,
            state: "ACTIVE",
            expireTime: "2099-08-14T00:00:00.000Z",
          },
        });
      },
    ),
    http.post(
      /^https:\/\/workspaceevents\.googleapis\.com\/v1\/subscriptions\/[^/]+:reactivate$/,
      ({ request }) => {
        if (!request.url.includes(testId)) {
          return HttpResponse.text("unowned test subscription", {
            status: 503,
          });
        }
        recorder.reactivateCalls += 1;
        return HttpResponse.json({
          response: {
            name: recorder.createdNames.at(-1),
            state: "ACTIVE",
            expireTime: "2099-08-14T00:00:00.000Z",
          },
        });
      },
    ),
    http.delete(
      /^https:\/\/workspaceevents\.googleapis\.com\/v1\/subscriptions\/[^/]+$/,
      async ({ request }) => {
        const url = new URL(request.url);
        const subscriptionName = url.pathname.slice("/v1/".length);
        if (!subscriptionName.includes(testId)) {
          return HttpResponse.text("unowned test subscription", {
            status: 503,
          });
        }
        recorder.deletedUrls.push(url.toString());
        recorder.operations.push(`delete-start:${subscriptionName}`);
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${accessToken}`,
        );
        expect(url.searchParams.get("allowMissing")).toBe("true");
        await options.onDelete?.();
        recorder.operations.push(`delete-end:${subscriptionName}`);
        if (options.deleteStatus !== undefined) {
          return HttpResponse.text("delete failed", {
            status: options.deleteStatus,
          });
        }
        return HttpResponse.json({
          name: `operations/delete-google-meet-${testId}`,
          done: true,
        });
      },
    ),
    http.get("https://www.googleapis.com/oauth2/v1/certs", () => {
      return HttpResponse.json(
        { [OIDC_CERT_KID]: oidcPublicKeyPem },
        { headers: { "cache-control": "no-cache" } },
      );
    }),
  );
  return recorder;
}

async function connectGoogleMeet(actor: OrgActor): Promise<string> {
  const started = await connectors.startOauth(actor, "google-meet", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Google Meet OAuth state");
  }
  await connectors.completeOauthCallback("google-meet", {
    code: "google-meet-code",
    state,
  });
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "google-meet",
  );
  const account = accounts[0];
  if (accounts.length !== 1 || !account) {
    throw new Error("Expected one Google Meet connector account");
  }
  return account.id;
}

async function setupFixture(
  options: GoogleMeetProviderOptions = {},
): Promise<GoogleMeetFixture> {
  const provider = configureGoogleMeetBoundaries(options);
  const { actor } = await workflows.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const orgActor: OrgActor = { ...actor, orgId: actor.orgId };
  const agent = await workflows.createAgent(orgActor, {
    displayName: "Google Meet automation agent",
  });
  const workflowId = await workflows.createWorkflow(orgActor, {
    agentId: agent.agentId,
    name: `google-meet-transcript-${randomUUID()}`,
  });
  await updateFeatureSwitchesForUser(
    context,
    { orgId: orgActor.orgId, userId: orgActor.userId },
    { [FeatureSwitchKey.ConnectorAccounts]: true },
  );
  const connectorId = await connectGoogleMeet(orgActor);
  context.mocks.s3.send.mockResolvedValue({});
  return { actor: orgActor, workflowId, connectorId, provider };
}

async function createMeetAutomation(
  fixture: GoogleMeetFixture,
  enabled?: boolean,
) {
  return await accept(
    automationsClient().create({
      headers: authHeaders(fixture.actor),
      params: { workflowId: fixture.workflowId },
      body: {
        kind: "event",
        eventType: "google-meet-transcript-generated",
        ...(enabled === undefined ? {} : { enabled }),
      },
    }),
    [201],
  );
}

function pubSubPushBody(
  subscriptionName: string,
  eventId: string = randomUUID(),
): string {
  const cloudEvent = {
    id: `google-meet-cloud-event-${eventId}`,
    source: `//workspaceevents.googleapis.com/${subscriptionName}`,
    subject: `//meet.googleapis.com/conferenceRecords/${eventId}`,
    type: "google.workspace.meet.transcript.v2.fileGenerated",
    time: "2026-08-14T01:00:00.000Z",
    specversion: "1.0",
    data: {
      transcript: {
        name: `conferenceRecords/${eventId}/transcripts/${eventId}`,
      },
    },
  };
  return JSON.stringify({
    message: {
      messageId: `google-meet-pubsub-${eventId}`,
      data: Buffer.from(JSON.stringify(cloudEvent), "utf8").toString("base64"),
    },
    subscription:
      "projects/vm0-ai-488909/subscriptions/google-workspace-events-push",
  });
}

async function postWorkspaceEvent(subscriptionName: string): Promise<Response> {
  return await createApp({
    signal: context.signal,
    routes: webhooksGoogleWorkspaceEventsRoutes,
  }).request("/api/webhooks/google-workspace-events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${signedGoogleIdToken()}`,
      "content-type": "application/json",
    },
    body: pubSubPushBody(subscriptionName),
  });
}

describe("Google Workspace Events subscription lifecycle", () => {
  it("dispatches a visible Google Meet transcript message", async () => {
    const fixture = await setupFixture();
    const created = await createMeetAutomation(fixture);
    if (!created.body.chatThreadId) {
      throw new Error("Expected the automation to bind a chat thread");
    }
    const subscriptionName = fixture.provider.createdNames[0];
    if (!subscriptionName) {
      throw new Error("Expected a Workspace Events subscription");
    }

    const response = await postWorkspaceEvent(subscriptionName);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });

    const events = await workflows.readThreadEvents(created.body.chatThreadId);
    const visibleEvent = events.find((event) => {
      return (
        event.eventType === "input.automation" ||
        event.eventType === "input.prompt"
      );
    });
    if (!visibleEvent) {
      throw new Error("Expected a visible Google Meet automation event");
    }
    expect(chatEventDisplayText(visibleEvent)).toBe(
      "A Google Meet transcript is ready.",
    );
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.id },
      }),
      [204],
    );
  });

  it("does not create provider state for a disabled automation", async () => {
    const fixture = await setupFixture();
    const created = await createMeetAutomation(fixture, false);

    expect(created.body.enabled).toBeFalsy();
    expect(fixture.provider.operations).toStrictEqual([]);

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.id },
      }),
      [204],
    );
    expect(fixture.provider.operations).toStrictEqual([]);
  });

  it("rolls back active create and enable when provider setup fails", async () => {
    const fixture = await setupFixture({ createStatus: 503 });
    const disabled = await createMeetAutomation(fixture, false);

    const enableFailure = await accept(
      automationsClient().enable({
        headers: authHeaders(fixture.actor),
        params: { id: disabled.body.id },
      }),
      [400],
    );
    expect(enableFailure.body.error.message).toContain(
      "Failed to ensure Google Meet Workspace Events subscription",
    );

    const createFailure = await accept(
      automationsClient().create({
        headers: authHeaders(fixture.actor),
        params: { workflowId: fixture.workflowId },
        body: {
          kind: "event",
          eventType: "google-meet-transcript-generated",
        },
      }),
      [400],
    );
    expect(createFailure.body.error.message).toContain(
      "Failed to ensure Google Meet Workspace Events subscription",
    );

    const listed = await accept(
      automationsClient().list({
        headers: authHeaders(fixture.actor),
        params: { workflowId: fixture.workflowId },
      }),
      [200],
    );
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      id: disabled.body.id,
      enabled: false,
    });
    expect(fixture.provider.createdNames).toHaveLength(2);
    expect(fixture.provider.deletedUrls).toStrictEqual([]);
  });

  it("keeps a shared subscription until the last enabled consumer", async () => {
    const fixture = await setupFixture();
    const first = await createMeetAutomation(fixture);
    const second = await createMeetAutomation(fixture);
    expect(fixture.provider.createdNames).toHaveLength(1);

    await accept(
      automationsClient().disable({
        headers: authHeaders(fixture.actor),
        params: { id: first.body.id },
      }),
      [200],
    );
    expect(fixture.provider.deletedUrls).toStrictEqual([]);

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: second.body.id },
      }),
      [204],
    );
    expect(fixture.provider.deletedUrls).toHaveLength(1);
    expect(fixture.provider.deletedUrls[0]).toContain(
      `/${fixture.provider.createdNames[0]}?allowMissing=true`,
    );

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: first.body.id },
      }),
      [204],
    );
    expect(fixture.provider.deletedUrls).toHaveLength(1);
  });

  it("fails closed and does not retry after provider delete failure", async () => {
    const fixture = await setupFixture({ deleteStatus: 503 });
    const created = await createMeetAutomation(fixture);
    const subscriptionName = fixture.provider.createdNames[0];
    if (!subscriptionName) {
      throw new Error("Expected a Workspace Events subscription");
    }

    await accept(
      automationsClient().disable({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(fixture.provider.deletedUrls).toHaveLength(1);

    const delayed = await postWorkspaceEvent(subscriptionName);
    expect(delayed.status).toBe(200);
    await expect(delayed.json()).resolves.toStrictEqual({
      success: true,
      watchStates: 0,
      dispatched: 0,
      duplicates: 0,
    });

    const renewed = await accept(
      renewalClient().renew({
        body: {
          org_id: fixture.actor.orgId,
          user_id: fixture.actor.userId,
        },
      }),
      [200],
    );
    expect(renewed.body).toMatchObject({
      success: true,
      renewed: 0,
      repaired: 0,
    });
    expect(fixture.provider.createdNames).toHaveLength(1);
    expect(fixture.provider.renewCalls).toBe(0);
  });

  it("commits connector deletion before one best-effort provider delete", async () => {
    const deleteStarted = createDeferredPromise<void>(context.signal);
    const deleteRelease = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!deleteRelease.settled()) {
        deleteRelease.resolve();
      }
    });
    const fixture = await setupFixture({
      deleteStatus: 503,
      tokenExpiresInSeconds: 60,
      onDelete: async () => {
        deleteStarted.resolve();
        await deleteRelease.promise;
      },
    });
    await createMeetAutomation(fixture);
    const subscriptionName = fixture.provider.createdNames[0];
    if (!subscriptionName) {
      throw new Error("Expected a Workspace Events subscription");
    }
    mockOptionalEnv(
      "GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME",
      `${fixture.provider.topicName}-replacement`,
    );

    const deletion = connectorAccountsClient().delete({
      headers: authHeaders(fixture.actor),
      params: { connectionId: fixture.connectorId },
      body: { target: { kind: "builtin", connectorSlug: "google-meet" } },
    });
    await deleteStarted.promise;
    const accountsWhileDeleteIsPending =
      await connectors.listBuiltinConnectorAccounts(
        fixture.actor,
        "google-meet",
      );
    expect(accountsWhileDeleteIsPending).toStrictEqual([]);
    deleteRelease.resolve();

    const deleted = await accept(deletion, [200]);
    expect(deleted.body).toStrictEqual({
      deletedConnectionId: fixture.connectorId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: null,
    });
    expect(fixture.provider.deletedUrls).toHaveLength(1);
    expect(fixture.provider.deletedUrls[0]).toContain(
      `/${subscriptionName}?allowMissing=true`,
    );
    const automations = await accept(
      automationsClient().list({
        headers: authHeaders(fixture.actor),
        params: { workflowId: fixture.workflowId },
      }),
      [200],
    );
    const automation = automations.body[0];
    if (!automation) {
      throw new Error("Expected the Google Meet automation");
    }
    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: automation.id },
      }),
      [204],
    );
  });

  it("serializes last-consumer cleanup with a concurrent enable", async () => {
    const deleteStarted = createDeferredPromise<void>(context.signal);
    const deleteRelease = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!deleteRelease.settled()) {
        deleteRelease.resolve();
      }
    });
    const fixture = await setupFixture({
      onDelete: async () => {
        deleteStarted.resolve();
        await deleteRelease.promise;
      },
    });
    const active = await createMeetAutomation(fixture);
    const disabled = await createMeetAutomation(fixture, false);

    const disableRequest = automationsClient().disable({
      headers: authHeaders(fixture.actor),
      params: { id: active.body.id },
    });
    await deleteStarted.promise;
    const enableRequest = automationsClient().enable({
      headers: authHeaders(fixture.actor),
      params: { id: disabled.body.id },
    });

    let enabledVisible = false;
    for (let attempt = 0; attempt < 100 && !enabledVisible; attempt += 1) {
      const listed = await accept(
        automationsClient().list({
          headers: authHeaders(fixture.actor),
          params: { workflowId: fixture.workflowId },
        }),
        [200],
      );
      enabledVisible =
        listed.body.find((automation) => {
          return automation.id === disabled.body.id;
        })?.enabled === true;
    }
    expect(enabledVisible).toBeTruthy();
    expect(fixture.provider.createdNames).toHaveLength(1);
    deleteRelease.resolve();

    await accept(disableRequest, [200]);
    await accept(enableRequest, [200]);
    expect(fixture.provider.createdNames).toHaveLength(2);
    expect(fixture.provider.operations).toStrictEqual([
      `create:${fixture.provider.createdNames[0]}`,
      `delete-start:${fixture.provider.createdNames[0]}`,
      `delete-end:${fixture.provider.createdNames[0]}`,
      `create:${fixture.provider.createdNames[1]}`,
    ]);

    await accept(
      automationsClient().disable({
        headers: authHeaders(fixture.actor),
        params: { id: disabled.body.id },
      }),
      [200],
    );
    expect(fixture.provider.deletedUrls).toHaveLength(2);
    expect(fixture.provider.deletedUrls[1]).toContain(
      `/${fixture.provider.createdNames[1]}?allowMissing=true`,
    );
  });

  it("renews a due subscription while an enabled consumer remains", async () => {
    const fixture = await setupFixture({
      expireTime: new Date(now() + 30 * 60 * 1000).toISOString(),
    });
    const created = await createMeetAutomation(fixture);

    const renewed = await accept(
      renewalClient().renew({
        body: {
          org_id: fixture.actor.orgId,
          user_id: fixture.actor.userId,
        },
      }),
      [200],
    );
    const unchanged = await accept(
      renewalClient().renew({
        body: {
          org_id: fixture.actor.orgId,
          user_id: fixture.actor.userId,
        },
      }),
      [200],
    );
    expect(renewed.body).toMatchObject({
      success: true,
      renewed: 1,
      repaired: 0,
    });
    expect(unchanged.body).toMatchObject({
      success: true,
      renewed: 0,
      repaired: 0,
    });
    expect(fixture.provider.renewCalls).toBe(1);

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.id },
      }),
      [204],
    );
  });
});
