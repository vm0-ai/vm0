import { fireEvent, screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatScrollContainer,
  makeRunGroupMessages,
} from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000904";

function setupHistory(events: readonly MockChatEventInput[]): Promise<void> {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Automation history",
    chatEvents: [...events],
  });
  return setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.vm0.ai",
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: false },
  });
}

function manualRun(
  id: string,
  prompt: string,
  response: string,
  minute: number,
): MockChatEventInput[] {
  return [
    {
      id: `${id}-user`,
      role: "user",
      content: prompt,
      runId: `${id}-run`,
      createdAt: `2026-08-01T12:${minute.toString().padStart(2, "0")}:00.000Z`,
    },
    {
      id: `${id}-assistant`,
      role: "assistant",
      content: response,
      runId: `${id}-run`,
      createdAt: `2026-08-01T12:${minute.toString().padStart(2, "0")}:30.000Z`,
    },
  ];
}

function runGroupFolds(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-chat-run-group-fold]"),
  );
}

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function usageEvent({
  id,
  runId,
  runGroupId,
  credits,
  settledAt,
}: {
  readonly id: string;
  readonly runId: string;
  readonly runGroupId: string;
  readonly credits: number;
  readonly settledAt: string;
}): MockChatEventInput {
  return {
    id,
    eventType: "usage.recorded",
    role: "assistant",
    content: null,
    runId,
    runGroupId,
    usage: {
      version: 1,
      totalCredits: credits,
      settledAt,
      breakdown: [
        {
          kind: "connector",
          credits,
          providers: [{ provider: "github", credits }],
        },
      ],
    },
    createdAt: "2026-08-01T12:30:00.000Z",
  };
}

test("Earlier runs in one automation group are folded", async () => {
  await setupHistory(
    makeRunGroupMessages({
      label: "Daily sync",
      count: 3,
      runGroupId: "daily-sync-group",
      startMinute: 0,
    }),
  );

  await screen.findByText("Daily sync reply 3");
  await waitFor(() => {
    expect(runGroupFolds()).toHaveLength(1);
  });
  const foldButton = buttonByLabel("Expand grouped run history");
  expect(foldButton).toHaveAttribute("aria-expanded", "false");
  expect(foldButton).toHaveTextContent("2 runs for Daily sync");
  expect(screen.queryByText("Daily sync reply 1")).toBeNull();
  expect(screen.queryByText("Daily sync reply 2")).toBeNull();

  click(foldButton);

  await waitFor(() => {
    expect(screen.getByText("Daily sync reply 1")).toBeInTheDocument();
    expect(screen.getByText("Daily sync reply 2")).toBeInTheDocument();
    expect(buttonByLabel("Collapse grouped run history")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

test("A folded group counts as one visible history item", async () => {
  const older = Array.from({ length: 6 }, (_, index) => {
    const item = index + 1;
    return manualRun(
      `older-${item}`,
      `Older prompt ${item}`,
      `Older reply ${item}`,
      index * 2,
    );
  }).flat();
  const grouped = makeRunGroupMessages({
    label: "Catalog refresh",
    count: 6,
    runGroupId: "catalog-refresh-group",
    startMinute: 15,
  });
  const recent = Array.from({ length: 4 }, (_, index) => {
    const item = index + 1;
    return manualRun(
      `recent-${item}`,
      `Recent prompt ${item}`,
      `Recent reply ${item}`,
      30 + index * 2,
    );
  }).flat();
  await setupHistory([...older, ...grouped, ...recent]);

  await screen.findByText("Recent reply 4");
  await waitFor(() => {
    expect(screen.getByText("Older reply 6")).toBeInTheDocument();
    expect(runGroupFolds()).toHaveLength(1);
  });
  expect(screen.getByText("Catalog refresh reply 6")).toBeInTheDocument();
  expect(screen.queryByText("Older reply 1")).toBeNull();

  const scrollContainer = chatScrollContainer();
  scrollContainer.scrollTop = 0;
  fireEvent.scroll(scrollContainer);

  await waitFor(() => {
    expect(screen.getByText("Older reply 1")).toBeInTheDocument();
  });
  expect(screen.queryByText("Older prompt 1")).toBeNull();
  expect(screen.getByText("Catalog refresh reply 6")).toBeInTheDocument();
});

test("Folded runs show complete current usage", async () => {
  const runGroupId = "github-settlement-group";
  const messages = makeRunGroupMessages({
    label: "GitHub settlement",
    count: 3,
    runGroupId,
    startMinute: 0,
  });
  await setupHistory([
    ...messages,
    usageEvent({
      id: "usage-run-1",
      runId: `${runGroupId}-run-1`,
      runGroupId,
      credits: 100,
      settledAt: "2026-08-01T12:10:00.000Z",
    }),
    usageEvent({
      id: "usage-run-2",
      runId: `${runGroupId}-run-2`,
      runGroupId,
      credits: 200,
      settledAt: "2026-08-01T12:11:00.000Z",
    }),
    usageEvent({
      id: "usage-run-3-current",
      runId: `${runGroupId}-run-3`,
      runGroupId,
      credits: 300,
      settledAt: "2026-08-01T12:12:00.000Z",
    }),
    usageEvent({
      id: "usage-run-3-stale",
      runId: `${runGroupId}-run-3`,
      runGroupId,
      credits: 900,
      settledAt: "2026-08-01T12:09:00.000Z",
    }),
  ]);

  await screen.findByText("GitHub settlement reply 3");
  await waitFor(() => {
    expect(
      queryAllByRoleFast("button").filter((button) => {
        return button.getAttribute("aria-label") === "Credit usage 600";
      }),
    ).toHaveLength(1);
  });
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label") === "Credit usage 1,200";
    }),
  ).toBeFalsy();
});

test("Interleaved automation groups fold separately", async () => {
  await setupHistory([
    ...makeRunGroupMessages({
      label: "Group A first section",
      count: 2,
      runGroupId: "group-a",
      startMinute: 0,
    }),
    ...makeRunGroupMessages({
      label: "Group B section",
      count: 2,
      runGroupId: "group-b",
      startMinute: 10,
    }),
    ...makeRunGroupMessages({
      label: "Group A final section",
      count: 2,
      runGroupId: "group-a",
      startMinute: 20,
    }).map((event) => {
      return {
        ...event,
        runId: event.runId ? `${event.runId}-final-section` : undefined,
      };
    }),
  ]);

  await screen.findByText("Group A final section reply 2");
  await waitFor(() => {
    expect(runGroupFolds()).toHaveLength(3);
  });
  expect(screen.getByText("Group A first section reply 2")).toBeInTheDocument();
  expect(screen.getByText("Group B section reply 2")).toBeInTheDocument();
  expect(screen.getByText("Group A final section reply 2")).toBeInTheDocument();
  expect(screen.queryByText("Group A first section reply 1")).toBeNull();
  expect(screen.queryByText("Group B section reply 1")).toBeNull();
  expect(screen.queryByText("Group A final section reply 1")).toBeNull();
});

test("An ordinary message breaks automation-run folding", async () => {
  await setupHistory([
    ...makeRunGroupMessages({
      label: "Grouped run before manual input",
      count: 1,
      runGroupId: "shared-group",
      startMinute: 0,
    }),
    ...manualRun(
      "manual-boundary",
      "Please pause the automation",
      "The automation is paused",
      5,
    ),
    ...makeRunGroupMessages({
      label: "Grouped run after manual input",
      count: 1,
      runGroupId: "shared-group",
      startMinute: 10,
    }),
  ]);

  await screen.findByText("Grouped run after manual input reply 1");
  expect(
    screen.getByText("Grouped run before manual input reply 1"),
  ).toBeInTheDocument();
  expect(screen.getByText("Please pause the automation")).toBeInTheDocument();
  expect(screen.getByText("The automation is paused")).toBeInTheDocument();
  expect(runGroupFolds()).toHaveLength(0);
});
