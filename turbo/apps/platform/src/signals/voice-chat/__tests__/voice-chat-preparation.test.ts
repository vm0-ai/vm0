import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroVoiceChatPrepareTriggerContract,
  onboardingStatusContract,
} from "@vm0/core";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { setChatAgentId$ } from "../../agent-chat.ts";
import {
  meetingPrepStatus$,
  meetingPrepPrompt$,
  meetingPrepStartTime$,
  triggerPreparation$,
  clearPreparation$,
} from "../voice-chat-preparation.ts";
import { setupVoiceChatPage$ } from "../voice-chat-setup.ts";
import {
  createDeferredPromise,
  detach,
  Reason,
  resetSignal,
} from "../../utils.ts";

const context = testContext();

const TEST_AGENT_ID = "agent-123";

async function setup() {
  await setupPage({
    context,
    path: "/",
    withoutRender: true,
  });
  context.store.set(setChatAgentId$, TEST_AGENT_ID);
}

function mockPrepareEndpoint(
  responses: { status: "preparing" | "ready" | "failed"; id?: string }[],
) {
  const counter = { count: 0 };
  server.use(
    mockApi(zeroVoiceChatPrepareTriggerContract.trigger, ({ respond }) => {
      const responseIndex = Math.min(counter.count, responses.length - 1);
      const response = responses[responseIndex];
      counter.count++;
      return respond(200, {
        preparation: {
          id: response.id ?? "prep-1",
          status: response.status,
        },
      });
    }),
  );
  return counter;
}

describe("voice-chat-preparation signals", () => {
  it("should set status to ready when preparation is cached", async () => {
    await setup();
    mockPrepareEndpoint([{ status: "ready" }]);

    await context.store.set(
      triggerPreparation$,
      "discuss quarterly goals",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("ready");
    expect(context.store.get(meetingPrepPrompt$)).toBe(
      "discuss quarterly goals",
    );
    expect(context.store.get(meetingPrepStartTime$)).toBeTypeOf("number");
  });

  it("should set status to failed immediately when initial status is failed", async () => {
    await setup();
    const counter = mockPrepareEndpoint([{ status: "failed" }]);

    await context.store.set(
      triggerPreparation$,
      "already failed prompt",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("failed");
    // Should exit immediately — only the initial call, no polling
    expect(counter.count).toBe(1);
  });

  it("should poll until ready when preparation is in progress", async () => {
    await setup();
    const counter = mockPrepareEndpoint([
      { status: "preparing" },
      { status: "preparing" },
      { status: "ready" },
    ]);

    const done = context.store.set(
      triggerPreparation$,
      "review sprint items",
      context.signal,
    );

    // Wait for the first API call (which enters setAblyLoop$ and subscribes),
    // then drive the polling loop forward via Ably events.
    await vi.waitFor(() => {
      expect(counter.count).toBeGreaterThanOrEqual(1);
    });
    triggerAblyEvent("voice:prep:test-user-123");
    await vi.waitFor(() => {
      expect(counter.count).toBeGreaterThanOrEqual(2);
    });
    triggerAblyEvent("voice:prep:test-user-123");

    await done;

    expect(context.store.get(meetingPrepStatus$)).toBe("ready");
    expect(counter.count).toBeGreaterThanOrEqual(3);
  });

  it("should set status to failed when preparation fails during poll", async () => {
    await setup();
    const counter = mockPrepareEndpoint([
      { status: "preparing" },
      { status: "failed" },
    ]);

    const done = context.store.set(
      triggerPreparation$,
      "team standup",
      context.signal,
    );

    await vi.waitFor(() => {
      expect(counter.count).toBeGreaterThanOrEqual(1);
    });
    triggerAblyEvent("voice:prep:test-user-123");

    await done;

    expect(context.store.get(meetingPrepStatus$)).toBe("failed");
  });

  it("should set status to failed when endpoint returns error", async () => {
    await setup();
    server.use(
      // mockApi cannot be used here: 500 is not declared in
      // zeroVoiceChatPrepareTriggerContract.trigger responses, so this raw
      // handler is the only way to simulate a server error.
      http.post("*/api/zero/voice-chat/prepare", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await context.store.set(
      triggerPreparation$,
      "error prompt",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("failed");
  });

  it("should set status to failed when no agent is selected", async () => {
    // Override onboarding to return no defaultAgentId before setup() so the
    // onboarding status fetched during page initialization has null defaultAgentId.
    // triggerPreparation$ reads defaultAgentId$ which derives from this status.
    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: false,
          defaultAgentId: null,
          defaultAgentMetadata: null,
        });
      }),
    );

    await setup();

    await context.store.set(
      triggerPreparation$,
      "no agent prompt",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("failed");
  });

  it("should reset all state on clearPreparation$", async () => {
    await setup();
    mockPrepareEndpoint([{ status: "ready" }]);

    await context.store.set(triggerPreparation$, "some prompt", context.signal);

    expect(context.store.get(meetingPrepStatus$)).toBe("ready");

    context.store.set(clearPreparation$);

    expect(context.store.get(meetingPrepStatus$)).toBe("idle");
    expect(context.store.get(meetingPrepPrompt$)).toBeNull();
    expect(context.store.get(meetingPrepStartTime$)).toBeNull();
  });
});

describe("voice-chat page navigation abort", () => {
  // resetSignal$ creates a ccstate command that manages an AbortController.
  // Each call to store.set(pageReset$) aborts the previous signal and returns
  // a new one — simulating page navigation (old page aborted, new page started).
  const pageReset$ = resetSignal();

  /**
   * Helper: bootstrap auth, set up the voice chat page with a controllable
   * signal from resetSignal$. The abort handler in setupVoiceChatPage$ is
   * registered after awaiting onboardGuard$ and hideAppSkeleton$, so we
   * await the full setup to guarantee the handler exists before the test
   * body runs.
   */
  async function setupPageWithAbort() {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });
    context.store.set(setChatAgentId$, TEST_AGENT_ID);

    const pageSignal = context.store.set(pageReset$, context.signal);
    await context.store.set(setupVoiceChatPage$, pageSignal);

    return pageSignal;
  }

  it("should NOT clear preparation state when status is ready on navigation abort", async () => {
    await setupPageWithAbort();
    mockPrepareEndpoint([{ status: "ready" }]);

    await context.store.set(
      triggerPreparation$,
      "discuss quarterly goals",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("ready");
    expect(context.store.get(meetingPrepPrompt$)).toBe(
      "discuss quarterly goals",
    );

    // Simulate navigation away — resetSignal$ aborts the previous page signal
    context.store.set(pageReset$, context.signal);

    // "ready" preparation should persist
    expect(context.store.get(meetingPrepStatus$)).toBe("ready");
    expect(context.store.get(meetingPrepPrompt$)).toBe(
      "discuss quarterly goals",
    );
    expect(context.store.get(meetingPrepStartTime$)).toBeTypeOf("number");
  });

  it("should clear preparation state when status is preparing on navigation abort", async () => {
    // Gate to block poll calls so we stay in "preparing"
    const prepBlock = createDeferredPromise<void>(context.signal);
    const initialCallDone = createDeferredPromise<void>(context.signal);
    let firstPrepCall = true;
    server.use(
      mockApi(
        zeroVoiceChatPrepareTriggerContract.trigger,
        async ({ respond }) => {
          if (firstPrepCall) {
            firstPrepCall = false;
            initialCallDone.resolve();
            return respond(200, {
              preparation: { id: "prep-1", status: "preparing" },
            });
          }
          // Block all subsequent poll calls so we stay in "preparing"
          await prepBlock.promise;
          return respond(200, {
            preparation: { id: "prep-1", status: "preparing" },
          });
        },
      ),
    );

    const pageSignal = await setupPageWithAbort();

    // Fire triggerPreparation$ but don't await — it polls forever.
    // Use pageSignal so the preparation poll is also aborted on navigation.
    detach(
      context.store.set(triggerPreparation$, "sprint review", pageSignal),
      Reason.Entrance,
      "test-trigger-prep",
    );

    // Wait for the initial API call to complete and status to become "preparing"
    await initialCallDone.promise;
    await Promise.resolve();

    expect(context.store.get(meetingPrepStatus$)).toBe("preparing");

    // Simulate navigation away — resetSignal$ aborts the page signal,
    // firing the abort handler registered by setupVoiceChatPage$.
    context.store.set(pageReset$, context.signal);

    // "preparing" state should be cleared
    expect(context.store.get(meetingPrepStatus$)).toBe("idle");
    expect(context.store.get(meetingPrepPrompt$)).toBeNull();
    expect(context.store.get(meetingPrepStartTime$)).toBeNull();
  });
});
