import { randomUUID } from "node:crypto";

import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import {
  deployScheduleResponseSchema,
  scheduleListResponseSchema,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";

import { testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { writeDb$ } from "../../external/db";
import {
  type SchedulesFixture,
  type SchedulesScenarioValues,
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
} from "./helpers/zero-schedules";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const track = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

interface TestApiResponse {
  readonly status: number;
  readonly body: unknown;
}

async function requestJson(
  path: string,
  init: RequestInit,
): Promise<TestApiResponse> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(path, init);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function listSchedules(
  headers: Record<string, string>,
): Promise<TestApiResponse> {
  return await requestJson("/api/zero/schedules", {
    method: "GET",
    headers,
  });
}

async function deploySchedule(
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer clerk-session" },
): Promise<TestApiResponse> {
  return await requestJson("/api/zero/schedules", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function expectErrorCode(response: TestApiResponse, code: string): void {
  const body = apiErrorSchema.parse(response.body);
  expect(body.error.code).toBe(code);
}

async function seedFixture(
  values: Partial<SchedulesScenarioValues> = {},
): Promise<SchedulesFixture> {
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const fixture = await track(
    store.set(
      seedSchedulesScenario$,
      {
        schedules: [],
        ...values,
      },
      context.signal,
    ),
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function enableChatMode(fixture: SchedulesFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.ScheduledChat]: true },
  });
}

async function disableChatMode(fixture: SchedulesFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.ScheduledChat]: false },
  });
}

async function seedThread(
  fixture: SchedulesFixture,
  userId: string = fixture.userId,
): Promise<string> {
  const db = store.set(writeDb$);
  const threadId = randomUUID();
  await db.insert(chatThreads).values({
    id: threadId,
    userId,
    agentComposeId: fixture.composeId,
    title: "linked thread",
  });
  return threadId;
}

describe("POST /api/zero/schedules — chat-mode linkage", () => {
  it("links a chat thread when the ScheduledChat switch is on", async () => {
    const fixture = await seedFixture();
    await enableChatMode(fixture);
    const threadId = await seedThread(fixture);

    const response = await deploySchedule({
      name: "chat-sched",
      agentId: fixture.composeId,
      cronExpression: "0 9 * * *",
      prompt: "daily report",
      description: "d",
      chatThreadId: threadId,
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule.chatThreadId).toBe(threadId);
  });

  it("ignores the chat thread (legacy) when the switch is off", async () => {
    const fixture = await seedFixture();
    await disableChatMode(fixture);
    const threadId = await seedThread(fixture);

    const response = await deploySchedule({
      name: "legacy-sched",
      agentId: fixture.composeId,
      cronExpression: "0 9 * * *",
      prompt: "daily report",
      description: "d",
      chatThreadId: threadId,
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule.chatThreadId).toBeNull();
  });

  it("creates a chat thread for a new schedule when the switch is on and no thread is supplied", async () => {
    const fixture = await seedFixture();
    await enableChatMode(fixture);

    const response = await deploySchedule({
      name: "needs-thread",
      agentId: fixture.composeId,
      cronExpression: "0 9 * * *",
      prompt: "daily report",
      description: "d",
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule.chatThreadId).not.toBeNull();

    const db = store.set(writeDb$);
    const [thread] = await db
      .select({
        id: chatThreads.id,
        userId: chatThreads.userId,
        agentComposeId: chatThreads.agentComposeId,
        title: chatThreads.title,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, body.schedule.chatThreadId ?? ""))
      .limit(1);
    expect(thread).toStrictEqual({
      id: body.schedule.chatThreadId,
      userId: fixture.userId,
      agentComposeId: fixture.composeId,
      title: "d",
    });
  });

  it("rejects changing the chat thread on an existing schedule", async () => {
    const fixture = await seedFixture();
    await enableChatMode(fixture);
    const threadId = await seedThread(fixture);
    const otherThreadId = await seedThread(fixture);

    const created = await deploySchedule({
      name: "immutable-sched",
      agentId: fixture.composeId,
      cronExpression: "0 9 * * *",
      prompt: "daily report",
      description: "d",
      chatThreadId: threadId,
    });
    expect(created.status).toBe(201);

    const redeploy = await deploySchedule({
      name: "immutable-sched",
      agentId: fixture.composeId,
      cronExpression: "0 10 * * *",
      prompt: "daily report",
      description: "d",
      chatThreadId: otherThreadId,
    });
    expect(redeploy.status).toBe(400);
    expectErrorCode(redeploy, "BAD_REQUEST");
  });

  it("rejects a chat thread owned by a different user", async () => {
    const fixture = await seedFixture();
    await enableChatMode(fixture);
    const otherThreadId = await seedThread(fixture, `user_${randomUUID()}`);

    const response = await deploySchedule({
      name: "cross-user-sched",
      agentId: fixture.composeId,
      cronExpression: "0 9 * * *",
      prompt: "daily report",
      description: "d",
      chatThreadId: otherThreadId,
    });

    expect(response.status).toBe(400);
    expectErrorCode(response, "BAD_REQUEST");
  });
});

describe("chat-mode schedule realtime signals", () => {
  it("publishes chatThreadSchedulesChanged when a chat-mode schedule is created", async () => {
    const fixture = await seedFixture();
    await enableChatMode(fixture);
    const threadId = await seedThread(fixture);

    const response = await deploySchedule({
      name: "chat-sched",
      agentId: fixture.composeId,
      cronExpression: "0 9 * * *",
      prompt: "daily report",
      description: "d",
      chatThreadId: threadId,
    });
    expect(response.status).toBe(201);

    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadSchedulesChanged:${threadId}`,
      null,
    );
  });

  it("does not publish chatThreadSchedulesChanged for a legacy schedule", async () => {
    const fixture = await seedFixture();
    const threadId = await seedThread(fixture);

    const response = await deploySchedule({
      name: "legacy-sched",
      agentId: fixture.composeId,
      cronExpression: "0 9 * * *",
      prompt: "daily report",
      description: "d",
      chatThreadId: threadId,
    });
    expect(response.status).toBe(201);

    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      expect.stringContaining("chatThreadSchedulesChanged:"),
      expect.anything(),
    );
  });

  it("publishes chatThreadSchedulesChanged when a chat-mode schedule is deleted", async () => {
    const fixture = await seedFixture();
    await enableChatMode(fixture);
    const threadId = await seedThread(fixture);

    await deploySchedule({
      name: "chat-sched",
      agentId: fixture.composeId,
      cronExpression: "0 9 * * *",
      prompt: "daily report",
      description: "d",
      chatThreadId: threadId,
    });
    context.mocks.ably.publish.mockClear();

    const app = createApp({ signal: context.signal });
    const del = await app.request(
      `/api/zero/schedules/chat-sched?agentId=${fixture.composeId}`,
      {
        method: "DELETE",
        headers: { authorization: "Bearer clerk-session" },
      },
    );
    expect(del.status).toBe(204);

    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadSchedulesChanged:${threadId}`,
      null,
    );
  });
});

describe("GET /api/zero/schedules", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await listSchedules({});

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const response = await listSchedules({
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns the list of schedules for the org member", async () => {
    const fixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          displayName: "Test Agent",
          schedules: [
            {
              name: "list-test-1",
              cronExpression: "0 9 * * *",
              prompt: "First",
            },
            {
              name: "list-test-2",
              cronExpression: "0 10 * * *",
              prompt: "Second",
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await listSchedules({
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(200);
    const body = scheduleListResponseSchema.parse(response.body);
    expect(body.schedules).toHaveLength(2);
    const byName = new Map(
      body.schedules.map((s) => {
        return [s.name, s] as const;
      }),
    );
    expect(byName.get("list-test-1")).toMatchObject({
      agentId: fixture.composeId,
      displayName: "Test Agent",
      userId: fixture.userId,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "First",
      enabled: true,
    });
    expect(byName.get("list-test-2")).toMatchObject({
      agentId: fixture.composeId,
      displayName: "Test Agent",
      userId: fixture.userId,
      triggerType: "cron",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
      prompt: "Second",
      enabled: true,
    });
  });

  it("returns an empty array when the user has no schedules", async () => {
    const fixture = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await listSchedules({
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(200);
    expect(scheduleListResponseSchema.parse(response.body)).toStrictEqual({
      schedules: [],
    });
  });
});

describe("POST /api/zero/schedules", () => {
  it("creates a cron schedule and returns 201", async () => {
    const fixture = await seedFixture();
    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "daily-zero",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "Run daily",
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.created).toBeTruthy();
    expect(body.schedule.name).toBe("daily-zero");
    expect(body.schedule.cronExpression).toBe("0 9 * * *");
    expect(body.schedule.enabled).toBeFalsy();
  });

  it("updates an existing schedule and returns 200", async () => {
    const fixture = await seedFixture({
      schedules: [
        {
          name: "update-zero",
          cronExpression: "0 9 * * *",
          prompt: "Original",
        },
      ],
    });

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "update-zero",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
      prompt: "Updated",
    });

    expect(response.status).toBe(200);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.created).toBeFalsy();
    expect(body.schedule.cronExpression).toBe("0 10 * * *");
    expect(body.schedule.prompt).toBe("Updated");
  });

  it("returns 404 for a non-existent agent", async () => {
    await seedFixture();

    const response = await deploySchedule({
      agentId: "00000000-0000-0000-0000-000000000000",
      name: "will-fail",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "Test",
    });

    expect(response.status).toBe(404);
    expectErrorCode(response, "NOT_FOUND");
  });

  it("creates a schedule using the compose agentId", async () => {
    const fixture = await seedFixture();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "agent-id-test",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "Run via agentId",
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.created).toBeTruthy();
    expect(body.schedule.name).toBe("agent-id-test");
  });

  it("ignores stale explicit model override values", async () => {
    const fixture = await seedFixture();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "explicit-model-override",
      cronExpression: "0 0 * * *",
      timezone: "UTC",
      prompt: "Test schedule with explicit model override",
      modelProviderId: "00000000-0000-4000-a000-000000000999",
      selectedModel: "kimi-k2.6",
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule).not.toHaveProperty("modelProviderId");
    expect(body.schedule).not.toHaveProperty("selectedModel");
    expect(body.schedule).not.toHaveProperty("preferPersonalProvider");
  });

  it("does not validate stale schedule model fields", async () => {
    const fixture = await seedFixture();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "stale-model-fields",
      cronExpression: "0 0 * * *",
      timezone: "UTC",
      prompt: "Test with bad provider",
      modelProviderId: "00000000-0000-0000-0000-000000000000",
      selectedModel: "nonexistent-model",
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule).not.toHaveProperty("modelProviderId");
    expect(body.schedule).not.toHaveProperty("selectedModel");
  });

  it("does not expose model fields when the schedule inherits the default", async () => {
    const fixture = await seedFixture();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "inherited-model-default",
      cronExpression: "0 0 * * *",
      timezone: "UTC",
      prompt: "Schedule using inherited model",
      modelProviderId: null,
      selectedModel: null,
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule).not.toHaveProperty("modelProviderId");
    expect(body.schedule).not.toHaveProperty("selectedModel");
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await deploySchedule(
      {
        agentId: randomUUID(),
        name: "unauth",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Test",
      },
      {},
    );

    expect(response.status).toBe(401);
    expectErrorCode(response, "UNAUTHORIZED");
  });

  it("creates a one-time schedule with atTime", async () => {
    const fixture = await seedFixture();
    const futureDate = new Date(now() + 86_400_000).toISOString();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "one-time-test",
      atTime: futureDate,
      timezone: "UTC",
      prompt: "Run once",
      enabled: true,
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule.triggerType).toBe("once");
    expect(body.schedule.atTime).toBe(futureDate);
  });

  it("creates a loop schedule with intervalSeconds", async () => {
    const fixture = await seedFixture();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "loop-test",
      intervalSeconds: 300,
      timezone: "UTC",
      prompt: "Loop every 5 minutes",
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule.triggerType).toBe("loop");
    expect(body.schedule.intervalSeconds).toBe(300);
  });

  it("rejects invalid timezone", async () => {
    const fixture = await seedFixture();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "bad-tz",
      cronExpression: "0 9 * * *",
      timezone: "Invalid/Timezone",
      prompt: "Bad timezone",
    });

    expect(response.status).toBe(400);
    expectErrorCode(response, "BAD_REQUEST");
  });

  it("rejects enabled one-time schedules with past atTime", async () => {
    const fixture = await seedFixture();
    const pastDate = new Date(now() - 86_400_000).toISOString();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "past-time",
      atTime: pastDate,
      timezone: "UTC",
      prompt: "Past schedule",
      enabled: true,
    });

    expect(response.status).toBe(400);
    expectErrorCode(response, "SCHEDULE_PAST");
  });

  it("preserves enabled state and nextRunAt when update omits enabled for enabled loop", async () => {
    const fixture = await seedFixture({
      schedules: [
        {
          name: "loop-shorten",
          triggerType: "loop",
          intervalSeconds: 300,
          prompt: "Loop",
          enabled: true,
          nextRunAt: new Date(now() + 60_000),
        },
      ],
    });

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "loop-shorten",
      intervalSeconds: 60,
      timezone: "UTC",
      prompt: "Loop",
    });

    expect(response.status).toBe(200);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule.enabled).toBeTruthy();
    expect(body.schedule.intervalSeconds).toBe(60);
    expect(body.schedule.nextRunAt).not.toBeNull();
  });

  it("updates schedule trigger type from cron to loop", async () => {
    const fixture = await seedFixture({
      schedules: [
        {
          name: "type-change",
          cronExpression: "0 9 * * *",
          prompt: "Was cron",
        },
      ],
    });

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "type-change",
      intervalSeconds: 600,
      timezone: "UTC",
      prompt: "Now loop",
    });

    expect(response.status).toBe(200);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.created).toBeFalsy();
    expect(body.schedule.triggerType).toBe("loop");
    expect(body.schedule.intervalSeconds).toBe(600);
    expect(body.schedule.cronExpression).toBeNull();
  });

  it("creates a schedule with a non-UTC timezone", async () => {
    const fixture = await seedFixture();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "tokyo-sched",
      cronExpression: "0 9 * * *",
      timezone: "Asia/Tokyo",
      prompt: "Tokyo schedule",
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule.timezone).toBe("Asia/Tokyo");
    expect(body.schedule.nextRunAt).toBeDefined();
  });

  it("preserves an explicit description", async () => {
    const fixture = await seedFixture();

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "desc-test",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "With description",
      description: "Custom description for schedule",
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.schedule.description).toBe("Custom description for schedule");
  });

  it("uses a fallback description when OpenRouter is rate limited", async () => {
    let openRouterCalls = 0;
    const openRouterHandler = () => {
      openRouterCalls++;
      return HttpResponse.json(
        {
          error: {
            message: "Rate limit exceeded: @ratelimit/too-many-requests.",
            code: 429,
          },
        },
        { status: 429 },
      );
    };
    server.use(http.post(OPENROUTER_URL, openRouterHandler));
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const fixture = await seedFixture({
      agentName: "zero-sched-deploy",
    });
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");

    const response = await deploySchedule({
      agentId: fixture.composeId,
      name: "openrouter-rate-limit",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "Run despite description generation failing",
    });

    expect(response.status).toBe(201);
    const body = deployScheduleResponseSchema.parse(response.body);
    expect(body.created).toBeTruthy();
    expect(body.schedule.description).toBe(
      "zero-sched-deploy recurring task: Run despite description generation failing",
    );
    expect(openRouterCalls).toBe(1);
  });
});
