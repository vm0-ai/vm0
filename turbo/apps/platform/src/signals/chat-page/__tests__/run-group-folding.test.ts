import { describe, expect, it } from "vitest";
import type {
  EnrichedChatMessage,
  GroupedChatMessageGroup,
} from "../chat-message.ts";
import {
  buildRunGroupFolding,
  previousRunGroupVisualWindowStartIndex,
  runGroupVisualWindowStartIndex,
} from "../run-group-folding.ts";

function userMessage(params: {
  readonly id: string;
  readonly runId?: string;
  readonly runGroupId?: string;
  readonly content?: string;
}): EnrichedChatMessage {
  return {
    id: params.id,
    role: "user",
    content: params.content ?? params.id,
    runId: params.runId,
    runGroupId: params.runGroupId,
    createdAt: "2026-06-24T00:00:00.000Z",
    blocks: [],
    isQueued: false,
    isOptimisticRun: false,
  };
}

function assistantMessage(params: {
  readonly id: string;
  readonly runId?: string;
  readonly runGroupId?: string;
  readonly content?: string;
}): EnrichedChatMessage {
  return {
    id: params.id,
    role: "assistant",
    content: params.content ?? params.id,
    runId: params.runId,
    runGroupId: params.runGroupId,
    createdAt: "2026-06-24T00:00:00.000Z",
    blocks: [],
    isQueued: false,
    isOptimisticRun: false,
  };
}

function group(
  role: "user" | "assistant",
  messages: EnrichedChatMessage[],
): GroupedChatMessageGroup {
  return {
    beginMessageId: messages[0]!.id,
    role,
    messages,
  };
}

function messageIds(groups: readonly GroupedChatMessageGroup[]): string[] {
  return groups.flatMap((item) => {
    return item.messages.map((message) => {
      return message.id;
    });
  });
}

function assistantRunGroups(params: {
  readonly label: string;
  readonly count: number;
  readonly runGroupId?: string;
}): GroupedChatMessageGroup[] {
  return Array.from({ length: params.count }, (_, index) => {
    const itemNumber = index + 1;
    const id = `${params.label}-${itemNumber}`;
    return group("assistant", [
      assistantMessage({
        id,
        runId: `${params.label}-run-${itemNumber}`,
        runGroupId: params.runGroupId,
      }),
    ]);
  });
}

describe("buildRunGroupFolding", () => {
  it("folds earlier consecutive runs in the same run group", () => {
    const groups: GroupedChatMessageGroup[] = [
      group("user", [userMessage({ id: "u1", runId: "r1", runGroupId: "g1" })]),
      group("assistant", [
        assistantMessage({ id: "a1", runId: "r1", runGroupId: "g1" }),
      ]),
      group("user", [userMessage({ id: "u2", runId: "r2", runGroupId: "g1" })]),
      group("assistant", [
        assistantMessage({ id: "a2", runId: "r2", runGroupId: "g1" }),
      ]),
      group("user", [userMessage({ id: "u3", runId: "r3", runGroupId: "g1" })]),
      group("assistant", [
        assistantMessage({ id: "a3", runId: "r3", runGroupId: "g1" }),
      ]),
    ];

    const folding = buildRunGroupFolding(groups);

    expect(folding).not.toBeNull();
    expect(messageIds(folding!.visibleGroups)).toStrictEqual(["u3", "a3"]);
    const fold = folding!.foldsByNextGroupId.get("u3")?.[0];
    expect(fold?.hiddenRunCount).toBe(2);
    expect(messageIds(fold?.hiddenGroups ?? [])).toStrictEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
  });

  it("does not fold runs separated by a normal message", () => {
    const groups: GroupedChatMessageGroup[] = [
      group("user", [userMessage({ id: "u1", runId: "r1", runGroupId: "g1" })]),
      group("assistant", [
        assistantMessage({ id: "a1", runId: "r1", runGroupId: "g1" }),
      ]),
      group("user", [userMessage({ id: "manual" })]),
      group("user", [userMessage({ id: "u2", runId: "r2", runGroupId: "g1" })]),
      group("assistant", [
        assistantMessage({ id: "a2", runId: "r2", runGroupId: "g1" }),
      ]),
    ];

    expect(buildRunGroupFolding(groups)).toBeNull();
  });

  it("treats interleaved run groups as separate fold sections", () => {
    const groups: GroupedChatMessageGroup[] = [
      group("user", [
        userMessage({ id: "a1u", runId: "a1", runGroupId: "group-a" }),
      ]),
      group("assistant", [
        assistantMessage({ id: "a1a", runId: "a1", runGroupId: "group-a" }),
      ]),
      group("user", [
        userMessage({ id: "a2u", runId: "a2", runGroupId: "group-a" }),
      ]),
      group("assistant", [
        assistantMessage({ id: "a2a", runId: "a2", runGroupId: "group-a" }),
      ]),
      group("user", [
        userMessage({ id: "b1u", runId: "b1", runGroupId: "group-b" }),
      ]),
      group("assistant", [
        assistantMessage({ id: "b1a", runId: "b1", runGroupId: "group-b" }),
      ]),
      group("user", [
        userMessage({ id: "a3u", runId: "a3", runGroupId: "group-a" }),
      ]),
      group("assistant", [
        assistantMessage({ id: "a3a", runId: "a3", runGroupId: "group-a" }),
      ]),
      group("user", [
        userMessage({ id: "a4u", runId: "a4", runGroupId: "group-a" }),
      ]),
      group("assistant", [
        assistantMessage({ id: "a4a", runId: "a4", runGroupId: "group-a" }),
      ]),
    ];

    const folding = buildRunGroupFolding(groups);

    expect(folding).not.toBeNull();
    expect(messageIds(folding!.visibleGroups)).toStrictEqual([
      "a2u",
      "a2a",
      "b1u",
      "b1a",
      "a4u",
      "a4a",
    ]);
    const firstFold = folding!.foldsByNextGroupId.get("a2u")?.[0];
    const secondFold = folding!.foldsByNextGroupId.get("a4u")?.[0];
    expect(messageIds(firstFold?.hiddenGroups ?? [])).toStrictEqual([
      "a1u",
      "a1a",
    ]);
    expect(messageIds(secondFold?.hiddenGroups ?? [])).toStrictEqual([
      "a3u",
      "a3a",
    ]);
    expect(firstFold?.key).not.toBe(secondFold?.key);
  });
});

describe("runGroupVisualWindowStartIndex", () => {
  it("counts a folded tail run group as one visual item", () => {
    const groups = [
      ...assistantRunGroups({
        label: "A",
        count: 11,
        runGroupId: "group-a",
      }),
      ...assistantRunGroups({
        label: "B",
        count: 1,
        runGroupId: "group-b",
      }),
    ];

    const startIndex = runGroupVisualWindowStartIndex(groups, null, 10);
    const folding = buildRunGroupFolding(groups.slice(startIndex));

    expect(startIndex).toBe(0);
    expect(folding?.foldsByNextGroupId.get("A-11")?.[0]?.hiddenRunCount).toBe(
      10,
    );
    expect(messageIds(folding?.visibleGroups ?? [])).toStrictEqual([
      "A-11",
      "B-1",
    ]);
  });

  it("keeps the item before a folded middle run group in the initial window", () => {
    const groups = [
      ...assistantRunGroups({
        label: "A",
        count: 1,
        runGroupId: "group-a",
      }),
      ...assistantRunGroups({
        label: "B",
        count: 10,
        runGroupId: "group-b",
      }),
      ...assistantRunGroups({
        label: "C",
        count: 1,
        runGroupId: "group-c",
      }),
    ];

    const startIndex = runGroupVisualWindowStartIndex(groups, null, 10);
    const folding = buildRunGroupFolding(groups.slice(startIndex));

    expect(startIndex).toBe(0);
    expect(folding?.foldsByNextGroupId.get("B-10")?.[0]?.hiddenRunCount).toBe(
      9,
    );
    expect(messageIds(folding?.visibleGroups ?? [])).toStrictEqual([
      "A-1",
      "B-10",
      "C-1",
    ]);
  });

  it("moves the cursor by visual items when loading more", () => {
    const groups = [
      ...assistantRunGroups({ label: "older", count: 12 }),
      ...assistantRunGroups({
        label: "A",
        count: 11,
        runGroupId: "group-a",
      }),
      ...assistantRunGroups({
        label: "B",
        count: 1,
        runGroupId: "group-b",
      }),
    ];

    const initialStartIndex = runGroupVisualWindowStartIndex(groups, null, 10);
    const previousStartIndex = previousRunGroupVisualWindowStartIndex(
      groups,
      initialStartIndex,
      10,
    );

    expect(groups[initialStartIndex]?.beginMessageId).toBe("older-5");
    expect(previousStartIndex).toBe(0);
  });
});
