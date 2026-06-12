import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import {
  applyStreamingDelta$,
  clearStreamingDraftsForThread$,
  createStreamingDraftsForThread,
  reconcileStreamingDrafts$,
} from "../streaming-drafts.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000706";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000707";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "f819e443-a3fc-5990-920b-5eb8e51e038e";
const OTHER_MESSAGE_ID = "17754783-c025-54d2-ac58-d57e47c21f82";

function createHarness(threadId: string = THREAD_ID) {
  const store = createStore();
  const drafts$ = createStreamingDraftsForThread(threadId);
  return { store, drafts$ };
}

function applyDelta(
  store: ReturnType<typeof createStore>,
  args: {
    readonly threadId?: string;
    readonly messageId?: string;
    readonly runEventId?: string;
    readonly text: string;
  },
): void {
  const threadId = args.threadId ?? THREAD_ID;
  store.set(applyStreamingDelta$, {
    threadId,
    payload: {
      messageId: args.messageId ?? MESSAGE_ID,
      runId: RUN_ID,
      runEventId: args.runEventId ?? "msg_01",
      threadId,
      text: args.text,
    },
  });
}

function finalAssistantMessage(
  overrides: Partial<PagedChatMessage> = {},
): PagedChatMessage {
  return {
    id: MESSAGE_ID,
    role: "assistant",
    content: "final answer",
    runId: RUN_ID,
    runEventId: "msg_01",
    createdAt: "2026-06-09T10:00:01Z",
    ...overrides,
  };
}

describe("streaming drafts", () => {
  it("creates one draft and appends text for repeated deltas", () => {
    const { store, drafts$ } = createHarness();

    applyDelta(store, { text: "one " });
    applyDelta(store, { text: "two " });
    applyDelta(store, { text: "three" });

    const drafts = store.get(drafts$);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      id: MESSAGE_ID,
      role: "assistant",
      content: "one two three",
      runId: RUN_ID,
      runEventId: "msg_01",
    });
  });

  it("keeps sequential message ids in arrival order", () => {
    const { store, drafts$ } = createHarness();

    applyDelta(store, {
      messageId: MESSAGE_ID,
      runEventId: "msg_01",
      text: "first",
    });
    applyDelta(store, {
      messageId: OTHER_MESSAGE_ID,
      runEventId: "msg_02",
      text: "second",
    });

    expect(
      store.get(drafts$).map((message) => {
        return message.id;
      }),
    ).toStrictEqual([MESSAGE_ID, OTHER_MESSAGE_ID]);
  });

  it("removes a draft when the final server message arrives", () => {
    const { store, drafts$ } = createHarness();
    applyDelta(store, { text: "partial" });

    store.set(reconcileStreamingDrafts$, {
      threadId: THREAD_ID,
      messages: [finalAssistantMessage()],
    });

    expect(store.get(drafts$)).toStrictEqual([]);
  });

  it("removes drafts when a terminal lifecycle row arrives for the run", () => {
    const { store, drafts$ } = createHarness();
    applyDelta(store, { text: "partial" });

    store.set(reconcileStreamingDrafts$, {
      threadId: THREAD_ID,
      messages: [
        finalAssistantMessage({
          id: "b2368301-3f6d-4d97-a1d5-c5352ad60980",
          content: null,
          runLifecycleEvent: "cancelled",
          runEventId: undefined,
        }),
      ],
    });

    expect(store.get(drafts$)).toStrictEqual([]);
  });

  it("clears drafts only for the selected thread", () => {
    const { store, drafts$ } = createHarness();
    const otherDrafts$ = createStreamingDraftsForThread(OTHER_THREAD_ID);
    applyDelta(store, { text: "first thread" });
    applyDelta(store, {
      threadId: OTHER_THREAD_ID,
      messageId: OTHER_MESSAGE_ID,
      text: "other thread",
    });

    store.set(clearStreamingDraftsForThread$, THREAD_ID);

    expect(store.get(drafts$)).toStrictEqual([]);
    expect(store.get(otherDrafts$)).toHaveLength(1);
  });

  it("throws for invalid payloads", () => {
    const { store } = createHarness();

    expect(() => {
      store.set(applyStreamingDelta$, {
        threadId: THREAD_ID,
        payload: {
          messageId: "not-a-uuid",
          runId: RUN_ID,
          runEventId: "msg_01",
          threadId: THREAD_ID,
          text: "bad",
        },
      });
    }).toThrow();
  });
});
