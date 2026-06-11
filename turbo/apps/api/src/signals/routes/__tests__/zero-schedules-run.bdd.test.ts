import { randomUUID } from "node:crypto";

import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import { connectors } from "@vm0/db/schema/connector";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets } from "@vm0/db/schema/secret";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import {
  type SchedulesFixture,
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
} from "./helpers/zero-schedules";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { seedOrgModelProvider$ } from "./helpers/zero-model-providers";
import { encryptSecretForTests } from "./helpers/encrypt-secret";

// BDD migration of the legacy `zero-schedules-run.test.ts`.
// The 9 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// happy path chain (401 unauthenticated → 201 executes
// schedule and returns runId with 201 + writes
// lastRunId + persists appendSystemPrompt + writes
// triggerSource=schedule + registers the cron callback →
// 201 chat mode: posts a user message + adds the chat
// callback → 201 resolves user grants for the schedule
// owner), (2) model + conflict chain (201 resolves the
// runtime model from the model-first default route → 404
// for a non-existent schedule → 409 when the previous run
// is still active), (3) validation chain (400 invalid body
// when scheduleId is missing → 400 invalid scheduleId
// format).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const runResponseSchema = z.object({ runId: z.string() });
const SLACK_CONNECTOR = "slack";
const SLACK_WRITE_PERMISSION = "chat:write";

interface QueuedNetworkPolicy {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
  readonly unknownPolicy: string;
}

const track = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

async function seedFixture(): Promise<SchedulesFixture> {
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  context.mocks.s3.send.mockResolvedValue({});

  const fixture = await track(
    store.set(
      seedSchedulesScenario$,
      {
        userName: "Schedule Owner",
        userEmail: "schedule-owner@example.com",
        timezone: "America/Los_Angeles",
        schedules: [
          {
            name: "run-test",
            cronExpression: "0 9 * * *",
            prompt: "Manual run test",
            description: "Run test description",
            appendSystemPrompt: "Use the schedule-specific context.",
            enabled: true,
          },
        ],
      },
      context.signal,
    ),
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function seedSlackGrantForScheduleOwner(
  fixture: SchedulesFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userConnectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    agentId: fixture.composeId,
    connectorType: SLACK_CONNECTOR,
  });
  await db.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: SLACK_CONNECTOR,
    authMethod: "oauth",
  });
  await db.insert(secrets).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "SLACK_ACCESS_TOKEN",
    encryptedValue: encryptSecretForTests("xoxb-schedule-token"),
    type: "connector",
  });
  await db.insert(userPermissionGrants).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    agentId: fixture.composeId,
    connectorRef: SLACK_CONNECTOR,
    permission: SLACK_WRITE_PERMISSION,
    action: "allow",
  });
}

async function networkPolicyForRun(
  runId: string,
  connectorRef: string,
): Promise<QueuedNetworkPolicy> {
  const db = store.set(writeDb$);
  const [job] = await db
    .select({ executionContext: runnerJobQueue.executionContext })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId));
  const executionContext = job?.executionContext as
    | {
        readonly networkPolicies?: Record<string, QueuedNetworkPolicy>;
      }
    | undefined;
  const policy = executionContext?.networkPolicies?.[connectorRef];
  if (!policy) {
    throw new Error(`Expected network policy for ${connectorRef}`);
  }
  return policy;
}

async function rawPostRun(body: unknown): Promise<{
  readonly status: number;
  readonly body: unknown;
}>;
async function rawPostRun(
  body: unknown,
  headers: Record<string, string>,
): Promise<{
  readonly status: number;
  readonly body: unknown;
}>;
async function rawPostRun(
  body: unknown,
  headers: Record<string, string> = {
    authorization: "Bearer clerk-session",
  },
): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/zero/schedules/run", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function expectErrorCode(response: { readonly body: unknown }): string {
  return apiErrorSchema.parse(response.body).error.code;
}

describe("BDD POST /api/zero/schedules/run — happy path chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 201 executes schedule and returns runId with 201 + writes lastRunId + persists appendSystemPrompt + writes triggerSource=schedule + registers the cron callback → 201 chat mode: posts a user message + adds the chat callback → 201 resolves user grants for the schedule owner", async () => {
    // Given: no auth header.

    // When + Then: 401 — unauthenticated request.
    const unauth = await rawPostRun({ scheduleId: randomUUID() }, {});
    expect(unauth.status).toBe(401);
    expect(expectErrorCode(unauth)).toBe("UNAUTHORIZED");

    // Given: a fixture.
    const fixture = await seedFixture();
    const scheduleId = fixture.scheduleIds[0];
    if (!scheduleId) {
      throw new Error("Expected schedule fixture");
    }

    // When + Then: 201 — schedule executes + lastRunId is
    // updated + run carries schedule context + zeroRun is
    // tagged as schedule + the cron callback is
    // registered.
    const response = await rawPostRun({ scheduleId });
    expect(response.status).toBe(201);
    const body = runResponseSchema.parse(response.body);

    const db = store.set(writeDb$);
    const [schedule] = await db
      .select({ lastRunId: zeroAgentSchedules.lastRunId })
      .from(zeroAgentSchedules)
      .where(eq(zeroAgentSchedules.id, scheduleId));
    expect(schedule?.lastRunId).toBe(body.runId);

    const [run] = await db
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, body.runId));
    expect(run?.prompt).toBe("Manual run test");
    expect(run?.appendSystemPrompt).toContain(
      "# Current Integration\nYou are currently running inside: Schedule",
    );
    expect(run?.appendSystemPrompt).toContain("Trigger type: cron");
    expect(run?.appendSystemPrompt).toContain(
      "Use the schedule-specific context.",
    );

    const [zeroRun] = await db
      .select({
        triggerSource: zeroRuns.triggerSource,
        scheduleId: zeroRuns.scheduleId,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, body.runId));
    expect(zeroRun).toStrictEqual({
      triggerSource: "schedule",
      scheduleId,
    });

    const callbacks = await db
      .select({
        url: agentRunCallbacks.url,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, body.runId));
    const cronCallback = callbacks.find((callback) => {
      return callback.url.endsWith("/api/internal/callbacks/schedule/cron");
    });
    expect(cronCallback).toBeDefined();
    expect(cronCallback?.payload).toMatchObject({ scheduleId });

    // Given: a fresh fixture linked to a chat thread.
    const chatFixture = await seedFixture();
    const chatScheduleId = chatFixture.scheduleIds[0];
    if (!chatScheduleId) {
      throw new Error("Expected schedule fixture");
    }
    const chatDb = store.set(writeDb$);
    const threadId = randomUUID();
    await chatDb.insert(chatThreads).values({
      id: threadId,
      userId: chatFixture.userId,
      agentComposeId: chatFixture.composeId,
      title: "linked thread",
    });
    await chatDb
      .update(zeroAgentSchedules)
      .set({ chatThreadId: threadId })
      .where(eq(zeroAgentSchedules.id, chatScheduleId));

    // When + Then: 201 — chat-mode run posts a user
    // message + adds both cron + chat callbacks.
    const chatResponse = await rawPostRun({ scheduleId: chatScheduleId });
    expect(chatResponse.status).toBe(201);
    const chatBody = runResponseSchema.parse(chatResponse.body);

    const [chatZeroRun] = await chatDb
      .select({
        triggerSource: zeroRuns.triggerSource,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, chatBody.runId));
    expect(chatZeroRun).toStrictEqual({
      triggerSource: "schedule",
      chatThreadId: threadId,
    });

    const messages = await chatDb
      .select({
        content: chatMessages.content,
        role: chatMessages.role,
        scheduleId: chatMessages.scheduleId,
        scheduleTitle: chatMessages.scheduleTitle,
        scheduleSnapshot: chatMessages.scheduleSnapshot,
      })
      .from(chatMessages)
      .where(eq(chatMessages.runId, chatBody.runId));
    expect(
      messages.some((message) => {
        return (
          message.role === "user" &&
          message.content === "Manual run test" &&
          message.scheduleId === chatScheduleId &&
          message.scheduleTitle === "run-test" &&
          message.scheduleSnapshot?.id === chatScheduleId &&
          message.scheduleSnapshot.title === "run-test" &&
          message.scheduleSnapshot.description === "Run test description"
        );
      }),
    ).toBeTruthy();

    const chatCallbacks = await chatDb
      .select({ url: agentRunCallbacks.url })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, chatBody.runId));
    const urls = chatCallbacks.map((callback) => {
      return callback.url;
    });
    expect(
      urls.some((url) => {
        return url.endsWith("/callbacks/schedule/cron");
      }),
    ).toBeTruthy();
    expect(
      urls.some((url) => {
        return url.endsWith("/callbacks/chat");
      }),
    ).toBeTruthy();

    // Given: a fresh fixture + slack grants for the
    // schedule owner + a different user session.
    const grantFixture = await seedFixture();
    const grantScheduleId = grantFixture.scheduleIds[0];
    if (!grantScheduleId) {
      throw new Error("Expected schedule fixture");
    }
    await seedSlackGrantForScheduleOwner(grantFixture);
    mocks.clerk.session(`trigger-${grantFixture.userId}`, grantFixture.orgId);

    // When + Then: 201 — the slack connector network
    // policy allows the granted `chat:write` permission.
    const grantResponse = await rawPostRun({ scheduleId: grantScheduleId });
    expect(grantResponse.status).toBe(201);
    const grantBody = runResponseSchema.parse(grantResponse.body);
    const policy = await networkPolicyForRun(grantBody.runId, SLACK_CONNECTOR);
    expect(policy.allow).toContain(SLACK_WRITE_PERMISSION);
    expect(policy.deny).not.toContain(SLACK_WRITE_PERMISSION);
  });
});

describe("BDD POST /api/zero/schedules/run — model + conflict chain", () => {
  it("gwt-wt-wt: 201 resolves the runtime model from the model-first default route → 404 for a non-existent schedule → 409 when the previous run is still active", async () => {
    // Given: a fixture + an org-level model policy.
    const fixture = await seedFixture();
    const scheduleId = fixture.scheduleIds[0];
    if (!scheduleId) {
      throw new Error("Expected schedule fixture");
    }
    const provider = await store.set(
      seedOrgModelProvider$,
      {
        orgId: fixture.orgId,
        type: "anthropic-api-key",
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    const db = store.set(writeDb$);
    await db.insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: "claude-opus-4-7",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: provider.id,
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });

    // When + Then: 201 — the run resolves the model
    // provider from the org default policy.
    const response = await rawPostRun({ scheduleId });
    expect(response.status).toBe(201);
    const body = runResponseSchema.parse(response.body);
    const [zeroRun] = await db
      .select({
        modelProvider: zeroRuns.modelProvider,
        modelProviderId: zeroRuns.modelProviderId,
        modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, body.runId));
    expect(zeroRun).toStrictEqual({
      modelProvider: "anthropic-api-key",
      modelProviderId: provider.id,
      modelProviderCredentialScope: "org",
      selectedModel: "claude-opus-4-7",
    });

    // Given: a fresh fixture + a non-existent schedule id.

    // When + Then: 404 — NOT_FOUND.
    await seedFixture();
    const notFoundResponse = await rawPostRun({
      scheduleId: "00000000-0000-0000-0000-000000000000",
    });
    expect(notFoundResponse.status).toBe(404);
    expect(expectErrorCode(notFoundResponse)).toBe("NOT_FOUND");

    // Given: a fresh fixture.

    // When + Then: 201 first run + 409 second run for the
    // same schedule (previous run still active).
    const conflictFixture = await seedFixture();
    const conflictScheduleId = conflictFixture.scheduleIds[0];
    if (!conflictScheduleId) {
      throw new Error("Expected schedule fixture");
    }
    const firstResponse = await rawPostRun({
      scheduleId: conflictScheduleId,
    });
    expect(firstResponse.status).toBe(201);
    expect(runResponseSchema.parse(firstResponse.body).runId).toBeDefined();
    const secondResponse = await rawPostRun({
      scheduleId: conflictScheduleId,
    });
    expect(secondResponse.status).toBe(409);
    expect(expectErrorCode(secondResponse)).toBe("CONFLICT");
  });
});

describe("BDD POST /api/zero/schedules/run — validation chain", () => {
  it("gwt-wt-wt: 400 invalid body when scheduleId is missing → 400 invalid scheduleId format", async () => {
    // Given: a fresh fixture.

    // When + Then: 400 — empty body.
    await seedFixture();
    const emptyResponse = await rawPostRun({});
    expect(emptyResponse.status).toBe(400);
    expect(emptyResponse.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    // Given: a fresh fixture + an invalid scheduleId
    // format.

    // When + Then: 400 — invalid uuid format.
    await seedFixture();
    const invalidFormatResponse = await rawPostRun({
      scheduleId: "not-a-uuid",
    });
    expect(invalidFormatResponse.status).toBe(400);
    expect(invalidFormatResponse.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});
