import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  context,
  creditUsage,
  expectTextOrder,
  findButton,
  installRunChat,
  promptEvent,
  queryButton,
  readyChat,
  RUN_PATH,
  usageEvent,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000201";
const RUN_B = "a0000000-0000-4000-a000-000000000202";
const RUN_C = "a0000000-0000-4000-a000-000000000203";
const RUN_D = "a0000000-0000-4000-a000-000000000204";

function createdAt(minute: number, second = 0): string {
  return `2026-08-01T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

function buttonsNamed(name: string): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return button.getAttribute("aria-label") === name;
  });
}

function runWorkPreviews(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-chat-run-work-preview]"),
  );
}

function workMessage(index: number): string {
  return `Work message ${String(index + 1)}`;
}

function workMessageEvents(count: number): MockChatEventInput[] {
  return Array.from({ length: count }, (_, index) => {
    return assistantEvent({
      id: `work-message-${String(index + 1)}`,
      runId: RUN_A,
      seqId: index + 2,
      text: workMessage(index),
      createdAt: createdAt(10, (index + 1) * 5),
    });
  });
}

function activeWorkChatEvents(messageCount: number): MockChatEventInput[] {
  return [
    promptEvent({
      id: "active-work-user",
      runId: RUN_A,
      seqId: 1,
      text: "Prepare the deployment review",
      createdAt: createdAt(10),
    }),
    ...workMessageEvents(messageCount),
  ];
}

function visibleWorkMessages(messageCount: number): string[] {
  return Array.from({ length: messageCount }, (_, index) => {
    return workMessage(index);
  }).filter((message) => {
    return screen.queryByText(message) !== null;
  });
}

function fullWorkMessages(messageCount: number): string[] {
  return Array.from({ length: messageCount }, (_, index) => {
    return workMessage(index);
  }).filter((message) => {
    const element = screen.queryByText(message);
    return (
      element !== null &&
      element.closest("[data-chat-run-work-preview]") === null
    );
  });
}

test("Browse completed work by conversation phase", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "phase-a-user",
        runId: RUN_A,
        seqId: 1,
        text: "Plan phase one",
        createdAt: createdAt(0),
      }),
      assistantEvent({
        id: "phase-a-work-1",
        runId: RUN_A,
        seqId: 2,
        text: "Collected requirements",
        createdAt: createdAt(0, 20),
      }),
      assistantEvent({
        id: "phase-a-answer-1",
        runId: RUN_A,
        seqId: 3,
        text: "Phase one outline",
        createdAt: createdAt(0, 40),
      }),
      promptEvent({
        id: "phase-a-followup",
        runId: RUN_A,
        seqId: 4,
        text: "Include rollback steps",
        createdAt: createdAt(1),
      }),
      assistantEvent({
        id: "phase-a-work-2",
        runId: RUN_A,
        seqId: 5,
        text: "Compared rollback options",
        createdAt: createdAt(1, 20),
      }),
      assistantEvent({
        id: "phase-a-final",
        runId: RUN_A,
        seqId: 6,
        text: "Phase one final plan",
        createdAt: createdAt(2),
      }),
      completedEvent({
        id: "phase-a-complete",
        runId: RUN_A,
        seqId: 7,
        createdAt: createdAt(2, 1),
      }),
      promptEvent({
        id: "phase-b-user",
        runId: RUN_B,
        seqId: 8,
        text: "Plan phase two",
        createdAt: createdAt(3),
      }),
      assistantEvent({
        id: "phase-b-work",
        runId: RUN_B,
        seqId: 9,
        text: "Checked launch dependencies",
        createdAt: createdAt(3, 20),
      }),
      assistantEvent({
        id: "phase-b-final",
        runId: RUN_B,
        seqId: 10,
        text: "Phase two final plan",
        createdAt: createdAt(5),
      }),
      completedEvent({
        id: "phase-b-complete",
        runId: RUN_B,
        seqId: 11,
        createdAt: createdAt(5, 1),
      }),
      usageEvent({
        id: "phase-b-usage",
        runId: RUN_B,
        seqId: 12,
        usage: creditUsage(7, [
          {
            kind: "connector",
            credits: 7,
            providers: [{ provider: "slack", credits: 7 }],
          },
        ]),
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });

  await readyChat();
  expect(screen.getByText("Worked for 40s")).toBeVisible();
  expect(screen.getByText("Worked for 1m")).toBeVisible();
  expect(screen.getByText("Worked for 2m")).toBeVisible();
  expect(screen.getByText("Phase one outline")).toBeVisible();
  expect(screen.getByText("Phase one final plan")).toBeVisible();
  expect(screen.getByText("Phase two final plan")).toBeVisible();
  expect(screen.queryByText("Collected requirements")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Compared rollback options"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Checked launch dependencies"),
  ).not.toBeInTheDocument();
  const firstExpand = buttonsNamed("Expand work history")[0];
  if (!firstExpand) {
    throw new Error("First work-history summary not found");
  }

  click(firstExpand);

  await expect(
    screen.findByText("Collected requirements"),
  ).resolves.toBeVisible();
  expect(
    screen.queryByText("Compared rollback options"),
  ).not.toBeInTheDocument();
  expectTextOrder(
    "Plan phase one",
    "Collected requirements",
    "Phase one outline",
    "Include rollback steps",
    "Phase one final plan",
  );
  expect(
    screen.queryByText("Checked launch dependencies"),
  ).not.toBeInTheDocument();

  click(await findButton("Collapse work history"));
  await waitFor(() => {
    expect(
      screen.queryByText("Collected requirements"),
    ).not.toBeInTheDocument();
  });

  const secondRunExpand = buttonsNamed("Expand work history").at(-1);
  if (!secondRunExpand) {
    throw new Error("Second run work-history summary not found");
  }
  click(secondRunExpand);

  await expect(
    screen.findByText("Checked launch dependencies"),
  ).resolves.toBeVisible();
  expect(screen.getByLabelText("Credit usage 7")).toBeVisible();
  expect(screen.queryByText("Collected requirements")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Compared rollback options"),
  ).not.toBeInTheDocument();

  click(await findButton("Collapse work history"));

  await waitFor(() => {
    expect(
      screen.queryByText("Checked launch dependencies"),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText("Plan phase two")).toBeVisible();
  expect(screen.getByText("Phase two final plan")).toBeVisible();
  expect(screen.getByText("Plan phase one")).toBeVisible();
  expect(screen.getByText("Phase one final plan")).toBeVisible();
});

test.each([0, 1, 2, 3, 4, 5, 8])(
  "Summarize an active run with %i text messages",
  async (messageCount) => {
    const messages = workMessageEvents(messageCount);
    installRunChat({
      activeRunIds: [RUN_A],
      chatEvents: activeWorkChatEvents(messageCount),
    });

    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
    });

    await readyChat();
    expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
    const expectedPreviews = messages
      .slice(Math.max(0, messageCount - 4), -1)
      .map((_, index) => {
        return workMessage(Math.max(0, messageCount - 4) + index);
      });
    const expectedLatestMessage =
      messageCount === 0 ? [] : [workMessage(messageCount - 1)];
    expect(screen.queryAllByText(/^Working for /)).toHaveLength(
      messageCount === 0 ? 0 : 1,
    );
    expect(
      runWorkPreviews().map((preview) => {
        return preview.textContent?.replace(/\s+/gu, " ").trim();
      }),
    ).toStrictEqual(
      expectedPreviews.map((message) => {
        return `•${message}`;
      }),
    );
    expect(visibleWorkMessages(messageCount)).toStrictEqual([
      ...expectedPreviews,
      ...expectedLatestMessage,
    ]);
    expect(fullWorkMessages(messageCount)).toStrictEqual(expectedLatestMessage);
    expect(buttonsNamed("Expand work history")).toHaveLength(
      messageCount > 1 ? 1 : 0,
    );
  },
);

test.each([2, 3, 4, 5, 8])(
  "Expand an active run with %i text messages",
  async (messageCount) => {
    installRunChat({
      activeRunIds: [RUN_A],
      chatEvents: activeWorkChatEvents(messageCount),
    });

    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
    });

    click(await findButton("Expand work history"));
    await waitFor(() => {
      expect(runWorkPreviews()).toHaveLength(0);
    });
    expect(fullWorkMessages(messageCount)).toStrictEqual(
      Array.from({ length: messageCount }, (_, index) => {
        return workMessage(index);
      }),
    );
  },
);

test.each([0, 1, 2, 5])(
  "Summarize a finished run with %i text messages",
  async (messageCount) => {
    const messages = workMessageEvents(messageCount);
    installRunChat({
      chatEvents: [
        promptEvent({
          id: "finished-work-user",
          runId: RUN_A,
          seqId: 1,
          text: "Prepare the deployment review",
          createdAt: createdAt(10),
        }),
        ...messages,
        completedEvent({
          id: "finished-work-complete",
          runId: RUN_A,
          seqId: messageCount + 2,
          createdAt: createdAt(11),
        }),
      ],
    });

    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
    });

    await readyChat();
    expect(screen.getByText(/^Worked for /)).toBeVisible();
    expect(runWorkPreviews()).toHaveLength(0);
    const expectedLatestMessage =
      messageCount === 0 ? [] : [workMessage(messageCount - 1)];
    expect(visibleWorkMessages(messageCount)).toStrictEqual(
      expectedLatestMessage,
    );
    expect(fullWorkMessages(messageCount)).toStrictEqual(expectedLatestMessage);
    expect(buttonsNamed("Expand work history")).toHaveLength(
      messageCount > 1 ? 1 : 0,
    );
  },
);

test("Keep non-text run output fully visible and outside the message count", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "active-work-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare the deployment review",
        createdAt: createdAt(10),
      }),
      assistantEvent({
        id: "active-work-text",
        runId: RUN_A,
        seqId: 2,
        text: "Checked the deployment logs",
        createdAt: createdAt(10, 20),
      }),
      assistantEvent({
        id: "active-work-image",
        runId: RUN_A,
        seqId: 3,
        text: "![Generated chart](https://example.com/generated-chart.png)",
        createdAt: createdAt(10, 40),
      }),
      assistantEvent({
        id: "active-work-action",
        runId: RUN_A,
        seqId: 4,
        text: "[Compare plans](/?settings=billing&billingView=plans)",
        createdAt: createdAt(10, 45),
      }),
      {
        id: "active-work-error",
        eventType: "output.error",
        role: "assistant",
        content: null,
        error: "Health check failed visibly",
        runId: RUN_A,
        seqId: 5,
        createdAt: createdAt(10, 50),
      },
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });

  await readyChat();
  expect(screen.getByText("Checked the deployment logs")).toBeVisible();
  await expect(screen.findByAltText("Generated chart")).resolves.toBeVisible();
  await expect(screen.findByTestId("plan-upgrade-card")).resolves.toBeVisible();
  expect(screen.getByText("Health check failed visibly")).toBeVisible();
  expect(screen.getByText(/^Working for /)).toBeVisible();
  expect(runWorkPreviews()).toHaveLength(0);
  expect(buttonsNamed("Expand work history")).toHaveLength(0);
});

test("Fold intermediate work only after a run completes", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "active-user",
        runId: RUN_A,
        seqId: 1,
        text: "Active request",
      }),
      assistantEvent({
        id: "active-partial",
        runId: RUN_A,
        seqId: 2,
        text: "Active partial work",
      }),
      promptEvent({
        id: "cancel-user",
        runId: RUN_B,
        seqId: 3,
        text: "Cancelled request",
      }),
      assistantEvent({
        id: "cancel-partial",
        runId: RUN_B,
        seqId: 4,
        text: "Cancelled partial work",
      }),
      cancelledEvent({ id: "cancel-terminal", runId: RUN_B, seqId: 5 }),
      promptEvent({
        id: "fold-user",
        runId: RUN_C,
        seqId: 6,
        text: "Completed research request",
      }),
      assistantEvent({
        id: "fold-work-1",
        runId: RUN_C,
        seqId: 7,
        text: "Intermediate research one",
      }),
      assistantEvent({
        id: "fold-work-2",
        runId: RUN_C,
        seqId: 8,
        text: "Intermediate research two",
      }),
      assistantEvent({
        id: "fold-final",
        runId: RUN_C,
        seqId: 9,
        text: "Completed research answer",
      }),
      completedEvent({ id: "fold-complete", runId: RUN_C, seqId: 10 }),
      promptEvent({
        id: "direct-user",
        runId: RUN_D,
        seqId: 11,
        text: "Direct question",
      }),
      assistantEvent({
        id: "direct-answer",
        runId: RUN_D,
        seqId: 12,
        text: "Direct answer",
      }),
      completedEvent({ id: "direct-complete", runId: RUN_D, seqId: 13 }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: false },
  });

  await readyChat();
  expect(screen.getByText("Active partial work")).toBeVisible();
  expect(screen.getByText("Cancelled partial work")).toBeVisible();
  expect(
    screen.queryByText("Intermediate research one"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Completed research answer")).toBeVisible();
  expect(screen.getByText("Direct answer")).toBeVisible();
  expect(buttonsNamed("Expand work history")).toHaveLength(1);

  click(await findButton("Expand work history"));

  await expect(
    screen.findByText("Intermediate research one"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Intermediate research two")).toBeVisible();
  expect(buttonsNamed("Collapse work history")).toHaveLength(1);
});

test("Keep interleaved run updates with their own turns", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "interleave-a-user",
        runId: RUN_A,
        seqId: 1,
        text: "Request A",
      }),
      promptEvent({
        id: "interleave-b-user",
        runId: RUN_B,
        seqId: 2,
        text: "Request B",
      }),
      assistantEvent({
        id: "interleave-b-answer",
        runId: RUN_B,
        seqId: 3,
        text: "B final answer",
      }),
      assistantEvent({
        id: "interleave-a-final",
        runId: RUN_A,
        seqId: 4,
        text: "A late final answer",
      }),
      completedEvent({ id: "interleave-a-complete", runId: RUN_A, seqId: 5 }),
      completedEvent({ id: "interleave-b-complete", runId: RUN_B, seqId: 6 }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(screen.getByText("A late final answer")).toBeVisible();
  expectTextOrder(
    "Request A",
    "A late final answer",
    "Request B",
    "B final answer",
  );
});

test("Keep run-budget instructions out of the transcript", async () => {
  const events: MockChatEventInput[] = [
    promptEvent({
      id: "budget-user",
      runId: RUN_A,
      seqId: 1,
      text: "Complete the migration",
    }),
    {
      id: "budget-instruction",
      eventType: "input.budget",
      role: "user",
      content: null,
      runId: RUN_A,
      seqId: 2,
      createdAt: "2026-08-01T10:00:02.000Z",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "text",
            text: "You have 12 minutes left in this run",
          },
        ],
      },
    },
    assistantEvent({
      id: "budget-answer",
      runId: RUN_A,
      seqId: 3,
      text: "The migration is complete.",
    }),
    completedEvent({ id: "budget-complete", runId: RUN_A, seqId: 4 }),
  ];
  installRunChat({ chatEvents: events });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(screen.getByText("Complete the migration")).toBeVisible();
  expect(screen.getByText("The migration is complete.")).toBeVisible();
  expect(
    screen.queryByText("You have 12 minutes left in this run"),
  ).not.toBeInTheDocument();
});

test("Keep usage-only activity out of the conversation", async () => {
  installRunChat({
    chatEvents: [
      usageEvent({
        id: "zero-usage",
        runId: RUN_A,
        seqId: 1,
        usage: creditUsage(0, []),
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  const chat = await readyChat();
  expect(chat).not.toHaveTextContent("Credit usage");
  expect(queryButton("Stop")).toBeNull();
  await expect(findButton("Send")).resolves.toBeVisible();
});

test("Preserve user text that resembles HTML", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "literal-html",
        runId: RUN_A,
        seqId: 1,
        text: "<span> 123 </span>",
      }),
      assistantEvent({
        id: "literal-answer",
        runId: RUN_A,
        seqId: 2,
        text: "I preserved it literally.",
      }),
      completedEvent({ id: "literal-complete", runId: RUN_A, seqId: 3 }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const literalText = screen.getByText("<span> 123 </span>");
  expect(literalText).toBeVisible();
  expect(literalText.textContent).toBe("<span> 123 </span>");
});

test("Replace a stale assistant answer with its correction", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "correction-user",
        runId: RUN_A,
        seqId: 1,
        text: "Revise the launch plan",
      }),
      assistantEvent({
        id: "obsolete-answer",
        runId: RUN_A,
        seqId: 2,
        text: "Obsolete launch plan",
      }),
      {
        id: "revised-answer",
        eventType: "output.message",
        role: "assistant",
        content: "Revised launch plan",
        runId: RUN_A,
        revokesEventId: "obsolete-answer",
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
      },
      completedEvent({ id: "correction-complete", runId: RUN_A, seqId: 4 }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(screen.getByText("Revised launch plan")).toBeVisible();
  expect(screen.queryByText("Obsolete launch plan")).not.toBeInTheDocument();
});
