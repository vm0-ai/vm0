import { describe, it, expect } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  completeZeroOnboarding$,
  setZeroAgentName$,
  setZeroWorkspaceName$,
  toggleZeroConnector$,
} from "../zero-onboarding.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { onboardingSetupContract } from "@vm0/core/contracts/onboarding";

const context = testContext();
const mockApi = createMockApi(context);

interface SetupPayload {
  displayName?: string;
  workspaceName?: string;
  sound?: string;
  avatarUrl?: string;
  selectedConnectors?: string[];
}

function setupHandler(capturePayload?: (payload: SetupPayload) => void) {
  return mockApi(onboardingSetupContract.setup, ({ body, respond }) => {
    capturePayload?.(body as SetupPayload);
    return respond(200, { agentId: "d0000000-0000-4000-a000-000000000001" });
  });
}

describe("completeZeroOnboarding$", () => {
  it("should call setup API with correct metadata", async () => {
    let capturedPayload: SetupPayload | null = null;

    server.use(
      setupHandler((payload) => {
        capturedPayload = payload;
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    context.store.set(setZeroAgentName$, "My Assistant");

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.displayName).toBe("My Assistant");
    expect(capturedPayload!.sound).toBe("professional");
    expect(capturedPayload!.avatarUrl).toBe("preset:0");
  });

  it("should send selectedConnectors when user selects connectors", async () => {
    let capturedPayload: SetupPayload | null = null;

    server.use(
      setupHandler((payload) => {
        capturedPayload = payload;
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    context.store.set(toggleZeroConnector$, "slack");

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.selectedConnectors).toStrictEqual(["slack"]);
  });

  it("should send workspaceName when user sets workspace name", async () => {
    let capturedPayload: SetupPayload | null = null;

    server.use(
      setupHandler((payload) => {
        capturedPayload = payload;
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    context.store.set(setZeroWorkspaceName$, "My Workspace");

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.workspaceName).toBe("My Workspace");
  });

  it("should not send workspaceName when empty", async () => {
    let capturedPayload: SetupPayload | null = null;

    server.use(
      setupHandler((payload) => {
        capturedPayload = payload;
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.workspaceName).toBeUndefined();
  });

  it("should not send selectedConnectors when none selected", async () => {
    let capturedPayload: SetupPayload | null = null;

    server.use(
      setupHandler((payload) => {
        capturedPayload = payload;
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.selectedConnectors).toBeUndefined();
  });

  it("should return agentId from setup response", async () => {
    server.use(setupHandler());

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const agentId = await context.store.set(
      completeZeroOnboarding$,
      context.signal,
    );

    expect(agentId).toBe("d0000000-0000-4000-a000-000000000001");
  });

  it("should treat 409 conflict as success", async () => {
    server.use(
      mockApi(onboardingSetupContract.setup, ({ respond }) => {
        return respond(409, {
          agentId: "d0000000-0000-4000-a000-000000000002",
        });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const agentId = await context.store.set(
      completeZeroOnboarding$,
      context.signal,
    );

    expect(agentId).toBe("d0000000-0000-4000-a000-000000000002");
  });
});
