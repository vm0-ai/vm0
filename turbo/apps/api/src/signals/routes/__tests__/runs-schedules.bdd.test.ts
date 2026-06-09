import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  createRunsSchedulesApi,
  uniqueScheduleName,
} from "./helpers/api-bdd-runs-schedules";

/**
 * helper gap:
 * - RUN-02 exhaustive connector credential, secret, variable, grant, custom
 *   connector, and skill setup still needs public API helper coverage before
 *   the old DB fixture matrix can be ported without DB writes. This file covers
 *   model-provider setup through API routes and run-context GET boundaries.
 * - RUN-01/RUN-03/CHAIN-RUN successful dispatch needs a public billing
 *   entitlement helper that can move a test org out of pro-suspend without DB
 *   writes. Until then, this file covers the visible no-credit admission
 *   response and runner heartbeat/poll auth surfaces.
 * - RUN-04 checkpoint creation and persisted runner log ingestion need
 *   callback/event API helpers. This file covers missing-run GET boundaries
 *   until API helpers can create visible checkpoint and log state.
 * - SCHED-01 has no standalone read-by-name route; schedule list is used as
 *   the visible read surface for create, update, enable, disable, and delete.
 * - CHAIN-SCHEDULE cron execution returns counts and exposes schedule
 *   lastRunAt, but the cron route does not expose the generated run id. Manual
 *   run-now currently covers the no-credit admission boundary until a public
 *   entitlement helper exists.
 * - SCHED-02 sync-skills valid-path coverage needs a focused external GitHub
 *   tarball/S3 helper; this file keeps cron auth and safe no-work cron routes
 *   route-based without adding that external fixture.
 */

const context = testContext();

async function createAgentWithModelProvider(actor: ApiTestUser): Promise<{
  readonly agentId: string;
}> {
  const bdd = createBddApi(context);
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD run agent",
    description: "Exercises run and schedule API integration tests.",
    visibility: "private",
  });

  const api = createRunsSchedulesApi(context);
  await api.ensureOrgModelProvider(actor);

  return { agentId: agent.agentId };
}

function findSchedule<
  TSchedule extends { readonly id: string; readonly name: string },
>(schedules: readonly TSchedule[], scheduleId: string): TSchedule | undefined {
  return schedules.find((schedule) => {
    return schedule.id === scheduleId;
  });
}

describe("RUN-01: run creation admission and validation", () => {
  it("rejects invalid or unauthorized run creation requests through API validation", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();

    const unauthenticated = await api.requestCreateRun(
      null,
      {
        agentId: randomUUID(),
        prompt: "summarize the repo",
        modelProvider: "anthropic-api-key",
      },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const missingAgent = await api.requestCreateRunUnchecked(
      actor,
      { prompt: "summarize the repo" },
      [400],
    );
    expectApiError(missingAgent.body);
    expect(missingAgent.body.error.code).toBe("BAD_REQUEST");

    const invalidTools = await api.requestCreateRun(
      actor,
      {
        agentId: randomUUID(),
        prompt: "use a malformed tool list",
        tools: ["Bash,Read"],
        modelProvider: "anthropic-api-key",
      },
      [400],
    );
    expectApiError(invalidTools.body);
    expect(invalidTools.body.error.code).toBe("BAD_REQUEST");

    const missingSession = await api.requestCreateRun(
      actor,
      {
        sessionId: randomUUID(),
        prompt: "resume a missing session",
        modelProvider: "anthropic-api-key",
      },
      [404],
    );
    expectApiError(missingSession.body);
    expect(missingSession.body.error.code).toBe("NOT_FOUND");

    const missingAgentId = await api.requestCreateRun(
      actor,
      {
        agentId: randomUUID(),
        prompt: "run a missing agent",
        modelProvider: "anthropic-api-key",
      },
      [404],
    );
    expectApiError(missingAgentId.body);
    expect(missingAgentId.body.error.code).toBe("NOT_FOUND");
  });
});

describe("RUN-01..04 and CHAIN-RUN: run admission, runner, and visible reads", () => {
  it("sets up run prerequisites through APIs and exposes the no-credit admission boundary", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);

    const denied = await api.requestCreateRun(
      actor,
      {
        agentId,
        prompt: "Produce a concise status report.",
        modelProvider: "anthropic-api-key",
        tools: ["Bash"],
        settings: "{}",
      },
      [402],
    );
    expectApiError(denied.body);
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const queue = await api.readRunQueue(actor);
    expect(queue.body.concurrency.active).toBe(0);
    expect(queue.body.queue).toHaveLength(0);

    const heartbeat = await api.heartbeatRunner();
    expect(heartbeat.body.ok).toBeTruthy();

    const poll = await api.pollRunner();
    expect(poll.body.job).toBeNull();

    const missingRunId = randomUUID();
    const missingRun = await api.requestReadRun(actor, missingRunId, [404]);
    expectApiError(missingRun.body);
    expect(missingRun.body.error.code).toBe("NOT_FOUND");

    const missingContext = await api.requestRunContext(
      actor,
      missingRunId,
      [404],
    );
    expectApiError(missingContext.body);
    expect(missingContext.body.error.code).toBe("NOT_FOUND");
  });

  it("keeps missing run detail and context hidden for another organization", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const outsider = bdd.user();
    const missingRunId = randomUUID();

    const hiddenRun = await api.requestReadRun(outsider, missingRunId, [404]);
    expectApiError(hiddenRun.body);
    expect(hiddenRun.body.error.code).toBe("NOT_FOUND");

    const hiddenContext = await api.requestRunContext(
      outsider,
      missingRunId,
      [404],
    );
    expectApiError(hiddenContext.body);
    expect(hiddenContext.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed and unauthenticated runner, queue, read, context, and cancel requests", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const missingRunId = randomUUID();
    const invalidRunId = "not-a-run-id";

    const unauthenticatedQueue = await api.requestReadRunQueue(null, [401]);
    expectApiError(unauthenticatedQueue.body);
    expect(unauthenticatedQueue.body.error.code).toBe("UNAUTHORIZED");

    const unauthenticatedRead = await api.requestReadRun(
      null,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedRead.body);
    expect(unauthenticatedRead.body.error.code).toBe("UNAUTHORIZED");

    const invalidRead = await api.requestReadRun(actor, invalidRunId, [400]);
    expectApiError(invalidRead.body);
    expect(invalidRead.body.error.code).toBe("BAD_REQUEST");

    const invalidContext = await api.requestRunContext(
      actor,
      invalidRunId,
      [400],
    );
    expectApiError(invalidContext.body);
    expect(invalidContext.body.error.code).toBe("BAD_REQUEST");

    const unauthenticatedCancel = await api.requestCancelRun(
      null,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedCancel.body);
    expect(unauthenticatedCancel.body.error.code).toBe("UNAUTHORIZED");

    const invalidCancel = await api.requestCancelRun(
      actor,
      invalidRunId,
      [400],
    );
    expectApiError(invalidCancel.body);
    expect(invalidCancel.body.error.code).toBe("BAD_REQUEST");

    const missingCancel = await api.requestCancelRun(
      actor,
      missingRunId,
      [404],
    );
    expectApiError(missingCancel.body);
    expect(missingCancel.body.error.code).toBe("NOT_FOUND");

    const unauthenticatedHeartbeat = await api.requestHeartbeatRunner(
      false,
      [401],
    );
    expectApiError(unauthenticatedHeartbeat.body);
    expect(unauthenticatedHeartbeat.body.error.code).toBe("UNAUTHORIZED");

    const invalidHeartbeatGroup = await api.requestHeartbeatRunner(
      true,
      [400],
      { group: "other/test" },
    );
    expectApiError(invalidHeartbeatGroup.body);
    expect(invalidHeartbeatGroup.body.error.code).toBe("BAD_REQUEST");

    const unauthenticatedPoll = await api.requestPollRunner(
      false,
      { group: "vm0/test", profiles: ["vm0/default"] },
      [401],
    );
    expectApiError(unauthenticatedPoll.body);
    expect(unauthenticatedPoll.body.error.code).toBe("UNAUTHORIZED");

    const invalidPollGroup = await api.requestPollRunner(
      true,
      { group: "not-a-group", profiles: ["vm0/default"] },
      [400],
    );
    expectApiError(invalidPollGroup.body);
    expect(invalidPollGroup.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("SCHED-01 and CHAIN-SCHEDULE: schedule lifecycle", () => {
  it("creates, lists, enables, reaches manual run admission, disables, and deletes a schedule", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const outsider = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    const scheduleName = uniqueScheduleName("bdd-schedule");

    const unauthorizedList = await api.requestListSchedules(null, [401]);
    expectApiError(unauthorizedList.body);
    expect(unauthorizedList.body.error.code).toBe("UNAUTHORIZED");

    const invalidBody = await api.requestDeployScheduleUnchecked(
      actor,
      {
        name: scheduleName,
        agentId,
        prompt: "missing a trigger",
        timezone: "UTC",
      },
      [400],
    );
    expectApiError(invalidBody.body);
    expect(invalidBody.body.error.code).toBe("BAD_REQUEST");

    const deployed = await api.deploySchedule(actor, {
      name: scheduleName,
      agentId,
      intervalSeconds: 60,
      prompt: "Run the scheduled status report.",
      description: "Scheduled BDD report",
      timezone: "UTC",
      enabled: false,
    });
    expect(deployed.created).toBeTruthy();
    expect(deployed.schedule).toMatchObject({
      name: scheduleName,
      agentId,
      enabled: false,
      triggerType: "loop",
      intervalSeconds: 60,
    });

    const listedAfterCreate = await api.listSchedules(actor);
    expect(
      findSchedule(listedAfterCreate.schedules, deployed.schedule.id),
    ).toBeDefined();

    const enabled = await api.enableSchedule(actor, deployed.schedule);
    expect(enabled.enabled).toBeTruthy();
    expect(enabled.nextRunAt).not.toBeNull();

    const outsiderEnable = await api.requestEnableSchedule(
      outsider,
      deployed.schedule,
      [404],
    );
    expectApiError(outsiderEnable.body);
    expect(outsiderEnable.body.error.code).toBe("NOT_FOUND");

    const runNow = await api.runScheduleNow(actor, deployed.schedule.id, [402]);
    expectApiError(runNow.body);
    expect(runNow.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const disabled = await api.disableSchedule(actor, deployed.schedule);
    expect(disabled.enabled).toBeFalsy();

    await api.deleteSchedule(actor, deployed.schedule);
    const listedAfterDelete = await api.listSchedules(actor);
    expect(
      findSchedule(listedAfterDelete.schedules, deployed.schedule.id),
    ).toBeUndefined();

    const deleteAgain = await api.requestDeleteSchedule(
      actor,
      deployed.schedule,
      [404],
    );
    expectApiError(deleteAgain.body);
    expect(deleteAgain.body.error.code).toBe("NOT_FOUND");
  });

  it("redeploys a cron schedule and exposes updated state through schedule list", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    const scheduleName = uniqueScheduleName("bdd-cron-update");

    const deployed = await api.deploySchedule(actor, {
      name: scheduleName,
      agentId,
      cronExpression: "0 9 * * *",
      prompt: "Run the morning report.",
      description: "Morning cron report",
      timezone: "UTC",
      enabled: false,
    });
    expect(deployed.created).toBeTruthy();
    expect(deployed.schedule).toMatchObject({
      name: scheduleName,
      agentId,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "Run the morning report.",
      description: "Morning cron report",
      enabled: false,
    });

    const updated = await api.deploySchedule(actor, {
      name: scheduleName,
      agentId,
      cronExpression: "30 9 * * *",
      prompt: "Run the updated morning report.",
      description: "Updated morning cron report",
      timezone: "America/New_York",
      enabled: false,
    });
    expect(updated.created).toBeFalsy();
    expect(updated.schedule.id).toBe(deployed.schedule.id);
    expect(updated.schedule.chatThreadId).toBe(deployed.schedule.chatThreadId);
    expect(updated.schedule).toMatchObject({
      name: scheduleName,
      agentId,
      triggerType: "cron",
      cronExpression: "30 9 * * *",
      timezone: "America/New_York",
      prompt: "Run the updated morning report.",
      description: "Updated morning cron report",
      enabled: false,
    });

    const listed = await api.listSchedules(actor);
    const listedSchedule = findSchedule(listed.schedules, deployed.schedule.id);
    if (!listedSchedule) {
      throw new Error("Expected redeployed schedule to be visible in list");
    }
    expect(listedSchedule).toMatchObject({
      id: deployed.schedule.id,
      name: scheduleName,
      agentId,
      triggerType: "cron",
      cronExpression: "30 9 * * *",
      timezone: "America/New_York",
      prompt: "Run the updated morning report.",
      description: "Updated morning cron report",
      enabled: false,
      chatThreadId: deployed.schedule.chatThreadId,
    });

    await api.deleteSchedule(actor, updated.schedule);
  });

  it("lets cron execution process a due loop schedule and exposes the transition through list", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    const scheduleName = uniqueScheduleName("bdd-cron");

    const deployed = await api.deploySchedule(actor, {
      name: scheduleName,
      agentId,
      intervalSeconds: 0,
      prompt: "Run from cron.",
      description: "Cron due schedule",
      timezone: "UTC",
      enabled: true,
    });
    expect(deployed.schedule.nextRunAt).not.toBeNull();

    const cron = await api.executeSchedulesCron(true);
    if (cron.status !== 200) {
      throw new Error("Expected execute schedules cron to succeed");
    }
    expect(cron.body.success).toBeTruthy();
    expect(cron.body.executed).toBe(0);
    expect(cron.body.skipped).toBeGreaterThanOrEqual(1);

    const afterCron = await api.listSchedules(actor);
    const schedule = afterCron.schedules.find((item) => {
      return item.id === deployed.schedule.id;
    });
    expect(schedule?.lastRunAt).not.toBeNull();
    expect(schedule?.consecutiveFailures).toBeGreaterThanOrEqual(1);
  });
});

describe("AUTOMATIONS-01: automation lifecycle through the public API", () => {
  it("creates, lists, updates, toggles, runs, and deletes an automation through API requests", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const outsider = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    const automationName = uniqueScheduleName("bdd-automation");

    await api.enableAutomations(actor);
    await api.enableAutomations(outsider);

    const unauthorizedList = await api.requestListAutomations(null, [401]);
    expectApiError(unauthorizedList.body);
    expect(unauthorizedList.body.error.code).toBe("UNAUTHORIZED");

    const invalidBody = await api.requestCreateAutomationUnchecked(
      actor,
      {
        name: automationName,
        agentId,
        prompt: "missing a trigger",
        timezone: "UTC",
      },
      [400],
    );
    expectApiError(invalidBody.body);
    expect(invalidBody.body.error.code).toBe("BAD_REQUEST");

    const created = await api.createAutomation(actor, {
      name: automationName,
      agentId,
      intervalSeconds: 60,
      prompt: "Run the automation status report.",
      description: "Automation BDD report",
      timezone: "UTC",
      enabled: false,
    });
    expect(created.created).toBeTruthy();
    expect(created.automation).toMatchObject({
      name: automationName,
      agentId,
      enabled: false,
      triggerType: "loop",
      intervalSeconds: 60,
      prompt: "Run the automation status report.",
      description: "Automation BDD report",
    });

    const listedAfterCreate = await api.listAutomations(actor);
    expect(
      findSchedule(listedAfterCreate.automations, created.automation.id),
    ).toMatchObject({
      id: created.automation.id,
      name: automationName,
      triggerType: "loop",
      enabled: false,
    });

    const schedulesAfterCreate = await api.listSchedules(actor);
    expect(
      findSchedule(schedulesAfterCreate.schedules, created.automation.id),
    ).toMatchObject({
      id: created.automation.id,
      name: automationName,
      triggerType: "loop",
      enabled: false,
    });

    const updated = await api.updateAutomation(actor, automationName, {
      agentId,
      cronExpression: "0 9 * * *",
      prompt: "Run the updated automation report.",
      description: "Updated automation BDD report",
      timezone: "America/New_York",
      enabled: true,
    });
    expect(updated.created).toBeFalsy();
    expect(updated.automation.id).toBe(created.automation.id);
    expect(updated.automation).toMatchObject({
      name: automationName,
      agentId,
      enabled: false,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "America/New_York",
      prompt: "Run the updated automation report.",
      description: "Updated automation BDD report",
      chatThreadId: created.automation.chatThreadId,
    });
    expect(updated.automation.nextRunAt).not.toBeNull();

    const listedAfterUpdate = await api.listAutomations(actor);
    expect(
      findSchedule(listedAfterUpdate.automations, updated.automation.id),
    ).toMatchObject({
      id: updated.automation.id,
      name: automationName,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      enabled: false,
    });

    const schedulesAfterUpdate = await api.listSchedules(actor);
    expect(
      findSchedule(schedulesAfterUpdate.schedules, updated.automation.id),
    ).toMatchObject({
      id: updated.automation.id,
      name: automationName,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      enabled: false,
      chatThreadId: created.automation.chatThreadId,
    });

    const disabled = await api.disableAutomation(actor, updated.automation);
    expect(disabled.enabled).toBeFalsy();

    const enabled = await api.enableAutomation(actor, updated.automation);
    expect(enabled.enabled).toBeTruthy();
    expect(enabled.nextRunAt).not.toBeNull();

    const outsiderRun = await api.requestRunAutomation(
      outsider,
      updated.automation.id,
      [404],
    );
    expectApiError(outsiderRun.body);
    expect(outsiderRun.body.error.code).toBe("NOT_FOUND");

    const deniedRun = await api.requestRunAutomation(
      actor,
      updated.automation.id,
      [402],
    );
    expectApiError(deniedRun.body);
    expect(deniedRun.body.error.code).toBe("INSUFFICIENT_CREDITS");

    await api.deleteAutomation(actor, updated.automation);
    const listedAfterDelete = await api.listAutomations(actor);
    expect(
      findSchedule(listedAfterDelete.automations, updated.automation.id),
    ).toBeUndefined();
    const schedulesAfterDelete = await api.listSchedules(actor);
    expect(
      findSchedule(schedulesAfterDelete.schedules, updated.automation.id),
    ).toBeUndefined();

    const deleteAgain = await api.requestDeleteAutomation(
      actor,
      updated.automation,
      [404],
    );
    expectApiError(deleteAgain.body);
    expect(deleteAgain.body.error.code).toBe("NOT_FOUND");
  });
});

describe("SCHED-02: cron routes", () => {
  it("rejects invalid cron auth and accepts safe no-work cron routes with valid auth", async () => {
    const api = createRunsSchedulesApi(context);

    const invalidExecute = await api.executeSchedulesCron(false);
    if (invalidExecute.status !== 401) {
      throw new Error("Expected missing cron auth to be rejected");
    }
    expectApiError(invalidExecute.body);
    expect(invalidExecute.body.error.code).toBe("UNAUTHORIZED");

    const invalidCronRoutes = await api.runSafeCronRoutes(false);
    expect(
      Object.values(invalidCronRoutes).every((response) => {
        return response.status === 401;
      }),
    ).toBeTruthy();

    context.mocks.axiom.query.mockResolvedValue([]);
    const validCronRoutes = await api.runSafeCronRoutes(true);
    expect(
      Object.values(validCronRoutes).every((response) => {
        return response.status === 200;
      }),
    ).toBeTruthy();

    const execute = await api.executeSchedulesCron(true);
    if (execute.status !== 200) {
      throw new Error("Expected execute schedules cron to succeed");
    }
    expect(execute.body.success).toBeTruthy();
  });
});
