import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { installRunChat, publishRunUpdate } from "./chat-run-test-fixtures.ts";

const WORKFLOW_GROUP_ID = "e0000000-0000-4000-a000-000000000871";
const WORKFLOW_RUN_IDS = [
  "d0000000-0000-4000-a000-000000000871",
  "d0000000-0000-4000-a000-000000000872",
  "d0000000-0000-4000-a000-000000000873",
] as const;

function timestamp(minute: number, second: number): string {
  return `2026-08-01T10:${String(minute).padStart(2, "0")}:${String(
    second,
  ).padStart(2, "0")}.000Z`;
}

function workflowInput(args: {
  readonly id: string;
  readonly runId: string;
  readonly runGroupId: string;
  readonly seqId: number;
  readonly minute: number;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "user",
    eventType: "input.automation",
    content: null,
    runId: args.runId,
    runGroupId: args.runGroupId,
    userMessage: {
      version: 1,
      parts: [
        {
          type: "automation",
          workflowName: "nightly-launch-review",
          automationBrief: "Nightly launch review",
        },
      ],
    },
    seqId: args.seqId,
    createdAt: timestamp(args.minute, 0),
  };
}

function assistantOutput(args: {
  readonly id: string;
  readonly runId: string;
  readonly runGroupId: string;
  readonly seqId: number;
  readonly minute: number;
  readonly second: number;
  readonly text: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    eventType: "output.message",
    content: args.text,
    runId: args.runId,
    runGroupId: args.runGroupId,
    seqId: args.seqId,
    createdAt: timestamp(args.minute, args.second),
  };
}

function completedMarker(args: {
  readonly id: string;
  readonly runId: string;
  readonly runGroupId: string;
  readonly seqId: number;
  readonly minute: number;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    eventType: "run.completed",
    content: null,
    runId: args.runId,
    runGroupId: args.runGroupId,
    runLifecycleEvent: "completed",
    seqId: args.seqId,
    createdAt: timestamp(args.minute, 31),
  };
}

function completedWorkflowRun(args: {
  readonly number: number;
  readonly runId: string;
  readonly seqId: number;
  readonly minute: number;
}): MockChatEventInput[] {
  return [
    workflowInput({
      id: `workflow-history-${String(args.number)}-input`,
      runId: args.runId,
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: args.seqId,
      minute: args.minute,
    }),
    assistantOutput({
      id: `workflow-history-${String(args.number)}-work`,
      runId: args.runId,
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: args.seqId + 1,
      minute: args.minute,
      second: 10,
      text: `Earlier workflow evidence ${String(args.number)}`,
    }),
    assistantOutput({
      id: `workflow-history-${String(args.number)}-result`,
      runId: args.runId,
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: args.seqId + 2,
      minute: args.minute,
      second: 30,
      text: `Earlier workflow result ${String(args.number)}`,
    }),
    completedMarker({
      id: `workflow-history-${String(args.number)}-completed`,
      runId: args.runId,
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: args.seqId + 3,
      minute: args.minute,
    }),
  ];
}

test("Browse earlier runs in a grouped goal or workflow history", async () => {
  const events = [
    ...completedWorkflowRun({
      number: 1,
      runId: WORKFLOW_RUN_IDS[0],
      seqId: 1,
      minute: 0,
    }),
    ...completedWorkflowRun({
      number: 2,
      runId: WORKFLOW_RUN_IDS[1],
      seqId: 5,
      minute: 2,
    }),
    workflowInput({
      id: "workflow-history-current-input",
      runId: WORKFLOW_RUN_IDS[2],
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: 9,
      minute: 4,
    }),
    {
      id: "workflow-history-current-thinking",
      role: "assistant" as const,
      eventType: "output.thinking" as const,
      content: null,
      thinking: "Checking the latest workflow run",
      runId: WORKFLOW_RUN_IDS[2],
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: 10,
      createdAt: timestamp(4, 10),
    },
  ] satisfies MockChatEventInput[];
  installRunChat({ chatEvents: events });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const fold = await findButton("Expand grouped run history");
  expect(fold).toHaveTextContent("2 runs for Nightly launch review");
  expect(fold).not.toHaveTextContent(/goal/iu);
  const currentProgress = await screen.findByLabelText(
    "Checking the latest workflow run",
  );
  expect(currentProgress).toBeVisible();
  expect(
    screen.queryByText("Earlier workflow result 1"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Earlier workflow result 2"),
  ).not.toBeInTheDocument();

  click(fold);

  const firstEarlierResult = await screen.findByText(
    "Earlier workflow result 1",
  );
  expect(firstEarlierResult).toBeVisible();
  expect(screen.getByText("Earlier workflow result 2")).toBeVisible();
  const workHistory = await findButton("Expand work history");
  expect(workHistory).toHaveTextContent(/Worked for \d+s/u);

  click(await findButton("Collapse grouped run history"));
  await waitFor(() => {
    expect(
      screen.queryByText("Earlier workflow result 1"),
    ).not.toBeInTheDocument();
  });
  events.push({
    id: "workflow-history-current-paused",
    role: "assistant",
    eventType: "run.cancelled",
    content: null,
    error: "Run cancelled",
    runId: WORKFLOW_RUN_IDS[2],
    runGroupId: WORKFLOW_GROUP_ID,
    runLifecycleEvent: "cancelled",
    seqId: 11,
    createdAt: timestamp(4, 20),
  });
  publishRunUpdate();

  const paused = await screen.findByText(
    "Paused mid-thought — pick it back up whenever.",
  );
  expect(paused).toBeVisible();
  expect(
    screen.queryByText("Earlier workflow result 1"),
  ).not.toBeInTheDocument();
  const collapsedFold = await findButton("Expand grouped run history");
  expect(collapsedFold).toBeVisible();
});

test("Keep pending grouped goal history with the assistant response", async () => {
  const goalGroupId = "e0000000-0000-4000-a000-000000000874";
  const completedRunId = "d0000000-0000-4000-a000-000000000874";
  const activeRunId = "d0000000-0000-4000-a000-000000000875";
  const events = [
    {
      id: "pending-goal-history-input",
      role: "user" as const,
      eventType: "input.prompt" as const,
      content: null,
      userMessage: {
        version: 1 as const,
        parts: [
          {
            type: "goal" as const,
            goalBrief: "Keep the launch evidence current",
          },
        ],
      },
      runId: completedRunId,
      runGroupId: goalGroupId,
      seqId: 1,
      createdAt: timestamp(0, 0),
    },
    assistantOutput({
      id: "pending-goal-history-answer",
      runId: completedRunId,
      runGroupId: goalGroupId,
      seqId: 2,
      minute: 0,
      second: 30,
      text: "The earlier launch evidence is complete.",
    }),
    completedMarker({
      id: "pending-goal-history-completed",
      runId: completedRunId,
      runGroupId: goalGroupId,
      seqId: 3,
      minute: 0,
    }),
    {
      id: "pending-goal-current-input",
      role: "user" as const,
      eventType: "input.prompt" as const,
      content: null,
      userMessage: {
        version: 1 as const,
        parts: [
          {
            type: "goal" as const,
            goalBrief: "Keep the launch evidence current",
          },
        ],
      },
      runId: activeRunId,
      runGroupId: goalGroupId,
      seqId: 4,
      createdAt: timestamp(2, 0),
    },
  ] satisfies MockChatEventInput[];
  installRunChat({ chatEvents: events, activeRunIds: [activeRunId] });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const fold = await findButton("Expand grouped run history");
  const thinking = await waitFor(() => {
    const indicator = document.querySelector<HTMLElement>(
      "[data-thinking-indicator]",
    );
    if (!indicator) {
      throw new Error("Expected the current assistant thinking response");
    }
    expect(indicator).toBeVisible();
    return indicator;
  });
  const pendingAssistant = fold.closest<HTMLElement>('[data-role="assistant"]');
  if (!pendingAssistant) {
    throw new Error("Expected grouped goal history in an assistant response");
  }
  expect(pendingAssistant).toBe(thinking);
  expect(
    queryAllByRoleFast("link", pendingAssistant).filter((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    }),
  ).toHaveLength(1);

  events.push(
    assistantOutput({
      id: "pending-goal-current-answer",
      runId: activeRunId,
      runGroupId: goalGroupId,
      seqId: 5,
      minute: 2,
      second: 30,
      text: "The current launch evidence is ready.",
    }),
  );
  publishRunUpdate();

  const answer = await screen.findByText(
    "The current launch evidence is ready.",
  );
  const currentFold = await findButton("Expand grouped run history");
  const answeringAssistant = answer.closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  if (!answeringAssistant) {
    throw new Error("Expected the answer in an assistant response");
  }
  expect(currentFold.closest('[data-role="assistant"]')).toBe(
    answeringAssistant,
  );
  expect(
    queryAllByRoleFast("link", answeringAssistant).filter((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    }),
  ).toHaveLength(1);
});

const ARCHIVED_GOAL_GROUP_ID = "e0000000-0000-4000-a000-000000000881";
const LINKED_ARCHIVED_EVENT_ID = "archived-goal-linked-result";

function archivedGoalRun(args: {
  readonly number: number;
  readonly runId: string;
  readonly seqId: number;
  readonly resultId: string;
  readonly result: string;
}): MockChatEventInput[] {
  return [
    {
      id: `archived-goal-${String(args.number)}-input`,
      role: "user",
      eventType: "input.prompt",
      content: null,
      userMessage: {
        version: 1,
        parts: [{ type: "goal", goalBrief: "Archive the launch evidence" }],
      },
      runId: args.runId,
      runGroupId: ARCHIVED_GOAL_GROUP_ID,
      seqId: args.seqId,
      createdAt: timestamp(args.number * 2, 0),
    },
    assistantOutput({
      id: args.resultId,
      runId: args.runId,
      runGroupId: ARCHIVED_GOAL_GROUP_ID,
      seqId: args.seqId + 1,
      minute: args.number * 2,
      second: 30,
      text: args.result,
    }),
    completedMarker({
      id: `archived-goal-${String(args.number)}-completed`,
      runId: args.runId,
      runGroupId: ARCHIVED_GOAL_GROUP_ID,
      seqId: args.seqId + 2,
      minute: args.number * 2,
    }),
  ];
}

test("Open an archived goal run from a linked event", async () => {
  const events = [
    ...archivedGoalRun({
      number: 1,
      runId: "d0000000-0000-4000-a000-000000000881",
      seqId: 1,
      resultId: LINKED_ARCHIVED_EVENT_ID,
      result: "Linked archived launch result",
    }),
    ...archivedGoalRun({
      number: 2,
      runId: "d0000000-0000-4000-a000-000000000882",
      seqId: 4,
      resultId: "archived-goal-middle-result",
      result: "Middle archived launch result",
    }),
    ...archivedGoalRun({
      number: 3,
      runId: "d0000000-0000-4000-a000-000000000883",
      seqId: 7,
      resultId: "archived-goal-latest-result",
      result: "Latest launch result",
    }),
  ];
  installRunChat({ chatEvents: events });

  await setupPage({
    context,
    path: `${RUN_PATH}#event-${LINKED_ARCHIVED_EVENT_ID}`,
  });

  await readyChat();
  const linkedResult = await screen.findByText("Linked archived launch result");
  expect(linkedResult).toBeVisible();
  expect(screen.getByText("Latest launch result")).toBeVisible();
  const expandedFold = await findButton("Collapse grouped run history");
  expect(expandedFold).toBeVisible();
});
