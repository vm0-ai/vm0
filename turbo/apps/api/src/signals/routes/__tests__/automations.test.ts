import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import {
  automationListResponseSchema,
  automationMutationResponseSchema,
  automationResponseSchema,
} from "@vm0/api-contracts/contracts/automations";
import { scheduleListResponseSchema } from "@vm0/api-contracts/contracts/zero-schedules";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
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
const runResponseSchema = z.object({ runId: z.string() });

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

async function requestStatus(path: string, init: RequestInit): Promise<number> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(path, init);
  return response.status;
}

const SESSION_HEADERS = { authorization: "Bearer clerk-session" } as const;

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { ...SESSION_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function seedFixture(
  values: Partial<SchedulesScenarioValues> = {},
): Promise<SchedulesFixture> {
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  context.mocks.s3.send.mockResolvedValue({});
  const fixture = await track(
    store.set(
      seedSchedulesScenario$,
      {
        timezone: "America/Los_Angeles",
        schedules: [],
        ...values,
      },
      context.signal,
    ),
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function enableAutomations(fixture: SchedulesFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.ZeroAutomations]: true },
  });
}

function expectErrorCode(response: TestApiResponse): string {
  return apiErrorSchema.parse(response.body).error.code;
}

interface RunArtifacts {
  readonly prompt: string | null;
  readonly appendSystemPrompt: string | null;
  readonly triggerSource: string | null;
  readonly scheduleId: string | null;
  readonly chatThreadId: string | null;
  readonly chatMessage: {
    readonly content: string | null;
    readonly role: string;
  } | null;
  readonly callbackPaths: readonly string[];
}

function callbackPath(url: string): string {
  return new URL(url).pathname;
}

// The run is identified by the agent-run row; collect everything that
// determines how it renders into the linked chat thread, normalized so two
// runs produced from equivalent definitions compare equal.
async function collectRunArtifacts(runId: string): Promise<RunArtifacts> {
  const db = store.set(writeDb$);
  const [run] = await db
    .select({
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  const [zeroRun] = await db
    .select({
      triggerSource: zeroRuns.triggerSource,
      scheduleId: zeroRuns.scheduleId,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId));
  const messages = await db
    .select({
      content: chatMessages.content,
      role: chatMessages.role,
    })
    .from(chatMessages)
    .where(eq(chatMessages.runId, runId));
  const userMessage = messages.find((message) => {
    return message.role === "user";
  });
  const callbacks = await db
    .select({ url: agentRunCallbacks.url })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));

  return {
    prompt: run?.prompt ?? null,
    appendSystemPrompt: run?.appendSystemPrompt ?? null,
    triggerSource: zeroRun?.triggerSource ?? null,
    // scheduleId / chatThreadId differ per schedule row, so blank them out:
    // parity is about the SHAPE of the rendering, not the row identity.
    scheduleId: zeroRun?.scheduleId ? "<scheduleId>" : null,
    chatThreadId: zeroRun?.chatThreadId ? "<chatThreadId>" : null,
    chatMessage: userMessage
      ? { content: userMessage.content, role: userMessage.role }
      : null,
    callbackPaths: callbacks
      .map((callback) => {
        return callbackPath(callback.url);
      })
      .sort(),
  };
}

interface TriggerCase {
  readonly label: string;
  readonly cronExpression?: string;
  // A future offset (ms from now) for `once` triggers; resolved inside the test
  // with the mockable now() so the at-time is not in the past.
  readonly atTimeOffsetMs?: number;
  readonly intervalSeconds?: number;
}

const TRIGGER_CASES: readonly TriggerCase[] = [
  { label: "cron", cronExpression: "0 9 * * *" },
  { label: "once", atTimeOffsetMs: 60 * 60 * 1000 },
  { label: "loop", intervalSeconds: 3600 },
];

describe("Automations API parity with the legacy schedule surface", () => {
  it("create + list produce equivalent automation/schedule rows", async () => {
    const fixture = await seedFixture();
    await enableAutomations(fixture);

    const oldResponse = await requestJson(
      "/api/zero/schedules",
      jsonInit("POST", {
        name: "legacy-create",
        agentId: fixture.composeId,
        cronExpression: "0 9 * * *",
        prompt: "Daily summary",
        appendSystemPrompt: "Use the shared context.",
        timezone: "UTC",
        enabled: true,
      }),
    );
    expect(oldResponse.status).toBe(201);

    const newResponse = await requestJson(
      "/api/automations",
      jsonInit("POST", {
        name: "automation-create",
        agentId: fixture.composeId,
        cronExpression: "0 9 * * *",
        prompt: "Daily summary",
        appendSystemPrompt: "Use the shared context.",
        timezone: "UTC",
        enabled: true,
      }),
    );
    expect(newResponse.status).toBe(201);

    const mutation = automationMutationResponseSchema.parse(newResponse.body);
    expect(mutation.created).toBeTruthy();

    // The new surface reports the SAME cleaned field set as the legacy deploy
    // — comparing the persisted rows (minus identity columns) proves parity.
    const db = store.set(writeDb$);
    const rows = await db
      .select({
        name: zeroAgentSchedules.name,
        triggerType: zeroAgentSchedules.triggerType,
        cronExpression: zeroAgentSchedules.cronExpression,
        intervalSeconds: zeroAgentSchedules.intervalSeconds,
        timezone: zeroAgentSchedules.timezone,
        prompt: zeroAgentSchedules.prompt,
        appendSystemPrompt: zeroAgentSchedules.appendSystemPrompt,
        enabled: zeroAgentSchedules.enabled,
      })
      .from(zeroAgentSchedules)
      .where(eq(zeroAgentSchedules.agentId, fixture.composeId));
    const legacyRow = rows.find((row) => {
      return row.name === "legacy-create";
    });
    const automationRow = rows.find((row) => {
      return row.name === "automation-create";
    });
    expect(legacyRow).toBeDefined();
    expect(automationRow).toBeDefined();
    const normalize = (row: NonNullable<typeof legacyRow>) => {
      return { ...row, name: "<name>" };
    };
    expect(normalize(automationRow!)).toStrictEqual(normalize(legacyRow!));

    // Both surfaces project the same rows; list output matches field-for-field.
    const automationsList = automationListResponseSchema.parse(
      (
        await requestJson("/api/automations", {
          method: "GET",
          headers: SESSION_HEADERS,
        })
      ).body,
    );
    const schedulesList = scheduleListResponseSchema.parse(
      (
        await requestJson("/api/zero/schedules", {
          method: "GET",
          headers: SESSION_HEADERS,
        })
      ).body,
    );
    expect(automationsList.automations).toStrictEqual(schedulesList.schedules);
  });

  it.each(TRIGGER_CASES)(
    "run-now renders identically for $label triggers",
    async (triggerCase) => {
      const atTime =
        triggerCase.atTimeOffsetMs === undefined
          ? undefined
          : new Date(now() + triggerCase.atTimeOffsetMs);
      const fixture = await seedFixture({
        schedules: [
          {
            name: `${triggerCase.label}-old`,
            prompt: "Run me",
            appendSystemPrompt: "Shared run context.",
            cronExpression: triggerCase.cronExpression,
            atTime,
            intervalSeconds: triggerCase.intervalSeconds,
            enabled: true,
          },
          {
            name: `${triggerCase.label}-new`,
            prompt: "Run me",
            appendSystemPrompt: "Shared run context.",
            cronExpression: triggerCase.cronExpression,
            atTime,
            intervalSeconds: triggerCase.intervalSeconds,
            enabled: true,
          },
        ],
      });
      await enableAutomations(fixture);

      const oldScheduleId = fixture.scheduleIds[0];
      const newScheduleId = fixture.scheduleIds[1];
      if (!oldScheduleId || !newScheduleId) {
        throw new Error("Expected two seeded schedules");
      }

      const oldRun = await requestJson(
        "/api/zero/schedules/run",
        jsonInit("POST", { scheduleId: oldScheduleId }),
      );
      expect(oldRun.status).toBe(201);
      const oldRunId = runResponseSchema.parse(oldRun.body).runId;

      const newRun = await requestJson(
        "/api/automations/run",
        jsonInit("POST", { automationId: newScheduleId }),
      );
      expect(newRun.status).toBe(201);
      const newRunId = runResponseSchema.parse(newRun.body).runId;

      const oldArtifacts = await collectRunArtifacts(oldRunId);
      const newArtifacts = await collectRunArtifacts(newRunId);

      // Same agent run + same chat-thread rendering for this trigger type.
      expect(newArtifacts).toStrictEqual(oldArtifacts);
      expect(newArtifacts.triggerSource).toBe("schedule");
      expect(newArtifacts.callbackPaths).toContain(
        "/api/internal/callbacks/chat",
      );
      const expectedReschedulePath =
        triggerCase.label === "loop"
          ? "/api/internal/callbacks/schedule/loop"
          : "/api/internal/callbacks/schedule/cron";
      expect(newArtifacts.callbackPaths).toContain(expectedReschedulePath);
    },
  );
});

describe("Automations API feature-switch gating", () => {
  it("returns 404 on every automation endpoint when the switch is off", async () => {
    const fixture = await seedFixture({
      schedules: [
        {
          name: "gated",
          prompt: "Run me",
          cronExpression: "0 9 * * *",
          enabled: true,
        },
      ],
    });
    const scheduleId = fixture.scheduleIds[0];
    if (!scheduleId) {
      throw new Error("Expected seeded schedule");
    }

    const create = await requestJson(
      "/api/automations",
      jsonInit("POST", {
        name: "blocked",
        agentId: fixture.composeId,
        cronExpression: "0 9 * * *",
        prompt: "Should not be created",
      }),
    );
    expect(create.status).toBe(404);
    expect(expectErrorCode(create)).toBe("NOT_FOUND");

    const list = await requestJson("/api/automations", {
      method: "GET",
      headers: SESSION_HEADERS,
    });
    expect(list.status).toBe(404);

    const update = await requestJson(
      "/api/automations/gated",
      jsonInit("PUT", {
        agentId: fixture.composeId,
        cronExpression: "0 10 * * *",
        prompt: "Should not update",
      }),
    );
    expect(update.status).toBe(404);

    const enable = await requestJson(
      "/api/automations/gated/enable",
      jsonInit("POST", { agentId: fixture.composeId }),
    );
    expect(enable.status).toBe(404);

    const disable = await requestJson(
      "/api/automations/gated/disable",
      jsonInit("POST", { agentId: fixture.composeId }),
    );
    expect(disable.status).toBe(404);

    const run = await requestJson(
      "/api/automations/run",
      jsonInit("POST", { automationId: scheduleId }),
    );
    expect(run.status).toBe(404);

    const del = await requestJson(
      `/api/automations/gated?agentId=${fixture.composeId}`,
      { method: "DELETE", headers: SESSION_HEADERS },
    );
    expect(del.status).toBe(404);

    // The legacy surface is unaffected while the switch is off.
    const legacyList = await requestJson("/api/zero/schedules", {
      method: "GET",
      headers: SESSION_HEADERS,
    });
    expect(legacyList.status).toBe(200);
    const parsed = scheduleListResponseSchema.parse(legacyList.body);
    expect(
      parsed.schedules.some((schedule) => {
        return schedule.name === "gated";
      }),
    ).toBeTruthy();
  });
});

describe("Automations API behaviors", () => {
  it("updates an existing automation by name via PUT", async () => {
    const fixture = await seedFixture({
      schedules: [
        {
          name: "editable",
          prompt: "Original",
          cronExpression: "0 9 * * *",
          enabled: true,
        },
      ],
    });
    await enableAutomations(fixture);

    const response = await requestJson(
      "/api/automations/editable",
      jsonInit("PUT", {
        agentId: fixture.composeId,
        cronExpression: "0 18 * * *",
        prompt: "Updated prompt",
        description: "Updated description",
      }),
    );
    expect(response.status).toBe(200);
    const mutation = automationMutationResponseSchema.parse(response.body);
    expect(mutation.created).toBeFalsy();
    expect(mutation.automation.prompt).toBe("Updated prompt");
    expect(mutation.automation.cronExpression).toBe("0 18 * * *");

    const db = store.set(writeDb$);
    const [row] = await db
      .select({
        prompt: zeroAgentSchedules.prompt,
        cronExpression: zeroAgentSchedules.cronExpression,
      })
      .from(zeroAgentSchedules)
      .where(eq(zeroAgentSchedules.id, mutation.automation.id));
    expect(row?.prompt).toBe("Updated prompt");
    expect(row?.cronExpression).toBe("0 18 * * *");
  });

  it("enables and disables an automation by name", async () => {
    const fixture = await seedFixture({
      schedules: [
        {
          name: "toggle",
          prompt: "Run me",
          cronExpression: "0 9 * * *",
          enabled: false,
        },
      ],
    });
    await enableAutomations(fixture);

    const enabled = await requestJson(
      "/api/automations/toggle/enable",
      jsonInit("POST", { agentId: fixture.composeId }),
    );
    expect(enabled.status).toBe(200);
    expect(automationResponseSchema.parse(enabled.body).enabled).toBeTruthy();

    const disabled = await requestJson(
      "/api/automations/toggle/disable",
      jsonInit("POST", { agentId: fixture.composeId }),
    );
    expect(disabled.status).toBe(200);
    expect(automationResponseSchema.parse(disabled.body).enabled).toBeFalsy();
  });

  it("deletes an automation by name", async () => {
    const fixture = await seedFixture({
      schedules: [
        {
          name: "removable",
          prompt: "Run me",
          cronExpression: "0 9 * * *",
          enabled: true,
        },
      ],
    });
    await enableAutomations(fixture);

    const delStatus = await requestStatus(
      `/api/automations/removable?agentId=${fixture.composeId}`,
      { method: "DELETE", headers: SESSION_HEADERS },
    );
    expect(delStatus).toBe(204);

    const db = store.set(writeDb$);
    const rows = await db
      .select({ id: zeroAgentSchedules.id })
      .from(zeroAgentSchedules)
      .where(eq(zeroAgentSchedules.agentId, fixture.composeId));
    expect(rows).toHaveLength(0);
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await requestJson("/api/automations", {
      method: "GET",
      headers: {},
    });
    expect(response.status).toBe(401);
    expect(expectErrorCode(response)).toBe("UNAUTHORIZED");
  });
});
