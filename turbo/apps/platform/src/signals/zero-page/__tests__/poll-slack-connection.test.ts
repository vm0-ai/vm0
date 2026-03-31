import { describe, it, expect, vi, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pollSlackConnection$ } from "../zero-slack.ts";

const context = testContext();

async function setup() {
  await setupPage({
    context,
    path: "/",
    withoutRender: true,
  });
}

const alwaysConnected = () => {
  return true;
};
const neverConnected = () => {
  return false;
};
const connectedOnThirdCall = (n: number) => {
  return n >= 3;
};

function mockSlackEndpoint(getIsConnected: (callCount: number) => boolean) {
  let callCount = 0;
  const counter = {
    get count() {
      return callCount;
    },
  };
  server.use(
    http.get("*/api/zero/integrations/slack", () => {
      callCount++;
      return HttpResponse.json({
        isConnected: getIsConnected(callCount),
        isInstalled: true,
        workspaceName: "Test Workspace",
        isAdmin: false,
        defaultAgentId: null,
        agentOrgSlug: null,
        environment: {
          requiredSecrets: [],
          requiredVars: [],
          missingSecrets: [],
          missingVars: [],
        },
      });
    }),
  );
  return counter;
}

describe("pollSlackConnection$", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return immediately when already connected", async () => {
    // Default mock returns isConnected: true
    await setup();

    const counter = mockSlackEndpoint(alwaysConnected);

    await context.store.set(pollSlackConnection$, context.signal);

    // Should have only fetched once (the initial check), no polling
    expect(counter.count).toBe(1);
  });

  it("should poll until connected and show success toast", async () => {
    // Return connected on the 3rd call
    const counter = mockSlackEndpoint(connectedOnThirdCall);

    await setup();

    vi.useFakeTimers();
    const pollPromise = context.store.set(pollSlackConnection$, context.signal);

    // Advance through poll intervals until connected
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(3000);
    }

    await pollPromise;
    vi.useRealTimers();

    // Called at least 3 times: initial check + polls until connected
    expect(counter.count).toBeGreaterThanOrEqual(3);
  });

  it("should stop polling when signal is aborted", async () => {
    // Never return connected
    const counter = mockSlackEndpoint(neverConnected);

    await setup();

    const abortController = new AbortController();

    vi.useFakeTimers();
    const pollPromise = context.store.set(
      pollSlackConnection$,
      abortController.signal,
    );

    // Let it poll a few times
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(3000);
    }

    // Abort the signal to stop polling
    abortController.abort();

    await expect(pollPromise).rejects.toThrow();
    vi.useRealTimers();

    // Should have polled a few times before abort
    expect(counter.count).toBeGreaterThanOrEqual(1);
  });
});
