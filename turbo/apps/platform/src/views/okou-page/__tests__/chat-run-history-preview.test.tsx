import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  context,
  findButton,
  findWorkHistoryToggle,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const RUN_ID = "a0000000-0000-4000-a000-000000000294";

async function setupRunWithOutputCount(count: number): Promise<void> {
  installRunChat({
    activeRunIds: [RUN_ID],
    chatEvents: [
      promptEvent({
        id: "preview-input",
        runId: RUN_ID,
        seqId: 1,
        text: "Check every step",
      }),
      ...Array.from({ length: count }, (_, index) => {
        return assistantEvent({
          id: `preview-${String(index)}`,
          runId: RUN_ID,
          seqId: index + 2,
          text: `Step ${String(index + 1)}`,
        });
      }),
    ],
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });
  await readyChat();
}

function workPreviewTexts(): (string | null)[] {
  return Array.from(
    document.querySelectorAll("[data-chat-run-work-preview]"),
  ).map((element) => {
    return element.textContent;
  });
}

test("Show no history messages without assistant output", async () => {
  await setupRunWithOutputCount(0);

  expect(workPreviewTexts()).toStrictEqual([]);
});

test.each([
  { count: 1, expected: [] },
  { count: 2, expected: ["Step 1"] },
  { count: 3, expected: ["Step 1", "Step 2"] },
  { count: 4, expected: ["Step 1", "Step 2", "Step 3"] },
])(
  "Show every history message without a group toggle with $count outputs",
  async ({ count, expected }) => {
    await setupRunWithOutputCount(count);

    expect(workPreviewTexts()).toStrictEqual(expected);
    const main = screen
      .getByText(`Step ${count}`)
      .closest("[data-chat-run-work-main]");
    if (!main) {
      throw new Error("Expected the main result container");
    }
    expect(queryButton("Copy message", main)).toBeVisible();
    expect(queryButton("Expand work history")).toBeNull();
  },
);

test.each([
  { count: 5, expected: ["Step 2", "Step 3", "Step 4"] },
  { count: 6, expected: ["Step 3", "Step 4", "Step 5"] },
])(
  "Show three recent messages and expand every history message with $count outputs",
  async ({ count, expected }) => {
    await setupRunWithOutputCount(count);

    expect(workPreviewTexts()).toStrictEqual(expected);
    const main = screen
      .getByText(`Step ${count}`)
      .closest("[data-chat-run-work-main]");
    if (!main) {
      throw new Error("Expected the main result container");
    }
    expect(queryButton("Copy message", main)).toBeVisible();
    const showAll = await findWorkHistoryToggle("collapsed");
    expect(showAll).toHaveAttribute("aria-expanded", "false");
    click(showAll);
    const showRecent = await findWorkHistoryToggle("expanded");
    expect(showRecent).toHaveAttribute("aria-expanded", "true");
    expect(
      document.querySelectorAll("[data-chat-run-work-message]"),
    ).toHaveLength(count - 1);
    expect(
      document.querySelectorAll("[data-chat-run-work-preview]"),
    ).toHaveLength(count - 1);
    expect(screen.getByText("Step 1")).toBeVisible();
    expect(screen.getByText(`Step ${count}`)).toBeVisible();
    expect(queryButton("Copy message", main)).toBeVisible();
    expect(
      document.querySelector(
        "[data-chat-run-status-tail] [data-thinking-indicator]",
      ),
    ).toBeVisible();

    click(showRecent);
    await waitFor(() => {
      expect(
        document.querySelectorAll("[data-chat-run-work-preview]"),
      ).toHaveLength(expected.length);
    });
    expect(screen.getByText(`Step ${count}`)).toBeVisible();
    expect(queryButton("Copy message", main)).toBeVisible();
    expect(
      document.querySelector(
        "[data-chat-run-status-tail] [data-thinking-indicator]",
      ),
    ).toBeVisible();
  },
);

test("Hide the empty history step count from the work summary", async () => {
  await setupRunWithOutputCount(1);

  const workSummary = document.querySelector("[data-chat-run-work]");
  expect(workSummary).toBeVisible();
  expect(workSummary).not.toHaveTextContent("0 steps");
  expect(workSummary).not.toHaveTextContent("·");
});

test.each([
  { outputCount: 2, expectedStepCount: "1 step" },
  { outputCount: 5, expectedStepCount: "4 steps" },
])(
  "Show a non-empty history step count with $outputCount outputs",
  async ({ outputCount, expectedStepCount }) => {
    await setupRunWithOutputCount(outputCount);

    expect(document.querySelector("[data-chat-run-work]")).toHaveTextContent(
      expectedStepCount,
    );
  },
);

test("Expand history messages independently and preserve them across history changes", async () => {
  installRunChat({
    activeRunIds: [RUN_ID],
    chatEvents: [
      promptEvent({
        id: "message-expansion-input",
        runId: RUN_ID,
        seqId: 1,
        text: "Check every step",
      }),
      ...Array.from({ length: 5 }, (_, index) => {
        return assistantEvent({
          id: `message-expansion-${index}`,
          runId: RUN_ID,
          seqId: index + 2,
          text: `Step ${index + 1}`,
        });
      }),
    ],
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });
  await readyChat();

  const stepTwo = await findButton("Step 2");
  stepTwo.focus();
  click(stepTwo);
  await waitFor(() => {
    expect(stepTwo).toHaveAccessibleName("Collapse history message: Step 2");
    expect(stepTwo).toHaveFocus();
  });
  click(await findButton("Step 3"));
  expect(
    document.querySelectorAll("[data-chat-run-work-message-expanded]"),
  ).toHaveLength(2);

  click(await findWorkHistoryToggle("collapsed"));
  expect(
    document.querySelectorAll("[data-chat-run-work-message]"),
  ).toHaveLength(4);
  expect(
    document.querySelectorAll("[data-chat-run-work-message-expanded]"),
  ).toHaveLength(2);

  click(await findButton("Step 1"));
  expect(
    document.querySelectorAll("[data-chat-run-work-message-expanded]"),
  ).toHaveLength(3);
  click(await findWorkHistoryToggle("expanded"));
  expect(screen.queryByText("Step 1")).toBeNull();
  expect(
    document.querySelectorAll("[data-chat-run-work-message-expanded]"),
  ).toHaveLength(2);

  click(await findWorkHistoryToggle("collapsed"));
  expect(screen.getByText("Step 1")).toBeVisible();
  expect(
    document.querySelectorAll("[data-chat-run-work-message-expanded]"),
  ).toHaveLength(3);
});

test("Keep work history open and keyboard focus in place when another output arrives", async () => {
  const events = [
    promptEvent({
      id: "focused-history-input",
      runId: RUN_ID,
      seqId: 1,
      text: "Check every step",
    }),
    assistantEvent({
      id: "focused-history-first",
      runId: RUN_ID,
      seqId: 2,
      text: "Checked the dependencies",
    }),
    assistantEvent({
      id: "focused-history-second",
      runId: RUN_ID,
      seqId: 3,
      text: "Checked the boundaries",
    }),
    assistantEvent({
      id: "focused-history-third",
      runId: RUN_ID,
      seqId: 4,
      text: "Checked the interactions",
    }),
    assistantEvent({
      id: "focused-history-fourth",
      runId: RUN_ID,
      seqId: 5,
      text: "Checked the responsive layout",
    }),
    assistantEvent({
      id: "focused-history-fifth",
      runId: RUN_ID,
      seqId: 6,
      text: "Checked the final details",
    }),
  ];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID] });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });
  await readyChat();
  const showAll = await findWorkHistoryToggle("collapsed");
  click(showAll);
  showAll.focus();

  events.push(
    assistantEvent({
      id: "focused-history-sixth",
      runId: RUN_ID,
      seqId: 7,
      text: "The checks are complete",
    }),
  );
  publishRunUpdate();

  await expect(
    screen.findByText("The checks are complete"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Checked the dependencies")).toBeVisible();
  expect(screen.getByText("Checked the boundaries")).toBeVisible();
  await expect(findWorkHistoryToggle("expanded")).resolves.toHaveFocus();
});

test("Keep a card-only output in the collapsed history preview", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "action-preview-input",
        runId: RUN_ID,
        seqId: 1,
        text: "Review the available plans",
      }),
      assistantEvent({
        id: "action-preview-card",
        runId: RUN_ID,
        seqId: 2,
        text: "[Compare plans](/?settings=billing&billingView=plans)",
      }),
      assistantEvent({
        id: "action-preview-result",
        runId: RUN_ID,
        seqId: 3,
        text: "The comparison is ready",
      }),
      completedEvent({
        id: "action-preview-complete",
        runId: RUN_ID,
        seqId: 4,
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
    document.querySelector("[data-chat-run-work-preview]"),
  ).toHaveTextContent("Message");
  expect(screen.queryByTestId("plan-upgrade-card")).toBeNull();

  click(await findButton("Message"));

  await expect(screen.findByTestId("plan-upgrade-card")).resolves.toBeVisible();
});

test.each(["completed", "failed", "cancelled"] as const)(
  "Keep Markdown and media previews after a run is %s",
  async (status) => {
    const terminal =
      status === "completed"
        ? completedEvent({ id: "preview-terminal", runId: RUN_ID, seqId: 6 })
        : status === "cancelled"
          ? cancelledEvent({ id: "preview-terminal", runId: RUN_ID, seqId: 6 })
          : {
              id: "preview-terminal",
              eventType: "run.failed" as const,
              runId: RUN_ID,
              seqId: 6,
              content: null,
              error: "The request failed",
              createdAt: "2026-08-01T10:00:06.000Z",
            };
    installRunChat({
      chatEvents: [
        promptEvent({
          id: "rich-preview-input",
          runId: RUN_ID,
          seqId: 1,
          text: "Prepare the report",
        }),
        ...[
          "## Review\n\nChecked **dependencies** and `tests`.",
          "![Dependency chart](https://example.com/dependencies.png)",
          "![report.pdf](https://cdn.vm7.io/artifacts/history-preview/report/report.pdf)",
          "The review is ready",
        ].map((text, index) => {
          return assistantEvent({
            id: `rich-preview-${index}`,
            runId: RUN_ID,
            seqId: index + 2,
            text,
          });
        }),
        terminal,
      ],
    });
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
    });
    await readyChat();

    expect(
      Array.from(document.querySelectorAll("[data-chat-run-work-preview]")).map(
        (element) => {
          return element.textContent;
        },
      ),
    ).toStrictEqual([
      "Review Checked dependencies and tests.",
      "Dependency chart",
      "report.pdf",
    ]);
    expect(screen.queryByAltText("Dependency chart")).toBeNull();
    expect(screen.getByText("The review is ready")).toBeVisible();

    click(await findButton("Dependency chart"));

    await expect(
      screen.findByAltText("Dependency chart"),
    ).resolves.toBeVisible();
    expect(
      document.querySelectorAll("[data-chat-run-work-preview]"),
    ).toHaveLength(2);
    expect(
      document.querySelectorAll("[data-chat-run-work-message-expanded]"),
    ).toHaveLength(1);
  },
);
