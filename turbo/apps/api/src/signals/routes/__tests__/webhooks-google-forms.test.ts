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
  authorizationHeaders: string[];
  responseFilters: string[];
  responseFields: string[];
  watchIds: string[];
}

function configureFormsApi(
  allowedAccessTokens: readonly string[] = ["google-forms-access-token"],
): FormsApiRecorder {
  const recorder: FormsApiRecorder = {
    authorizationHeaders: [],
    responseFilters: [],
    responseFields: [],
    watchIds: [],
  };
  server.use(
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId",
      ({ request, params }) => {
        expect(params.formId).toBe(FORM_ID);
        const authorization = request.headers.get("authorization");
        expect(authorization).not.toBeNull();
        expect(allowedAccessTokens).toContain(
          authorization?.replace("Bearer ", ""),
        );
        recorder.authorizationHeaders.push(authorization ?? "");
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
        const authorization = request.headers.get("authorization");
        expect(authorization).not.toBeNull();
        expect(allowedAccessTokens).toContain(
          authorization?.replace("Bearer ", ""),
        );
        recorder.authorizationHeaders.push(authorization ?? "");
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

async function setupGoogleFormsAutomation() {
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
      [FeatureSwitchKey.ConnectorAccounts]: true,
    },
  );
  mockGoogleFormsConnectorOAuth();
  await workflows.connectConnector(actor, "google-forms");
  const connector = await connectors.readConnectorBySlug(actor, "google-forms");
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
  const chatThreadId = created.body.chatThreadId;
  if (
    created.body.kind !== "event" ||
    created.body.eventType !== "google-forms-response-submitted" ||
    !chatThreadId
  ) {
    throw new Error("Expected a Google Forms response automation");
  }
  expect(created.body.eventConfig.connectorId).toBe(connector.id);
  expect(created.body).not.toHaveProperty("warning");
  return { automationId: created.body.id, chatThreadId, formsApi };
}

describe("Google Forms Pub/Sub webhook", () => {
  it("delivers metadata without response data", async () => {
    const { automationId, chatThreadId, formsApi } =
      await setupGoogleFormsAutomation();
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

    const events = await workflows.readThreadEvents(chatThreadId);
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
      automationId,
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
    await flushWaitUntilForTest();
  });

  it("de-duplicates a retry and ignores an unknown watch id", async () => {
    const { formsApi } = await setupGoogleFormsAutomation();
    const watchId = formsApi.watchIds[0];
    if (!watchId) {
      throw new Error("Expected a Google Forms watch id");
    }
    const push = formsPushBody("pubsub-forms-retry", watchId);
    const first = await postWebhook(push);
    expect(first).toMatchObject({
      status: 200,
      body: { watchStates: 1, dispatched: 1, duplicates: 0 },
    });
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
        watchStates: 0,
        dispatched: 0,
        duplicates: 0,
      },
    });
    expect(formsApi.responseFilters).toHaveLength(2);
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
    const { actor: firstActor } = await workflows.setupWorkflowOrg();
    if (!firstActor.orgId) {
      throw new Error("Expected an org-scoped workflow actor");
    }
    const secondActor = workflows.user({ orgId: firstActor.orgId });

    for (const { actor, suffix } of [
      { actor: firstActor, suffix: "first" },
      { actor: secondActor, suffix: "second" },
    ] as const) {
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

  async function setupGoogleFormsMultiAccountAutomations() {
    configureEnvironment();
    const formsApi = configureFormsApi([
      "google-forms-access-token",
      "google-forms-second-access-token",
    ]);
    const { actor } = await workflows.setupWorkflowOrg();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped workflow actor");
    }
    const agent = await workflows.createAgent(actor, {
      displayName: "Google Forms multi-account agent",
    });
    const firstWorkflowId = await workflows.createWorkflow(actor, {
      agentId: agent.agentId,
      name: "google-forms-first-account-workflow",
    });
    const secondWorkflowId = await workflows.createWorkflow(actor, {
      agentId: agent.agentId,
      name: "google-forms-second-account-workflow",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:member");
    await updateFeatureSwitchesForUser(
      context,
      { orgId: actor.orgId, userId: actor.userId },
      {
        [FeatureSwitchKey.GoogleFormsWorkflowAutomations]: true,
        [FeatureSwitchKey.ConnectorAccounts]: true,
      },
    );
    mockGoogleFormsConnectorOAuth();
    await workflows.connectConnector(actor, "google-forms");
    const firstConnector = await connectors.readConnectorBySlug(
      actor,
      "google-forms",
    );

    mockGoogleFormsConnectorOAuth({
      accessToken: "google-forms-second-access-token",
      refreshToken: "google-forms-second-refresh-token",
      subject: "bdd-google-forms-second-user-id",
      email: "bdd-google-forms-second@example.test",
    });
    const oauth = await connectors.startOauth(
      actor,
      "google-forms",
      "oauth",
      agent.agentId,
      { intent: "add", displayName: "Second Google Forms" },
    );
    const state = new URL(oauth.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Google Forms OAuth state");
    }
    await connectors.completeOauthCallback("google-forms", {
      code: "google-forms-second-code",
      state,
    });
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "google-forms",
    );
    const secondConnector = accounts.find((account) => {
      return account.externalEmail === "bdd-google-forms-second@example.test";
    });
    if (!secondConnector) {
      throw new Error("Expected the second Google Forms account");
    }

    const createAutomation = async (workflowId: string) => {
      return await accept(
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
    };
    const first = await createAutomation(firstWorkflowId);
    const second = await createAutomation(secondWorkflowId);
    const firstChatThreadId = first.body.chatThreadId;
    const secondChatThreadId = second.body.chatThreadId;
    if (
      first.body.kind !== "event" ||
      first.body.eventType !== "google-forms-response-submitted" ||
      second.body.kind !== "event" ||
      second.body.eventType !== "google-forms-response-submitted" ||
      !firstChatThreadId ||
      !secondChatThreadId
    ) {
      throw new Error("Expected Google Forms automation chat threads");
    }
    expect(first.body.eventConfig).toMatchObject({
      connectorId: firstConnector.id,
    });
    expect(second.body.eventConfig).toMatchObject({
      connectorId: firstConnector.id,
    });

    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(),
        params: { id: secondChatThreadId },
        body: {
          connectionId: secondConnector.id,
          target: { kind: "builtin", connectorSlug: "google-forms" },
        },
      }),
      [200],
    );
    const switched = await accept(
      automationsClient().get({
        headers: authHeaders(),
        params: { id: second.body.id },
      }),
      [200],
    );
    if (
      switched.body.kind !== "event" ||
      switched.body.eventType !== "google-forms-response-submitted"
    ) {
      throw new Error("Expected a switched Google Forms automation");
    }
    expect(switched.body.eventConfig.connectorId).toBe(secondConnector.id);
    expect(formsApi.watchIds).toHaveLength(2);
    const firstWatchId = formsApi.watchIds[0];
    const secondWatchId = formsApi.watchIds[1];
    if (!firstWatchId || !secondWatchId) {
      throw new Error("Expected one watch per Google Forms account");
    }
    return {
      first: { chatThreadId: firstChatThreadId },
      second: { chatThreadId: secondChatThreadId },
      firstWatchId,
      secondWatchId,
      secondConnector,
      formsApi,
    };
  }

  it("rejects the previous account watch after a switch", async () => {
    const { first, second, firstWatchId } =
      await setupGoogleFormsMultiAccountAutomations();
    const firstPush = await postWebhook(
      formsPushBody("pubsub-first-account", firstWatchId),
    );
    expect(firstPush).toMatchObject({
      status: 200,
      body: { watchStates: 1, dispatched: 1 },
    });
    const firstEvents = await workflows.readThreadEvents(first.chatThreadId);
    const secondEvents = await workflows.readThreadEvents(second.chatThreadId);
    expect(
      firstEvents.filter((event) => {
        return event.eventType === "input.prompt";
      }),
    ).toHaveLength(1);
    expect(
      secondEvents.filter((event) => {
        return event.eventType === "input.prompt";
      }),
    ).toHaveLength(0);
    await flushWaitUntilForTest();
  });

  it("routes the selected account with exact credentials", async () => {
    const { formsApi, first, second, secondConnector, secondWatchId } =
      await setupGoogleFormsMultiAccountAutomations();
    const secondPush = await postWebhook(
      formsPushBody("pubsub-second-account", secondWatchId),
    );
    expect(secondPush).toMatchObject({
      status: 200,
      body: { watchStates: 1, dispatched: 1 },
    });
    expect(formsApi.authorizationHeaders).toContain(
      "Bearer google-forms-access-token",
    );
    expect(formsApi.authorizationHeaders).toContain(
      "Bearer google-forms-second-access-token",
    );

    const firstEvents = await workflows.readThreadEvents(first.chatThreadId);
    const secondEvents = await workflows.readThreadEvents(second.chatThreadId);
    expect(
      firstEvents.filter((event) => {
        return event.eventType === "input.prompt";
      }),
    ).toHaveLength(0);
    expect(
      secondEvents.filter((event) => {
        return event.eventType === "input.prompt";
      }),
    ).toHaveLength(1);
    const secondRunId = secondEvents.find((event) => {
      return event.eventType === "input.prompt" && event.runId;
    })?.runId;
    if (!secondRunId) {
      throw new Error("Expected a second-account Google Forms run");
    }
    await runs.heartbeatRunner(RUNNER_GROUP);
    const claim = await runs.claimRunnerJob(secondRunId);
    expect(
      Object.values(claim.secretConnectorMetadataMap ?? {}),
    ).toContainEqual(expect.objectContaining({ sourceId: secondConnector.id }));
    await flushWaitUntilForTest();
  });
});
