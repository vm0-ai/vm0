import { describe, it, expect } from "vitest";
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

    await context.store.set(pollSlackConnection$, context.signal);

    // Called at least 3 times: initial check + polls until connected
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("should stop polling after MAX_POLL_ATTEMPTS when never connected", async () => {
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

    await context.store.set(pollSlackConnection$, context.signal);

    // Should have made exactly MAX_POLL_ATTEMPTS + 1 calls (1 initial check + 100 poll attempts)
    expect(callCount).toBe(101);
  });
});
