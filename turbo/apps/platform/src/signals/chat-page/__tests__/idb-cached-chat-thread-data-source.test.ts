import { describe, expect, it } from "vitest";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import { readCachedMessagesBeforeUntilMiss } from "../idb-cached-chat-thread-data-source";
import { testContext } from "../../__tests__/test-helpers.ts";

function message(index: number): PagedChatMessage {
  const id = `m${index.toString().padStart(3, "0")}`;
  return {
    id,
    role: index % 2 === 0 ? "assistant" : "user",
    content: `message ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  };
}

function range(start: number, end: number): PagedChatMessage[] {
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    return message(start + offset);
  });
}

function ids(messages: PagedChatMessage[]): string[] {
  return messages.map((msg) => {
    return msg.id;
  });
}

describe("readCachedMessagesBeforeUntilMiss", () => {
  const ctx = testContext();

  it("keeps reading older cached pages until IndexedDB misses", async () => {
    const calls: string[] = [];
    const pages = new Map<string, PagedChatMessage[]>([
      ["m151", range(101, 150)],
      ["m101", range(51, 100)],
      ["m051", []],
    ]);
    const signal = ctx.signal;

    const result = await readCachedMessagesBeforeUntilMiss(
      {
        readBefore(_threadId, beforeId, limit, passedSignal) {
          expect(limit).toBe(50);
          expect(passedSignal).toBe(signal);
          calls.push(beforeId);
          return Promise.resolve(pages.get(beforeId) ?? []);
        },
      },
      "thread-1",
      "m151",
      null,
      signal,
    );

    expect(calls).toStrictEqual(["m151", "m101", "m051"]);
    expect(result.pages).toBe(2);
    expect(result.hasMore).toBeTruthy();
    expect(ids(result.messages)).toStrictEqual(ids(range(51, 150)));
  });

  it("stops once the cached messages include the known thread start", async () => {
    const calls: string[] = [];
    const pages = new Map<string, PagedChatMessage[]>([
      ["m151", range(101, 150)],
      ["m101", range(51, 100)],
      ["m051", []],
    ]);
    const signal = ctx.signal;

    const result = await readCachedMessagesBeforeUntilMiss(
      {
        readBefore(_threadId, beforeId) {
          calls.push(beforeId);
          return Promise.resolve(pages.get(beforeId) ?? []);
        },
      },
      "thread-1",
      "m151",
      "m051",
      signal,
    );

    expect(calls).toStrictEqual(["m151", "m101"]);
    expect(result.pages).toBe(2);
    expect(result.hasMore).toBeFalsy();
    expect(ids(result.messages)).toStrictEqual(ids(range(51, 150)));
  });
});
