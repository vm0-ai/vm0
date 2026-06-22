/**
 * Tests for zero workflow ref resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { resolveWorkflowRef } from "../ref";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_AGENT_ID = "33333333-3333-3333-3333-333333333333";
const WORKFLOW_ID = "22222222-2222-2222-2222-222222222222";

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "my-agent",
    agentDisplayName: "My Agent",
    name: "daily-brief",
    displayName: "Daily Brief",
    description: null,
    visibility: "private",
    requestToPublish: false,
    ownerUserId: "user-123",
    canManage: true,
    ...overrides,
  };
}

describe("resolveWorkflowRef", () => {
  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    vi.stubEnv("ZERO_AGENT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns UUID refs without lookup", async () => {
    await expect(resolveWorkflowRef(WORKFLOW_ID)).resolves.toBe(WORKFLOW_ID);
  });

  it("resolves a name under ZERO_AGENT_ID", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/workflows", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json([workflow()]);
      }),
    );
    vi.stubEnv("ZERO_AGENT_ID", AGENT_ID);

    await expect(resolveWorkflowRef("daily-brief")).resolves.toBe(WORKFLOW_ID);
    expect(capturedUrl?.searchParams.get("agentId")).toBe(AGENT_ID);
  });

  it("resolves a name under an agent name", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/workflows", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json([
          workflow({ agentId: OTHER_AGENT_ID, agentName: "other-agent" }),
          workflow(),
        ]);
      }),
    );

    await expect(
      resolveWorkflowRef("daily-brief", { agent: "my-agent" }),
    ).resolves.toBe(WORKFLOW_ID);
    expect(capturedUrl?.searchParams.has("agentId")).toBe(false);
  });

  it("requires an agent scope for name refs", async () => {
    await expect(resolveWorkflowRef("daily-brief")).rejects.toThrow(
      "Provide --agent",
    );
  });

  it("rejects missing workflow names", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/workflows", () => {
        return HttpResponse.json([]);
      }),
    );

    await expect(
      resolveWorkflowRef("daily-brief", { agent: AGENT_ID }),
    ).rejects.toThrow("not found");
  });

  it("rejects ambiguous workflow names", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/workflows", () => {
        return HttpResponse.json([
          workflow(),
          workflow({ id: "44444444-4444-4444-4444-444444444444" }),
        ]);
      }),
    );

    await expect(
      resolveWorkflowRef("daily-brief", { agent: AGENT_ID }),
    ).rejects.toThrow("ambiguous");
  });
});
