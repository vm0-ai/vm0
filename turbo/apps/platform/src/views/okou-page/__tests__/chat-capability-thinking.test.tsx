import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  assistantEvent,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  thinkingEvent,
} from "./chat-run-test-fixtures.ts";
import {
  context,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

const ACTIVE_RUN_ID = "d0000000-0000-4000-a000-000000000841";
const ACTIVE_THINKING_TEXT = "Checking the current release evidence";

function activeRunEvents(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "thinking-capability-prompt",
      runId: ACTIVE_RUN_ID,
      seqId: 1,
      text: "Prepare the current answer",
    }),
  ];
}

function activeThinkingEvents(): MockChatEventInput[] {
  return [
    ...activeRunEvents(),
    thinkingEvent({
      id: "thinking-loader-progress",
      runId: ACTIVE_RUN_ID,
      seqId: 2,
      text: ACTIVE_THINKING_TEXT,
    }),
  ];
}

async function visibleThinkingLoader(): Promise<HTMLElement> {
  const label = await screen.findByLabelText(ACTIVE_THINKING_TEXT);
  const indicator = label.closest("[data-thinking-indicator]");
  if (!(indicator instanceof HTMLElement)) {
    throw new Error("Expected the active thinking indicator");
  }
  const loader = indicator.querySelector("[data-thinking-loader]");
  if (!(loader instanceof HTMLElement)) {
    throw new Error("Expected the active thinking loader");
  }
  return loader;
}

test("Keep the block loader when the thinking spinner is disabled", async () => {
  installRunChat({
    chatEvents: activeThinkingEvents(),
    activeRunIds: [ACTIVE_RUN_ID],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatThinkingSpinner]: false },
  });

  await readyChat();
  await expect(visibleThinkingLoader()).resolves.toHaveAttribute(
    "data-thinking-loader",
    "blocks",
  );
});

test("Show the Okou spinner when the thinking spinner is enabled", async () => {
  installRunChat({
    chatEvents: activeThinkingEvents(),
    activeRunIds: [ACTIVE_RUN_ID],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatThinkingSpinner]: true },
  });

  await readyChat();
  await expect(visibleThinkingLoader()).resolves.toHaveAttribute(
    "data-thinking-loader",
    "spinner",
  );
});

test("Keep current thinking progress aligned with the active run", async () => {
  const events = activeRunEvents();
  installRunChat({ chatEvents: events, activeRunIds: [ACTIVE_RUN_ID] });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  events.push(
    thinkingEvent({
      id: "thinking-capability-current",
      runId: ACTIVE_RUN_ID,
      seqId: 2,
      text: "Checking the current release evidence",
    }),
  );
  publishRunUpdate();

  const currentProgress = await screen.findByLabelText(
    "Checking the current release evidence",
  );
  expect(currentProgress).toBeVisible();

  events.push(
    assistantEvent({
      id: "thinking-capability-answer",
      runId: ACTIVE_RUN_ID,
      seqId: 3,
      text: "The current release evidence is complete.",
    }),
  );
  publishRunUpdate();

  const answer = await screen.findByText(
    "The current release evidence is complete.",
  );
  expect(answer).toBeVisible();
  await waitFor(() => {
    expect(
      screen.queryByLabelText("Checking the current release evidence"),
    ).not.toBeInTheDocument();
  });
});

test("Keep long and multi-line thinking progress readable", async () => {
  const events = activeRunEvents();
  const originalBoundingClientRect =
    HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function getThinkingLabelRect(this: HTMLElement): DOMRect {
      if (this.classList.contains("zero-shimmer-text")) {
        return {
          bottom: 20,
          height: 20,
          left: 0,
          right: 112,
          top: 0,
          width: 112,
          x: 0,
          y: 0,
          toJSON: () => {
            return {};
          },
        };
      }
      return originalBoundingClientRect.call(this);
    },
  );
  installRunChat({ chatEvents: events, activeRunIds: [ACTIVE_RUN_ID] });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const longProgress =
    "Reviewing every release dependency before composing the final answer";
  events.push(
    thinkingEvent({
      id: "thinking-capability-long",
      runId: ACTIVE_RUN_ID,
      seqId: 2,
      text: longProgress,
    }),
  );
  publishRunUpdate();

  const longIndicator = await screen.findByLabelText(longProgress);
  await waitFor(() => {
    expect(longIndicator.textContent).toMatch(/…$/u);
    expect(longIndicator).not.toHaveTextContent(longProgress);
  });

  const progressLines = [
    "Checking inputs",
    "Comparing results",
    "Writing the answer",
  ] as const;
  const multiLineProgress = progressLines.join("\n");
  events.push(
    thinkingEvent({
      id: "thinking-capability-multi-line",
      runId: ACTIVE_RUN_ID,
      seqId: 3,
      text: multiLineProgress,
    }),
  );
  publishRunUpdate();

  const multiLineIndicator = await screen.findByLabelText(
    /Checking inputs\s+Comparing results\s+Writing the answer/u,
  );
  expect(multiLineIndicator).toBeVisible();
  expect(
    multiLineIndicator.getAttribute("aria-label")?.split("\n"),
  ).toStrictEqual(progressLines);
});
