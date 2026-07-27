import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";
interface SidebarThread {
  readonly id: string;
  readonly title: string | null;
  readonly agent: { readonly id: string; readonly avatarUrl: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string | null;
  readonly renamedAt?: string | null;
}

const restoreNavigator = vi.hoisted(() => {
  const macUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  const maxTouchPoints = Object.getOwnPropertyDescriptor(
    navigator,
    "maxTouchPoints",
  );
  const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
  const userAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");

  function restoreProperty(
    property: "maxTouchPoints" | "platform" | "userAgent",
    descriptor: PropertyDescriptor | undefined,
  ): void {
    if (descriptor) {
      Object.defineProperty(navigator, property, descriptor);
    } else {
      delete (navigator as Partial<Record<typeof property, unknown>>)[property];
    }
  }

  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: macUserAgent,
  });
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: 0,
  });

  return () => {
    restoreProperty("userAgent", userAgent);
    restoreProperty("platform", platform);
    restoreProperty("maxTouchPoints", maxTouchPoints);
  };
});

function prepareDefaultAgent(): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

function createThread(id: string, title: string): SidebarThread {
  return {
    id,
    title,
    agent: { id: AGENT_ID, avatarUrl: null },
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    pinnedAt: null,
  };
}

function mockSidebarThreadStory(threads: readonly SidebarThread[]): void {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threads.map((thread, index) => {
        return {
          id: thread.id,
          agentId: thread.agent.id,
          title: thread.title,
          sortAt: new Date(
            Date.parse("2026-03-10T00:00:00Z") +
              (threads.length - index) * 1000,
          ).toISOString(),
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          pinnedAt: thread.pinnedAt ?? null,
          renamedAt: thread.renamedAt ?? null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        };
      }),
      latestEventId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
    return respond(200, { threadIds: [] });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
    });
  });
}

afterAll(() => {
  restoreNavigator();
  vi.resetModules();
});

describe("zero sidebar mac shortcuts", () => {
  it("toggles the sidebar with cmd+b while the chat composer is focused", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([createThread(THREAD_ID, "Release plan")]);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const composer = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => {
      expect(screen.getByLabelText("Collapse sidebar")).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand sidebar")).not.toBeInTheDocument();
    });

    composer.focus();
    expect(composer).toHaveFocus();
    fireEvent.keyDown(composer, {
      key: "b",
      code: "KeyB",
      keyCode: 66,
      metaKey: true,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Expand sidebar")).toBeInTheDocument();
    });
  });

  it("copies the current URL with cmd+l in standalone PWA mode", async () => {
    context.mocks.browser.standaloneDisplayMode(true);
    const clipboard = context.mocks.browser.clipboardWriteText();
    prepareDefaultAgent();
    mockSidebarThreadStory([createThread(THREAD_ID, "Release plan")]);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const composer = await screen.findByRole("textbox", { name: "Message" });
    composer.focus();
    const event = new KeyboardEvent("keydown", {
      key: "l",
      code: "KeyL",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(event);
    expect(event.defaultPrevented).toBeTruthy();

    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([window.location.href]);
    });
  });

  it("leaves cmd+l to the browser outside standalone PWA mode", async () => {
    context.mocks.browser.standaloneDisplayMode(false);
    const clipboard = context.mocks.browser.clipboardWriteText();
    prepareDefaultAgent();
    mockSidebarThreadStory([createThread(THREAD_ID, "Release plan")]);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const composer = await screen.findByRole("textbox", { name: "Message" });
    composer.focus();
    const event = new KeyboardEvent("keydown", {
      key: "l",
      code: "KeyL",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(event);
    expect(event.defaultPrevented).toBeFalsy();

    expect(clipboard.writes).toStrictEqual([]);
  });
});
