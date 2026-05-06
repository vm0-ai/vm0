import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import {
  createTestTelegramInstallation,
  insertTestTelegramMessages,
  countTestTelegramMessages,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request("http://localhost:3000/api/cron/telegram-cleanup", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("GET /api/cron/telegram-cleanup", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    reloadEnv();
  });

  it("should return 401 with invalid cron secret", async () => {
    const response = await GET(cronRequest("wrong-secret"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should preserve recent messages and return deleted count", async () => {
    const installationId = await createTestTelegramInstallation();
    const recentDate = new Date();
    await insertTestTelegramMessages(installationId, 2, recentDate);

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(typeof body.deleted).toBe("number");
    expect(await countTestTelegramMessages(installationId)).toBe(2);
  });

  it("should delete messages older than 30 days", async () => {
    const installationId = await createTestTelegramInstallation();

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 31);
    await insertTestTelegramMessages(installationId, 3, oldDate);

    const recentDate = new Date();
    await insertTestTelegramMessages(installationId, 2, recentDate);

    expect(await countTestTelegramMessages(installationId)).toBe(5);

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deleted).toBeGreaterThanOrEqual(3);
    expect(await countTestTelegramMessages(installationId)).toBe(2);
  });

  it("should not delete messages within retention period", async () => {
    const installationId = await createTestTelegramInstallation();

    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 29);
    await insertTestTelegramMessages(installationId, 5, recentDate);

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(typeof body.deleted).toBe("number");
    expect(await countTestTelegramMessages(installationId)).toBe(5);
  });
});
