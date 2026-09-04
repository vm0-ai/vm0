import { goalsContract } from "@okouai/api-contracts/contracts/goals";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-capability-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  installRunChat,
  promptEvent,
  publishRunUpdate,
} from "./chat-run-test-fixtures.ts";

const COMPLETED_RUN_ID = "d0000000-0000-4000-a000-000000000851";

function queuedGoalEvents(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "goal-lifecycle-prompt",
      runId: COMPLETED_RUN_ID,
      seqId: 1,
      text: "Prepare the autonomous launch work",
    }),
    assistantEvent({
      id: "goal-lifecycle-response",
      runId: COMPLETED_RUN_ID,
      seqId: 2,
      text: "The launch workspace is ready.",
    }),
    completedEvent({
      id: "goal-lifecycle-completed",
      runId: COMPLETED_RUN_ID,
      seqId: 3,
    }),
    {
      id: "goal-lifecycle-queued-message",
      role: "user",
      eventType: "input.automation",
      content: null,
      runId: undefined,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "automation",
            workflowName: "launch-review",
            automationBrief: "Queued launch review",
          },
        ],
      },
      seqId: 4,
      createdAt: "2026-08-01T10:00:04.000Z",
    },
    {
      id: "goal-lifecycle-queued-goal",
      role: "user",
      eventType: "input.goal",
      content: null,
      runId: undefined,
      userMessage: {
        version: 1,
        parts: [{ type: "goal", goalBrief: "Queued release goal" }],
      },
      seqId: 5,
      createdAt: "2026-08-01T10:00:05.000Z",
    },
  ];
}

function goalMarker(args: {
  readonly id: string;
  readonly eventType: "goal.close" | "goal.open";
  readonly seqId: number;
  readonly objective?: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    eventType: args.eventType,
    content: args.objective ?? null,
    runId: undefined,
    seqId: args.seqId,
    createdAt: `2026-08-01T10:00:0${String(args.seqId)}.000Z`,
  };
}

test("Follow the lifecycle of the active chat goal", async () => {
  const events = queuedGoalEvents();
  installRunChat({ chatEvents: events });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const queuedItem = await screen.findByRole("listitem", {
    name: "Pending automation event",
  });
  expect(queuedItem).toHaveTextContent("Queued launch review");
  expect(
    screen.queryByRole("listitem", { name: "Active goal" }),
  ).not.toBeInTheDocument();

  events.push(
    goalMarker({
      id: "goal-lifecycle-open",
      eventType: "goal.open",
      objective: "Draft the launch narrative",
      seqId: 6,
    }),
  );
  publishRunUpdate();

  let activeGoal = await screen.findByRole("listitem", {
    name: "Active goal",
  });
  expect(activeGoal).toHaveTextContent("Draft the launch narrative");
  expect(
    queuedItem.compareDocumentPosition(activeGoal) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getAllByRole("listitem", { name: "Active goal" })).toHaveLength(
    1,
  );

  events.push(
    goalMarker({
      id: "goal-lifecycle-close",
      eventType: "goal.close",
      seqId: 7,
    }),
    goalMarker({
      id: "goal-lifecycle-reopen",
      eventType: "goal.open",
      objective: "Publish the revised launch narrative",
      seqId: 8,
    }),
  );
  publishRunUpdate();

  activeGoal = await waitFor(() => {
    const currentGoal = screen.getByRole("listitem", { name: "Active goal" });
    expect(currentGoal).toHaveTextContent(
      "Publish the revised launch narrative",
    );
    return currentGoal;
  });
  expect(activeGoal).not.toHaveTextContent("Draft the launch narrative");
  expect(screen.getAllByRole("listitem", { name: "Active goal" })).toHaveLength(
    1,
  );

  events.push(
    goalMarker({
      id: "goal-lifecycle-complete",
      eventType: "goal.close",
      seqId: 9,
    }),
  );
  publishRunUpdate();

  await waitFor(() => {
    expect(
      screen.queryByRole("listitem", { name: "Active goal" }),
    ).not.toBeInTheDocument();
  });
});

test("Inspect and pause an active goal", async () => {
  const events = [
    ...queuedGoalEvents().slice(0, 3),
    goalMarker({
      id: "goal-detail-open",
      eventType: "goal.open",
      objective: "Prepare the launch objective",
      seqId: 4,
    }),
  ];
  const pausedThreadIds: string[] = [];
  installRunChat({ chatEvents: events });
  context.mocks.api(goalsContract.getForChatThread, ({ respond }) => {
    return respond(200, {
      objective:
        "## Launch objective\n\nProtect **customer data** throughout the release:\n\n- Validate the migration\n- Publish the rollback plan",
      objectiveBrief: "Prepare the launch objective",
      status: "active",
    });
  });
  context.mocks.api(goalsContract.pauseForChatThread, ({ params, respond }) => {
    pausedThreadIds.push(params.threadId);
    events.push(
      goalMarker({
        id: "goal-detail-paused",
        eventType: "goal.close",
        seqId: 5,
      }),
    );
    publishRunUpdate(params.threadId);
    return respond(200, {
      objective:
        "## Launch objective\n\nProtect customer data throughout the release.",
      objectiveBrief: "Prepare the launch objective",
      status: "paused",
    });
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const activeGoal = await screen.findByRole("listitem", {
    name: "Active goal",
  });
  expect(activeGoal).toHaveTextContent("Prepare the launch objective");

  click(await findButton("Open goal details"));

  const dialog = await screen.findByRole("dialog", { name: "Goal" });
  const objectiveHeading = await within(dialog).findByRole("heading", {
    level: 2,
    name: "Launch objective",
  });
  expect(objectiveHeading).toBeVisible();
  expect(within(dialog).getByText("customer data").tagName).toBe("STRONG");
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);

  click(await findButton("Close"));
  click(await findButton("Cancel goal"));

  await waitFor(() => {
    expect(pausedThreadIds).toStrictEqual([RUN_THREAD_ID]);
    expect(
      screen.queryByRole("listitem", { name: "Active goal" }),
    ).not.toBeInTheDocument();
  });
});
