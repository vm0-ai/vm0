import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  chatThreadEventsContract,
  type ChatEventResponse,
} from "@vm0/api-contracts/contracts/chat-threads";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "b0000000-0000-4000-a000-000000000920";
const TOTAL_MESSAGES = 400;
const PAGE_SIZE = 50;
// The 7th history page request, after six pages (300 messages) have been
// fetched and flushed into the persistent message state.
const GATED_BEFORE_SEQ_ID = 51;

function eventForSeq(seqId: number): ChatEventResponse {
  if (seqId === TOTAL_MESSAGES) {
    return {
      id: `00000000-0000-4000-8000-${String(seqId).padStart(12, "0")}`,
      threadId: THREAD_ID,
      eventType: "output.message",
      content: "Latest visible message",
      seqId,
      createdAt: new Date(
        Date.parse("2026-03-10T00:00:00.000Z") + seqId * 1000,
      ).toISOString(),
    };
  }
  return {
    id: `00000000-0000-4000-8000-${String(seqId).padStart(12, "0")}`,
    threadId: THREAD_ID,
    eventType: "goal.changed",
    // Control rows participate in history pagination without rendering
    // hundreds of unrelated transcript nodes in this progress-only test.
    content: null,
    seqId,
    goalEvent: { type: "cleared" },
    createdAt: new Date(
      Date.parse("2026-03-10T00:00:00.000Z") + seqId * 1000,
    ).toISOString(),
  };
}

function eventsInRange(
  fromSeqId: number,
  toSeqId: number,
): ChatEventResponse[] {
  const events: ChatEventResponse[] = [];
  for (let seqId = fromSeqId; seqId <= toSeqId; seqId++) {
    events.push(eventForSeq(seqId));
  }
  return events;
}

function mockPagedHistory(): {
  finalHistoryPage: ReturnType<typeof context.mocks.deferred<void>>;
  beforeSeqIds: number[];
} {
  mockChatLifecycle(context, { threadId: THREAD_ID });
  const finalHistoryPage = context.mocks.deferred<void>();
  const beforeSeqIds: number[] = [];
  context.mocks.api(
    chatThreadEventsContract.list,
    async ({ query, respond }) => {
      if (query.sinceSeqId !== undefined) {
        return respond(200, { events: [] });
      }
      if (query.beforeSeqId === undefined) {
        return respond(200, {
          events: eventsInRange(TOTAL_MESSAGES - PAGE_SIZE + 1, TOTAL_MESSAGES),
          hasHistoryBefore: true,
        });
      }
      beforeSeqIds.push(query.beforeSeqId);
      if (query.beforeSeqId === GATED_BEFORE_SEQ_ID) {
        await finalHistoryPage.promise;
      }
      const toSeqId = query.beforeSeqId - 1;
      const fromSeqId = Math.max(1, toSeqId - PAGE_SIZE + 1);
      return respond(200, {
        events: eventsInRange(fromSeqId, toSeqId),
        hasHistoryBefore: fromSeqId > 1,
      });
    },
  );
  return { finalHistoryPage, beforeSeqIds };
}

describe("chat history backfill loading", () => {
  it("shows a message skeleton pair above the first message and hides it once history completes", async () => {
    const { finalHistoryPage, beforeSeqIds } = mockPagedHistory();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatHistoryBackfillProgress]: true,
      },
    });

    await waitFor(() => {
      expect(beforeSeqIds).toContain(GATED_BEFORE_SEQ_ID);
      const messageContainer = document.querySelector(
        "[data-message-container]",
      );
      const skeleton = document.querySelector(
        "[data-history-backfill-skeleton]",
      );
      const firstMessage = document.querySelector('[data-role="assistant"]');
      if (
        !(messageContainer instanceof HTMLElement) ||
        !(skeleton instanceof HTMLElement) ||
        !(firstMessage instanceof HTMLElement)
      ) {
        throw new Error("Expected the loading skeleton above a chat message");
      }
      expect(skeleton.parentElement).toBe(messageContainer);
      expect(
        skeleton.querySelectorAll("[data-chat-message-skeleton]"),
      ).toHaveLength(2);
      expect(
        skeleton.compareDocumentPosition(firstMessage) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    finalHistoryPage.resolve();
    await waitFor(() => {
      expect(
        document.querySelector("[data-history-backfill-skeleton]"),
      ).toBeNull();
    });
  });

  it("stays hidden during backfill when the feature switch is off", async () => {
    const { finalHistoryPage, beforeSeqIds } = mockPagedHistory();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(beforeSeqIds).toContain(GATED_BEFORE_SEQ_ID);
    });
    expect(
      document.querySelector("[data-history-backfill-skeleton]"),
    ).toBeNull();
    finalHistoryPage.resolve();
  });
});
