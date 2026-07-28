import { createHash } from "node:crypto";
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
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@vm0/core";
import { Cron } from "croner";
import { describe, expect, it } from "vitest";

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
import { mockGoogleCalendarConnectorOAuth } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { flushWaitUntilForTest } from "../../context/wait-until";

/**
 * MORNING-BRIEF: the daily 7:00 local-time brief end to end.
 *
 * Every Given is built through public APIs (onboarding, entitlement, connector
 * OAuth, feature switches, user preferences) and external HTTP mocks; every
 * Then is a cron response, chat read, Resend send capture, or preferences
 * read — no database fixtures or row asserts.
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

  return { actor: orgActor, runnerGroup, gmailAfterSeconds };
}

async function findMorningBriefThreadOrNull(scenario: Scenario): Promise<{
  readonly threadId: string;
  readonly runId: string;
  readonly chatMessage: string;
} | null> {
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
  const messages = await accept(
    setupApp({ context })(chatThreadEventsContract).list({
      headers: actorHeaders(),
      params: { threadId: thread.chatThreadId },
      query: { limit: 50 },
    }),
    [200],
  );
  const runMessage = messages.body.events.find((message) => {
    return message.eventType === "input.prompt" && message.runId !== undefined;
  });
  if (!runMessage?.runId || runMessage.content === null) {
    throw new Error("Expected the Morning Brief run message");
  }
  return {
    threadId: thread.chatThreadId,
    runId: runMessage.runId,
    chatMessage: runMessage.content,
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
    const { runId, chatMessage } = await findMorningBriefThread(scenario);

    // The thread shows only the member-facing line, with no signed URL.
    expect(chatMessage).toBe(`Generate my Morning Brief for ${BRIEF_DATE}.`);
    expect(chatMessage).not.toContain("# Run facts");

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

  it.each([
    { projection: "structured", structuredPromptEnabled: true },
    { projection: "legacy", structuredPromptEnabled: false },
  ])(
    "uses $projection message text in the chat-thread source",
    async ({ structuredPromptEnabled }) => {
      const scenario = await setupMorningBriefActor({
        connectConnectors: false,
      });
      await updateFeatureSwitchesForUser(context, scenario.actor, {
        [FeatureSwitchKey.MorningBrief]: true,
        [FeatureSwitchKey.StructuredPrompt]: structuredPromptEnabled,
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
      const structuredPrompt: UserMessageDocument = {
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
          structuredPrompt,
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
      const structuredContent = `[Template: ${style.title}]\n\nReview the structured brief`;
      const legacyContent = "stale morning brief content";
      const expectedContent = structuredPromptEnabled
        ? structuredContent
        : legacyContent;
      const excludedContent = structuredPromptEnabled
        ? legacyContent
        : structuredContent;
      expect(sourceThread?.recentMessages).toContainEqual({
        role: "user",
        content: expectedContent,
        at: expect.any(String),
      });
      expect(
        sourceThread?.recentMessages.some((message) => {
          return message.content.includes(excludedContent);
        }),
      ).toBeFalsy();
    },
  );

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
    expect(triggered.body.runId).toBeTruthy();

    const githubConnector = await connectors.readConnectorByType(
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
    await completeMorningBriefRun(scenario, triggered.body.runId, 0, null);
    await drainOutbox();
    expect(sentMorningBriefEmails()).toHaveLength(1);

    // Repeat triggers on the same local date reset the delivery and resend.
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const second = await accept(
      morningBriefTriggerClient().trigger({
        headers: actorHeaders(),
        body: {},
      }),
      [200],
    );
    await flushWaitUntilForTest();
    mockUploadedBriefOutput(VALID_OUTPUT);
    await completeMorningBriefRun(
      scenario,
      second.body.runId,
      0,
      `morning-brief-cli-${triggered.body.runId}`,
    );
    await drainOutbox();
    expect(sentMorningBriefEmails()).toHaveLength(2);
    clearMockNow();
  });

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
