import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export interface PinnedThreadOrder {
  readonly id: string;
  readonly pinnedAt: string | null;
  readonly pinOrder?: string | null;
}

/** Historical pins retain their reverse chronological order without a backfill. */
function chatThreadPinOrder(thread: PinnedThreadOrder): string {
  if (thread.pinOrder != null) {
    return thread.pinOrder;
  }
  if (thread.pinnedAt === null) {
    throw new Error("Cannot rank an unpinned thread");
  }
  const reverseTimestamp = 8640000000000000 - Date.parse(thread.pinnedAt);
  // A valid fractional key: fixed-width digits preserve timestamp order, and
  // the nonzero suffix leaves space on either side of every historical pin.
  return `a0${reverseTimestamp.toString().padStart(17, "0")}1`;
}

export function comparePinnedThreads(
  left: PinnedThreadOrder,
  right: PinnedThreadOrder,
): number {
  const a = chatThreadPinOrder(left);
  const b = chatThreadPinOrder(right);
  // Fractional keys use byte ordering, never localeCompare's collation.
  if (a !== b) {
    return a < b ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? 1 : -1;
}

export function firstChatThreadPinOrder(
  threads: readonly PinnedThreadOrder[],
): string {
  const first = threads
    .filter((thread) => {
      return thread.pinnedAt !== null;
    })
    .sort(comparePinnedThreads)[0];
  return generateKeyBetween(null, first ? chatThreadPinOrder(first) : null);
}

export function isChatThreadPinOrder(value: string): boolean {
  if (!/^[A-Za-z][0-9A-Za-z]+$/.test(value)) {
    return false;
  }
  try {
    generateKeyBetween(null, value);
    return true;
  } catch {
    // The library validates integer length, reserved keys and trailing zeroes.
    return false;
  }
}

/** Compute only the moved rank, plus a tied suffix if the insertion gap is zero. */
export function moveChatThreadPinOrder(
  threads: readonly PinnedThreadOrder[],
  threadId: string,
  targetId: string,
  side: "before" | "after",
): { threadId: string; pinOrder: string }[] {
  const ordered = threads
    .filter((thread) => {
      return thread.pinnedAt !== null;
    })
    .sort(comparePinnedThreads);
  const moved = ordered.find((thread) => {
    return thread.id === threadId;
  });
  if (!moved || threadId === targetId) {
    return [];
  }
  const remaining = ordered.filter((thread) => {
    return thread.id !== threadId;
  });
  const target = remaining.findIndex((thread) => {
    return thread.id === targetId;
  });
  if (target < 0) {
    return [];
  }
  const index = target + (side === "after" ? 1 : 0);
  if (ordered[index]?.id === threadId) {
    return [];
  }
  const left = index > 0 ? chatThreadPinOrder(remaining[index - 1]!) : null;
  const right =
    index < remaining.length ? chatThreadPinOrder(remaining[index]!) : null;
  if (left === null || left !== right) {
    return [{ threadId, pinOrder: generateKeyBetween(left, right) }];
  }
  let end = index;
  while (
    end < remaining.length &&
    chatThreadPinOrder(remaining[end]!) === left
  ) {
    end++;
  }
  const upper =
    end < remaining.length ? chatThreadPinOrder(remaining[end]!) : null;
  const affected = [moved, ...remaining.slice(index, end)];
  const keys = generateNKeysBetween(left, upper, affected.length);
  return affected.map((thread, i) => {
    return {
      threadId: thread.id,
      pinOrder: keys[i]!,
    };
  });
}
