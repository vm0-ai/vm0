import type { ChatEventUsagePayload } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

function usageButton(total: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === `Credit usage ${total}`;
  });
  if (!button) {
    throw new Error(`Credit usage ${total} button not found`);
  }
  return button;
}

function setupUsageChat(
  threadId: string,
  runId: string,
  usage: ChatEventUsagePayload,
): Promise<void> {
  mockChatLifecycle(context, {
    threadId,
    chatEvents: [
      {
        id: `${runId}-user`,
        role: "user",
        content: "Show this run's credit usage",
        runId,
        createdAt: "2026-08-14T12:00:00.000Z",
      },
      {
        id: `${runId}-assistant`,
        role: "assistant",
        content: "The usage summary is ready.",
        runId,
        createdAt: "2026-08-14T12:00:01.000Z",
      },
      {
        id: `${runId}-usage`,
        role: "assistant",
        content: null,
        runId,
        usage,
        createdAt: "2026-08-14T12:00:02.000Z",
      },
    ],
  });
  return setupPage({
    context,
    path: `/chats/${threadId}`,
    locale: "en-US",
  });
}

async function openUsage(total: string): Promise<void> {
  await waitFor(() => {
    expect(usageButton(total)).toBeInTheDocument();
  });
  click(usageButton(total));
  await screen.findByText("Credit usage");
}

test("Credit usage labels image recognition consistently", async () => {
  await setupUsageChat(
    "b0000000-0000-4000-a000-000000000801",
    "run-credit-image-recognition",
    {
      version: 1,
      totalCredits: 22,
      settledAt: "2026-08-14T12:00:02.000Z",
      breakdown: [
        {
          kind: "image-recognition",
          credits: 10,
          providers: [{ provider: "acme/vision-pro", credits: 10 }],
        },
        {
          kind: "model/google/gemini-3.5-flash/tokens.input",
          credits: 12,
          providers: [{ provider: "google/gemini-3.5-flash", credits: 12 }],
        },
      ],
    },
  );

  await openUsage("22");

  expect(screen.getAllByText("Image Recognize")).toHaveLength(2);
});

test("Credit usage shows friendly chat model names", async () => {
  await setupUsageChat(
    "b0000000-0000-4000-a000-000000000802",
    "run-credit-friendly-model",
    {
      version: 1,
      totalCredits: 30,
      settledAt: "2026-08-14T12:00:02.000Z",
      breakdown: [
        {
          kind: "model/gpt-5.6-sol/tokens.output",
          credits: 30,
          providers: [{ provider: "openai", credits: 30 }],
        },
      ],
    },
  );

  await openUsage("30");

  expect(screen.getByText("GPT 5.6 Sol")).toBeInTheDocument();
  expect(screen.queryByText("gpt-5.6-sol")).not.toBeInTheDocument();
});

test("Credit usage preserves unknown historical model identifiers", async () => {
  await setupUsageChat(
    "b0000000-0000-4000-a000-000000000803",
    "run-credit-historical-model",
    {
      version: 1,
      totalCredits: 40,
      settledAt: "2026-08-14T12:00:02.000Z",
      breakdown: [
        {
          kind: "model/acme/vision-pro/tokens.output",
          credits: 40,
          providers: [{ provider: "acme", credits: 40 }],
        },
      ],
    },
  );

  await openUsage("40");

  expect(screen.getByText("acme/vision-pro")).toBeInTheDocument();
  expect(screen.queryByText("Acme Vision Pro")).not.toBeInTheDocument();
});

test("Credit usage formats unknown image-provider names for people to read", async () => {
  await setupUsageChat(
    "b0000000-0000-4000-a000-000000000804",
    "run-credit-image-provider",
    {
      version: 1,
      totalCredits: 50,
      settledAt: "2026-08-14T12:00:02.000Z",
      breakdown: [
        {
          kind: "image/acme/vision-pro/output_images",
          credits: 50,
          providers: [{ provider: "acme", credits: 50 }],
        },
      ],
    },
  );

  await openUsage("50");

  expect(screen.getByText("Acme Vision Pro")).toBeInTheDocument();
  expect(screen.queryByText("acme/vision/pro")).not.toBeInTheDocument();
});
