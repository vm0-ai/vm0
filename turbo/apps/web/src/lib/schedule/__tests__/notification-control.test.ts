import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestZeroAgent,
  createTestRequest,
  createTestOrg,
  getTestZeroAgentId,
  findTestRunCallbacks,
  findTestScheduleById,
  updateTestScheduleState,
  disableAllSchedules,
  createTestSlackOrgInstallation,
  createTestSlackOrgConnection,
} from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { POST as deployScheduleRoute } from "../../../../app/api/zero/schedules/route";
import { POST as enableScheduleRoute } from "../../../../app/api/zero/schedules/[name]/enable/route";
import { executeDueSchedules } from "../schedule-service";

const context = testContext();

/**
 * Create a schedule with specific notification settings via the zero API,
 * enable it, and make it due for execution.
 */
async function createDueSchedule(
  agentId: string,
  name: string,
  options: { notifyEmail: boolean; notifySlack: boolean },
): Promise<string> {
  // Create schedule via zero API with notification settings
  const createReq = createTestRequest(
    `http://localhost:3000/api/zero/schedules`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId,
        name,
        cronExpression: "0 0 * * *",
        timezone: "UTC",
        prompt: "Test notification control",
        notifyEmail: options.notifyEmail,
        notifySlack: options.notifySlack,
      }),
    },
  );
  const createRes = await deployScheduleRoute(createReq);
  const createData = await createRes.json();
  const scheduleId = createData.schedule.id as string;

  // Enable the schedule
  const enableReq = createTestRequest(
    `http://localhost:3000/api/zero/schedules/${encodeURIComponent(name)}/enable`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    },
  );
  await enableScheduleRoute(enableReq, {
    params: Promise.resolve({ name }),
  });

  // Make it due by setting nextRunAt to the past
  const pastTime = new Date(Date.now() - 60_000);
  await updateTestScheduleState(scheduleId, { nextRunAt: pastTime });

  return scheduleId;
}

describe("Schedule notification control - per-schedule settings", () => {
  let user: UserContext;
  let agentId: string;
  let slug: string;

  beforeEach(async () => {
    context.setupMocks();
    // Mock time to avoid dev server schedules interfering with the batch limit
    context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));
    user = await context.setupUser();

    // Set up org
    slug = uniqueId("notify");
    mockClerk({ userId: user.userId, orgId: user.orgId, orgRole: "org:admin" });
    await createTestOrg(slug);

    const agentName = uniqueId("notify-agent");
    await createTestCompose(agentName);
    await createTestZeroAgent(user.orgId, agentName, {});
    agentId = await getTestZeroAgentId(user.orgId, agentName);

    // Set up Slack installation + user connection (required for notifySlack: true)
    const { slackWorkspaceId } = await createTestSlackOrgInstallation({
      orgId: user.orgId,
    });
    await createTestSlackOrgConnection({
      slackWorkspaceId,
      vm0UserId: user.userId,
    });

    // Disable any schedules from other tests to avoid interference
    await disableAllSchedules(user.orgId);
  });

  it("should register both email and slack callbacks when schedule has both enabled", async () => {
    const scheduleId = await createDueSchedule(agentId, "both-on", {
      notifyEmail: true,
      notifySlack: true,
    });

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).toContainEqual(
      expect.stringContaining("/email/callbacks/schedule"),
    );
    expect(callbackUrls).toContainEqual(
      expect.stringContaining("/callbacks/slack/org/schedule"),
    );
  });

  it("should NOT register email callback when schedule notifyEmail is false", async () => {
    const scheduleId = await createDueSchedule(agentId, "email-off", {
      notifyEmail: false,
      notifySlack: true,
    });

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/email/callbacks/schedule"),
    );
    expect(callbackUrls).toContainEqual(
      expect.stringContaining("/callbacks/slack/org/schedule"),
    );
  });

  it("should NOT register slack callback when schedule notifySlack is false", async () => {
    const scheduleId = await createDueSchedule(agentId, "slack-off", {
      notifyEmail: true,
      notifySlack: false,
    });

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).toContainEqual(
      expect.stringContaining("/email/callbacks/schedule"),
    );
    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/callbacks/slack/org/schedule"),
    );
  });

  it("should NOT register any notification callbacks when both are off", async () => {
    const scheduleId = await createDueSchedule(agentId, "silent", {
      notifyEmail: false,
      notifySlack: false,
    });

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/email/callbacks/schedule"),
    );
    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/callbacks/slack/org/schedule"),
    );
  });

  it("should reject notifySlack: true when user has no Slack connection", async () => {
    // Create a second user without Slack connection (custom prefix to avoid cache)
    const user2 = await context.setupUser({ prefix: "no-slack-user" });
    const slug2 = uniqueId("no-slack");
    mockClerk({
      userId: user2.userId,
      orgId: user2.orgId,
      orgRole: "org:admin",
    });
    await createTestOrg(slug2);

    const agentName2 = uniqueId("no-slack-agent");
    await createTestCompose(agentName2);
    await createTestZeroAgent(user2.orgId, agentName2, {});
    const agentId2 = await getTestZeroAgentId(user2.orgId, agentName2);

    const createReq = createTestRequest(
      `http://localhost:3000/api/zero/schedules`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agentId2,
          name: "no-slack-schedule",
          cronExpression: "0 0 * * *",
          timezone: "UTC",
          prompt: "Test no slack connection",
          notifySlack: true,
        }),
      },
    );
    const res = await deployScheduleRoute(createReq);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error.message).toContain("Slack");
  });

  it("should accept notifySlack: false without Slack connection", async () => {
    // Create a second user without Slack connection (custom prefix to avoid cache)
    const user2 = await context.setupUser({ prefix: "no-slack-ok-user" });
    const slug2 = uniqueId("no-slack-ok");
    mockClerk({
      userId: user2.userId,
      orgId: user2.orgId,
      orgRole: "org:admin",
    });
    await createTestOrg(slug2);

    const agentName2 = uniqueId("no-slack-ok-agent");
    await createTestCompose(agentName2);
    await createTestZeroAgent(user2.orgId, agentName2, {});
    const agentId2 = await getTestZeroAgentId(user2.orgId, agentName2);

    const createReq = createTestRequest(
      `http://localhost:3000/api/zero/schedules`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agentId2,
          name: "no-slack-ok-schedule",
          cronExpression: "0 0 * * *",
          timezone: "UTC",
          prompt: "Test no slack but not requesting it",
          notifySlack: false,
        }),
      },
    );
    const res = await deployScheduleRoute(createReq);
    expect(res.status).toBe(201);
  });
});
