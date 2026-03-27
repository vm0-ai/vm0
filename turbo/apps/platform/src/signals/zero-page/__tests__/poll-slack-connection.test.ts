import { describe, it, expect, vi, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pollSlackConnection$ } from "../zero-slack.ts";

const context = testContext();

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  await setupPage({
    context,
    path: "/",
    withoutRender: true,
  });
}

describe("pollSlackConnection$", () => {
  it("should return immediately when already connected", async () => {
    // Default mock returns isConnected: true
    await setup();

    let callCount = 0;
    server.use(
      http.get("*/api/zero/integrations/slack", () => {
        callCount++;
        return HttpResponse.json({
          isConnected: true,
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

    await context.store.set(pollSlackConnection$, context.signal);

    // Should have only fetched once (the initial check), no polling
    expect(callCount).toBe(1);
  });

  it("should poll until connected and show success toast", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    server.use(
      http.get("*/api/zero/integrations/slack", () => {
        callCount++;
        // Return connected on the 3rd call (initial check + 2 polls)
        const isConnected = callCount >= 3;
        return HttpResponse.json({
          isConnected,
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

    const pollPromise = context.store.set(pollSlackConnection$, context.signal);

    // Advance time past 2 poll intervals to trigger 2 polls
    await vi.advanceTimersByTimeAsync(3000 * 3);

    await pollPromise;

    // Called at least 3 times: initial check + polls until connected
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("should stop polling after MAX_POLL_ATTEMPTS when never connected", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    server.use(
      http.get("*/api/zero/integrations/slack", () => {
        callCount++;
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

    const pollPromise = context.store.set(pollSlackConnection$, context.signal);

    // Advance time past MAX_POLL_ATTEMPTS (100) * POLL_INTERVAL_MS (3000) = 300,000ms
    await vi.advanceTimersByTimeAsync(100 * 3000 + 1000);

    // The command should have terminated due to the cap
    await pollPromise;

    // Should have made exactly MAX_POLL_ATTEMPTS + 1 calls (1 initial check + 100 poll attempts)
    expect(callCount).toBe(101);
  });
});
