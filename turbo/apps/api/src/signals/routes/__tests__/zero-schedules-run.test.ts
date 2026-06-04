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

describe("POST /api/zero/schedules/run", () => {
  it("executes a schedule and returns runId with 201", async () => {
    const fixture = await seedFixture();
    const scheduleId = fixture.scheduleIds[0];
    if (!scheduleId) {
      throw new Error("Expected schedule fixture");
    }

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

    const [callback] = await db
      .select({
        url: agentRunCallbacks.url,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, body.runId));
    expect(callback?.url).toMatch(
      /\/api\/internal\/callbacks\/schedule\/cron$/,
    );
    expect(callback?.payload).toMatchObject({ scheduleId });
  });

  it("runs in chat mode: posts a user message + adds the chat callback", async () => {
    const fixture = await seedFixture();
    const scheduleId = fixture.scheduleIds[0];
    if (!scheduleId) {
      throw new Error("Expected schedule fixture");
    }
    const db = store.set(writeDb$);
    const threadId = randomUUID();
    await db.insert(chatThreads).values({
      id: threadId,
      userId: fixture.userId,
      agentComposeId: fixture.composeId,
      title: "linked thread",
    });
    await db
      .update(zeroAgentSchedules)
      .set({ chatThreadId: threadId })
      .where(eq(zeroAgentSchedules.id, scheduleId));

    const response = await rawPostRun({ scheduleId });
    expect(response.status).toBe(201);
    const body = runResponseSchema.parse(response.body);

    // The run is bound to the thread but still identified as a scheduled run.
    const [zeroRun] = await db
      .select({
        triggerSource: zeroRuns.triggerSource,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, body.runId));
    expect(zeroRun).toStrictEqual({
      triggerSource: "schedule",
      chatThreadId: threadId,
    });

    // The prompt was posted as a user chat message bound to the run, tagged
    // with the originating schedule's id and a snapshot of its title.
    const messages = await db
      .select({
        content: chatMessages.content,
        role: chatMessages.role,
        scheduleId: chatMessages.scheduleId,
        scheduleTitle: chatMessages.scheduleTitle,
      })
      .from(chatMessages)
      .where(eq(chatMessages.runId, body.runId));
    expect(
      messages.some((message) => {
        return (
          message.role === "user" &&
          message.content === "Manual run test" &&
          message.scheduleId === scheduleId &&
          message.scheduleTitle === "run-test"
        );
      }),
    ).toBeTruthy();

    // Both the reschedule callback and the chat callback are registered.
    const callbacks = await db
      .select({ url: agentRunCallbacks.url })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, body.runId));
    const urls = callbacks.map((callback) => {
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
  });

  it("resolves user grants for the schedule owner", async () => {
    const fixture = await seedFixture();
    const scheduleId = fixture.scheduleIds[0];
    if (!scheduleId) {
      throw new Error("Expected schedule fixture");
    }
    await seedSlackGrantForScheduleOwner(fixture);
    mocks.clerk.session(`trigger-${fixture.userId}`, fixture.orgId);

    const response = await rawPostRun({ scheduleId });

    expect(response.status).toBe(201);
    const body = runResponseSchema.parse(response.body);
    const policy = await networkPolicyForRun(body.runId, SLACK_CONNECTOR);
    expect(policy.allow).toContain(SLACK_WRITE_PERMISSION);
    expect(policy.deny).not.toContain(SLACK_WRITE_PERMISSION);
  });

  it("resolves the runtime model from the model-first default route", async () => {
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
  });

  it("returns 404 for a non-existent schedule", async () => {
    await seedFixture();

    const response = await rawPostRun({
      scheduleId: "00000000-0000-0000-0000-000000000000",
    });

    expect(response.status).toBe(404);
    expect(expectErrorCode(response)).toBe("NOT_FOUND");
  });

  it("returns 409 when the previous run is still active", async () => {
    const fixture = await seedFixture();
    const scheduleId = fixture.scheduleIds[0];
    if (!scheduleId) {
      throw new Error("Expected schedule fixture");
    }

    const firstResponse = await rawPostRun({ scheduleId });
    expect(firstResponse.status).toBe(201);
    expect(runResponseSchema.parse(firstResponse.body).runId).toBeDefined();

    const secondResponse = await rawPostRun({ scheduleId });

    expect(secondResponse.status).toBe(409);
    expect(expectErrorCode(secondResponse)).toBe("CONFLICT");
  });

  it("returns 400 for invalid body when scheduleId is missing", async () => {
    await seedFixture();

    const response = await rawPostRun({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("returns 400 for invalid scheduleId format", async () => {
    await seedFixture();

    const response = await rawPostRun({ scheduleId: "not-a-uuid" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await rawPostRun({ scheduleId: randomUUID() }, {});

    expect(response.status).toBe(401);
    expect(expectErrorCode(response)).toBe("UNAUTHORIZED");
  });
});
