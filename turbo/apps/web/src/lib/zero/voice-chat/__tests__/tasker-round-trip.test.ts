import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  insertTestVoiceChatSession,
  getTestVoiceChatEvents,
  createTestCallback,
  createSignedCallbackRequest,
} from "../../../../__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import { insertOrgDefaultModelProvider } from "../../../../__tests__/db-test-seeders/org";
import { mockAblyPublish } from "../../../../__tests__/ably-mock";
import { buildVoiceChatQuickPrepPrompt } from "../../integration-prompt";
/* eslint-disable web/no-direct-db-in-tests -- Service-level exception: no user-facing API appends slow-brain/fast-brain-sourced events or reads a task without auth; exercising the round trip requires simulating both sides. */
import { appendEvent } from "../context-service";
import { getVoiceChatTask } from "../task-service";
/* eslint-enable web/no-direct-db-in-tests */

vi.mock("@vm0/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vm0/core")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { POST: postTaskRoute } =
  await import("../../../../../app/api/zero/voice-chat/[id]/tasks/route");
const { POST: postCallbackRoute } =
  await import("../../../../../app/api/internal/callbacks/voice-chat-task/route");

const TASKS_BASE_URL = "http://localhost:3000/api/zero/voice-chat";
const CALLBACK_URL = "http://localhost/api/internal/callbacks/voice-chat-task";

describe("voice-chat slow-brain prompt includes tasker guidance", () => {
  const prompt = buildVoiceChatQuickPrepPrompt("test-session-id");

  it.each([
    ["task create command", "zero voice-chat task create"],
    ["task get command", "zero voice-chat task get"],
    ["task list command", "zero voice-chat task list"],
    ["task-dispatched event", "task-dispatched"],
    ["task-completed event", "task-completed"],
    ["never-block rule", "Never block"],
    ["natural language rule", "natural language"],
    ["phase 1 dispatch guard", "Do NOT dispatch tasks during preparation"],
  ])("includes %s", (_name, substring) => {
    expect(prompt).toContain(substring);
  });
});

describe("tasker round trip through the blackboard", () => {
  const context = testContext();

  async function setupOrg(userId: string) {
    const slug = uniqueId("zvc-tasker-rt");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:admin" });
    await createTestOrg(slug);
    await insertOrgDefaultModelProvider(
      orgId,
      "anthropic",
      "claude-3-5-sonnet-20241022",
    );
    return { orgId, slug };
  }

  beforeEach(async () => {
    mockAblyPublish.mockClear();
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("fast-brain request -> slow-brain dispatch -> tasker complete -> slow-brain directive", async () => {
    const { userId } = await context.setupUser();
    const { orgId } = await setupOrg(userId);
    const agent = await createTestCompose(uniqueId("zvc-tasker-rt-agent"));
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
    });

    await appendEvent(
      sessionId,
      "fast-brain",
      "request-slow-brain",
      "check if PR #123 merged",
    );

    const dispatchResponse = await postTaskRoute(
      createTestRequest(`${TASKS_BASE_URL}/${sessionId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt:
            "Check GitHub for PR #123 in vm0-ai/vm0 and return merged/open status with merger and date.",
        }),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    expect(dispatchResponse.status).toBe(200);
    const { task } = await dispatchResponse.json();
    expect(task.status).toBe("queued");
    expect(task.runId).toBeTruthy();

    await appendEvent(
      sessionId,
      "slow-brain",
      "directive",
      "I'm checking the PR — tell the user you're looking into it.",
    );

    const eventsAfterDispatch = await getTestVoiceChatEvents(sessionId);
    const dispatched = eventsAfterDispatch.find((e) => {
      return e.type === "task-dispatched";
    });
    expect(dispatched).toBeTruthy();
    expect(dispatched!.source).toBe("system");
    const dispatchedContent = JSON.parse(dispatched!.content!);
    expect(dispatchedContent.taskId).toBe(task.id);
    expect(dispatchedContent.prompt).toContain("PR #123");

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "PR #123 merged by @alice on 2026-04-21" } },
    ]);

    const { secret } = await createTestCallback({
      runId: task.runId,
      url: CALLBACK_URL,
      payload: { taskId: task.id },
    });

    const callbackResponse = await postCallbackRoute(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          runId: task.runId,
          status: "completed",
          payload: { taskId: task.id },
        },
        secret,
      ),
    );
    expect(callbackResponse.status).toBe(200);

    const completedTask = await getVoiceChatTask(task.id);
    expect(completedTask?.status).toBe("done");
    expect(completedTask?.result).toContain("merged by @alice");

    await context.mocks.flushAfter();
    expect(mockAblyPublish).toHaveBeenCalledWith(`voice:${sessionId}`, null);

    const eventsAfterComplete = await getTestVoiceChatEvents(sessionId);
    const completedEvent = eventsAfterComplete.find((e) => {
      return e.type === "task-completed";
    });
    expect(completedEvent).toBeTruthy();
    expect(completedEvent!.source).toBe("system");
    const completedContent = JSON.parse(completedEvent!.content!);
    expect(completedContent.taskId).toBe(task.id);
    expect(completedContent.status).toBe("done");
    expect(completedContent.result).toContain("merged by @alice");

    const fetched = await getVoiceChatTask(task.id);
    await appendEvent(
      sessionId,
      "slow-brain",
      "directive",
      `The PR was merged yesterday by Alice — tell the user naturally. ${fetched!.result}`,
    );

    const eventsFinal = await getTestVoiceChatEvents(sessionId);
    const directives = eventsFinal.filter((e) => {
      return e.source === "slow-brain" && e.type === "directive";
    });
    expect(directives).toHaveLength(2);

    const completionDirective = directives[1]!.content!;
    expect(completionDirective).not.toContain("taskId");
    expect(completionDirective).not.toContain(task.id);
    expect(completionDirective.toLowerCase()).not.toMatch(/\btask\b/);
    expect(completionDirective).toContain("merged");
  });
});
