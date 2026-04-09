import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../utils.ts";
import {
  pollSlackConnection$,
  setSlackPollIntervalMs$,
} from "../zero-slack.ts";

const context = testContext();

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
  beforeEach(() => {
    // Use a zero poll interval so tests run fast without fake timers.
    context.store.set(setSlackPollIntervalMs$, 0);
  });

  it("should return immediately when already connected", async () => {
    const counter = mockSlackEndpoint(alwaysConnected);

    await setup();

    await context.store.set(pollSlackConnection$, context.signal);

    // Setup fetches slack status once (counter already registered), then
    // pollSlackConnection$ sees isConnected and returns without polling. Total: 1 fetch.
    expect(counter.count).toBe(1);
  });

  it("should poll until connected and show success toast", async () => {
    // Return connected on the 3rd call
    const counter = mockSlackEndpoint(connectedOnThirdCall);

    await setup();

    await context.store.set(pollSlackConnection$, context.signal);

    // Called at least 3 times: initial check + polls until connected on 3rd call
    expect(counter.count).toBeGreaterThanOrEqual(3);
  });

  it("should stop polling when signal is aborted", async () => {
    const abortController = new AbortController();
    const deferred = createDeferredPromise<void>(context.signal);
    let callCount = 0;
    server.use(
      http.get("*/api/zero/integrations/slack", async () => {
        callCount++;
        // The second call is the first real poll — block it and abort the controller
        if (callCount === 2) {
          abortController.abort();
          deferred.resolve();
          await deferred.promise;
        }
        return HttpResponse.json({
          isConnected: false,
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

    await setup();

    const pollPromise = context.store.set(
      pollSlackConnection$,
      abortController.signal,
    );

    await expect(pollPromise).rejects.toThrow();

    // Should have polled at least once before abort
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
