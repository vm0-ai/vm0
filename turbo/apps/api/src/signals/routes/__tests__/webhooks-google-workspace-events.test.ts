import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign as signData } from "node:crypto";

import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { chatThreadRoutes } from "../chat-threads";
import { webhooksGoogleWorkspaceEventsRoutes } from "../webhooks-google-workspace-events";
import { workflowAutomationsRoutes } from "../workflow-automations";

const context = testContext();
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);
const workflows = createWorkflowsBddApi(context);

const TOPIC_NAME = "projects/vm0-ai-488909/topics/google-workspace-events";
const PUSH_AUDIENCE = "https://api.vm0.ai/api/webhooks/google-workspace-events";
const PUSH_SERVICE_ACCOUNT =
  "google-workspace-events-push@vm0-ai-488909.iam.gserviceaccount.com";
const OIDC_CERT_KID = "google-workspace-events-test-key";
const SUBSCRIPTION_NAME = "subscriptions/google-meet-test";
const TRANSCRIPT_NAME = "conferenceRecords/123/transcripts/456";
const oidcKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const oidcPublicKeyPem = oidcKeyPair.publicKey.export({
  type: "spki",
  format: "pem",
});

function authHeaders() {
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

function configureGoogleMeetBoundaries(): void {
  mockEnv("OKOU_WEB_URL", "https://www.vm0.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/google-workspace-events-test");
  mockOptionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME", TOPIC_NAME);
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
        access_token: "google-meet-access-token",
        refresh_token: "google-meet-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get("https://www.googleapis.com/oauth2/v2/userinfo", () => {
      return HttpResponse.json({
        id: "google-meet-user-id",
        email: "meet-user@example.test",
        name: "Google Meet User",
      });
    }),
    http.post(
      "https://workspaceevents.googleapis.com/v1/subscriptions",
      async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer google-meet-access-token",
        );
        await expect(request.json()).resolves.toStrictEqual({
          targetResource:
            "//cloudidentity.googleapis.com/users/google-meet-user-id",
          eventTypes: ["google.workspace.meet.transcript.v2.fileGenerated"],
          notificationEndpoint: { pubsubTopic: TOPIC_NAME },
          ttl: "604800s",
        });
        return HttpResponse.json({
          response: {
            name: SUBSCRIPTION_NAME,
            targetResource:
              "//cloudidentity.googleapis.com/users/google-meet-user-id",
            eventTypes: ["google.workspace.meet.transcript.v2.fileGenerated"],
            notificationEndpoint: { pubsubTopic: TOPIC_NAME },
            state: "ACTIVE",
            expireTime: "2099-08-14T00:00:00.000Z",
          },
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
}

async function connectGoogleMeet(
  actor: Parameters<typeof connectors.startOauth>[0],
): Promise<void> {
  const started = await connectors.startOauth(actor, "google-meet", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Google Meet OAuth state");
  }
  await connectors.completeOauthCallback("google-meet", {
    code: "google-meet-code",
    state,
  });
}

function pubSubPushBody(): string {
  const cloudEvent = {
    id: "google-meet-cloud-event",
    source: `//workspaceevents.googleapis.com/${SUBSCRIPTION_NAME}`,
    subject: "//meet.googleapis.com/conferenceRecords/123",
    type: "google.workspace.meet.transcript.v2.fileGenerated",
    time: "2026-08-14T01:00:00.000Z",
    specversion: "1.0",
    data: { transcript: { name: TRANSCRIPT_NAME } },
  };
  return JSON.stringify({
    message: {
      messageId: "google-meet-pubsub-message",
      data: Buffer.from(JSON.stringify(cloudEvent), "utf8").toString("base64"),
    },
    subscription:
      "projects/vm0-ai-488909/subscriptions/google-workspace-events-push",
  });
}

describe("POST /api/webhooks/google-workspace-events", () => {
  it("dispatches a visible Google Meet transcript message", async () => {
    configureGoogleMeetBoundaries();
    const { actor } = await workflows.setupWorkflowOrg();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped workflow actor");
    }
    const agent = await workflows.createAgent(actor, {
      displayName: "Google Meet automation agent",
    });
    const workflowId = await workflows.createWorkflow(actor, {
      agentId: agent.agentId,
      name: "google-meet-transcript-workflow",
    });
    await updateFeatureSwitchesForUser(
      context,
      { orgId: actor.orgId, userId: actor.userId },
      { [FeatureSwitchKey.ConnectorAccounts]: true },
    );
    await connectGoogleMeet(actor);
    mocks.clerk.session(actor.userId, actor.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-meet-transcript-generated",
        },
      }),
      [201],
    );
    if (!created.body.chatThreadId) {
      throw new Error("Expected the automation to bind a chat thread");
    }

    const response = await createApp({
      signal: context.signal,
      routes: webhooksGoogleWorkspaceEventsRoutes,
    }).request("/api/webhooks/google-workspace-events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${signedGoogleIdToken()}`,
        "content-type": "application/json",
      },
      body: pubSubPushBody(),
    });
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
        headers: authHeaders(),
        params: { id: created.body.chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);
  });
});
