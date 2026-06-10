import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { composesMainContract } from "@vm0/api-contracts/contracts/composes";
import { zeroComposesByIdContract } from "@vm0/api-contracts/contracts/zero-composes";
import {
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  zeroSchedulesMainContract,
} from "@vm0/api-contracts/contracts/zero-schedules";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface AgentFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

interface ScheduleCleanup {
  readonly agent: AgentFixture;
  readonly name: string;
}

interface TestComposeContent {
  readonly version: string;
  readonly agents: Record<string, { readonly framework: "claude-code" }>;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function composeClient() {
  return setupApp({ context })(composesMainContract);
}

function composeByIdClient() {
  return setupApp({ context })(zeroComposesByIdContract);
}

function schedulesClient() {
  return setupApp({ context })(zeroSchedulesMainContract);
}

function scheduleByNameClient() {
  return setupApp({ context })(zeroSchedulesByNameContract);
}

function scheduleEnableClient() {
  return setupApp({ context })(zeroSchedulesEnableContract);
}

function composeContent(name: string): TestComposeContent {
  return {
    version: "1.0",
    agents: {
      [name]: { framework: "claude-code" },
    },
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroTokenWithoutScheduleDelete(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["schedule:read"],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function createAgent(args: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<AgentFixture> {
  mocks.clerk.session(args.userId, args.orgId);
  const name = `schedule-agent-${randomUUID().slice(0, 8)}`;
  const response = await accept(
    composeClient().create({
      body: { content: composeContent(name) },
      headers: authHeaders(),
    }),
    [201],
  );

  const fixture = {
    userId: args.userId,
    orgId: args.orgId,
    agentId: response.body.composeId,
  };

  return await trackAgent(Promise.resolve(fixture));
}

async function deleteAgent(fixture: AgentFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  mocks.s3.listObjects([]);
  await accept(
    composeByIdClient().delete({
      params: { id: fixture.agentId },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

async function deployCronSchedule(args: {
  readonly agent: AgentFixture;
  readonly name: string;
  readonly enabled?: boolean;
}) {
  mocks.clerk.session(args.agent.userId, args.agent.orgId);
  trackSchedule({ agent: args.agent, name: args.name });
  return await schedulesClient().deploy({
    headers: authHeaders(),
    body: {
      name: args.name,
      agentId: args.agent.agentId,
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "daily report",
      description: "daily report",
      enabled: args.enabled,
    },
  });
}

async function deployOneTimeSchedule(args: {
  readonly agent: AgentFixture;
  readonly name: string;
  readonly atTime: string;
  readonly enabled: boolean;
}) {
  mocks.clerk.session(args.agent.userId, args.agent.orgId);
  trackSchedule({ agent: args.agent, name: args.name });
  return await schedulesClient().deploy({
    headers: authHeaders(),
    body: {
      name: args.name,
      agentId: args.agent.agentId,
      atTime: args.atTime,
      timezone: "UTC",
      prompt: "one time",
      description: "one time",
      enabled: args.enabled,
    },
  });
}

async function invalidEnableBody(name: string): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(`/api/zero/schedules/${name}/enable`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: "{}",
  });
}

async function invalidDisableBody(name: string): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(`/api/zero/schedules/${name}/disable`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: "{}",
  });
}

async function deleteSchedule(schedule: ScheduleCleanup): Promise<void> {
  mocks.clerk.session(schedule.agent.userId, schedule.agent.orgId);
  await accept(
    scheduleByNameClient().delete({
      headers: authHeaders(),
      params: { name: schedule.name },
      query: { agentId: schedule.agent.agentId },
    }),
    [204, 404],
  );
}

function createScheduleCleanupTracker(): {
  readonly trackAgent: (
    fixturePromise: Promise<AgentFixture>,
  ) => Promise<AgentFixture>;
  readonly trackSchedule: (schedule: ScheduleCleanup) => void;
} {
  const trackedAgents: AgentFixture[] = [];
  const trackedSchedules: ScheduleCleanup[] = [];

  afterEach(async () => {
    clearMockNow();
    while (trackedSchedules.length > 0) {
      const schedule = trackedSchedules.pop();
      if (schedule !== undefined) {
        await deleteSchedule(schedule);
      }
    }
    while (trackedAgents.length > 0) {
      const agent = trackedAgents.pop();
      if (agent !== undefined) {
        await deleteAgent(agent);
      }
    }
  });

  return {
    trackAgent: async (
      fixturePromise: Promise<AgentFixture>,
    ): Promise<AgentFixture> => {
      const fixture = await fixturePromise;
      trackedAgents.push(fixture);
      return fixture;
    },
    trackSchedule: (schedule: ScheduleCleanup) => {
      trackedSchedules.push(schedule);
    },
  };
}

const { trackAgent, trackSchedule } = createScheduleCleanupTracker();

describe("/api/zero/schedules enable/disable/delete BDD", () => {
  it("deploys a schedule, disables it, enables it, deletes it, and observes list state", async () => {
    const agent = await createAgent({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const name = `sched-${randomUUID().slice(0, 8)}`;

    const deployed = await accept(
      deployCronSchedule({ agent, name, enabled: true }),
      [201],
    );

    expect(deployed.body.schedule.enabled).toBeTruthy();

    const disabled = await accept(
      scheduleEnableClient().disable({
        headers: authHeaders(),
        params: { name },
        body: { agentId: agent.agentId },
      }),
      [200],
    );

    expect(disabled.body.enabled).toBeFalsy();
    expect(disabled.body.retryStartedAt).toBeNull();

    const enabled = await accept(
      scheduleEnableClient().enable({
        headers: authHeaders(),
        params: { name },
        body: { agentId: agent.agentId },
      }),
      [200],
    );

    expect(enabled.body.enabled).toBeTruthy();
    expect(enabled.body.retryStartedAt).toBeNull();
    expect(enabled.body.consecutiveFailures).toBe(0);
    expect(enabled.body.nextRunAt).not.toBeNull();

    const listed = await accept(
      schedulesClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(
      listed.body.schedules.map((schedule) => {
        return schedule.name;
      }),
    ).toContain(name);

    const deleted = await accept(
      scheduleByNameClient().delete({
        headers: authHeaders(),
        params: { name },
        query: { agentId: agent.agentId },
      }),
      [204],
    );

    expect(deleted.body).toBeUndefined();

    const repeatDelete = await accept(
      scheduleByNameClient().delete({
        headers: authHeaders(),
        params: { name },
        query: { agentId: agent.agentId },
      }),
      [404],
    );
    const afterDelete = await accept(
      schedulesClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(repeatDelete.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    expect(
      afterDelete.body.schedules.map((schedule) => {
        return schedule.name;
      }),
    ).not.toContain(name);
  });

  it("maps auth, validation, not-found, and capability boundaries", async () => {
    const agent = await createAgent({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });

    const unauthenticatedEnable = await accept(
      scheduleEnableClient().enable({
        headers: {},
        params: { name: "any" },
        body: { agentId: randomUUID() },
      }),
      [401],
    );
    const unauthenticatedDisable = await accept(
      scheduleEnableClient().disable({
        headers: {},
        params: { name: "any" },
        body: { agentId: randomUUID() },
      }),
      [401],
    );
    const unauthenticatedDelete = await accept(
      scheduleByNameClient().delete({
        headers: {},
        params: { name: "any" },
        query: { agentId: randomUUID() },
      }),
      [401],
    );

    expect(unauthenticatedEnable.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedDisable.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedDelete.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(agent.userId, agent.orgId);
    const missingEnable = await accept(
      scheduleEnableClient().enable({
        headers: authHeaders(),
        params: { name: "non-existent" },
        body: { agentId: agent.agentId },
      }),
      [404],
    );
    const missingDisable = await accept(
      scheduleEnableClient().disable({
        headers: authHeaders(),
        params: { name: "non-existent" },
        body: { agentId: agent.agentId },
      }),
      [404],
    );
    const missingDelete = await accept(
      scheduleByNameClient().delete({
        headers: authHeaders(),
        params: { name: "non-existent" },
        query: { agentId: agent.agentId },
      }),
      [404],
    );

    expect(missingEnable.body.error.code).toBe("NOT_FOUND");
    expect(missingDisable.body.error.code).toBe("NOT_FOUND");
    expect(missingDelete.body.error.code).toBe("NOT_FOUND");

    const invalidEnable = await invalidEnableBody("any");
    const invalidDisable = await invalidDisableBody("any");
    const invalidDelete = await scheduleByNameClient().delete({
      headers: authHeaders(),
      params: { name: "any" },
      query: { agentId: "not-a-uuid" },
    });

    expect(invalidEnable.status).toBe(400);
    await expect(invalidEnable.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(invalidDisable.status).toBe(400);
    await expect(invalidDisable.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(invalidDelete.status).toBe(400);
    if (invalidDelete.status === 400) {
      expect(invalidDelete.body.error.code).toBe("BAD_REQUEST");
    }

    const protectedName = `cant-delete-${randomUUID().slice(0, 8)}`;
    await accept(deployCronSchedule({ agent, name: protectedName }), [201]);
    const token = zeroTokenWithoutScheduleDelete({
      userId: agent.userId,
      orgId: agent.orgId,
      runId: `run_${randomUUID()}`,
    });
    const forbiddenDelete = await accept(
      scheduleByNameClient().delete({
        headers: { authorization: `Bearer ${token}` },
        params: { name: protectedName },
        query: { agentId: agent.agentId },
      }),
      [403],
    );

    expect(forbiddenDelete.body).toStrictEqual({
      error: {
        message: "Missing required capability: schedule:delete",
        code: "FORBIDDEN",
      },
    });

    await accept(
      scheduleByNameClient().delete({
        headers: authHeaders(),
        params: { name: protectedName },
        query: { agentId: agent.agentId },
      }),
      [204],
    );
  });

  it("returns SCHEDULE_PAST when enabling a disabled one-time schedule after its atTime", async () => {
    const agent = await createAgent({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const name = `once-${randomUUID().slice(0, 8)}`;

    mockNow(new Date("2026-06-10T10:00:00.000Z"));
    const atTime = "2026-06-10T11:00:00.000Z";
    const deployed = await accept(
      deployOneTimeSchedule({
        agent,
        name,
        atTime,
        enabled: false,
      }),
      [201],
    );

    expect(deployed.body.schedule.enabled).toBeFalsy();

    mockNow(new Date("2026-06-10T12:00:00.000Z"));
    const response = await accept(
      scheduleEnableClient().enable({
        headers: authHeaders(),
        params: { name },
        body: { agentId: agent.agentId },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Schedule time has already passed",
        code: "SCHEDULE_PAST",
      },
    });

    await accept(
      scheduleByNameClient().delete({
        headers: authHeaders(),
        params: { name },
        query: { agentId: agent.agentId },
      }),
      [204],
    );
  });
});
