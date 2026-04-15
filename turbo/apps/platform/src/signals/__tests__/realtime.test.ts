import { describe, it, expect, vi } from "vitest";
import { command, createStore } from "ccstate";
import { setAblyLoop$ } from "../realtime.ts";

// ---------------------------------------------------------------------------
// setAblyLoop$ — IN_VITEST fallback to setLoop
// ---------------------------------------------------------------------------

describe("setAblyLoop$ — IN_VITEST fallback (setLoop)", () => {
  it("resolves when loopCommand$ returns true on first call", async () => {
    const store = createStore();
    const controller = new AbortController();

    const body = vi.fn().mockReturnValue(true);
    const loopCommand$ = command((_store, _signal: AbortSignal) => {
      return body() as boolean;
    });

    await store.set(setAblyLoop$, "topic", loopCommand$, 0, controller.signal);

    expect(body).toHaveBeenCalledOnce();
  });

  it("keeps calling loopCommand$ until it returns true", async () => {
    const store = createStore();
    const controller = new AbortController();

    let calls = 0;
    const loopCommand$ = command((_store, _signal: AbortSignal) => {
      calls++;
      return calls >= 3;
    });

    await store.set(setAblyLoop$, "topic", loopCommand$, 0, controller.signal);

    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
