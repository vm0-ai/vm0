import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  completeZeroOnboarding$,
  saveZeroModelProvider$,
  setZeroAgentName$,
  setZeroProviderType$,
  setZeroStep$,
  toggleZeroSkill$,
  zeroCanSave$,
  zeroFormValues$,
  zeroOnboardingStep$,
  zeroOnboardingError$,
  zeroSaving$,
} from "../zero-onboarding.ts";
import { SEED_INSTRUCTIONS, SEED_SKILLS } from "../../../data/the-seed.ts";

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
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as CreateAgentPayload;
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentComposeId: "new-compose-id",
          description: null,
          displayName: capturedPayload.displayName ?? null,
          sound: capturedPayload.sound ?? null,
          connectors: capturedPayload.connectors,
        });
      }),
      http.put(
        "*/api/zero/agents/test-agent-uuid/instructions",
        async ({ request }) => {
          capturedInstructions = (await request.json()) as InstructionsPayload;
          return HttpResponse.json({
            name: "test-agent-uuid",
            agentComposeId: "new-compose-id",
            description: null,
            displayName: null,
            sound: null,
            connectors: [],
          });
        },
      ),
      http.put("*/api/orgs/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Set agent name to a user-facing display name
    context.store.set(setZeroAgentName$, "My Assistant");

    await context.store.set(completeZeroOnboarding$, context.signal);

    // Verify agent was created with connectors
    expect(capturedPayload).toBeTruthy();
    expect(capturedPayload!.connectors).toStrictEqual([...SEED_SKILLS]);
    expect(capturedPayload!.displayName).toBe("My Assistant");
    expect(capturedPayload!.sound).toBe("professional");

    // Instructions should be SEED_INSTRUCTIONS
    expect(capturedInstructions).toBeTruthy();
    expect(capturedInstructions!.content).toBe(SEED_INSTRUCTIONS);
  });

  it("should merge user-selected skills with seed skills and deduplicate", async () => {
    let capturedPayload: CreateAgentPayload | null = null;

    server.use(
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as CreateAgentPayload;
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentComposeId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: capturedPayload.connectors,
        });
      }),
      http.put("*/api/zero/agents/test-agent-uuid/instructions", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentComposeId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/orgs/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Select a connector skill and a duplicate seed skill
    context.store.set(toggleZeroSkill$, "slack");
    context.store.set(toggleZeroSkill$, "vm0"); // duplicate of seed skill

    await context.store.set(completeZeroOnboarding$, context.signal);

    // All seed skills + "slack" (vm0 deduplicated)
    const expectedConnectors = [...SEED_SKILLS, "slack"];
    expect(capturedPayload!.connectors).toStrictEqual(expectedConnectors);
  });

  it("should set default agent after creating compose", async () => {
    let defaultAgentBody: Record<string, unknown> | null = null;

    server.use(
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentComposeId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/zero/agents/test-agent-uuid/instructions", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentComposeId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/orgs/default-agent", async ({ request }) => {
        defaultAgentBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(defaultAgentBody).toStrictEqual({
      agentComposeId: "new-compose-id",
    });
  });

  it("should set step to done and saving to false after completion", async () => {
    server.use(
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentComposeId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/zero/agents/test-agent-uuid/instructions", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentComposeId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/orgs/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(context.store.get(zeroOnboardingStep$)).toBe("done");
    expect(context.store.get(zeroSaving$)).toBeFalsy();
  });

  it("should set error state and reset saving on build failure", async () => {
    server.use(
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
      "Build failed: sandbox error",
    );
    expect(context.store.get(zeroSaving$)).toBeFalsy();
    expect(context.store.get(zeroOnboardingStep$)).toBe("4");
  });

  it("should clear error state on successful retry", async () => {
    // First call: fail
    server.use(
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
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentComposeId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/zero/agents/test-agent-uuid/instructions", () => {
        return HttpResponse.json({
          name: "test-agent-uuid",
          agentComposeId: "new-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
        });
      }),
      http.put("*/api/orgs/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(context.store.get(zeroOnboardingError$)).toBeNull();
    expect(context.store.get(zeroOnboardingStep$)).toBe("done");
  });
});

describe("zero-onboarding vm0 no-secret provider", () => {
  it("should allow saving without a secret for vm0 provider", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    // Switch to vm0 provider type
    context.store.set(setZeroProviderType$, "vm0");

    // zeroCanSave$ should return true without entering any secret
    const canSave = context.store.get(zeroCanSave$);
    expect(canSave).toBeTruthy();
  });

  it("should initialize useDefaultModel to false when provider has a default model", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    // Switch to vm0 provider — vm0 has a default model (claude-sonnet-4.6)
    context.store.set(setZeroProviderType$, "vm0");

    const formValues = context.store.get(zeroFormValues$);
    expect(formValues.useDefaultModel).toBeFalsy();
    expect(formValues.selectedModel).toBe("claude-sonnet-4.6");
  });

  it("should not include secret in request when saving vm0 provider", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.post("*/api/zero/model-providers", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            provider: {
              id: "test-id",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: (capturedBody.selectedModel as string) ?? null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            created: true,
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Switch to vm0 provider type
    context.store.set(setZeroProviderType$, "vm0");

    // Save the model provider
    await context.store.set(saveZeroModelProvider$, context.signal);

    // Should have sent the request
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.type).toBe("vm0");

    // Should NOT include a secret field
    expect(capturedBody).not.toHaveProperty("secret");

    // Should include the pre-selected model
    expect(capturedBody!.selectedModel).toBe("claude-sonnet-4.6");
  });
});
