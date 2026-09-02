import { screen, waitFor, within } from "@testing-library/react";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const PROMPT_EVENT_ID = "b0000000-0000-4000-a000-000000000802";
const ANSWER_EVENT_ID = "b0000000-0000-4000-a000-000000000803";
const SHARED_THREAD_ID = "b0000000-0000-4000-a000-000000000804";
const GROUPED_ANSWER_EVENT_IDS = [
  "b0000000-0000-4000-a000-000000000811",
  "b0000000-0000-4000-a000-000000000812",
  "b0000000-0000-4000-a000-000000000813",
] as const;
const GROUPED_RUN_ID = "grouped-launch-run";
const PROMPT = "Summarize the launch plan";
const ANSWER = "The launch plan has three phases.";

function mockConversation(chatEvents = standardConversation()): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Launch planning",
    chatEvents,
  });
}

function standardConversation() {
  return [
    {
      id: PROMPT_EVENT_ID,
      role: "user" as const,
      content: PROMPT,
      runId: "launch-run",
      createdAt: "2026-08-01T10:00:00Z",
    },
    {
      id: ANSWER_EVENT_ID,
      role: "assistant" as const,
      content: ANSWER,
      runId: "launch-run",
      createdAt: "2026-08-01T10:00:01Z",
    },
  ];
}

function buttonsNamed(name: string): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return (
      button.getAttribute("aria-label") === name ||
      button.textContent?.trim() === name
    );
  });
}

function requiredButtonNamed(name: string): HTMLElement {
  const button = buttonsNamed(name)[0];
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function selectableGroupForText(text: string): HTMLElement {
  const group = screen
    .getByText(text)
    .closest<HTMLElement>("[data-chat-share-selectable-group]");
  if (!group) {
    throw new Error(`Selectable message group not found: ${text}`);
  }
  return group;
}

test("Share selected message groups as a public conversation snapshot", async () => {
  const createRequests: string[][] = [];
  mockConversation();
  context.mocks.api(sharedThreadsContract.create, ({ body, respond }) => {
    createRequests.push([...body.eventIds]);
    return respond(201, { id: SHARED_THREAD_ID });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.vm0.ai",
    featureSwitches: { [FeatureSwitchKey.SharedThreadSharing]: true },
  });

  await screen.findByText(PROMPT);
  await waitFor(() => {
    expect(buttonsNamed("Share messages").length).toBeGreaterThan(0);
  });

  click(requiredButtonNamed("Share messages"));

  await waitFor(() => {
    expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);
  });
  const promptGroup = selectableGroupForText(PROMPT);
  const answerGroup = selectableGroupForText(ANSWER);
  const promptSelection = within(promptGroup).getByRole("checkbox", {
    name: "Select message group",
  });

  click(screen.getByText(PROMPT));
  await waitFor(() => {
    expect(promptSelection).toBeChecked();
    expect(promptSelection).toHaveAccessibleName("Deselect message group");
  });

  click(screen.getByText(PROMPT));
  await waitFor(() => {
    expect(promptSelection).not.toBeChecked();
    expect(promptSelection).toHaveAccessibleName("Select message group");
  });

  click(screen.getByText(PROMPT));
  click(screen.getByText(ANSWER));
  await waitFor(() => {
    expect(screen.getAllByText("2 selected").length).toBeGreaterThan(0);
    expect(requiredButtonNamed("Share")).toBeEnabled();
  });

  click(requiredButtonNamed("Share"));

  await waitFor(() => {
    expect(createRequests).toStrictEqual([[PROMPT_EVENT_ID, ANSWER_EVENT_ID]]);
  });
  const shareLink = await screen.findByRole("textbox", {
    name: "Shared conversation link",
  });
  expect(shareLink).toHaveValue(
    `https://app.vm0.ai/share/threads/${SHARED_THREAD_ID}`,
  );
  expect(within(answerGroup).getByRole("checkbox")).toBeChecked();
});

test("Sharing controls are hidden when conversation sharing is unavailable", async () => {
  mockConversation();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.vm0.ai",
    featureSwitches: { [FeatureSwitchKey.SharedThreadSharing]: false },
  });

  await screen.findByText(PROMPT);
  expect(screen.getByText(ANSWER)).toBeVisible();
  expect(buttonsNamed("Share messages")).toHaveLength(0);
});

test("A multi-message answer counts as one shared selection", async () => {
  const createRequests: string[][] = [];
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Grouped launch answer",
    chatEvents: [
      {
        id: PROMPT_EVENT_ID,
        role: "user",
        content: PROMPT,
        runId: GROUPED_RUN_ID,
        createdAt: "2026-08-01T10:00:00Z",
      },
      ...GROUPED_ANSWER_EVENT_IDS.map((id, index) => {
        return {
          id,
          role: "assistant" as const,
          content: `Launch answer ${String(index + 1)}`,
          runId: GROUPED_RUN_ID,
          createdAt: `2026-08-01T10:00:0${String(index + 1)}Z`,
        };
      }),
    ],
    activeRunIds: [GROUPED_RUN_ID],
  });
  context.mocks.api(sharedThreadsContract.create, ({ body, respond }) => {
    createRequests.push([...body.eventIds]);
    return respond(201, { id: SHARED_THREAD_ID });
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.vm0.ai",
    featureSwitches: { [FeatureSwitchKey.SharedThreadSharing]: true },
  });

  await screen.findByText("Launch answer 3");
  await waitFor(() => {
    expect(buttonsNamed("Share messages").length).toBeGreaterThan(0);
  });
  click(requiredButtonNamed("Share messages"));

  const answerGroup = selectableGroupForText("Launch answer 3");
  const answerSelection = within(answerGroup).getByRole("checkbox", {
    name: "Select message group",
  });
  click(answerSelection);

  await waitFor(() => {
    expect(screen.getAllByText("1 selected").length).toBeGreaterThan(0);
    expect(answerSelection).toBeChecked();
  });
  expect(
    document.querySelectorAll('[role="checkbox"][aria-checked="true"]'),
  ).toHaveLength(1);

  click(requiredButtonNamed("Share"));
  await screen.findByRole("textbox", { name: "Shared conversation link" });
  expect(createRequests).toStrictEqual([[...GROUPED_ANSWER_EVENT_IDS]]);
});

test("An oversized message group cannot be added to a shared snapshot", async () => {
  const oversizedBody = `Oversized message\n\n<!--${"界".repeat(524_289)}-->`;
  mockConversation([
    {
      id: PROMPT_EVENT_ID,
      role: "user",
      content: "A normal message remains available",
      runId: "oversized-run",
      createdAt: "2026-08-01T10:00:00Z",
    },
    {
      id: ANSWER_EVENT_ID,
      role: "assistant",
      content: oversizedBody,
      runId: "oversized-run",
      createdAt: "2026-08-01T10:00:01Z",
    },
  ]);
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.vm0.ai",
    featureSwitches: { [FeatureSwitchKey.SharedThreadSharing]: true },
  });

  await screen.findByText("A normal message remains available");
  await waitFor(() => {
    expect(buttonsNamed("Share messages").length).toBeGreaterThan(0);
  });
  click(requiredButtonNamed("Share messages"));

  await screen.findByText("Oversized message");
  const oversizedGroup = selectableGroupForText("Oversized message");
  const oversizedSelection = within(oversizedGroup).getByRole("checkbox", {
    name: "Select message group",
  });

  click(screen.getByText("Oversized message"));

  await screen.findByText("Select fewer messages to share");
  expect(oversizedSelection).not.toBeChecked();
  expect(screen.getByText("A normal message remains available")).toBeVisible();
});
