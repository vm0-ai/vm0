import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { insertPendingOutboundCall } from "../../../../../src/__tests__/db-test-seeders/phone";
import { findPendingOutboundCall } from "../../../../../src/__tests__/db-test-assertions/phone";
import { reloadEnv } from "../../../../../src/env";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request("http://localhost:3000/api/cron/phone-cleanup", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("GET /api/cron/phone-cleanup", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    reloadEnv();
  });

  it("should return 401 with invalid cron secret", async () => {
    const response = await GET(cronRequest("wrong-secret"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect((body as { error: { code: string } }).error.code).toBe(
      "UNAUTHORIZED",
    );
  });

  it("should return 401 with no authorization header", async () => {
    const response = await GET(cronRequest());
    expect(response.status).toBe(401);
  });

  it("should return zero cleaned when no stale rows exist", async () => {
    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect((body as { success: boolean; cleaned: number }).success).toBe(true);
    expect((body as { success: boolean; cleaned: number }).cleaned).toBe(0);
  });

  it("should delete pending outbound call rows older than 24h", async () => {
    const user = await context.setupUser();
    const callId = uniqueId("call-stale");
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago

    await insertPendingOutboundCall({
      callId,
      orgId: user.orgId,
      userId: user.userId,
      agentId: "00000000-0000-0000-0000-000000000001",
      createdAt: staleTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect((body as { cleaned: number }).cleaned).toBe(1);
    expect(await findPendingOutboundCall(callId)).toBeUndefined();
  });

  it("should not delete recent pending outbound call rows (<24h)", async () => {
    const user = await context.setupUser();
    const callId = uniqueId("call-fresh");

    await insertPendingOutboundCall({
      callId,
      orgId: user.orgId,
      userId: user.userId,
      agentId: "00000000-0000-0000-0000-000000000002",
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect((body as { cleaned: number }).cleaned).toBe(0);
    expect(await findPendingOutboundCall(callId)).toBeDefined();
  });
});
