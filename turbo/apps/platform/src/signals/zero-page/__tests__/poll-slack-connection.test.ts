import { describe, it, expect, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pollSlackConnection$ } from "../zero-slack.ts";
import { zeroIntegrationsSlackContract } from "@vm0/core/contracts/zero-integrations-slack";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { triggerAblyEvent, hasSubscription } from "../../../mocks/ably.ts";

const context = testContext();
const mockApi = createMockApi(context);

function setup() {
  detachedSetupPage({
    context,
    path: "/",
    withoutRender: true,
  });
}

const alwaysConnected = () => {
  return true;
};
const alwaysDisconnected = () => {
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
    mockApi(zeroIntegrationsSlackContract.getStatus, ({ respond }) => {
      callCount++;
      return respond(200, {
        isConnected: getIsConnected(callCount),
        isInstalled: true,
        workspaceName: "Test Workspace",
        isAdmin: false,
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
  it("should return immediately when already connected", async () => {
    const counter = mockSlackEndpoint(alwaysConnected);

    await setup();

    await context.store.set(pollSlackConnection$, context.signal);

    // Initial slackOrgData$ read sees isConnected=true and returns without
    // subscribing. Total: 1 fetch.
    expect(counter.count).toBe(1);
  });

  it("should subscribe and re-check on slack:changed events until connected", async () => {
    const counter = mockSlackEndpoint(connectedOnThirdCall);

    await setup();

    const pollPromise = context.store.set(pollSlackConnection$, context.signal);

    // Initial slackOrgData$ read is call #1. setAblyLoop$ does not prime the
    // body on subscribe; it waits for Ably events to re-check status.
    await vi.waitFor(() => {
      expect(hasSubscription("slack:changed")).toBeTruthy();
    });

    // First event re-runs the body as call #2 and remains disconnected.
    triggerAblyEvent("slack:changed");
    await vi.waitFor(() => {
      expect(counter.count).toBeGreaterThanOrEqual(2);
    });

    // Second event re-runs as call #3 and sees connected.
    triggerAblyEvent("slack:changed");

    await pollPromise;

    expect(counter.count).toBeGreaterThanOrEqual(3);
  });

  it("should stop subscribing when signal is aborted", async () => {
    const abortController = new AbortController();
    const counter = mockSlackEndpoint(alwaysDisconnected);

    await setup();

    const pollPromise = context.store.set(
      pollSlackConnection$,
      abortController.signal,
    );

    // Wait until the subscription is registered (body already ran once).
    await vi.waitFor(() => {
      expect(hasSubscription("slack:changed")).toBeTruthy();
    });

    abortController.abort();

    await expect(pollPromise).rejects.toThrow();
    expect(counter.count).toBe(1);
    expect(hasSubscription("slack:changed")).toBeFalsy();
  });
});
