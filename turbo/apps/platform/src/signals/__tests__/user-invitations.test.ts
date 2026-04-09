/**
 * Tests for user-invitations signals.
 *
 * Entry point: store.set(pollUserInvitations$, signal)
 * Mock (external): Clerk via mock-auth
 * Real (internal): signals, state management, setLoop
 */

import { describe, it, expect } from "vitest";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { detach, Reason } from "../utils.ts";
import { pollUserInvitations$ } from "../user-invitations.ts";

const context = testContext();

async function setup() {
  await setupPage({
    context,
    path: "/",
    withoutRender: true,
  });
}

describe("pollUserInvitations$", () => {
  it("polls continuously — loop does not exit after the first iteration", async () => {
    await setup();

    // Track whether pollUserInvitations$ resolves on its own (without abort).
    // Before the fix, `return true` in the setLoop callback caused the loop to
    // exit after one iteration (loopExited = true). After the fix, `return false`
    // keeps the loop running until the signal is aborted (loopExited = false).
    let loopExited = false;

    detach(
      context.store.set(pollUserInvitations$, context.signal).then(
        () => {
          loopExited = true;
        },
        () => {
          // AbortError on cleanup — not a loop exit
        },
      ),
      Reason.Daemon,
    );

    // Yield enough microtasks to let the loop settle if it exits early.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    // The poll should still be running — it has not exited because context.signal
    // has not been aborted. Before the fix, loopExited would be true here.
    expect(loopExited).toBeFalsy();
  });
});
