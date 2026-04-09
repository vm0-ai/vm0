import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockAPIs() {
  let threadCounter = 0;
  let createCount = 0;
  const threads: {
    id: string;
    title: string | null;
    agentId: string;
    createdAt: string;
    updatedAt: string;
  }[] = [];

  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads });
    }),
    http.get("*/api/zero/chat-threads/:id", ({ params }) => {
      const thread = threads.find((t) => {
        return t.id === params.id;
      });
      return HttpResponse.json({
        id: params.id,
        title: thread?.title ?? null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        unsavedRuns: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.post("*/api/zero/chat-threads", async ({ request }) => {
      const body = (await request.json()) as {
        agentId: string;
        title?: string;
      };
      threadCounter++;
      createCount++;
      const now = new Date().toISOString();
      const newThread = {
        id: `new-thread-${threadCounter}`,
        title: body.title ?? null,
        agentId: body.agentId,
        createdAt: now,
        updatedAt: now,
      };
      threads.unshift(newThread);
      return HttpResponse.json(
        {
          id: newThread.id,
          title: newThread.title,
          createdAt: newThread.createdAt,
        },
        { status: 201 },
      );
    }),
  );

  return {
    getCreateCount: () => {
      return createCount;
    },
    getThreads: () => {
      return threads;
    },
  };
}

async function openConversationAndSelectZero(
  user: ReturnType<typeof userEvent.setup>,
) {
  const openBtn = await waitFor(() => {
    return screen.getByLabelText("Open a conversation");
  });
  await user.click(openBtn);

  // Wait for dialog to appear
  const agentBtn = await waitFor(() => {
    return screen.getByText("Your lead assistant, always here for you");
  });
  // Click the parent button (the text is inside a button)
  await user.click(agentBtn.closest("button")!);
}

describe("sidebar duplicate new chat (#7368)", () => {
  it("should reuse existing empty chat when selecting the same agent via 'Open a conversation' multiple times", async () => {
    const user = userEvent.setup();
    const { getCreateCount, getThreads } = mockAPIs();

    detachedSetupPage({ context, path: "/agents" });

    // --- First: click "Open a conversation" and select Zero ---
    await openConversationAndSelectZero(user);

    // Wait for thread creation and navigation
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-1");
    });
    expect(getCreateCount()).toBe(1);

    // --- Second: click "Open a conversation" again and select Zero ---
    await openConversationAndSelectZero(user);

    // Should reuse the existing empty thread instead of creating a new one
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-1");
    });
    expect(getCreateCount()).toBe(1);
    expect(getThreads()).toHaveLength(1);
  });
});
