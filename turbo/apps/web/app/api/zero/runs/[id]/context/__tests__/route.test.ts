import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import type { RunContextSnapshot } from "../../../../../../../src/lib/shared/axiom/client";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zctx");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function contextUrl(runId: string): string {
  return `http://localhost:3000/api/zero/runs/${runId}/context`;
}

function makeSnapshot(runId: string, userId: string): RunContextSnapshot {
  return {
    runId,
    userId,
    prompt: "test prompt",
    appendSystemPrompt: null,
    sessionId: null,
    secretNames: ["API_KEY", "DB_PASSWORD"],
    environment: {
      NODE_ENV: "production",
      API_KEY: "***",
    },
    firewalls: [
      {
        name: "test-fw",
        ref: "test-ref",
        apis: [
          {
            base: "https://api.example.com",
            permissions: [
              {
                name: "read",
                rules: ["GET /users/*"],
              },
            ],
          },
        ],
      },
    ],
    volumes: [
      {
        name: "data",
        mountPath: "/data",
        vasStorageName: "vol-1",
        vasVersionId: "ver-1",
      },
    ],
    artifact: {
      mountPath: "/artifacts",
      vasStorageName: "art-1",
      vasVersionId: "art-ver-1",
    },
    memory: null,
    networkPolicies: null,
    featureFlags: { computerUse: true, voiceChat: false },
  };
}

describe("GET /api/zero/runs/:id/context", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return run context snapshot", async () => {
    const userId = uniqueId("zctx-get");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zctx")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "running",
      prompt: "test prompt",
    });

    const snapshot = makeSnapshot(runId, userId);
    context.mocks.axiom.queryAxiom.mockResolvedValue([snapshot]);

    const response = await GET(createTestRequest(contextUrl(runId)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.prompt).toBe("test prompt");
    expect(data.runId).toBe(runId);
    expect(data.sessionId).toBeNull();
    expect(data.secretNames).toEqual(["API_KEY", "DB_PASSWORD"]);
    expect(data.environment).toEqual({
      NODE_ENV: "production",
      API_KEY: "***",
    });
    expect(data.firewalls).toHaveLength(1);
    expect(data.firewalls[0].name).toBe("test-fw");
    expect(data.volumes).toHaveLength(1);
    expect(data.artifact).toBeDefined();
    expect(data.memory).toBeNull();
    expect(data.networkPolicies).toBeNull();
    expect(data.featureFlags).toEqual({ computerUse: true, voiceChat: false });
  });

  it("should return 404 when run not found", async () => {
    const userId = uniqueId("zctx-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(contextUrl(randomUUID())));
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 when context not available", async () => {
    const userId = uniqueId("zctx-nc");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zctx")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "running",
    });

    context.mocks.axiom.queryAxiom.mockResolvedValue([]);

    const response = await GET(createTestRequest(contextUrl(runId)));
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error.message).toBe("Run context not available");
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/runs/some-id/context"),
    );
    expect(response.status).toBe(401);
  });
});
