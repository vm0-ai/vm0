import { describe, expect, it } from "vitest";

import { testContext } from "../../__tests__/test-helpers.ts";
import { createChatThreadSharingSignals } from "../chat-thread-sharing.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";

describe("chat thread sharing selection", () => {
  it("starts with no messages selected and toggles complete visual groups", () => {
    const sharing = createChatThreadSharingSignals(THREAD_ID);
    const events = [
      { id: "event-1", text: "First message" },
      { id: "event-2", text: "Second message" },
    ];

    context.store.set(sharing.start$);

    expect(context.store.get(sharing.phase$)).toBe("selecting");
    expect(context.store.get(sharing.selectedCount$)).toBe(0);
    expect([...context.store.get(sharing.selectedEventIds$)]).toStrictEqual([]);

    expect(context.store.set(sharing.toggle$, events)).toBe("selected");
    expect([...context.store.get(sharing.selectedEventIds$)]).toStrictEqual([
      "event-1",
      "event-2",
    ]);

    expect(context.store.set(sharing.toggle$, events)).toBe("deselected");
    expect(context.store.get(sharing.selectedCount$)).toBe(0);
  });

  it("keeps the existing selection when another group exceeds the text limit", () => {
    const sharing = createChatThreadSharingSignals(THREAD_ID);
    const selectedEvent = { id: "event-1", text: "Selected message" };
    const oversizedEvent = {
      id: "event-2",
      text: "a".repeat(1.5 * 1024 * 1024 + 1),
    };

    context.store.set(sharing.start$);
    expect(context.store.set(sharing.toggle$, [selectedEvent])).toBe(
      "selected",
    );

    expect(context.store.set(sharing.toggle$, [oversizedEvent])).toBe(
      "too-large",
    );
    expect([...context.store.get(sharing.selectedEventIds$)]).toStrictEqual([
      "event-1",
    ]);
  });

  it("clears selection and created state when the flow closes", () => {
    const sharing = createChatThreadSharingSignals(THREAD_ID);

    context.store.set(sharing.start$);
    context.store.set(sharing.toggle$, [{ id: "event-1", text: "Message" }]);
    context.store.set(sharing.close$);

    expect(context.store.get(sharing.phase$)).toBe("idle");
    expect(context.store.get(sharing.selectedCount$)).toBe(0);
    expect(context.store.get(sharing.createdSharedThreadId$)).toBeNull();
  });
});
