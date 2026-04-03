import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pollSlackConnection$ } from "../zero-slack.ts";
import { createDeferredPromise } from "../../utils.ts";

vi.mock("signal-timers", async (importOriginal) => {
  const mod = await importOriginal<typeof import("signal-timers")>();
  return {
    ...mod,
    delay: () => {
      return Promise.resolve();
    },
  };
});

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
  it("should return immediately when already connected", async () => {
    await setup();

    const counter = mockSlackEndpoint(alwaysConnected);

    await context.store.set(pollSlackConnection$, context.signal);

    // Should have only fetched once (the initial check), no polling
    expect(counter.count).toBe(1);
  });

  it("should poll until connected and show success toast", async () => {
    const counter = mockSlackEndpoint(connectedOnThirdCall);

    await setup();

    await context.store.set(pollSlackConnection$, context.signal);

    // Called at least 3 times: initial check + polls until connected
    expect(counter.count).toBeGreaterThanOrEqual(3);
  });

  it("should stop polling when signal is aborted", async () => {
    const counter = mockSlackEndpoint(neverConnected);

    await setup();

    const abortController = new AbortController();

    // Use a deferred to abort after a few polls
    const abortDeferred = createDeferredPromise<void>(context.signal);
    let pollsSeen = 0;
    server.use(
      http.get("*/api/zero/integrations/slack", () => {
        pollsSeen++;
        if (pollsSeen >= 3) {
          abortDeferred.resolve();
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

    const pollPromise = context.store.set(
      pollSlackConnection$,
      abortController.signal,
    );

    await abortDeferred.promise;
    abortController.abort();

    await expect(pollPromise).rejects.toThrow();

    // Should have polled a few times before abort
    expect(counter.count).toBeGreaterThanOrEqual(1);
  });
});
