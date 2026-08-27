import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomUUID, sign as signData } from "node:crypto";

import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createConnectorBddApi,
  mockGoogleFormsConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { chatThreadRoutes } from "../chat-threads";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { webhooksGoogleFormsRoutes } from "../webhooks-google-forms";

const TEST_APP_ROUTES = Object.freeze([
  ...webhooksGoogleFormsRoutes,
  ...workflowAutomationsRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const workflows = createWorkflowsBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);

const FORM_ID = `1FAIpQLScWebhookGoogleFormsTest${randomUUID().replaceAll("-", "")}`;
const FORM_URL = `https://docs.google.com/forms/d/${FORM_ID}/edit`;
const FORM_TITLE = "Customer survey";
const TOPIC_NAME = "projects/vm0-ai-488909/topics/forms-events";
const AUDIENCE = "https://api.vm0.ai/api/webhooks/google-forms";
const PUSH_SERVICE_ACCOUNT =
  "gmail-pubsub-push@vm0-ai-488909.iam.gserviceaccount.com";
const RUNNER_GROUP = "vm0/google-forms-webhook-test";
const SEED_CURSOR = "2026-08-05T09:30:00.123456Z";
const RESPONSE_CREATE_TIME = "2026-08-05T10:00:00.654000Z";
const RESPONSE_SUBMITTED_TIME = "2026-08-05T10:00:00.654321Z";
const OIDC_CERT_KID = "google-forms-pubsub-test-key";
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
    aud: AUDIENCE,
    email: PUSH_SERVICE_ACCOUNT,
    email_verified: true,
    exp: issuedAt + 600,
    iat: issuedAt,
    iss: "https://accounts.google.com",
    sub: "google-forms-pubsub-test-subject",
  };
  const signedContent = `${encodeJwtPart(header)}.${encodeJwtPart(payload)}`;
  const signature = signData(
    "RSA-SHA256",
    Buffer.from(signedContent, "utf8"),
    oidcKeyPair.privateKey,
  );
  return `${signedContent}.${signature.toString("base64url")}`;
}

function configureEnvironment(): void {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", RUNNER_GROUP);
  mockOptionalEnv("GOOGLE_FORMS_PUBSUB_TOPIC_NAME", TOPIC_NAME);
  mockOptionalEnv("GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE", AUDIENCE);
  mockOptionalEnv(
    "GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    PUSH_SERVICE_ACCOUNT,
  );
  server.use(
    http.get("https://www.googleapis.com/oauth2/v1/certs", () => {
      return HttpResponse.json(
        { [OIDC_CERT_KID]: oidcPublicKeyPem },
        { headers: { "cache-control": "no-cache" } },
      );
    }),
  );
}

interface FormsApiRecorder {
  responseFilters: string[];
  responseFields: string[];
  watchIds: string[];
}

function configureFormsApi(): FormsApiRecorder {
  const recorder: FormsApiRecorder = {
    responseFilters: [],
    responseFields: [],
    watchIds: [],
  };
  server.use(
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId",
      ({ request, params }) => {
        expect(params.formId).toBe(FORM_ID);
        expect(request.headers.get("authorization")).toBe(
          "Bearer google-forms-access-token",
        );
        return HttpResponse.json({
          formId: FORM_ID,
          info: { title: FORM_TITLE },
          publishSettings: {
            publishState: {
              isPublished: true,
              isAcceptingResponses: true,
            },
          },
        });
      },
    ),
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId/responses",
      ({ request, params }) => {
        expect(params.formId).toBe(FORM_ID);
        expect(request.headers.get("authorization")).toBe(
          "Bearer google-forms-access-token",
        );
        const url = new URL(request.url);
        const fields = url.searchParams.get("fields");
        if (!fields) {
          throw new Error("Expected Google Forms responses fields mask");
        }
        recorder.responseFields.push(fields);
        const filter = url.searchParams.get("filter");
        if (filter === null) {
          if (url.searchParams.get("pageSize") !== "1") {
            throw new Error("Expected a one-response cursor seed request");
          }
          return HttpResponse.json({
            responses: [
              {
                responseId: "seed-response",
                createTime: SEED_CURSOR,
                lastSubmittedTime: SEED_CURSOR,
              },
            ],
          });
        }
        recorder.responseFilters.push(filter);
        return HttpResponse.json({
          responses: [
            {
              responseId: "response-1",
              createTime: RESPONSE_CREATE_TIME,
              lastSubmittedTime: RESPONSE_SUBMITTED_TIME,
              respondentEmail: "respondent@example.test",
            },
          ],
        });
      },
    ),
    http.post(
      "https://forms.googleapis.com/v1/forms/:formId/watches",
      async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({
          watch: {
            target: { topic: { topicName: TOPIC_NAME } },
            eventType: "RESPONSES",
          },
        });
        const watchId = `forms-watch-${randomUUID()}`;
        recorder.watchIds.push(watchId);
        return HttpResponse.json({
          id: watchId,
          createTime: "2026-08-05T09:45:00Z",
          expireTime: "2099-08-12T09:45:00Z",
          eventType: "RESPONSES",
          target: { topic: { topicName: TOPIC_NAME } },
        });
      },
    ),
  );
  return recorder;
}

function formsPushBody(messageId: string, watchId: string): string {
  return JSON.stringify({
    message: {
      messageId,
      attributes: {
        formId: FORM_ID,
        watchId,
        eventType: "RESPONSES",
      },
    },
  });
}

async function postWebhook(rawBody: string): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request("/api/webhooks/google-forms", {
    method: "POST",
    headers: {
      authorization: `Bearer ${signedGoogleIdToken()}`,
      "Content-Type": "application/json",
    },
    body: rawBody,
  });
  return { status: response.status, body: await response.json() };
}

function eventContextFromAgentPrompt(prompt: string): Record<string, unknown> {
  const marker = "\nEvent data:\n";
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error("Expected automation event payload in the agent prompt");
  }
  const parsed = JSON.parse(
    prompt.slice(markerIndex + marker.length),
  ) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected automation event payload object");
  }
  return parsed as Record<string, unknown>;
}

describe("Google Forms Pub/Sub webhook", () => {
  it("delivers metadata without data, then de-duplicates a retry", async () => {
    configureEnvironment();
    const formsApi = configureFormsApi();
    const { actor } = await workflows.setupWorkflowOrg();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped workflow actor");
    }
    const agent = await workflows.createAgent(actor, {
      displayName: "Google Forms automation agent",
    });
    const workflowId = await workflows.createWorkflow(actor, {
      agentId: agent.agentId,
      name: "google-forms-response-workflow",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:member");
    await updateFeatureSwitchesForUser(
      context,
      { orgId: actor.orgId, userId: actor.userId },
      {
        [FeatureSwitchKey.GoogleFormsWorkflowAutomations]: true,
      },
    );
    mockGoogleFormsConnectorOAuth();
    await workflows.connectConnector(actor, "google-forms");
    const connector = await connectors.readConnectorBySlug(
      actor,
      "google-forms",
    );
    mocks.clerk.session(actor.userId, actor.orgId, "org:member");

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: FORM_URL,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "google-forms-response-submitted" ||
      !created.body.chatThreadId
    ) {
      throw new Error("Expected a Google Forms response automation");
    }
    expect(created.body.eventConfig.connectorId).toBe(connector.id);
    expect(created.body).not.toHaveProperty("warning");

    const watchId = formsApi.watchIds[0];
    if (!watchId) {
      throw new Error("Expected a Google Forms watch id");
    }
    const push = formsPushBody("pubsub-forms-1", watchId);
    const first = await postWebhook(push);
    expect(first).toStrictEqual({
      status: 200,
      body: {
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      },
    });
    expect(formsApi.responseFilters[0]).toBe(`timestamp > ${SEED_CURSOR}`);
    expect(formsApi.responseFields).toContain(
      "responses(responseId,createTime,lastSubmittedTime,respondentEmail),nextPageToken",
    );

    const events = await workflows.readThreadEvents(created.body.chatThreadId);
    const visibleEvent = events.find((event) => {
      return (
        event.eventType === "input.automation" ||
        event.eventType === "input.prompt"
      );
    });
    if (!visibleEvent) {
      throw new Error("Expected a visible Google Forms automation event");
    }
    expect(chatEventDisplayText(visibleEvent)).toBe(
      `A new response from respondent@example.test was submitted to Google Form "${FORM_TITLE}".`,
    );
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(),
        params: { id: created.body.chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);
    const runId = events.find((event) => {
      return event.eventType === "input.prompt" && event.runId;
    })?.runId;
    if (!runId) {
      throw new Error("Expected a dispatched Google Forms workflow run");
    }
    await runs.heartbeatRunner(RUNNER_GROUP);
    const claim = await runs.claimRunnerJob(runId);
    const eventContext = eventContextFromAgentPrompt(claim.prompt);
    expect(eventContext).toStrictEqual({
      automationId: created.body.id,
      formId: FORM_ID,
      formTitle: FORM_TITLE,
      formUrl: FORM_URL,
      responseId: "response-1",
      changeType: "created",
      createTime: RESPONSE_CREATE_TIME,
      lastSubmittedTime: RESPONSE_SUBMITTED_TIME,
      respondentEmail: "respondent@example.test",
      previouslyDelivered: false,
    });
    expect(eventContext).not.toHaveProperty("answers");
    expect(claim.appendSystemPrompt).toContain("# Agent Identity");
    expect(claim.appendSystemPrompt).not.toContain("# Current context");

    const retry = await postWebhook(push);
    expect(retry).toStrictEqual({
      status: 200,
      body: {
        success: true,
        watchStates: 1,
        dispatched: 0,
        duplicates: 1,
      },
    });
    const fallback = await postWebhook(
      formsPushBody("pubsub-forms-fallback", `missing-watch-${randomUUID()}`),
    );
    expect(fallback).toStrictEqual({
      status: 200,
      body: {
        success: true,
        watchStates: 1,
        dispatched: 0,
        duplicates: 1,
      },
    });
    expect(formsApi.responseFilters[1]).toBe(
      `timestamp > ${RESPONSE_SUBMITTED_TIME}`,
    );
    await flushWaitUntilForTest();
  });

  it("routes a shared-form notification by watch id without fanout", async () => {
    configureEnvironment();
    const formsApi = configureFormsApi();
    const createdAutomations: {
      readonly chatThreadId: string;
      readonly orgId: string;
      readonly userId: string;
    }[] = [];

    for (const suffix of ["first", "second"] as const) {
      const { actor } = await workflows.setupWorkflowOrg();
      if (!actor.orgId) {
        throw new Error("Expected an org-scoped workflow actor");
      }
      const agent = await workflows.createAgent(actor, {
        displayName: `Google Forms ${suffix} agent`,
      });
      const workflowId = await workflows.createWorkflow(actor, {
        agentId: agent.agentId,
        name: `google-forms-${suffix}-workflow`,
      });
      mocks.clerk.session(actor.userId, actor.orgId, "org:member");
      await updateFeatureSwitchesForUser(
        context,
        { orgId: actor.orgId, userId: actor.userId },
        { [FeatureSwitchKey.GoogleFormsWorkflowAutomations]: true },
      );
      mockGoogleFormsConnectorOAuth();
      await workflows.connectConnector(actor, "google-forms");
      mocks.clerk.session(actor.userId, actor.orgId, "org:member");
      const created = await accept(
        automationsClient().create({
          headers: authHeaders(),
          params: { workflowId },
          body: {
            kind: "event",
            eventType: "google-forms-response-submitted",
            eventConfig: {
              provider: "google-forms",
              event: "response_submitted",
              formUrl: FORM_URL,
            },
          },
        }),
        [201],
      );
      if (!created.body.chatThreadId) {
        throw new Error("Expected a Google Forms automation chat thread");
      }
      createdAutomations.push({
        chatThreadId: created.body.chatThreadId,
        orgId: actor.orgId,
        userId: actor.userId,
      });
    }

    const firstWatchId = formsApi.watchIds[0];
    if (!firstWatchId) {
      throw new Error("Expected the first Google Forms watch id");
    }
    const delivered = await postWebhook(
      formsPushBody("pubsub-shared-form", firstWatchId),
    );
    expect(delivered).toStrictEqual({
      status: 200,
      body: {
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      },
    });

    const firstAutomation = createdAutomations[0];
    const secondAutomation = createdAutomations[1];
    if (!firstAutomation || !secondAutomation) {
      throw new Error("Expected two Google Forms automations");
    }
    mocks.clerk.session(
      firstAutomation.userId,
      firstAutomation.orgId,
      "org:member",
    );
    const firstEvents = await workflows.readThreadEvents(
      firstAutomation.chatThreadId,
    );
    mocks.clerk.session(
      secondAutomation.userId,
      secondAutomation.orgId,
      "org:member",
    );
    const secondEvents = await workflows.readThreadEvents(
      secondAutomation.chatThreadId,
    );
    expect(
      firstEvents.some((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.runId !== null &&
          event.runId !== undefined
        );
      }),
    ).toBeTruthy();
    expect(
      secondEvents.some((event) => {
        return event.eventType === "input.prompt";
      }),
    ).toBeFalsy();
    await flushWaitUntilForTest();
  });
});
