import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { handlers, http } from "../../../../__tests__/msw";
import { server } from "../../../../mocks/server";
import { notifyScheduleRunComplete } from "../schedule-notification";
import {
  givenLinkedSlackUser,
  givenUserHasAgent,
} from "../../../../__tests__/slack/api-helpers";
import {
  createTestCompose,
  createTestRun,
  createTestSchedule,
  linkRunToSchedule,
  updateTestRunStatus,
} from "../../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../../__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

const SLACK_API = "https://slack.com/api";

const slackHandlers = handlers({
  postMessage: http.post(
    `${SLACK_API}/chat.postMessage`,
    async ({ request }) => {
      const body = await request.formData();
      const data = Object.fromEntries(body.entries());
      return HttpResponse.json({
        ok: true,
        ts: `${Date.now()}.000000`,
        channel: data.channel,
      });
    },
  ),
});

describe("notifyScheduleRunComplete", () => {
  beforeEach(() => {
    context.setupMocks();
    server.use(...slackHandlers.handlers);
  });

  it("should send Slack DM when schedule has slack notification enabled", async () => {
    // Given a linked Slack user with an agent
    const { userLink } = await givenLinkedSlackUser();
    const { binding } = await givenUserHasAgent(userLink, {
      agentName: "my-scheduled-agent",
    });

    // And a schedule
    mockClerk({ userId: userLink.vm0UserId });
    const schedule = await createTestSchedule(
      binding.composeId,
      uniqueId("sched"),
    );

    // And a completed run for this schedule
    const { runId } = await createTestRun(binding.composeId, "Scheduled task");
    await linkRunToSchedule(runId, schedule.id);
    await updateTestRunStatus(runId, "completed");

    // When notifyScheduleRunComplete is called
    await notifyScheduleRunComplete(runId, "completed");

    // Then a Slack DM should be sent
    expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);
  });

  it("should skip notification when user has no Slack link", async () => {
    // Given a different user with no Slack link
    await context.setupUser({ prefix: "no-slack-user" });

    // Create a compose for this user (who has no Slack link)
    const { composeId } = await createTestCompose(uniqueId("no-slack"));

    // And a schedule
    const schedule = await createTestSchedule(composeId, uniqueId("sched"));

    // And a completed run
    const { runId } = await createTestRun(composeId, "Task");
    await linkRunToSchedule(runId, schedule.id);
    await updateTestRunStatus(runId, "completed");

    // When notifyScheduleRunComplete is called
    await notifyScheduleRunComplete(runId, "completed");

    // Then no Slack message should be sent (no linked user)
    expect(slackHandlers.mocked.postMessage).not.toHaveBeenCalled();
  });

  it("should send error notification for failed runs", async () => {
    // Given a linked Slack user with an agent
    const { userLink } = await givenLinkedSlackUser();
    const { binding } = await givenUserHasAgent(userLink, {
      agentName: "my-agent",
    });

    // And a schedule
    mockClerk({ userId: userLink.vm0UserId });
    const schedule = await createTestSchedule(
      binding.composeId,
      uniqueId("sched"),
    );

    // And a failed run
    const { runId } = await createTestRun(binding.composeId, "Task");
    await linkRunToSchedule(runId, schedule.id);
    await updateTestRunStatus(runId, "failed", { error: "Agent crashed" });

    // When notifyScheduleRunComplete is called with failure
    await notifyScheduleRunComplete(runId, "failed", "Agent crashed");

    // Then a Slack DM should be sent with error info
    expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);
  });

  it("should skip for non-scheduled runs", async () => {
    // Given a run without scheduleId
    await context.setupUser({ prefix: "non-sched-user" });
    const { composeId } = await createTestCompose(uniqueId("non-sched"));
    const { runId } = await createTestRun(composeId, "Manual run");

    // When notifyScheduleRunComplete is called
    await notifyScheduleRunComplete(runId, "completed");

    // Then no notification should be sent
    expect(slackHandlers.mocked.postMessage).not.toHaveBeenCalled();
  });
});
