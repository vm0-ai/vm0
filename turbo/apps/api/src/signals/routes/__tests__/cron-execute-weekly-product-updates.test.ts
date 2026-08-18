import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cronExecuteWeeklyProductUpdatesContract } from "@okouai/api-contracts/contracts/cron";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { chatThreadRoutes } from "../chat-threads";
import { cronExecuteWeeklyProductUpdatesRoutes } from "../cron-execute-weekly-product-updates";
import { userPreferencesRoutes } from "../user-preferences";

/**
 * WEEKLY-PRODUCT-UPDATE: the newsletter broadcast arriving in Web Chat.
 *
 * Given is always a signed Resend `email.sent` event (or the backstop listing)
 * plus the public preferences and feature-switch APIs. Then is always a chat
 * read: the member either sees one product update message or sees nothing.
 */
const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const routeMocks = createZeroRouteMocks(context);

const CRON_SECRET = "test-weekly-product-update-cron-secret";
// Matches the signing secret the shared webhook test helper signs with.
const WEBHOOK_SECRET = "whsec_test";
const THREAD_TITLE = "Product updates";

interface Scenario {
  readonly actor: ApiTestUser & { readonly orgId: string };
}

function weeklyBroadcastHtml(slug: string): string {
  return [
    "<html><body>",
    "<div>Preheader copy that duplicates the subject line.</div>",
    '<img src="https://cdn.example.com/vm0_cube_icon_01.png" alt="VM0" />',
    "<p>Zero, your trustworthy AI teammate.</p>",
    "<h1>Inside the Build, Weekly</h1>",
    "<p>Week of August 10 to August 16, 2026</p>",
    "<p><strong>Hi </strong>{{{contact.first_name|there}}}<strong>,</strong></p>",
    "<p>The headline this week is steering active runs.</p>",
    `<p><a href="https://www.vm0.ai/en/blog/posts/${slug}">Read the full update →</a></p>`,
    "<h2>New Features</h2>",
    "<h3>Steer Zero while it works</h3>",
    "<p>Send corrections during an active run.</p>",
    '<table><tbody><tr><td><img src="https://cdn.example.com/steer.png" alt="Steering an active run" /></td></tr></tbody></table>',
    "<p>That's the week. Thanks for building with VM0.</p>",
    '<p><a href="https://vm0.ai">Web</a> · <a href="https://github.com/vm0-ai/vm0">GitHub</a> · <a href="https://x.com/vm0_ai">X</a></p>',
    "<p>995 Market St, San Francisco, CA 94103</p>",
    "<p>© 2026 Zero, your trustworthy AI teammate.</p>",
    '<p><a href="https://resend.example.com/unsubscribe/abc">Unsubscribe</a></p>',
    "</body></html>",
  ].join("");
}

function sentBroadcast(args: {
  readonly id: string;
  readonly subject: string;
  readonly slug: string;
}) {
  return {
    id: args.id,
    name: "Untitled",
    segment_id: null,
    audience_id: null,
    from: "VM0 Team <product@vm0.ai>",
    subject: args.subject,
    reply_to: null,
    preview_text: null,
    status: "sent" as const,
    created_at: "2026-08-15T06:45:17.000Z",
    scheduled_at: "2026-08-17T16:00:00.000Z",
    sent_at: "2026-08-17T16:04:17.000Z",
    html: weeklyBroadcastHtml(args.slug),
    text: null,
  };
}

/** Tests share one database, so every case needs its own weekly post. */
function uniqueSlug(): string {
  return `whats-new-in-zero-week-of-${randomUUID().slice(0, 8)}`;
}

function cronHeaders() {
  return { authorization: `Bearer ${CRON_SECRET}` };
}

function actorHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function setupScenario(): Promise<Scenario> {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockEnv("RESEND_API_KEY", "test-resend-key");
  mockEnv("RESEND_WEBHOOK_SECRET", WEBHOOK_SECRET);

  // The fan-out reaches every member in the database, so settle whatever an
  // earlier case published before this case's member exists.
  await drainCron();

  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const orgActor = { ...actor, orgId: actor.orgId };

  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(orgActor);
  await api.ensureOrgModelProvider(orgActor);

  const onboarding = await bdd.readOnboardingStatus(orgActor);
  if (!onboarding.defaultAgentId) {
    throw new Error("Expected a default agent for the weekly update thread");
  }

  await updateFeatureSwitchesForUser(context, orgActor, {
    [FeatureSwitchKey.WeeklyProductUpdate]: true,
  });

  // Materialize the member preference row the fan-out scans.
  routeMocks.clerk.session(orgActor.userId, orgActor.orgId);
  await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).update({ headers: actorHeaders(), body: { sendMode: "enter" } }),
    [200],
  );

  return { actor: orgActor };
}

async function postBroadcastSent(broadcastId: string): Promise<void> {
  const event = {
    type: "email.sent",
    data: {
      broadcast_id: broadcastId,
      email_id: `email_${randomUUID()}`,
      to: ["subscriber@example.com"],
    },
  };
  await webhooks.requestResendInboundWebhook(
    event,
    webhooks.signedResendWebhookHeaders(event),
    [200],
  );
  await flushWaitUntilForTest();
}

async function runCron() {
  return await accept(
    setupApp({ context, routes: cronExecuteWeeklyProductUpdatesRoutes })(
      cronExecuteWeeklyProductUpdatesContract,
    ).execute({ headers: cronHeaders() }),
    [200],
  );
}

/** Advance the bounded fan-out until a tick has nothing left to do. */
async function drainCron(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    const result = await runCron();
    if (
      result.body.claimed === 0 &&
      result.body.delivered === 0 &&
      result.body.skipped === 0
    ) {
      return;
    }
  }
  throw new Error("The weekly product update fan-out did not settle");
}

async function updateThreadIdOrNull(
  scenario: Scenario,
): Promise<string | null> {
  routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const threadEvents = await accept(
    setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract).events(
      {
        headers: actorHeaders(),
        query: {},
      },
    ),
    [200],
  );
  const thread = threadEvents.body.events.find((event) => {
    return event.kind === "created" && event.title === THREAD_TITLE;
  });
  return thread?.chatThreadId ?? null;
}

async function updateMessages(scenario: Scenario): Promise<readonly string[]> {
  const threadId = await updateThreadIdOrNull(scenario);
  if (!threadId) {
    return [];
  }
  routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const events = await readProjectedChatEvents(context, {
    threadId,
    headers: actorHeaders(),
  });
  return events
    .filter((event) => {
      return event.eventType === "output.message";
    })
    .map((event) => {
      // A product announcement is not agent output, so it carries no run.
      expect(event.runId).toBeUndefined();
      return event.content;
    });
}

beforeEach(() => {
  context.mocks.resend.broadcastsList.mockResolvedValue({
    data: { object: "list", has_more: false, data: [] },
    error: null,
  });
});

describe("weekly product update delivery", () => {
  it("delivers one update per member and drops the sibling send events", async () => {
    const scenario = await setupScenario();
    const slug = uniqueSlug();
    const broadcastId = randomUUID();
    context.mocks.resend.broadcastsGet.mockResolvedValue({
      data: sentBroadcast({
        id: broadcastId,
        subject: "VM0 Inside the Build: Week of August 10",
        slug,
      }),
      error: null,
    });

    // A broadcast emits one email.sent per recipient.
    await postBroadcastSent(broadcastId);
    await postBroadcastSent(broadcastId);
    await postBroadcastSent(broadcastId);

    expect(context.mocks.resend.broadcastsGet).toHaveBeenCalledTimes(1);

    await drainCron();

    const messages = await updateMessages(scenario);
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message).toContain("# Inside the Build, Weekly");
    expect(message).toContain("### Steer Zero while it works");
    expect(message).toContain(
      "![Steering an active run](https://cdn.example.com/steer.png)",
    );
    expect(message).toContain(`https://www.vm0.ai/en/blog/posts/${slug}`);
    // Email chrome must not reach Web Chat.
    expect(message).not.toContain("Unsubscribe");
    expect(message).not.toContain("{{{contact.first_name");
    expect(message).not.toContain("vm0_cube_icon");
    expect(message).not.toContain("Preheader copy");

    // A later tick finds nobody left and delivers nothing more.
    const settled = await runCron();
    expect(settled.body.delivered).toBe(0);
    await expect(updateMessages(scenario)).resolves.toHaveLength(1);
  });

  it("ignores a broadcast that is not a weekly product update", async () => {
    const scenario = await setupScenario();
    const broadcastId = randomUUID();
    context.mocks.resend.broadcastsGet.mockResolvedValue({
      data: sentBroadcast({
        id: broadcastId,
        subject: "Claim $100 in free VM0 credits",
        slug: uniqueSlug(),
      }),
      error: null,
    });

    await postBroadcastSent(broadcastId);
    await drainCron();

    await expect(updateThreadIdOrNull(scenario)).resolves.toBeNull();
  });

  it("does not deliver the same post twice when the campaign is resent", async () => {
    const scenario = await setupScenario();
    const slug = uniqueSlug();
    const firstBroadcastId = randomUUID();
    context.mocks.resend.broadcastsGet.mockResolvedValue({
      data: sentBroadcast({
        id: firstBroadcastId,
        subject: "VM0 Inside the Build: Week of August 10",
        slug,
      }),
      error: null,
    });
    await postBroadcastSent(firstBroadcastId);
    await drainCron();
    await expect(updateMessages(scenario)).resolves.toHaveLength(1);

    const resentBroadcastId = randomUUID();
    context.mocks.resend.broadcastsGet.mockResolvedValue({
      data: sentBroadcast({
        id: resentBroadcastId,
        subject: "VM0 Inside the Build: Week of August 10",
        slug,
      }),
      error: null,
    });
    await postBroadcastSent(resentBroadcastId);
    await drainCron();

    await expect(updateMessages(scenario)).resolves.toHaveLength(1);
  });

  it("skips a member who turned the weekly update off", async () => {
    const scenario = await setupScenario();
    routeMocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    await accept(
      setupApp({ context, routes: userPreferencesRoutes })(
        userPreferencesContract,
      ).update({
        headers: actorHeaders(),
        body: { weeklyProductUpdateEnabled: false },
      }),
      [200],
    );

    const broadcastId = randomUUID();
    context.mocks.resend.broadcastsGet.mockResolvedValue({
      data: sentBroadcast({
        id: broadcastId,
        subject: "VM0 Inside the Build: Week of August 10",
        slug: uniqueSlug(),
      }),
      error: null,
    });
    await postBroadcastSent(broadcastId);
    await drainCron();

    await expect(updateThreadIdOrNull(scenario)).resolves.toBeNull();
  });

  it("claims a sent broadcast the webhook never delivered", async () => {
    const scenario = await setupScenario();
    const broadcastId = randomUUID();
    context.mocks.resend.broadcastsList.mockResolvedValue({
      data: {
        object: "list",
        has_more: false,
        data: [
          {
            id: broadcastId,
            name: "Untitled",
            audience_id: null,
            segment_id: null,
            status: "sent",
            created_at: "2026-08-15T06:45:17.000Z",
            scheduled_at: "2026-08-17T16:00:00.000Z",
            sent_at: nowDate().toISOString(),
          },
        ],
      },
      error: null,
    });
    context.mocks.resend.broadcastsGet.mockResolvedValue({
      data: sentBroadcast({
        id: broadcastId,
        subject: "VM0 Inside the Build: Week of August 10",
        slug: uniqueSlug(),
      }),
      error: null,
    });

    const first = await runCron();
    expect(first.body.claimed).toBe(1);
    await drainCron();

    const settled = await runCron();
    expect(settled.body.claimed).toBe(0);
    expect(settled.body.delivered).toBe(0);

    await expect(updateMessages(scenario)).resolves.toHaveLength(1);
  });
});
