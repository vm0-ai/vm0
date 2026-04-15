import { describe, it, expect, vi } from "vitest";
import { createStore } from "ccstate";
import { ablyNotify$ } from "../realtime.ts";

// ---------------------------------------------------------------------------
// ablyNotify$ — IN_VITEST fallback to setLoop
// ---------------------------------------------------------------------------

describe("ablyNotify$ — IN_VITEST fallback (setLoop)", () => {
  it("resolves when body returns true on first call", async () => {
    const store = createStore();
    const ablyNotify = store.get(ablyNotify$);
    const controller = new AbortController();

    const body = vi.fn().mockReturnValue(true);
    await ablyNotify("topic", body, 0, controller.signal);

    expect(body).toHaveBeenCalledOnce();
  });

  it("keeps calling body until it returns true", async () => {
    const store = createStore();
    const ablyNotify = store.get(ablyNotify$);
    const controller = new AbortController();

    let calls = 0;
    const body = vi.fn(() => {
      calls++;
      return calls >= 3;
    });

    await ablyNotify("topic", body, 0, controller.signal);

    expect(body.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
