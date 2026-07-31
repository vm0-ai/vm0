import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { HttpResponse, http } from "msw";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  cronDrainEmailOutboxContract,
  cronExecuteMorningBriefsContract,
} from "@vm0/api-contracts/contracts/cron";
import {
  chatThreadEventsContract,
  chatThreadsContract,
  type GenerationTemplateRequest,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroMorningBriefContract } from "@vm0/api-contracts/contracts/zero-morning-brief";
import { zeroModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@vm0/core";
import { Cron } from "croner";
import { describe, expect, it, onTestFinished } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { chatEventDisplayText } from "./helpers/chat-event";
import { mockGoogleCalendarConnectorOAuth } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  holdOrgAdmissionLockFixture,
  readChatEventInputParamsFixture,
} from "../../../test-fixtures/chat-events";
import {
  insertOldFormatQueuedUserMessageFixture,
  insertQueuedWebUserMessageFixture,
  readMorningBriefDeliveryFixture,
  readMorningBriefQueuedParamsForDeliveryFixture,
  readMorningBriefQueuedParamsFixture,
  replaceMorningBriefQueuedCallbackPayloadFixture,
} from "../../../test-fixtures/morning-brief";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { readRunApiStart } from "./helpers/runtime-state";

/**
 * MORNING-BRIEF: the daily 7:00 local-time brief end to end.
 *
 * Every Given is built through public APIs (onboarding, entitlement, connector
 * OAuth, feature switches, user preferences) and external HTTP mocks; every
 * Then is a cron response, chat read, Resend send capture, or preferences
 * read. Storage migration cases also assert the queue-only transport row
 * lifecycle directly.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const connectors = createConnectorBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const routeMocks = createZeroRouteMocks(context);
const CRON_SECRET = "test-morning-brief-cron-secret";
const TIMEZONE = "Asia/Shanghai";
// Anchor on the next 7:00 local strictly after the real clock: runner job
// leases compare against database now(), so mocked time must not lag reality.
const SEVEN_LOCAL = new Cron("0 7 * * *", { timezone: TIMEZONE })
  .nextRun(new Date(now() + 60 * 1000))!
  .getTime();
const BEFORE_SEVEN_LOCAL = SEVEN_LOCAL - 10 * 60 * 1000;
const AFTER_SEVEN_LOCAL = SEVEN_LOCAL + 30 * 1000;
const BRIEF_DATE = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: TIMEZONE,
}).format(SEVEN_LOCAL);
const BRIEF_DATE_LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: TIMEZONE,
}).format(SEVEN_LOCAL);
const DAY_MS = 24 * 60 * 60 * 1000;

function cronHeaders() {
  return { authorization: `Bearer ${CRON_SECRET}` };
}

function actorHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function morningBriefCronClient() {
  return setupApp({ context })(cronExecuteMorningBriefsContract);
}

function drainOutboxClient() {
  return setupApp({ context })(cronDrainEmailOutboxContract);
}

function preferencesClient() {
  return setupApp({ context })(zeroUserPreferencesContract);
}

function morningBriefTriggerClient() {
  return setupApp({ context })(zeroMorningBriefContract);
}

function modelProvidersByTypeClient() {
  return setupApp({ context })(zeroModelProvidersByTypeContract);
}

// Counts cover every due member in the shared test database, so assertions
// stay scoped to the current actor's thread and emails instead.
async function executeMorningBriefsCron(): Promise<void> {
  await accept(
    morningBriefCronClient().execute({ headers: cronHeaders() }),
    [200],
  );
  await flushWaitUntilForTest();
}

async function connectOauthConnector(
  actor: ApiTestUser,
  type: "github" | "gmail" | "google-calendar",
  code: string,
): Promise<void> {
  const oauth = await connectors.startOauth(actor, type, "oauth");
  const state = new URL(oauth.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error(`Expected ${type} OAuth state`);
  }
  await connectors.completeOauthCallback(type, { code, state });
}

function mockMorningBriefDataSources(gmailAfterSeconds: number[]): void {
  server.use(
    http.get("https://api.github.com/user", () => {
      return HttpResponse.json({ id: 42, login: "bdd-github-user" });
    }),
    http.get("https://api.github.com/notifications", () => {
      return HttpResponse.json([
        {
          reason: "review_requested",
          updated_at: "2026-07-20T20:00:00Z",
          subject: {
            title: "feat: morning brief",
            url: "https://api.github.com/repos/vm0-ai/vm0/pulls/1",
            type: "PullRequest",
          },
          repository: { full_name: "vm0-ai/vm0" },
        },
      ]);
    }),
    http.get("https://api.github.com/search/issues", () => {
      return HttpResponse.json({
        items: [
          {
            title: "feat: morning brief",
            html_url: "https://github.com/vm0-ai/vm0/pull/1",
            state: "open",
            updated_at: "2026-07-20T20:00:00Z",
            draft: false,
            pull_request: { merged_at: null },
            repository_url: "https://api.github.com/repos/vm0-ai/vm0",
          },
        ],
      });
    }),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ({ request }) => {
        const query = new URL(request.url).searchParams.get("q") ?? "";
        const afterMatch = query.match(/after:(\d+)/u);
        expect(afterMatch).not.toBeNull();
        gmailAfterSeconds.push(Number(afterMatch?.[1]));
        return HttpResponse.json({
          messages: [{ id: "gm-1", threadId: "gt-1" }],
        });
      },
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/gm-1",
      () => {
        return HttpResponse.json({
          id: "gm-1",
          threadId: "gt-1",
          labelIds: ["INBOX", "UNREAD"],
          snippet: "Quarterly report attached",
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: "Alice <alice@example.com>" },
              { name: "To", value: "me@example.com" },
              { name: "Subject", value: "Quarterly report" },
              { name: "Date", value: "Mon, 20 Jul 2026 19:00:00 +0000" },
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: {
                  data: Buffer.from("Please review.").toString("base64url"),
                },
                filename: "",
              },
              { mimeType: "application/pdf", filename: "report.pdf" },
            ],
          },
        });
      },
    ),
    http.get(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      () => {
        return HttpResponse.json({
          items: [
            {
              id: "primary-cal",
              summary: "Work",
              selected: true,
              primary: true,
            },
            {
              id: "zh.china#holiday@group.v.calendar.google.com",
              summary: "Holidays",
              selected: true,
            },
          ],
        });
      },
    ),
    http.get(
      "https://www.googleapis.com/calendar/v3/calendars/primary-cal/events",
      ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("singleEvents")).toBe("true");
        return HttpResponse.json({
          items: [
            {
              id: "evt-1",
              status: "confirmed",
              summary: "Design review",
              htmlLink: "https://calendar.google.com/event?eid=evt-1",
              start: { dateTime: "2026-07-21T10:00:00+08:00" },
              end: { dateTime: "2026-07-21T11:00:00+08:00" },
              attendees: [
                {
                  email: "me@example.com",
                  self: true,
                  responseStatus: "accepted",
                },
              ],
            },
            {
              id: "evt-2",
              status: "confirmed",
              summary: "Declined sync",
              start: { dateTime: "2026-07-21T12:00:00+08:00" },
              end: { dateTime: "2026-07-21T12:30:00+08:00" },
              attendees: [
                {
                  email: "me@example.com",
                  self: true,
                  responseStatus: "declined",
                },
              ],
            },
          ],
        });
      },
    ),
  );
}

interface Scenario {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly gmailAfterSeconds: number[];
}

async function setupMorningBriefActor(
  options: { readonly connectConnectors?: boolean } = {},
): Promise<Scenario> {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockEnv("RESEND_FROM_DOMAIN", "vm0.bot");
  mockEnv("APP_URL", "https://app.vm0.test");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  mockNow(BEFORE_SEVEN_LOCAL);

  const gmailAfterSeconds: number[] = [];
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const onboarding = await bdd.readOnboardingStatus(actor);
  if (!onboarding.defaultAgentId) {
    throw new Error("Expected the Morning Brief default agent");
  }
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const orgActor = { ...actor, orgId: actor.orgId };

  await updateFeatureSwitchesForUser(context, orgActor, {
    [FeatureSwitchKey.MorningBrief]: true,
  });

  if (options.connectConnectors !== false) {
    mockGitHubConnectorOAuth();
    mockGmailConnectorOAuth({ email: "me@example.com" });
    mockGoogleCalendarConnectorOAuth({ email: "me@example.com" });
    await connectOauthConnector(orgActor, "github", "gh-code");
    await connectOauthConnector(orgActor, "gmail", "gmail-code");
    await connectOauthConnector(orgActor, "google-calendar", "cal-code");
    mockMorningBriefDataSources(gmailAfterSeconds);
  }

  routeMocks.clerk.session(actor.userId, actor.orgId);

  // Morning Brief is opt-in: the preference defaults to off for everyone.
  const initial = await accept(
    preferencesClient().get({ headers: actorHeaders() }),
    [200],
  );
  expect(initial.body.morningBriefEnabled).toBeFalsy();
  // No schedule exists before opting in, so no next run is exposed.
  expect(initial.body.morningBriefNextRunAt).toBeNull();

  // Opting in with a timezone schedules the next 7:00 local run, and the
  // response surfaces that instant for the settings UI.
  const optedIn = await accept(
    preferencesClient().update({
      headers: actorHeaders(),
      body: { timezone: TIMEZONE, morningBriefEnabled: true },
    }),
    [200],
  );
  expect(optedIn.body.morningBriefNextRunAt).toBe(
    new Date(SEVEN_LOCAL).toISOString(),
  );

  return {
    actor: orgActor,
    agentId: onboarding.defaultAgentId,
    runnerGroup,
    gmailAfterSeconds,
  };
}

async function findMorningBriefThreadIdOrNull(
  scenario: Scenario,
): Promise<string | null> {
  routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const threadEvents = await accept(
    setupApp({ context })(chatThreadsContract).events({
      headers: actorHeaders(),
      query: {},
    }),
    [200],
  );
  const thread = threadEvents.body.events.find((event) => {
    return event.kind === "created" && event.title === "Morning Brief";
  });
  if (!thread) {
    return null;
  }
  return thread.chatThreadId;
}

async function readMorningBriefThreadEvents(
  scenario: Scenario,
  threadId: string,
) {
  const messages = await accept(
    setupApp({ context })(chatThreadEventsContract).list({
      headers: actorHeaders(),
      params: { threadId },
      query: { limit: 50 },
    }),
    [200],
  );
  return messages.body.events;
}

async function findMorningBriefThreadOrNull(scenario: Scenario): Promise<{
  readonly threadId: string;
  readonly runId: string;
  readonly chatMessage: string;
} | null> {
  const threadId = await findMorningBriefThreadIdOrNull(scenario);
  if (!threadId) {
    return null;
  }
  const messages = await readMorningBriefThreadEvents(scenario, threadId);
  const runMessage = messages.find((message) => {
    return message.eventType === "input.prompt" && message.runId !== undefined;
  });
  if (!runMessage?.runId) {
    throw new Error("Expected the Morning Brief run message");
  }
  const chatMessage = chatEventDisplayText(runMessage);
  if (chatMessage === null) {
    throw new Error("Expected the Morning Brief run message display text");
  }
  return {
    threadId,
    runId: runMessage.runId,
    chatMessage,
  };
}

async function findMorningBriefThread(scenario: Scenario): Promise<{
  readonly threadId: string;
  readonly runId: string;
  readonly chatMessage: string;
}> {
  const found = await findMorningBriefThreadOrNull(scenario);
  if (!found) {
    throw new Error("Expected a Morning Brief chat thread");
  }
  return found;
}

function capturedMorningBriefInput(): {
  readonly sources: Record<
    string,
    { readonly ok: boolean; readonly data?: { readonly threads?: unknown[] } }
  >;
} {
  const put = context.mocks.s3.send.mock.calls
    .map(([command]) => {
      return command as {
        readonly constructor: { readonly name: string };
        readonly input?: { readonly Key?: string; readonly Body?: string };
      };
    })
    .find((command) => {
      return (
        command.constructor.name === "PutObjectCommand" &&
        command.input?.Key?.endsWith("input.json") === true
      );
    });
  if (!put?.input?.Body) {
    throw new Error("Expected the staged morning brief input.json upload");
  }
  return JSON.parse(put.input.Body) as ReturnType<
    typeof capturedMorningBriefInput
  >;
}

function mockUploadedBriefOutput(body: string): void {
  const previous = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const record = command as {
      readonly constructor: { readonly name: string };
      readonly input?: { readonly Key?: string };
    };
    if (
      record.constructor.name === "GetObjectCommand" &&
      record.input?.Key?.endsWith("output.json") === true
    ) {
      return Promise.resolve({
        Body: Readable.from([Buffer.from(body)]),
        ContentLength: Buffer.byteLength(body),
      });
    }
    if (previous) {
      return previous(command);
    }
    return Promise.resolve({});
  });
}

async function completeMorningBriefRun(
  scenario: Scenario,
  runId: string,
  exitCode: number,
  expectedResumeSessionId?: string | null,
): Promise<{
  readonly prompt: string;
  readonly appendSystemPrompt: string;
}> {
  const stored = await api.readRun(scenario.actor, runId);
  if (stored.status !== "pending") {
    throw new Error(
      `Expected queued morning brief run: ${JSON.stringify(stored)}`,
    );
  }
  await api.heartbeatRunner(scenario.runnerGroup);
  const claim = await api.claimRunnerJob(runId);
  if (expectedResumeSessionId !== undefined) {
    expect(claim.resumeSession?.sessionId ?? null).toBe(
      expectedResumeSessionId,
    );
  }
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `morning-brief-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`morning brief history ${runId}`)
        .digest("hex"),
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId, exitCode },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
  return {
    prompt: claim.prompt,
    appendSystemPrompt: claim.appendSystemPrompt ?? "",
  };
}

async function primeMorningBriefThread(scenario: Scenario): Promise<void> {
  mockNow(AFTER_SEVEN_LOCAL - DAY_MS);
  routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const previous = await accept(
    morningBriefTriggerClient().trigger({
      headers: actorHeaders(),
      body: {},
    }),
    [200],
  );
  if (!previous.body.runId) {
    throw new Error("Expected the previous-day Morning Brief run");
  }
  await completeMorningBriefRun(scenario, previous.body.runId, 1);
}

async function drainOutbox(): Promise<void> {
  await accept(drainOutboxClient().drain({ headers: cronHeaders() }), [200]);
}

function sentMorningBriefEmails(): readonly {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly headers?: Record<string, string>;
}[] {
  return context.mocks.resend.send.mock.calls
    .map(([payload]) => {
      return payload as {
        readonly from: string;
        readonly to: readonly string[];
        readonly subject: string;
        readonly html: string;
        readonly headers?: Record<string, string>;
      };
    })
    .filter((payload) => {
      return payload.subject.startsWith("Morning Briefing");
    });
}

const VALID_OUTPUT = JSON.stringify({
  version: 1,
  headline:
    "Good morning. One design review and one PR deserve your attention today.",
  sections: [
    {
      key: "schedule",
      title: "Today's schedule",
      items: [
        {
          title: "Design review at 10:00",
          detail: "1 hour with the product team",
          url: "https://calendar.google.com/event?eid=evt-1",
        },
      ],
    },
    {
      key: "github_updates",
      title: "GitHub updates",
      items: [
        {
          title: "Review requested: feat: morning brief",
          url: "https://github.com/vm0-ai/vm0/pull/1",
        },
        {
          title: "Sketchy link that must be dropped",
          url: "https://evil.example.com/phish",
        },
      ],
    },
  ],
});

describe("cron execute morning briefs", () => {
  it("rejects a tick without the cron secret", async () => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    await accept(
      morningBriefCronClient().execute({
        headers: { authorization: "Bearer wrong-secret" },
      }),
      [401],
    );
  });

  it("delivers a full brief end to end and honors the unsubscribe link", async () => {
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-morning-brief" },
      error: null,
    });
    const scenario = await setupMorningBriefActor();

    // Before 7:00 local nothing is due for this member.
    mockNow(BEFORE_SEVEN_LOCAL + 60 * 1000);
    await executeMorningBriefsCron();
    await expect(findMorningBriefThreadOrNull(scenario)).resolves.toBeNull();

    // At 7:00 local the schedule fires exactly once; a second tick is a no-op
    // thanks to the per-local-date delivery guard.
    mockNow(AFTER_SEVEN_LOCAL);
    await executeMorningBriefsCron();
    await executeMorningBriefsCron();

    // The run lands in the fixed Morning Brief thread through the chat queue.
    const { threadId, runId, chatMessage } =
      await findMorningBriefThread(scenario);

    // The thread shows only the member-facing line, with no signed URL.
    expect(chatMessage).toBe(`Generate my Morning Brief for ${BRIEF_DATE}.`);
    expect(chatMessage).not.toContain("# Run facts");
    const delivery = await readMorningBriefDeliveryFixture({
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      briefDate: BRIEF_DATE,
    });
    expect(delivery).toStrictEqual(
      expect.objectContaining({
        id: expect.any(String),
        status: "running",
        runId,
        inputKey: expect.stringContaining("/input.json"),
        outputKey: expect.stringContaining("/output.json"),
      }),
    );
    if (!delivery) {
      throw new Error("Expected the admitted Morning Brief delivery");
    }
    const threadMessages = await readMorningBriefThreadEvents(
      scenario,
      threadId,
    );
    expect(
      threadMessages.filter((message) => {
        return (
          message.eventType === "input.prompt" &&
          chatEventDisplayText(message) === chatMessage &&
          message.runId !== undefined
        );
      }),
    ).toHaveLength(1);

    // The agent uploads output.json and the run completes.
    mockUploadedBriefOutput(VALID_OUTPUT);
    const { prompt, appendSystemPrompt } = await completeMorningBriefRun(
      scenario,
      runId,
      0,
    );
    await drainOutbox();

    expect(appendSystemPrompt).toContain("Begin exactly with `Good morning.`");

    // The run itself carries the facts that separate this delivery from the
    // earlier ones sharing the thread's persistent session.
    expect(prompt).toContain(`Generate my Morning Brief for ${BRIEF_DATE}.`);
    expect(prompt).toContain("# Run facts");
    expect(prompt).toContain(
      `- trigger: the Morning Brief schedule fired for ${BRIEF_DATE}; nobody typed this message`,
    );
    expect(prompt).toContain("- chat thread: every Morning Brief delivery");
    expect(prompt).toContain("HTTP GET https://");
    expect(prompt).toContain("HTTP PUT https://");
    expect(prompt).toContain(
      "- when a run ends with no object at the PUT URL: the delivery is recorded failed, no email is queued, and nothing re-runs it",
    );
    const emails = sentMorningBriefEmails();
    expect(emails).toHaveLength(1);
    const email = emails[0];
    if (!email) {
      throw new Error("Expected a morning brief email");
    }
    expect(email.from).toBe("Zero <zero@vm0.bot>");
    expect(email.subject).toBe(`Morning Briefing - ${BRIEF_DATE_LABEL}`);
    // Generic preheader only; specifics stay inside the body.
    expect(email.html).toContain(
      "Your schedule, action items, and updates for today.",
    );
    expect(email.html).toContain(
      "Good morning. One design review and one PR deserve your attention today.",
    );
    expect(email.html).toContain("<strong>Today's schedule</strong> (1)");
    expect(email.html).toContain("Design review at 10:00");
    expect(email.html).toContain(
      '(<a href="https://calendar.google.com/event?eid=evt-1"',
    );
    expect(email.html).toContain("https://github.com/vm0-ai/vm0/pull/1");
    expect(email.html).toContain("Continue in Zero");
    expect(email.html).toContain(
      "From your &ldquo;Morning Brief&rdquo; routine",
    );
    expect(email.html).not.toContain("<h1>");
    // Non-allowlisted link hosts are stripped from the email.
    expect(email.html).not.toContain("evil.example.com");
    expect(email.headers?.["List-Unsubscribe"]).toContain(
      "/api/email/morning-brief/unsubscribe",
    );

    // The email body links to the platform unsubscribe page, which performs
    // the actual unsubscribe through the one-click POST endpoint.
    const manageUrlMatch = email.html.match(
      /href="([^"]*morning-brief\/unsubscribe[^"]*)"/u,
    );
    if (!manageUrlMatch?.[1]) {
      throw new Error("Expected the manage link in the email");
    }
    const manageUrl = new URL(manageUrlMatch[1].replaceAll("&amp;", "&"));
    expect(manageUrl.pathname).toBe("/email/morning-brief/unsubscribe");
    const token = manageUrl.searchParams.get("token");
    expect(token).toBeTruthy();

    const unsubscribeResponse = await createApp({
      signal: context.signal,
    }).request(`/api/email/morning-brief/unsubscribe?token=${token}`, {
      method: "POST",
    });
    expect(unsubscribeResponse.status).toBe(200);

    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const preferences = await accept(
      preferencesClient().get({ headers: actorHeaders() }),
      [200],
    );
    expect(preferences.body.morningBriefEnabled).toBeFalsy();
    // Unsubscribing pauses the schedule, so the next run disappears.
    expect(preferences.body.morningBriefNextRunAt).toBeNull();

    // The next day nothing fires for the unsubscribed member.
    mockNow(AFTER_SEVEN_LOCAL + DAY_MS);
    await executeMorningBriefsCron();
    await drainOutbox();
    expect(sentMorningBriefEmails()).toHaveLength(1);
    clearMockNow();
  });

  it("delivers a brief from vm0 chat threads when no connectors are connected", async () => {
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-threads-only-brief" },
      error: null,
    });
    const scenario = await setupMorningBriefActor({ connectConnectors: false });
    mockNow(AFTER_SEVEN_LOCAL);
    await executeMorningBriefsCron();

    // The brief runs on the internal chat-threads source alone; connector
    // sources are annotated as failed instead of gating the whole brief.
    const { runId } = await findMorningBriefThread(scenario);
    const input = capturedMorningBriefInput();
    expect(input.sources.github?.ok).toBeFalsy();
    expect(input.sources.gmail?.ok).toBeFalsy();
    expect(input.sources.calendar?.ok).toBeFalsy();
    expect(input.sources.chatThreads?.ok).toBeTruthy();
    expect(input.sources.chatThreads?.data?.threads).toStrictEqual([]);

    mockUploadedBriefOutput(
      JSON.stringify({
        version: 1,
        sections: [
          {
            key: "unread_threads",
            title: "Task results you haven't seen",
            items: [
              {
                title: "Competitor research finished",
                detail: "The report is ready in the thread.",
                url: "https://app.vm0.test/chats/123e4567-e89b-12d3-a456-426614174000",
              },
              {
                title: "Sketchy link that must be dropped",
                url: "https://evil.example.com/chats/1",
              },
            ],
          },
        ],
      }),
    );
    await completeMorningBriefRun(scenario, runId, 0);
    await drainOutbox();

    const emails = sentMorningBriefEmails();
    expect(emails).toHaveLength(1);
    const email = emails[0];
    if (!email) {
      throw new Error("Expected a morning brief email");
    }
    expect(email.html).toContain("Good morning. Here's your brief for today.");
    expect(email.html).toContain("Competitor research finished");
    // App-origin thread links survive sanitization; foreign hosts do not.
    expect(email.html).toContain(
      "https://app.vm0.test/chats/123e4567-e89b-12d3-a456-426614174000",
    );
    expect(email.html).not.toContain("evil.example.com");
    clearMockNow();
  });

  it("uses userMessage text in the chat-thread source", async () => {
    const scenario = await setupMorningBriefActor({
      connectConnectors: false,
    });
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.MorningBrief]: true,
    });
    const agent = await bdd.createAgent(scenario.actor, {
      displayName: "Structured morning brief agent",
      visibility: "private",
    });
    const thread = await chat.createThread(scenario.actor, {
      agentId: agent.agentId,
      title: "Structured morning brief source",
    });
    await chat.markThreadRead(scenario.actor, thread.id);

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const userMessage: UserMessageDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        { type: "text", text: "Review the structured brief" },
      ],
    };

    mockNow(BEFORE_SEVEN_LOCAL + 60_000);
    await chat.requestSendEvent(
      scenario.actor,
      {
        agentId: agent.agentId,
        threadId: thread.id,
        prompt: "stale morning brief content",
        generationTemplate,
        userMessage,
      },
      [201],
    );

    mockNow(AFTER_SEVEN_LOCAL);
    await executeMorningBriefsCron();

    const input = capturedMorningBriefInput();
    const threads = input.sources.chatThreads?.data?.threads as
      | {
          readonly threadId: string;
          readonly recentMessages: readonly {
            readonly role: string;
            readonly content: string;
          }[];
        }[]
      | undefined;
    const sourceThread = threads?.find((item) => {
      return item.threadId === thread.id;
    });
    const userMessageContent = `[Template: ${style.title}]\n\nReview the structured brief`;
    const legacyContent = "stale morning brief content";
    expect(sourceThread?.recentMessages).toContainEqual({
      role: "user",
      content: userMessageContent,
      at: expect.any(String),
    });
    expect(
      sourceThread?.recentMessages.some((message) => {
        return message.content.includes(legacyContent);
      }),
    ).toBeFalsy();
  });

  it("triggers a brief immediately through the manual endpoint", async () => {
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-manual-brief" },
      error: null,
    });
    const scenario = await setupMorningBriefActor();

    // The manual endpoint is gated by its own feature switch.
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [403],
    );
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.ManualMorningBrief]: true,
    });

    mockNow(AFTER_SEVEN_LOCAL);
    scenario.gmailAfterSeconds.length = 0;
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const triggered = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(triggered.body.queued).toBeFalsy();
    if (!triggered.body.runId) {
      throw new Error("Expected the manually triggered Morning Brief run");
    }
    const triggeredRunId = triggered.body.runId;

    const githubConnector = await connectors.readConnectorBySlug(
      scenario.actor,
      "github",
    );
    expect(githubConnector.connectionStatus).toBe("connected");
    expect(githubConnector.reconnectReason).toBeNull();
    expect(githubConnector.tokenExpiresAt).toBeNull();

    // The collection window never shrinks below the last 24 hours.
    const minWindowStartSeconds = Math.floor(
      (AFTER_SEVEN_LOCAL - 24 * 60 * 60 * 1000) / 1000,
    );
    for (const afterSeconds of scenario.gmailAfterSeconds) {
      expect(afterSeconds).toBeLessThanOrEqual(minWindowStartSeconds + 1);
    }

    mockUploadedBriefOutput(VALID_OUTPUT);
    await completeMorningBriefRun(scenario, triggeredRunId, 0, null);
    await drainOutbox();
    expect(sentMorningBriefEmails()).toHaveLength(1);

    // Repeat triggers on the same local date return the admitted delivery
    // without enqueueing a second message or sending a second email.
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const second = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    await flushWaitUntilForTest();
    await drainOutbox();
    expect(second.body).toStrictEqual({
      runId: triggeredRunId,
      briefDate: BRIEF_DATE,
      queued: false,
    });
    expect(sentMorningBriefEmails()).toHaveLength(1);
    const thread = await findMorningBriefThread(scenario);
    const events = await readMorningBriefThreadEvents(
      scenario,
      thread.threadId,
    );
    expect(
      events.filter((event) => {
        return (
          event.eventType === "input.prompt" &&
          chatEventDisplayText(event) ===
            `Generate my Morning Brief for ${BRIEF_DATE}.` &&
          event.runId !== undefined
        );
      }),
    ).toHaveLength(1);
    clearMockNow();
  });

  it("marks a failed queued launch failed and dispatches its failure callback", async () => {
    const scenario = await setupMorningBriefActor();
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.ManualMorningBrief]: true,
    });
    useSecretKmsProbe((_command, callNumber) => {
      return callNumber === 2
        ? Promise.reject(new Error("Morning Brief launch encryption failed"))
        : undefined;
    });

    mockNow(AFTER_SEVEN_LOCAL);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [400],
    );
    await flushWaitUntilForTest();

    const delivery = await readMorningBriefDeliveryFixture({
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      briefDate: BRIEF_DATE,
    });
    expect(delivery).toStrictEqual(
      expect.objectContaining({
        status: "failed",
        runId: expect.any(String),
        error: expect.stringContaining("launch encryption failed"),
      }),
    );
    if (!delivery?.runId) {
      throw new Error("Expected the failed Morning Brief run");
    }
    const run = await api.readRun(scenario.actor, delivery.runId);
    expect(run.status).toBe("failed");
    expect(sentMorningBriefEmails()).toHaveLength(0);
    clearMockNow();
  });

  it("processes terminal chat state before a failed Morning Brief callback", async () => {
    const scenario = await setupMorningBriefActor();
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.ManualMorningBrief]: true,
    });

    mockNow(AFTER_SEVEN_LOCAL - DAY_MS);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const previous = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    if (!previous.body.runId) {
      throw new Error("Expected the active predecessor run");
    }

    mockNow(AFTER_SEVEN_LOCAL);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const queued = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    expect(queued.body).toStrictEqual({
      runId: null,
      briefDate: BRIEF_DATE,
      queued: true,
    });

    const threadId = await findMorningBriefThreadIdOrNull(scenario);
    if (!threadId) {
      throw new Error("Expected the Morning Brief thread");
    }
    const delivery = await readMorningBriefDeliveryFixture({
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      briefDate: BRIEF_DATE,
    });
    if (!delivery) {
      throw new Error("Expected the queued Morning Brief delivery");
    }
    await replaceMorningBriefQueuedCallbackPayloadFixture({
      deliveryId: delivery.id,
      threadId,
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      payload: { deliveryId: "not-a-uuid" },
    });

    useSecretKmsProbe((_command, callNumber) => {
      return callNumber === 1
        ? Promise.reject(new Error("Morning Brief launch encryption failed"))
        : undefined;
    });
    await completeMorningBriefRun(scenario, previous.body.runId, 1);
    await flushWaitUntilForTest();

    const failedDelivery = await readMorningBriefDeliveryFixture({
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      briefDate: BRIEF_DATE,
    });
    expect(failedDelivery).toStrictEqual(
      expect.objectContaining({
        status: "failed",
        runId: expect.any(String),
        error: null,
      }),
    );
    if (!failedDelivery?.runId) {
      throw new Error("Expected the failed Morning Brief run");
    }
    const run = await api.readRun(scenario.actor, failedDelivery.runId);
    expect(run.status).toBe("failed");
    const events = await readMorningBriefThreadEvents(scenario, threadId);
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "run.failed",
        runId: failedDelivery.runId,
      }),
    );
    expect(sentMorningBriefEmails()).toHaveLength(0);
    clearMockNow();
  }, 90_000);

  it("rejects a Morning Brief admission failure and keeps the thread drainable", async () => {
    const scenario = await setupMorningBriefActor();
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.ManualMorningBrief]: true,
    });
    await primeMorningBriefThread(scenario);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    await accept(
      modelProvidersByTypeClient().delete({
        headers: actorHeaders(),
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );

    mockNow(AFTER_SEVEN_LOCAL);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [400],
    );

    const threadId = await findMorningBriefThreadIdOrNull(scenario);
    if (!threadId) {
      throw new Error("Expected the Morning Brief thread");
    }
    const delivery = await readMorningBriefDeliveryFixture({
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      briefDate: BRIEF_DATE,
    });
    expect(delivery).toStrictEqual(
      expect.objectContaining({
        status: "failed",
        runId: null,
        error: expect.any(String),
      }),
    );
    const events = await readMorningBriefThreadEvents(scenario, threadId);
    const rejectedBrief = events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        chatEventDisplayText(event) ===
          `Generate my Morning Brief for ${BRIEF_DATE}.` &&
        event.runId === undefined
      );
    });
    if (!rejectedBrief) {
      throw new Error("Expected the rejected Morning Brief input event");
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "control.revoke",
        revokesEventId: rejectedBrief.id,
      }),
    );

    await api.ensureOrgModelProvider(scenario.actor);
    const userMessage = await chat.requestSendEvent(
      scenario.actor,
      {
        agentId: scenario.agentId,
        threadId,
        prompt: "Continue after the failed Morning Brief admission.",
      },
      [201],
    );
    if ("error" in userMessage.body) {
      throw new Error(userMessage.body.error.message);
    }
    expect(userMessage.body.runId).toStrictEqual(expect.any(String));
    clearMockNow();
  });

  it("retries the same-day delivery after an admission failure", async () => {
    const scenario = await setupMorningBriefActor();
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.ManualMorningBrief]: true,
    });
    await primeMorningBriefThread(scenario);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    await accept(
      modelProvidersByTypeClient().delete({
        headers: actorHeaders(),
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );

    mockNow(AFTER_SEVEN_LOCAL);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [400],
    );
    const failed = await readMorningBriefDeliveryFixture({
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      briefDate: BRIEF_DATE,
    });
    expect(failed?.status).toBe("failed");

    await api.ensureOrgModelProvider(scenario.actor);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const retried = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    expect(retried.body.queued).toBeFalsy();
    if (!retried.body.runId) {
      throw new Error("Expected the retried Morning Brief run");
    }
    const running = await readMorningBriefDeliveryFixture({
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      briefDate: BRIEF_DATE,
    });
    expect(running).toStrictEqual(
      expect.objectContaining({
        id: failed?.id,
        status: "running",
        runId: retried.body.runId,
        error: null,
      }),
    );
    clearMockNow();
  });

  it("returns a successful queued response behind an active run", async () => {
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-queued-retry" },
      error: null,
    });
    const scenario = await setupMorningBriefActor();
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.ManualMorningBrief]: true,
    });

    const previousTriggerTime = AFTER_SEVEN_LOCAL - DAY_MS;
    const previousBriefDate = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: TIMEZONE,
    }).format(previousTriggerTime);
    mockNow(previousTriggerTime);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const previous = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    if (!previous.body.runId) {
      throw new Error("Expected the active predecessor run");
    }

    mockNow(AFTER_SEVEN_LOCAL);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const queued = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    expect(queued.body).toStrictEqual({
      runId: null,
      briefDate: BRIEF_DATE,
      queued: true,
    });

    const threadId = await findMorningBriefThreadIdOrNull(scenario);
    if (!threadId) {
      throw new Error("Expected the queued Morning Brief thread");
    }
    const delivery = await readMorningBriefDeliveryFixture({
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      briefDate: BRIEF_DATE,
    });
    expect(delivery).toStrictEqual(
      expect.objectContaining({ status: "queued", runId: null }),
    );
    if (!delivery) {
      throw new Error("Expected the queued Morning Brief delivery");
    }
    const queuedParams = await readMorningBriefQueuedParamsForDeliveryFixture({
      deliveryId: delivery.id,
      threadId,
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
    });
    expect(queuedParams).not.toHaveProperty("apiStartTime");
    expect(queuedParams?.prompt).toContain(
      "expire 1440 minutes after the trigger above",
    );

    const queuedEvents = await readMorningBriefThreadEvents(scenario, threadId);
    const strandedEvent = queuedEvents.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        chatEventDisplayText(event) ===
          `Generate my Morning Brief for ${BRIEF_DATE}.` &&
        event.runId === undefined
      );
    });
    if (!strandedEvent) {
      throw new Error("Expected the pending Morning Brief queue event");
    }
    await expect(
      readChatEventInputParamsFixture(strandedEvent.id),
    ).resolves.toMatchObject({
      eventId: strandedEvent.id,
      encryptedParams: expect.any(String),
    });
    await chat.requestSendEvent(
      scenario.actor,
      {
        agentId: scenario.agentId,
        threadId,
        revokesEventId: strandedEvent.id,
        clientEventId: randomUUID(),
      },
      [201],
    );
    await expect(
      readChatEventInputParamsFixture(strandedEvent.id),
    ).resolves.toBeNull();

    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const readmitted = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    expect(readmitted.body).toStrictEqual({
      runId: null,
      briefDate: BRIEF_DATE,
      queued: true,
    });
    const readmittedDelivery = await readMorningBriefDeliveryFixture({
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      briefDate: BRIEF_DATE,
    });
    expect(readmittedDelivery).toStrictEqual(
      expect.objectContaining({
        id: delivery.id,
        status: "queued",
        runId: null,
      }),
    );
    const readmittedEvents = await readMorningBriefThreadEvents(
      scenario,
      threadId,
    );
    const readmittedEvent = [...readmittedEvents].reverse().find((event) => {
      return (
        event.eventType === "input.prompt" &&
        chatEventDisplayText(event) ===
          `Generate my Morning Brief for ${BRIEF_DATE}.` &&
        event.runId === undefined &&
        event.id !== strandedEvent.id
      );
    });
    if (!readmittedEvent) {
      throw new Error("Expected the readmitted Morning Brief queue event");
    }
    await expect(
      readChatEventInputParamsFixture(readmittedEvent.id),
    ).resolves.toMatchObject({
      eventId: readmittedEvent.id,
      encryptedParams: expect.any(String),
    });

    mockNow(AFTER_SEVEN_LOCAL + 31 * 60 * 1000);
    mockUploadedBriefOutput(VALID_OUTPUT);
    await completeMorningBriefRun(scenario, previous.body.runId, 0);

    let queuedRunId: string | null = null;
    await expect
      .poll(async () => {
        const claimed = await readMorningBriefDeliveryFixture({
          orgId: scenario.actor.orgId,
          userId: scenario.actor.userId,
          briefDate: BRIEF_DATE,
        });
        queuedRunId = claimed?.runId ?? null;
        return claimed?.status;
      })
      .toBe("running");
    if (!queuedRunId) {
      throw new Error("Expected the queued Morning Brief to drain");
    }
    await expect(
      readChatEventInputParamsFixture(readmittedEvent.id),
    ).resolves.toBeNull();
    expect(previousBriefDate).not.toBe(BRIEF_DATE);
    await completeMorningBriefRun(scenario, queuedRunId, 0);
    clearMockNow();
  }, 90_000);

  it("keeps a queued brief and a concurrent user message in FIFO order", async () => {
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-fifo" },
      error: null,
    });
    const scenario = await setupMorningBriefActor();
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.ManualMorningBrief]: true,
    });
    mockNow(AFTER_SEVEN_LOCAL);
    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: scenario.actor.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const briefRequest = morningBriefTriggerClient().trigger({
      headers: actorHeaders(),
      body: {},
    });

    let threadId: string | null = null;
    await expect
      .poll(async () => {
        threadId = await findMorningBriefThreadIdOrNull(scenario);
        return threadId;
      })
      .not.toBeNull();
    if (!threadId) {
      throw new Error("Expected the queued Morning Brief thread");
    }
    const queuedThreadId = threadId;
    await expect
      .poll(async () => {
        const events = await readMorningBriefThreadEvents(
          scenario,
          queuedThreadId,
        );
        return events.some((event) => {
          return (
            event.eventType === "input.prompt" &&
            chatEventDisplayText(event) ===
              `Generate my Morning Brief for ${BRIEF_DATE}.` &&
            event.runId === undefined
          );
        });
      })
      .toBe(true);

    const userPrompt = "Add the budget review to today's priorities.";
    await insertQueuedWebUserMessageFixture({
      threadId: queuedThreadId,
      content: userPrompt,
      createdAt: new Date(AFTER_SEVEN_LOCAL + 1000),
    });
    await expect
      .poll(async () => {
        const events = await readMorningBriefThreadEvents(
          scenario,
          queuedThreadId,
        );
        return events.some((event) => {
          return (
            event.eventType === "input.prompt" &&
            chatEventDisplayText(event) === userPrompt
          );
        });
      })
      .toBe(true);

    admissionLock.release();
    const brief = await accept(briefRequest, [200]);
    await admissionLock.done;
    if (!brief.body.runId) {
      throw new Error("Expected the admitted Morning Brief run");
    }
    const briefRunId = brief.body.runId;

    mockUploadedBriefOutput(VALID_OUTPUT);
    await completeMorningBriefRun(scenario, briefRunId, 0);
    await drainOutbox();

    let userRunId: string | null = null;
    await expect
      .poll(async () => {
        const events = await readMorningBriefThreadEvents(
          scenario,
          queuedThreadId,
        );
        const claimed = events.filter((event) => {
          return (
            event.eventType === "input.prompt" &&
            event.runId !== undefined &&
            (chatEventDisplayText(event) ===
              `Generate my Morning Brief for ${BRIEF_DATE}.` ||
              chatEventDisplayText(event) === userPrompt)
          );
        });
        userRunId =
          claimed.find((event) => {
            return chatEventDisplayText(event) === userPrompt;
          })?.runId ?? null;
        return claimed.map((event) => {
          return chatEventDisplayText(event);
        });
      })
      .toStrictEqual([
        `Generate my Morning Brief for ${BRIEF_DATE}.`,
        userPrompt,
      ]);
    if (!userRunId) {
      throw new Error("Expected the concurrent user message run");
    }
    expect(userRunId).not.toBe(briefRunId);
    await completeMorningBriefRun(scenario, userRunId, 0);
    clearMockNow();
  }, 90_000);

  it("drains an old-format queued params payload without new delivery fields", async () => {
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-old-format" },
      error: null,
    });
    const scenario = await setupMorningBriefActor();
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.ManualMorningBrief]: true,
    });
    mockNow(AFTER_SEVEN_LOCAL);
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const triggered = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    if (!triggered.body.runId) {
      throw new Error("Expected the initial Morning Brief run");
    }
    const triggeredRunId = triggered.body.runId;
    const thread = await findMorningBriefThread(scenario);

    const displayContent = "Legacy queued Morning Brief display text.";
    const realPrompt = "Legacy queued Morning Brief execution prompt.";
    const appendSystemPrompt = "Legacy Morning Brief system instructions.";
    const messageId = await insertOldFormatQueuedUserMessageFixture({
      threadId: thread.threadId,
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
      content: displayContent,
      prompt: realPrompt,
      appendSystemPrompt,
      apiStartTime: BEFORE_SEVEN_LOCAL,
    });
    const oldParams = await readMorningBriefQueuedParamsFixture({
      messageId,
      orgId: scenario.actor.orgId,
      userId: scenario.actor.userId,
    });
    expect(oldParams).toStrictEqual({
      version: 1,
      prompt: realPrompt,
      appendSystemPrompt,
      apiStartTime: BEFORE_SEVEN_LOCAL,
    });

    mockUploadedBriefOutput(VALID_OUTPUT);
    await completeMorningBriefRun(scenario, triggeredRunId, 0);
    await drainOutbox();
    const events = await readMorningBriefThreadEvents(
      scenario,
      thread.threadId,
    );
    const claimed = events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        chatEventDisplayText(event) === displayContent &&
        event.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error("Expected the old-format queue item to drain");
    }
    await expect(readRunApiStart(context, claimed.runId)).resolves.toBe(
      new Date(BEFORE_SEVEN_LOCAL).toISOString(),
    );
    const runInput = await completeMorningBriefRun(scenario, claimed.runId, 0);
    expect(runInput.prompt).toBe(realPrompt);
    expect(runInput.appendSystemPrompt).toContain(appendSystemPrompt);
    clearMockNow();
  }, 90_000);

  it("sends no email when the uploaded brief output is invalid", async () => {
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-invalid-brief" },
      error: null,
    });
    const scenario = await setupMorningBriefActor();
    mockNow(AFTER_SEVEN_LOCAL);
    await executeMorningBriefsCron();

    const { runId } = await findMorningBriefThread(scenario);
    mockUploadedBriefOutput('{"version": 999, "nonsense": true}');
    await completeMorningBriefRun(scenario, runId, 0);
    await drainOutbox();

    expect(sentMorningBriefEmails()).toHaveLength(0);
    clearMockNow();
  });
});
