import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  completeZeroOnboarding$,
  setZeroAgentName$,
  zeroOnboardingStep$,
  zeroSaving$,
} from "../zero-onboarding.ts";

const context = testContext();

interface ComposePayload {
  content: {
    version: string;
    agents: Record<
      string,
      {
        framework: string;
        metadata?: { displayName?: string; sound?: string };
        skills?: string[];
      }
    >;
  };
}

describe("completeZeroOnboarding$", () => {
  it("should create compose with UUID key and metadata containing display name", async () => {
    let capturedPayload: ComposePayload | null = null;

    server.use(
      http.post("*/api/agent/composes", async ({ request }) => {
        capturedPayload = (await request.json()) as ComposePayload;
        return HttpResponse.json({
          composeId: "new-compose-id",
          name: "test-compose",
        });
      }),
      http.put("*/api/scopes/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Set agent name to a user-facing display name
    context.store.set(setZeroAgentName$, "My Assistant");

    await context.store.set(completeZeroOnboarding$, context.signal);

    // Verify compose was created
    expect(capturedPayload).toBeTruthy();

    // Agent key should be a UUID, not the display name
    const agentKeys = Object.keys(capturedPayload!.content.agents);
    expect(agentKeys).toHaveLength(1);
    const agentKey = agentKeys[0];
    expect(agentKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Display name should be in metadata
    const agentDef = capturedPayload!.content.agents[agentKey];
    expect(agentDef.metadata).toStrictEqual({
      displayName: "My Assistant",
      sound: "professional",
    });
    expect(agentDef.framework).toBe("claude-code");
  });

  it("should set default agent after creating compose", async () => {
    let defaultAgentBody: Record<string, unknown> | null = null;

    server.use(
      http.post("*/api/agent/composes", () => {
        return HttpResponse.json({
          composeId: "new-compose-id",
          name: "test-compose",
        });
      }),
      http.put("*/api/scopes/default-agent", async ({ request }) => {
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
      http.post("*/api/agent/composes", () => {
        return HttpResponse.json({
          composeId: "new-compose-id",
          name: "test-compose",
        });
      }),
      http.put("*/api/scopes/default-agent", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(completeZeroOnboarding$, context.signal);

    expect(context.store.get(zeroOnboardingStep$)).toBe("done");
    expect(context.store.get(zeroSaving$)).toBeFalsy();
  });
});
