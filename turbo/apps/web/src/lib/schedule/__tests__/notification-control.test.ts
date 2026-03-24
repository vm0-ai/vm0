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
  insertOrgMembersEntry,
  disableAllSchedules,
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
  slug: string,
  name: string,
  options: { notifyEmail: boolean; notifySlack: boolean },
): Promise<string> {
  // Create schedule via zero API with notification settings
  const createReq = createTestRequest(
    `http://localhost:3000/api/zero/schedules?org=${slug}`,
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
    `http://localhost:3000/api/zero/schedules/${encodeURIComponent(name)}/enable?org=${slug}`,
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

describe("Schedule notification control - AND logic", () => {
  let user: UserContext;
  let agentId: string;
  let slug: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Set up org with explicit slug for zero schedule routes
    slug = uniqueId("notify");
    mockClerk({ userId: user.userId, orgId: user.orgId, orgRole: "org:admin" });
    await createTestOrg(slug);

    const agentName = uniqueId("notify-agent");
    await createTestCompose(agentName);
    await createTestZeroAgent(user.orgId, agentName, {});
    agentId = await getTestZeroAgentId(user.orgId, agentName);

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
    const scheduleId = await createDueSchedule(agentId, slug, "both-on", {
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
    const scheduleId = await createDueSchedule(agentId, slug, "email-off", {
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
    const scheduleId = await createDueSchedule(agentId, slug, "slack-off", {
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
    const scheduleId = await createDueSchedule(
      agentId,
      slug,
      "user-email-off",
      {
        notifyEmail: true,
        notifySlack: true,
      },
    );

    await executeDueSchedules();

    const schedule = await findTestScheduleById(scheduleId);
    expect(schedule?.lastRunId).toBeDefined();

    const callbacks = await findTestRunCallbacks(schedule!.lastRunId!);
    const callbackUrls = callbacks.map((c) => c.url);

    expect(callbackUrls).not.toContainEqual(
      expect.stringContaining("/email/callbacks/schedule"),
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
    const scheduleId = await createDueSchedule(agentId, slug, "silent", {
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
      expect.stringContaining("/callbacks/slack/schedule"),
    );
  });
});
