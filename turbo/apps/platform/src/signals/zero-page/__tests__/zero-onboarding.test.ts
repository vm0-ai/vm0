import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  completeZeroOnboarding$,
  setZeroAgentName$,
  setZeroStep$,
  toggleZeroConnector$,
  zeroOnboardingStep$,
  zeroOnboardingError$,
  zeroSaving$,
} from "../zero-onboarding.ts";
import { SEED_INSTRUCTIONS } from "../../../data/the-seed.ts";

const context = testContext();

interface CreateAgentPayload {
  connectors: string[];
  displayName?: string;
  sound?: string;
}

interface InstructionsPayload {
  content: string;
}

describe("completeZeroOnboarding$", () => {
  it("should create agent via zero agents api with connectors and metadata", async () => {
    let capturedPayload: CreateAgentPayload | null = null;
    let capturedInstructions: InstructionsPayload | null = null;

    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          { provider: { id: "mp-1", type: "vm0" }, created: true },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as CreateAgentPayload;
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "new-compose-id",
            description: null,
            displayName: capturedPayload.displayName ?? null,
            sound: capturedPayload.sound ?? null,
            connectors: capturedPayload.connectors,
          },
          { status: 201 },
        );
      }),
      http.put(
        "*/api/zero/agents/new-compose-id/instructions",
        async ({ request }) => {
          capturedInstructions = (await request.json()) as InstructionsPayload;
          return HttpResponse.json({
            name: "test-agent-uuid",
            agentId: "new-compose-id",
            description: null,
            displayName: null,
            sound: null,
            connectors: [],
          });
        },
      ),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ success: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Set agent name to a user-facing display name
    context.store.set(setZeroAgentName$, "My Assistant");

    await context.store.set(completeZeroOnboarding$, context.signal);

    // Verify agent was created — frontend sends only user connectors (empty)
    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.connectors).toStrictEqual([]);
    expect(capturedPayload!.displayName).toBe("My Assistant");
    expect(capturedPayload!.sound).toBe("professional");

    // Instructions should be SEED_INSTRUCTIONS
    expect(capturedInstructions).toBeTruthy();
    expect(capturedInstructions!.content).toBe(SEED_INSTRUCTIONS);
  });

  it("should send only user-selected connectors (server adds seed skills)", async () => {
    let capturedPayload: CreateAgentPayload | null = null;

    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          { provider: { id: "mp-1", type: "vm0" }, created: true },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as CreateAgentPayload;
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "new-compose-id",
            description: null,
            displayName: null,
            sound: null,
            connectors: capturedPayload.connectors,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-compose-id/instructions", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ success: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Select a user connector
    context.store.set(toggleZeroConnector$, "slack");

    await context.store.set(completeZeroOnboarding$, context.signal);

    // Only user-selected connectors sent (server injects seed skills)
    expect(capturedPayload!.connectors).toStrictEqual(["slack"]);
  });

  it("should set default agent after creating compose", async () => {
    let defaultAgentBody: Record<string, unknown> | null = null;

    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          { provider: { id: "mp-1", type: "vm0" }, created: true },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "new-compose-id",
            description: null,
            displayName: null,
            sound: null,
            connectors: [],
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-compose-id/instructions", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/zero/default-agent", async ({ request }) => {
        defaultAgentBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ success: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(defaultAgentBody).toStrictEqual({
      agentId: "new-compose-id",
    });
  });

  it("should reset saving to false after completion (step remains unchanged)", async () => {
    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          { provider: { id: "mp-1", type: "vm0" }, created: true },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "new-compose-id",
            description: null,
            displayName: null,
            sound: null,
            connectors: [],
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-compose-id/instructions", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ success: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    // Step no longer auto-set to "done"; callers use dismissZeroOnboarding$
    expect(context.store.get(zeroSaving$)).toBeFalsy();
  });

  it("should set error state and reset saving on build failure", async () => {
    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          { provider: { id: "mp-1", type: "vm0" }, created: true },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          { error: { message: "Build failed: sandbox error" } },
          { status: 500 },
        );
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Set step to "4" so we can verify it doesn't change to "done"
    context.store.set(setZeroStep$, "4");

    // Should NOT throw — error is caught internally
    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(context.store.get(zeroOnboardingError$)).toBe(
      "Failed to create agent (500)",
    );
    expect(context.store.get(zeroSaving$)).toBeFalsy();
    expect(context.store.get(zeroOnboardingStep$)).toBe("4");
  });

  it("should clear error state on successful retry", async () => {
    // First call: fail
    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          { provider: { id: "mp-1", type: "vm0" }, created: true },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          { error: { message: "Build failed" } },
          { status: 500 },
        );
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });
    context.store.set(setZeroStep$, "4");

    await context.store.set(completeZeroOnboarding$, context.signal);
    expect(context.store.get(zeroOnboardingError$)).toBeTruthy();

    // Second call: succeed
    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          { provider: { id: "mp-1", type: "vm0" }, created: true },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "new-compose-id",
            description: null,
            displayName: null,
            sound: null,
            connectors: [],
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-compose-id/instructions", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ success: true });
      }),
    );

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(context.store.get(zeroOnboardingError$)).toBeNull();
    // Step is no longer auto-set to "done" by completeZeroOnboarding$;
    // callers use dismissZeroOnboarding$ to dismiss the dialog.
    expect(context.store.get(zeroOnboardingStep$)).toBe("4");
  });
});

describe("completeZeroOnboarding$ auto-init model provider", () => {
  it("should auto-create vm0 model provider with claude-sonnet-4.6 before creating agent", async () => {
    let capturedProviderBody: Record<string, unknown> | null = null;

    server.use(
      http.post("*/api/zero/model-providers", async ({ request }) => {
        capturedProviderBody = (await request.json()) as Record<
          string,
          unknown
        >;
        return HttpResponse.json(
          { provider: { id: "mp-1", type: "vm0" }, created: true },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "new-compose-id",
            description: null,
            displayName: null,
            sound: null,
            connectors: [],
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-compose-id/instructions", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ success: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(capturedProviderBody).not.toBeNull();
    expect(capturedProviderBody!.type).toBe("vm0");
    expect(capturedProviderBody!.selectedModel).toBe("claude-sonnet-4.6");
  });
});
