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
  displayName?: string;
  sound?: string;
  avatarUrl?: string;
}

interface InstructionsPayload {
  content: string;
}

describe("completeZeroOnboarding$", () => {
  it("should create agent via zero agents api with metadata", async () => {
    let capturedPayload: CreateAgentPayload | null = null;
    let capturedInstructions: InstructionsPayload | null = null;

    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as CreateAgentPayload;
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: capturedPayload.displayName ?? null,
            sound: capturedPayload.sound ?? null,
            avatarUrl: null,
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put(
        "*/api/zero/agents/d0000000-0000-4000-a000-000000000001/instructions",
        async ({ request }) => {
          capturedInstructions = (await request.json()) as InstructionsPayload;
          return HttpResponse.json({
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          });
        },
      ),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({
          agentId: "d0000000-0000-4000-a000-000000000001",
        });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Set agent name to a user-facing display name
    context.store.set(setZeroAgentName$, "My Assistant");

    await context.store.set(completeZeroOnboarding$, context.signal);

    // Verify agent was created with metadata (no connectors in create body)
    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.displayName).toBe("My Assistant");
    expect(capturedPayload!.sound).toBe("professional");

    // Instructions should be SEED_INSTRUCTIONS
    expect(capturedInstructions).toBeTruthy();
    expect(capturedInstructions!.content).toBe(SEED_INSTRUCTIONS);
  });

  it("should set user-connectors after creating agent when connectors are selected", async () => {
    let capturedUserConnectorsBody: { enabledTypes: string[] } | null = null;

    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put(
        "*/api/zero/agents/d0000000-0000-4000-a000-000000000001/instructions",
        () => {
          return HttpResponse.json({
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          });
        },
      ),
      http.put(
        "*/api/zero/agents/d0000000-0000-4000-a000-000000000001/user-connectors",
        async ({ request }) => {
          capturedUserConnectorsBody = (await request.json()) as {
            enabledTypes: string[];
          };
          return HttpResponse.json({ enabledTypes: ["slack"] });
        },
      ),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({
          agentId: "d0000000-0000-4000-a000-000000000001",
        });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Select a user connector
    context.store.set(toggleZeroConnector$, "slack");

    await context.store.set(completeZeroOnboarding$, context.signal);

    // User-selected connectors sent to user-connectors API (not create body)
    expect(capturedUserConnectorsBody).toBeTruthy();
    expect(capturedUserConnectorsBody!.enabledTypes).toStrictEqual(["slack"]);
  });

  it("should set default agent after creating compose", async () => {
    let defaultAgentBody: Record<string, unknown> | null = null;

    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put(
        "*/api/zero/agents/d0000000-0000-4000-a000-000000000001/instructions",
        () => {
          return HttpResponse.json({
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          });
        },
      ),
      http.put("*/api/zero/default-agent", async ({ request }) => {
        defaultAgentBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          agentId: "d0000000-0000-4000-a000-000000000001",
        });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(defaultAgentBody).toStrictEqual({
      agentId: "d0000000-0000-4000-a000-000000000001",
    });
  });

  it("should reset saving to false after completion (step remains unchanged)", async () => {
    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put(
        "*/api/zero/agents/d0000000-0000-4000-a000-000000000001/instructions",
        () => {
          return HttpResponse.json({
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          });
        },
      ),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({
          agentId: "d0000000-0000-4000-a000-000000000001",
        });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ ok: true });
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
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Build failed: sandbox error",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
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
    await expect(context.store.get(zeroOnboardingStep$)).resolves.toBe("4");
  });

  it("should clear error state on successful retry", async () => {
    // First call: fail
    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          { error: { message: "Build failed", code: "INTERNAL_SERVER_ERROR" } },
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
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put(
        "*/api/zero/agents/d0000000-0000-4000-a000-000000000001/instructions",
        () => {
          return HttpResponse.json({
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          });
        },
      ),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({
          agentId: "d0000000-0000-4000-a000-000000000001",
        });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(context.store.get(zeroOnboardingError$)).toBeNull();
    // Step is no longer auto-set to "done" by completeZeroOnboarding$;
    // callers use dismissZeroOnboarding$ to dismiss the dialog.
    await expect(context.store.get(zeroOnboardingStep$)).resolves.toBe("4");
  });
});

describe("completeZeroOnboarding$ avatar", () => {
  it("should send preset:0 as avatarUrl for the lead agent", async () => {
    let capturedPayload: Record<string, unknown> | null = null;

    server.use(
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: capturedPayload.avatarUrl ?? null,
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put(
        "*/api/zero/agents/d0000000-0000-4000-a000-000000000001/instructions",
        () => {
          return HttpResponse.json({
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          });
        },
      ),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({
          agentId: "d0000000-0000-4000-a000-000000000001",
        });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.avatarUrl).toBe("preset:0");
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
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put(
        "*/api/zero/agents/d0000000-0000-4000-a000-000000000001/instructions",
        () => {
          return HttpResponse.json({
            name: "test-agent-uuid",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
          });
        },
      ),
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({
          agentId: "d0000000-0000-4000-a000-000000000001",
        });
      }),
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(capturedProviderBody).not.toBeNull();
    expect(capturedProviderBody!.type).toBe("vm0");
    expect(capturedProviderBody!.selectedModel).toBe("claude-sonnet-4.6");
  });
});
