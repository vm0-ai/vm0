/**
 * Regression guards for scroll-flicker bugs introduced in b4ea355d and 1550e48c.
 *
 * b4ea355d — ChatThreadComposer now subscribes to skeletonVisible$, which means it
 *   re-renders when hideSkeleton$ fires in the same animationFrame as scrollToBottom$.
 *   Guard (CHAT-COMPOSER-SCROLL-001): scroll position and auto-scroll remain intact
 *   after the composer transitions from actionsLoading=true to actionsLoading=false.
 *
 * 1550e48c — The model picker lock condition changed from threadData.modelProviderId
 *   (stable after first resolve) to hasUserMessages (re-evaluated on every Ably
 *   message event). Every new message can now trigger a ChatThreadComposer re-render.
 *   Guard (CHAT-COMPOSER-SCROLL-002): scroll position and auto-scroll remain intact
 *   after the picker transitions from interactive to locked on the first user message.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/core/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createChatMessage } from "../../../mocks/mock-helpers.ts";
import { setMockOrgModelProviders } from "../../../mocks/handlers/api-org-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const PROVIDER_ID = "00000000-0000-4000-a000-000000000001";

// Attach a MutationObserver that gives the scroll container a non-zero
// scrollHeight as soon as it appears so scrollToBottom$ has a real value.
function interceptScrollContainer(scrollHeight: number): MutationObserver {
  const obs = new MutationObserver(() => {
    const el = document.querySelector<HTMLElement>("[data-scroll-container]");
    if (!el) {
      return;
    }
    Object.defineProperty(el, "scrollHeight", {
      get: () => scrollHeight,
      configurable: true,
    });
  });
  obs.observe(document.body, { childList: true, subtree: true });
  return obs;
}

// Capture the first ResizeObserver instantiated (the one created by
// createScrollSignals), replacing the global with a no-op mock. Call
// restore() in a finally block to reinstate the original.
function captureFirstResizeObserver(): {
  getCallback: () => ResizeObserverCallback | null;
  restore: () => void;
} {
  let captured: ResizeObserverCallback | null = null;
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class MockResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      if (captured === null) {
        captured = cb;
      }
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return {
    getCallback: () => captured,
    restore: () => {
      globalThis.ResizeObserver = original;
    },
  };
}

// ─── CHAT-COMPOSER-SCROLL-001 (b4ea355d regression) ─────────────────────────

// When messages finish loading, chat-page-setup fires scrollToBottom$ then
// hideSkeleton$ in the same animationFrame. hideSkeleton$ flips skeletonVisible$
// to false, which ChatThreadComposer subscribes to via actionsLoading. The
// subsequent React commit (Skeleton → real buttons) must not reset scrollTop or
// disable auto-scroll.
describe("chat scroll — skeleton hide does not disrupt scroll or auto-scroll (CHAT-COMPOSER-SCROLL-001)", () => {
  it("scrollTop stays at scrollHeight after skeleton hides and composer shows real buttons", async () => {
    const messagesDeferred = createDeferredPromise<void>(context.signal);

    server.use(
      mockApi(chatThreadMessagesContract.list, async ({ query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        await messagesDeferred.promise;
        return respond(200, {
          messages: [
            {
              id: "msg-1",
              role: "user" as const,
              content: "Hello",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              id: "msg-2",
              role: "assistant" as const,
              content: "World",
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-ccs-001",
          title: null,
          agentId: AGENT_ID,
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    const scrollObs = interceptScrollContainer(800);
    const { getCallback: getResizeCb, restore: restoreRO } =
      captureFirstResizeObserver();

    try {
      detachedSetupPage({ context, path: "/chats/thread-ccs-001" });

      // While messages are loading the skeleton overlay must be up and the
      // composer must be in actionsLoading=true state (Skeleton shown, no Send).
      await waitFor(() => {
        expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();
      });
      expect(screen.queryByLabelText("Send")).toBeNull();

      // Resolve messages — triggers: scrollToBottom$ then hideSkeleton$ (same frame).
      messagesDeferred.resolve();

      // Skeleton disappears (hideSkeleton$ fired, skeletonVisible$ → false).
      await waitFor(() => {
        expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
      });

      // Messages must now be visible.
      await waitFor(() => {
        expect(screen.getByText("Hello")).toBeInTheDocument();
      });

      const scrollContainer = document.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
      expect(scrollContainer).not.toBeNull();

      // scrollTop must equal scrollHeight after both scrollToBottom$ and the
      // subsequent composer re-render (Skeleton → real buttons) have committed.
      expect(scrollContainer!.scrollTop).toBe(800);

      // Composer must now render real buttons — actionsLoading is false.
      await waitFor(() => {
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
      });

      // Auto-scroll must still be enabled. Fire the ResizeObserver as if new
      // content appeared inside the scroll container (e.g. a streaming token)
      // and verify it snaps back to scrollHeight.
      const resizeCb = getResizeCb();
      expect(resizeCb).not.toBeNull();
      resizeCb!([], {} as ResizeObserver);
      expect(scrollContainer!.scrollTop).toBe(800);
    } finally {
      scrollObs.disconnect();
      restoreRO();
    }
  });
});

// ─── CHAT-COMPOSER-SCROLL-002 (1550e48c regression) ──────────────────────────

// hasUserMessages is re-evaluated every time groupedChatMessages$ resolves. When
// the first user message arrives via Ably, ChatThreadComposer re-renders and the
// model picker transitions from interactive (combobox) to locked (span). This
// re-render must not reset scrollTop or disable auto-scroll.
describe("chat scroll — Ably user-message event does not disrupt scroll or auto-scroll (CHAT-COMPOSER-SCROLL-002)", () => {
  beforeEach(() => {
    setMockFeatureSwitches({ [FeatureSwitchKey.ModelProviderSelection]: true });
    setMockOrgModelProviders([
      {
        id: PROVIDER_ID,
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: true,
        selectedModel: "claude-sonnet-4-6",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
  });

  it("scrollTop stays at scrollHeight and picker locks after first user message arrives via Ably (CHAT-COMPOSER-SCROLL-002)", async () => {
    let userMessageArrived = false;

    server.use(
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId) {
          if (userMessageArrived) {
            return respond(200, {
              messages: [
                {
                  id: "msg-user-1",
                  role: "user" as const,
                  content: "New user message",
                  createdAt: "2026-03-10T00:00:01Z",
                },
              ],
            });
          }
          return respond(200, { messages: [] });
        }
        // Initial load: assistant-only thread — hasUserMessages = false, picker interactive.
        return respond(200, {
          messages: [
            {
              id: "msg-0",
              role: "assistant" as const,
              content: "Welcome",
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-ccs-002",
          title: null,
          agentId: AGENT_ID,
          chatMessages: [],
          latestSessionId: null,
          latestSessionProviderType: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          modelProviderId: null,
          selectedModel: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    const scrollObs = interceptScrollContainer(900);
    const { getCallback: getResizeCb, restore: restoreRO } =
      captureFirstResizeObserver();

    try {
      detachedSetupPage({ context, path: "/chats/thread-ccs-002" });

      // Initial load: assistant message displayed, picker is interactive.
      await waitFor(() => {
        expect(screen.getByText("Welcome")).toBeInTheDocument();
      });

      const scrollContainer = document.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
      expect(scrollContainer).not.toBeNull();
      expect(scrollContainer!.scrollTop).toBe(900);

      // Picker must be interactive — no user messages yet (hasUserMessages = false).
      await waitFor(() => {
        expect(
          screen.getByRole("combobox", { name: /Claude Sonnet 4\.6/i }),
        ).toBeInTheDocument();
      });

      // Simulate a user message arriving via Ably. This fires
      // chatThreadMessageCreated:thread-ccs-002, which triggers loadPagedMessages$
      // to re-poll with sinceId. The mock now returns the new user message.
      userMessageArrived = true;
      createChatMessage("thread-ccs-002");

      // The new message must appear — groupedChatMessages$ has resolved with a
      // user message, so hasUserMessages = true.
      await waitFor(() => {
        expect(screen.getByText("New user message")).toBeInTheDocument();
      });

      // scrollTop must still be at bottom despite the composer re-render caused
      // by the hasUserMessages transition (false → true).
      expect(scrollContainer!.scrollTop).toBe(900);

      // The picker must now be locked — hasUserMessages = true means provider
      // must stay consistent within the session.
      await waitFor(() => {
        expect(
          screen.queryByRole("combobox", { name: /Claude Sonnet 4\.6/i }),
        ).toBeNull();
        const label = screen.getByLabelText("Claude Sonnet 4.6");
        expect(label.tagName).toBe("SPAN");
      });

      // Auto-scroll must remain enabled — fire ResizeObserver to confirm it
      // would still snap new content to the bottom.
      const resizeCb = getResizeCb();
      expect(resizeCb).not.toBeNull();
      resizeCb!([], {} as ResizeObserver);
      expect(scrollContainer!.scrollTop).toBe(900);
    } finally {
      scrollObs.disconnect();
      restoreRO();
    }
  });
});
