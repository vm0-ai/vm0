import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  queryMessageBody,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  context,
  creditUsage,
  expectTextOrder,
  findButton,
  findLink,
  installRunChat,
  promptEvent,
  queryButton,
  readyChat,
  RUN_PATH,
  thinkingEvent,
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

function buttonNamedIn(name: string, container: HTMLElement): HTMLElement {
  const button = buttonsNamed(name).find((candidate) => {
    return container.contains(candidate);
  });
  if (!button) {
    throw new Error(`Expected button named "${name}" in container`);
  }
  return button;
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

function assistantGroupFor(element: Element): HTMLElement {
  const group = element.closest<HTMLElement>('[data-role="assistant"]');
  if (!group) {
    throw new Error("Expected content inside one assistant response");
  }
  return group;
}

function viewAgentProfileLinks(): HTMLElement[] {
  return queryAllByRoleFast("link").filter((link) => {
    return link.getAttribute("aria-label") === "View agent profile";
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
  expect(
    assistantGroupFor(screen.getByText("Phase one outline")),
  ).toHaveTextContent("Worked for 1m");
  expect(
    assistantGroupFor(screen.getByText("Phase one final plan")),
  ).toHaveTextContent("Worked for 1m");
  expect(screen.getByText("Worked for 2m")).toBeVisible();
  expect(screen.getByText("Phase one outline")).toBeVisible();
  expect(screen.getByText("Phase one final plan")).toBeVisible();
  expect(screen.getByText("Phase two final plan")).toBeVisible();
  expect(queryMessageBody("Collected requirements")).not.toBeInTheDocument();
  expect(queryMessageBody("Compared rollback options")).not.toBeInTheDocument();
  expect(
    queryMessageBody("Checked launch dependencies"),
  ).not.toBeInTheDocument();
  const firstExpand = buttonsNamed("Expand work history")[0];
  if (!firstExpand) {
    throw new Error("First work-history summary not found");
  }

  click(firstExpand);

  await expect(
    screen.findByText("Collected requirements"),
  ).resolves.toBeVisible();
  expect(queryMessageBody("Compared rollback options")).not.toBeInTheDocument();
  expectTextOrder(
    "Plan phase one",
    "Collected requirements",
    "Phase one outline",
    "Include rollback steps",
    "Phase one final plan",
  );
  expect(
    queryMessageBody("Checked launch dependencies"),
  ).not.toBeInTheDocument();

  click(await findButton("Collapse work history"));
  await waitFor(() => {
    expect(queryMessageBody("Collected requirements")).not.toBeInTheDocument();
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
  expect(queryMessageBody("Collected requirements")).not.toBeInTheDocument();
  expect(queryMessageBody("Compared rollback options")).not.toBeInTheDocument();

  click(await findButton("Collapse work history"));

  await waitFor(() => {
    expect(
      queryMessageBody("Checked launch dependencies"),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText("Plan phase two")).toBeVisible();
  expect(screen.getByText("Phase two final plan")).toBeVisible();
  expect(screen.getByText("Plan phase one")).toBeVisible();
  expect(screen.getByText("Phase one final plan")).toBeVisible();
});

test.each([
  {
    label: "no output messages",
    messageCount: 0,
    showsHistoryStatus: false,
    canExpandHistory: false,
  },
  {
    label: "one output message",
    messageCount: 1,
    showsHistoryStatus: true,
    canExpandHistory: false,
  },
  {
    label: "multiple output messages",
    messageCount: 3,
    showsHistoryStatus: true,
    canExpandHistory: true,
  },
])(
  "Project an active run with $label",
  async ({ messageCount, showsHistoryStatus, canExpandHistory }) => {
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
    const thinking = document.querySelector<HTMLElement>(
      "[data-thinking-indicator]",
    );
    expect(thinking).toBeVisible();
    expect(screen.queryAllByText(/^Working(?: for)? /u)).toHaveLength(
      showsHistoryStatus ? 1 : 0,
    );
    expect(buttonsNamed("Expand work history")).toHaveLength(
      canExpandHistory ? 1 : 0,
    );

    if (messageCount === 0) {
      return;
    }

    const main = screen.getByText(workMessage(messageCount - 1));
    expect(main).toBeVisible();

    for (let index = 0; index < messageCount - 1; index += 1) {
      expect(queryMessageBody(workMessage(index))).toBeNull();
    }
    expect(assistantGroupFor(main)).toContainElement(thinking);

    if (!canExpandHistory) {
      return;
    }

    click(await findButton("Expand work history"));
    const firstHistoryMessage = await screen.findByText(workMessage(0));
    const secondHistoryMessage = screen.getByText(workMessage(1));
    expect(assistantGroupFor(firstHistoryMessage)).toBe(
      assistantGroupFor(main),
    );
    expect(assistantGroupFor(secondHistoryMessage)).toBe(
      assistantGroupFor(main),
    );
    expectTextOrder(workMessage(0), workMessage(1), workMessage(2));
  },
);

test("Do not create history before the first output.message", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "status-only-user",
        runId: RUN_A,
        seqId: 1,
        text: "Inspect the release",
        createdAt: createdAt(0),
      }),
      thinkingEvent({
        id: "status-only-thinking",
        runId: RUN_A,
        seqId: 2,
        text: "Reading release evidence",
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });

  await readyChat();
  expect(screen.queryByText(/^Working(?: for)? /u)).toBeNull();
  expect(buttonsNamed("Expand work history")).toHaveLength(0);
  expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
});

test("Count one output.message once when Markdown renders multiple child blocks", async () => {
  const artifactUrl =
    "https://cdn.vm7.io/artifacts/run-folding/multi-block/package.pdf";
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "multi-block-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare the package",
      }),
      assistantEvent({
        id: "multi-block-output",
        runId: RUN_A,
        seqId: 2,
        text: [
          "Final package",
          "![Package chart](https://example.com/package-chart.png)",
          artifactUrl,
          "[Compare plans](/?settings=billing&billingView=plans)",
        ].join("\n\n"),
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });

  await readyChat();
  expect(screen.getByText("Final package")).toBeVisible();
  await expect(screen.findByAltText("Package chart")).resolves.toBeVisible();
  await expect(
    findLink("Open pdf preview for package.pdf"),
  ).resolves.toBeVisible();
  await expect(screen.findByTestId("plan-upgrade-card")).resolves.toBeVisible();
  expect(buttonsNamed("Expand work history")).toHaveLength(0);
  expect(screen.queryAllByText(/^Working(?: for)? /u)).toHaveLength(1);
  expect(viewAgentProfileLinks()).toHaveLength(1);
});

test.each([
  {
    label: "one output message",
    messageCount: 1,
    canExpandHistory: false,
  },
  {
    label: "multiple output messages",
    messageCount: 3,
    canExpandHistory: true,
  },
])(
  "Project a completed run with $label",
  async ({ messageCount, canExpandHistory }) => {
    installRunChat({
      chatEvents: [
        ...activeWorkChatEvents(messageCount),
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
    expect(screen.getByText(workMessage(messageCount - 1))).toBeVisible();
    expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    expect(screen.queryAllByText(/^Worked(?: for)? /u)).toHaveLength(1);
    expect(buttonsNamed("Expand work history")).toHaveLength(
      canExpandHistory ? 1 : 0,
    );
    for (let index = 0; index < messageCount - 1; index += 1) {
      expect(queryMessageBody(workMessage(index))).toBeNull();
    }
  },
);

const finalOutputDocuments = [
  {
    label: "plain Markdown",
    content: "Final plain answer",
    find: () => {
      return screen.findByText("Final plain answer");
    },
  },
  {
    label: "a fenced media-looking literal",
    content: ["```text", "https://example.com/final-literal.png", "```"].join(
      "\n",
    ),
    find: () => {
      return screen.findByText("https://example.com/final-literal.png");
    },
  },
  {
    label: "an inline image",
    content: "![Final chart](https://example.com/final-chart.png)",
    find: () => {
      return screen.findByAltText("Final chart");
    },
  },
  {
    label: "an artifact card",
    content: "https://cdn.vm7.io/artifacts/tests/run-folding/final-report.pdf",
    find: () => {
      return findLink("Open pdf preview for final-report.pdf");
    },
  },
  {
    label: "an action card",
    content: "[Compare plans](/?settings=billing&billingView=plans)",
    find: () => {
      return screen.findByTestId("plan-upgrade-card");
    },
  },
] as const;

test.each(finalOutputDocuments)(
  "Use the last output.message as the main result when it renders $label",
  async ({ content, find }) => {
    installRunChat({
      activeRunIds: [RUN_A],
      chatEvents: [
        promptEvent({
          id: "document-shape-user",
          runId: RUN_A,
          seqId: 1,
          text: "Prepare the final result",
          createdAt: createdAt(10),
        }),
        assistantEvent({
          id: "document-shape-history",
          runId: RUN_A,
          seqId: 2,
          text: "Earlier output belongs in history",
          createdAt: createdAt(10, 20),
        }),
        assistantEvent({
          id: "document-shape-main",
          runId: RUN_A,
          seqId: 3,
          text: content,
          createdAt: createdAt(10, 40),
        }),
      ],
    });

    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
    });

    await readyChat();
    const main = await find();
    expect(main).toBeVisible();
    expect(viewAgentProfileLinks()).toHaveLength(1);
    expect(queryMessageBody("Earlier output belongs in history")).toBeNull();
    expect(buttonsNamed("Expand work history")).toHaveLength(1);
    const thinking = document.querySelector<HTMLElement>(
      "[data-thinking-indicator]",
    );
    expect(assistantGroupFor(main)).toContainElement(thinking);
  },
);

test("Keep result actions visible alongside running progress", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "exclusive-tail-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare a result",
      }),
      assistantEvent({
        id: "exclusive-tail-result",
        runId: RUN_A,
        seqId: 2,
        text: "The result is still being checked",
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });

  await readyChat();
  expect(screen.getByText("The result is still being checked")).toBeVisible();
  expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
  expect(
    document.querySelector('[data-testid="chat-event-actions"]'),
  ).toBeVisible();
});

test("Do not render result actions while waiting for assistant output", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "waiting-actions-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare a result",
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });

  await readyChat();
  expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
  expect(
    document.querySelector('[data-testid="chat-event-actions"]'),
  ).toBeNull();
});

test("Render result actions after a run completes", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "completed-actions-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare a completed result",
      }),
      assistantEvent({
        id: "completed-actions-result",
        runId: RUN_A,
        seqId: 2,
        text: "The completed result is ready",
      }),
      completedEvent({
        id: "completed-actions-terminal",
        runId: RUN_A,
        seqId: 3,
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });

  await readyChat();
  const result = screen.getByText("The completed result is ready");
  const assistantGroup = assistantGroupFor(result);
  const mainMessage = result.closest<HTMLElement>("[data-chat-run-work-main]");
  if (!mainMessage) {
    throw new Error("Expected the result inside the main message region");
  }
  expect(assistantGroup.querySelector("[data-thinking-indicator]")).toBeNull();
  const actions = assistantGroup.querySelector<HTMLElement>(
    '[data-testid="chat-event-actions"]',
  );
  if (!actions) {
    throw new Error("Expected the completed result action bar");
  }
  expect(actions).toBeVisible();
  expect(mainMessage).toContainElement(actions);
  expect(
    result.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
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
  const directAnswer = screen.getByText("Direct answer");
  expect(directAnswer).toBeVisible();
  expect(buttonsNamed("Expand work history")).toHaveLength(1);

  const directGroup = assistantGroupFor(directAnswer);
  const directCopy = buttonNamedIn("Copy message", directGroup);
  expect(directGroup.firstElementChild).toContainElement(directAnswer);
  expect(directGroup.firstElementChild).not.toContainElement(directCopy);
  expect(directGroup.lastElementChild).toContainElement(directCopy);
  expect(
    directGroup.querySelector(
      "[data-chat-run-work], [data-chat-run-work-main], [data-chat-run-work-remaining-artifacts]",
    ),
  ).toBeNull();

  click(await findButton("Expand work history"));

  await expect(
    screen.findByText("Intermediate research one"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Intermediate research two")).toBeVisible();
  expect(buttonsNamed("Collapse work history")).toHaveLength(1);
});

test("Keep the legacy running tail outside the response when work folding is disabled", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: activeWorkChatEvents(2),
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: false },
  });

  await readyChat();
  const latestMessage = screen.getByText(workMessage(1));
  const assistantGroup = assistantGroupFor(latestMessage);
  const thinking = document.querySelector<HTMLElement>(
    "[data-thinking-indicator]",
  );
  const copy = buttonNamedIn("Copy message", assistantGroup);

  expect(screen.getByText(workMessage(0))).toBeVisible();
  expect(thinking).toBeVisible();
  expect(assistantGroup).not.toContainElement(thinking);
  expect(assistantGroup.firstElementChild).toContainElement(latestMessage);
  expect(assistantGroup.firstElementChild).not.toContainElement(copy);
  expect(assistantGroup.lastElementChild).toContainElement(copy);
  expect(assistantGroup.querySelector("[data-chat-run-work]")).toBeNull();
  expect(buttonsNamed("Expand work history")).toHaveLength(0);
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
