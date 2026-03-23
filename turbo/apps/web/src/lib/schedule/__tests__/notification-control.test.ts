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
  findTestRunCallbacks,
  findTestScheduleById,
  updateTestScheduleState,
  insertOrgMembersEntry,
  disableAllSchedules,
} from "../../../__tests__/api-test-helpers";
import { POST as deployScheduleRoute } from "../../../../app/api/agent/schedules/route";
import { POST as enableScheduleRoute } from "../../../../app/api/agent/schedules/[name]/enable/route";
import { executeDueSchedules } from "../schedule-service";

const context = testContext();

/**
 * Create a schedule with specific notification settings via the API,
 * enable it, and make it due for execution.
 */
async function createDueSchedule(
  composeId: string,
  name: string,
  options: { notifyEmail: boolean; notifySlack: boolean },
): Promise<string> {
  // Create schedule via API with notification settings
  const createReq = createTestRequest(
    "http://localhost:3000/api/agent/schedules",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        composeId,
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
    `http://localhost:3000/api/agent/schedules/${encodeURIComponent(name)}/enable`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ composeId }),
    },
  );
  await enableScheduleRoute(enableReq);

  // Make it due by setting nextRunAt to the past
  const pastTime = new Date(Date.now() - 60_000);
  await updateTestScheduleState(scheduleId, { nextRunAt: pastTime });

  return scheduleId;
}

describe("Schedule notification control - AND logic", () => {
  let user: UserContext;
  let composeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const agentName = uniqueId("notify-agent");
    const compose = await createTestCompose(agentName);
    composeId = compose.composeId;
    await createTestZeroAgent(user.orgId, agentName, {});

    // Disable any schedules from other tests to avoid interference
    await disableAllSchedules();
  });

  it("should register both email and slack callbacks when all notifications enabled", async () => {
    // User global: both on
    await insertOrgMembersEntry({
      orgId: user.orgId,
      userId: user.userId,
      notifyEmail: true,
      notifySlack: true,
    });

    // Schedule: both on
    const scheduleId = await createDueSchedule(composeId, "both-on", {
      notifyEmail: true,
      notifySlack: true,
    });

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).toContainEqual(
      expect.stringContaining("/callbacks/email/schedule"),
    );
    expect(callbackUrls).toContainEqual(
      expect.stringContaining("/callbacks/slack/schedule"),
    );
  });

  it("should NOT register email callback when schedule notifyEmail is false", async () => {
    // User global: both on
    await insertOrgMembersEntry({
      orgId: user.orgId,
      userId: user.userId,
      notifyEmail: true,
      notifySlack: true,
    });

    // Schedule: email off
    const scheduleId = await createDueSchedule(composeId, "email-off", {
      notifyEmail: false,
      notifySlack: true,
    });

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/callbacks/email/schedule"),
    );
    expect(callbackUrls).toContainEqual(
      expect.stringContaining("/callbacks/slack/schedule"),
    );
  });

  it("should NOT register slack callback when schedule notifySlack is false", async () => {
    // User global: both on
    await insertOrgMembersEntry({
      orgId: user.orgId,
      userId: user.userId,
      notifyEmail: true,
      notifySlack: true,
    });

    // Schedule: slack off
    const scheduleId = await createDueSchedule(composeId, "slack-off", {
      notifyEmail: true,
      notifySlack: false,
    });

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).toContainEqual(
      expect.stringContaining("/callbacks/email/schedule"),
    );
    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/callbacks/slack/schedule"),
    );
  });

  it("should NOT register email callback when user global notifyEmail is false", async () => {
    // User global: email off
    await insertOrgMembersEntry({
      orgId: user.orgId,
      userId: user.userId,
      notifyEmail: false,
      notifySlack: true,
    });

    // Schedule: both on
    const scheduleId = await createDueSchedule(composeId, "user-email-off", {
      notifyEmail: true,
      notifySlack: true,
    });

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/callbacks/email/schedule"),
    );
    expect(callbackUrls).toContainEqual(
      expect.stringContaining("/callbacks/slack/schedule"),
    );
  });

  it("should NOT register any notification callbacks when both schedule notifications are off", async () => {
    // User global: both on
    await insertOrgMembersEntry({
      orgId: user.orgId,
      userId: user.userId,
      notifyEmail: true,
      notifySlack: true,
    });

    // Schedule: both off
    const scheduleId = await createDueSchedule(composeId, "silent", {
      notifyEmail: false,
      notifySlack: false,
    });

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/callbacks/email/schedule"),
    );
    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/callbacks/slack/schedule"),
    );
  });
});
