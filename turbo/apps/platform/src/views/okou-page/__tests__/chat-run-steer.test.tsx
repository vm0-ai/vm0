import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { mockNow } from "../../../__tests__/time.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  expectTextOrder,
  findLink,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000301";
const RUN_B = "a0000000-0000-4000-a000-000000000302";
const RESULT = "The API review is in progress.";
const STEER = "Focus on the authentication boundary first";
const NEXT_RESULT = "The authentication boundary review is ready.";

function createdAt(second: number): string {
  return `2026-08-01T10:00:${String(second).padStart(2, "0")}.000Z`;
}

function resultEvents(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "initial-request",
      runId: RUN_A,
      seqId: 1,
      text: "Review the API",
      createdAt: createdAt(0),
    }),
    assistantEvent({
      id: "review-artifact",
      runId: RUN_A,
      seqId: 2,
      text: "https://cdn.vm7.io/artifacts/steer/review/report.pdf",
      createdAt: createdAt(1),
    }),
    assistantEvent({
      id: "initial-result",
      runId: RUN_A,
      seqId: 3,
      text: RESULT,
      createdAt: createdAt(2),
    }),
  ];
}

function pendingSteer(): MockChatEventInput {
  return promptEvent({
    id: "pending-steer",
    seqId: 4,
    text: STEER,
    createdAt: createdAt(12),
  });
}

function deliveredSteer(): MockChatEventInput {
  return {
    ...promptEvent({
      id: "delivered-steer",
      runId: RUN_A,
      seqId: 5,
      text: STEER,
      createdAt: createdAt(15),
    }),
    revokesEventId: "pending-steer",
  };
}

async function openChat(second: number): Promise<void> {
  mockNow(new Date(createdAt(second)), context.signal);
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });
  await readyChat();
}

function mainResult(text: string): HTMLElement {
  const main = screen
    .getByText(text)
    .closest<HTMLElement>("[data-chat-run-work-main]");
  if (!main) {
    throw new Error(`Expected a main result for ${text}`);
  }
  return main;
}

function assistantGroup(text: string): HTMLElement {
  const group = mainResult(text).closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  if (!group) {
    throw new Error(`Expected an assistant response for ${text}`);
  }
  return group;
}

function workSummary(text = RESULT): Element | null {
  return assistantGroup(text).querySelector("[data-chat-run-work]");
}

async function expectRetainedResult(): Promise<void> {
  const main = mainResult(RESULT);
  expect(main).toBeVisible();
  expect(main).toContainElement(
    await findLink("Open pdf preview for report.pdf"),
  );
  expect(queryButton("Copy message", main)).toBeVisible();
}

function expectWaitingAfter(text: string): void {
  const waiting = document.querySelector("[data-thinking-indicator]");
  expect(waiting).toBeVisible();
  expect(document.querySelectorAll("[data-thinking-indicator]")).toHaveLength(
    1,
  );
  expect(
    screen.getByText(text).compareDocumentPosition(waiting!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

test("Freeze the previous work when a steer is sent, before the send request returns", async () => {
  const appendGate = context.mocks.deferred<void>();
  const appendStarted = context.mocks.deferred<void>();
  installRunChat({
    chatEvents: resultEvents(),
    activeRunIds: [RUN_A],
    appendGate: appendGate.promise,
    onQueuedEventAppend: () => {
      appendStarted.resolve();
    },
  });
  await openChat(12);
  expect(workSummary()).toHaveTextContent("Working for");

  await sendText(STEER);
  await appendStarted.promise;

  await expect(screen.findByText(STEER)).resolves.toBeVisible();
  expectWaitingAfter(STEER);
  await expectRetainedResult();
  expect(workSummary()).toHaveTextContent("Worked for 12s");

  appendGate.resolve();
});

test.each([
  { state: "pending", deliveryEvents: [] },
  { state: "delivered", deliveryEvents: [deliveredSteer()] },
])(
  "Restore the original steer boundary from recorded $state input when opening a chat",
  async ({ deliveryEvents }) => {
    installRunChat({
      chatEvents: [...resultEvents(), pendingSteer(), ...deliveryEvents],
      activeRunIds: [RUN_A],
    });

    await openChat(20);

    expect(screen.getAllByText(STEER)).toHaveLength(1);
    expectWaitingAfter(STEER);
    await expectRetainedResult();
    expect(workSummary()).toHaveTextContent("Worked for 12s");
  },
);

test("Keep the work boundary and elapsed time stable through steer delivery and completion", async () => {
  const events = [...resultEvents(), pendingSteer()];
  const chat = installRunChat({ chatEvents: events, activeRunIds: [RUN_A] });
  await openChat(12);
  expect(screen.getByText(STEER)).toBeVisible();
  expectWaitingAfter(STEER);
  expect.soft(workSummary()).toHaveTextContent("Worked for 12s");

  mockNow(new Date(createdAt(20)), context.signal);
  events.push(
    deliveredSteer(),
    assistantEvent({
      id: "result-after-steer",
      runId: RUN_A,
      seqId: 6,
      text: NEXT_RESULT,
      createdAt: createdAt(18),
    }),
  );
  publishRunUpdate();

  await expect(screen.findByText(NEXT_RESULT)).resolves.toBeVisible();
  expect(screen.getAllByText(STEER)).toHaveLength(1);
  await expectRetainedResult();
  expect(queryButton("Copy message", mainResult(NEXT_RESULT))).toBeVisible();
  expectTextOrder(RESULT, STEER, NEXT_RESULT);
  expect.soft(workSummary()).toHaveTextContent("Worked for 12s");
  expect(workSummary(NEXT_RESULT)).toHaveTextContent("Working for");

  chat.completeRun();

  await waitFor(() => {
    expect(workSummary(NEXT_RESULT)).toHaveTextContent("Worked for");
  });
  expect.soft(workSummary()).toHaveTextContent("Worked for 12s");
  expect.soft(workSummary(NEXT_RESULT)).toHaveTextContent("Worked for 8s");
});

test("Keep separate history previews, artifacts and actions on both sides of a steer in the same run", async () => {
  const oldHistory = [
    "Started the API review",
    "Checked the dependency graph",
    "Checked the service boundaries",
    "Checked the request gateways",
  ];
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "history-request",
        runId: RUN_A,
        seqId: 1,
        text: "Review the API",
        createdAt: createdAt(0),
      }),
      assistantEvent({
        id: "history-artifact",
        runId: RUN_A,
        seqId: 2,
        text: "https://cdn.vm7.io/artifacts/steer/review/report.pdf",
        createdAt: createdAt(1),
      }),
      ...oldHistory.map((text, index) => {
        return assistantEvent({
          id: `history-${String(index)}`,
          runId: RUN_A,
          seqId: index + 3,
          text,
          createdAt: createdAt(index + 2),
        });
      }),
      assistantEvent({
        id: "history-result",
        runId: RUN_A,
        seqId: 7,
        text: RESULT,
        createdAt: createdAt(6),
      }),
      promptEvent({
        id: "history-steer",
        runId: RUN_A,
        seqId: 8,
        text: STEER,
        createdAt: createdAt(12),
      }),
      assistantEvent({
        id: "next-history",
        runId: RUN_A,
        seqId: 9,
        text: "Checked the token validation path",
        createdAt: createdAt(16),
      }),
      assistantEvent({
        id: "next-result",
        runId: RUN_A,
        seqId: 10,
        text: NEXT_RESULT,
        createdAt: createdAt(18),
      }),
    ],
    activeRunIds: [RUN_A],
  });

  await openChat(20);

  await expectRetainedResult();
  const previousGroup = assistantGroup(RESULT);
  const nextGroup = assistantGroup(NEXT_RESULT);
  expect(previousGroup).not.toBe(nextGroup);
  const oldPreviews = previousGroup.querySelectorAll(
    "[data-chat-run-work-preview]",
  );
  expect(oldPreviews).toHaveLength(3);
  for (const [index, text] of oldHistory.slice(-3).entries()) {
    expect(oldPreviews[index]).toHaveTextContent(text);
  }
  const newPreviews = nextGroup.querySelectorAll(
    "[data-chat-run-work-preview]",
  );
  expect(newPreviews).toHaveLength(1);
  expect(newPreviews[0]).toHaveTextContent("Checked the token validation path");
  expect(screen.queryByText("Started the API review")).toBeNull();
  expect(queryButton("Copy message", mainResult(NEXT_RESULT))).toBeVisible();
  expect(screen.getAllByTestId("chat-event-actions")).toHaveLength(2);
  expect(nextGroup).not.toContainElement(
    await findLink("Open pdf preview for report.pdf"),
  );
  expect(workSummary()).toHaveTextContent("Worked for");
  expect(workSummary(NEXT_RESULT)).toHaveTextContent("Working for");
  expectWaitingAfter(NEXT_RESULT);
  expectTextOrder(RESULT, STEER, NEXT_RESULT);
});

test.each([
  { state: "pending", runId: undefined },
  { state: "delivered", runId: RUN_A },
])(
  "Keep consecutive $state steers visible without empty work sections between them",
  async ({ runId }) => {
    const secondSteer = "Include the token refresh path as well";
    installRunChat({
      chatEvents: [
        ...resultEvents(),
        { ...pendingSteer(), runId },
        promptEvent({
          id: "second-steer",
          runId,
          seqId: 5,
          text: secondSteer,
          createdAt: createdAt(16),
        }),
      ],
      activeRunIds: [RUN_A],
    });

    await openChat(20);

    expect(screen.getAllByText(STEER)).toHaveLength(1);
    expect(screen.getAllByText(secondSteer)).toHaveLength(1);
    expectTextOrder(RESULT, STEER, secondSteer);
    await expectRetainedResult();
    expect(document.querySelectorAll("[data-chat-run-work-main]")).toHaveLength(
      1,
    );
    expect(document.querySelectorAll("[data-chat-run-work]")).toHaveLength(1);
    expect(screen.getAllByTestId("chat-event-actions")).toHaveLength(1);
    expectWaitingAfter(secondSteer);
  },
);

test("Wait after a steer before the first output without creating an empty previous result", async () => {
  const events = [
    promptEvent({
      id: "empty-request",
      runId: RUN_A,
      seqId: 1,
      text: "Review the API",
      createdAt: createdAt(0),
    }),
    pendingSteer(),
  ];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_A] });
  await openChat(12);

  expect(screen.getByText(STEER)).toBeVisible();
  expectWaitingAfter(STEER);
  expect(document.querySelector("[data-chat-run-work-main]")).toBeNull();
  expect(document.querySelector("[data-chat-run-work]")).toBeNull();
  expect(screen.queryByTestId("chat-event-actions")).toBeNull();

  events.push(
    deliveredSteer(),
    assistantEvent({
      id: "first-result-after-steer",
      runId: RUN_A,
      seqId: 6,
      text: NEXT_RESULT,
      createdAt: createdAt(20),
    }),
  );
  mockNow(new Date(createdAt(20)), context.signal);
  publishRunUpdate();

  await expect(screen.findByText(NEXT_RESULT)).resolves.toBeVisible();
  expectTextOrder("Review the API", STEER, NEXT_RESULT);
  expect(screen.getAllByText(STEER)).toHaveLength(1);
  expect(document.querySelectorAll("[data-chat-run-work-main]")).toHaveLength(
    1,
  );
  expect(document.querySelectorAll("[data-chat-run-work]")).toHaveLength(1);
  expect(queryButton("Copy message", mainResult(NEXT_RESULT))).toBeVisible();
});

test("Keep an already completed response's original duration when the next user message arrives", async () => {
  const events = [
    ...resultEvents(),
    completedEvent({
      id: "initial-completion",
      runId: RUN_A,
      seqId: 4,
      createdAt: createdAt(5),
    }),
  ];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_B] });
  await openChat(12);
  expect(workSummary()).toHaveTextContent("Worked for 5s");

  events.push(
    promptEvent({
      id: "next-request",
      runId: RUN_B,
      seqId: 5,
      text: STEER,
      createdAt: createdAt(12),
    }),
  );
  mockNow(new Date(createdAt(20)), context.signal);
  publishRunUpdate();

  await expect(screen.findByText(STEER)).resolves.toBeVisible();
  await waitFor(() => {
    expectWaitingAfter(STEER);
  });
  expect(workSummary()).toHaveTextContent("Worked for 5s");
  await expectRetainedResult();
});
