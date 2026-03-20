import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  agentDisplayName$,
  defaultAgentMetadata$,
} from "../zero-agent-name.ts";

const context = testContext();

function mockOnboardingStatus(overrides: Record<string, unknown>) {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: false,
        isAdmin: true,
        hasOrg: true,
        hasModelProvider: true,
        hasDefaultAgent: true,
        defaultAgentName: "zero",
        defaultAgentComposeId: "mock-compose-id",
        defaultAgentMetadata: null,
        defaultAgentSkills: [],
        ...overrides,
      });
    }),
  );
}

describe("defaultAgentMetadata$", () => {
  it("should return metadata when available", async () => {
    mockOnboardingStatus({
      defaultAgentMetadata: { displayName: "My Agent", sound: "friendly" },
    });

    await setupPage({ context, path: "/", withoutRender: true });

    const metadata = await context.store.get(defaultAgentMetadata$);
    expect(metadata).toStrictEqual({
      displayName: "My Agent",
      sound: "friendly",
    });
  });

  it("should return null when metadata is not set", async () => {
    mockOnboardingStatus({ defaultAgentMetadata: null });

    await setupPage({ context, path: "/", withoutRender: true });

    const metadata = await context.store.get(defaultAgentMetadata$);
    expect(metadata).toBeNull();
  });
});

describe("agentDisplayName$", () => {
  it("should return metadata displayName when available", async () => {
    mockOnboardingStatus({
      defaultAgentName: "abc-123",
      defaultAgentMetadata: { displayName: "My Agent" },
    });

    await setupPage({ context, path: "/", withoutRender: true });

    const name = await context.store.get(agentDisplayName$);
    expect(name).toBe("My Agent");
  });

  it("should capitalize agent name when metadata has no displayName", async () => {
    mockOnboardingStatus({
      defaultAgentName: "zero",
      defaultAgentMetadata: null,
    });

    await setupPage({ context, path: "/", withoutRender: true });

    const name = await context.store.get(agentDisplayName$);
    expect(name).toBe("Zero");
  });

  it("should fall back to 'Zero' when no agent name is set", async () => {
    mockOnboardingStatus({
      defaultAgentName: null,
      defaultAgentMetadata: null,
    });

    await setupPage({ context, path: "/", withoutRender: true });

    const name = await context.store.get(agentDisplayName$);
    expect(name).toBe("Zero");
  });
});
