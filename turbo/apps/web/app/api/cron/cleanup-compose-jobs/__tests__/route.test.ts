import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import {
  createTestComposeJob,
  findTestComposeJob,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request("http://localhost:3000/api/cron/cleanup-compose-jobs", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("GET /api/cron/cleanup-compose-jobs", () => {
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

  it("should return empty results when no stale jobs exist", async () => {
    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(0);
    expect(body.results).toEqual([]);
  });

  it("should clean up stale pending and running jobs", async () => {
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const pendingId = await createTestComposeJob({
      status: "pending",
      createdAt: staleTime,
    });
    const runningId = await createTestComposeJob({
      status: "running",
      createdAt: staleTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(2);

    const pending = await findTestComposeJob(pendingId);
    expect(pending?.status).toBe("failed");
    expect(pending?.error).toContain("timed out");

    const running = await findTestComposeJob(runningId);
    expect(running?.status).toBe("failed");
  });

  it("should not touch recent or already-completed jobs", async () => {
    const recentTime = new Date();
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);

    const recentId = await createTestComposeJob({
      status: "pending",
      createdAt: recentTime,
    });
    const completedId = await createTestComposeJob({
      status: "completed",
      createdAt: staleTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(0);

    const recent = await findTestComposeJob(recentId);
    expect(recent?.status).toBe("pending");

    const completed = await findTestComposeJob(completedId);
    expect(completed?.status).toBe("completed");
  });

  it("should update each job individually", async () => {
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const id1 = await createTestComposeJob({
      status: "pending",
      createdAt: staleTime,
    });
    const id2 = await createTestComposeJob({
      status: "running",
      createdAt: staleTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(body.cleaned).toBe(2);
    expect(body.results).toHaveLength(2);

    const jobIds = body.results.map((r: { jobId: string }) => r.jobId);
    expect(jobIds).toContain(id1);
    expect(jobIds).toContain(id2);

    for (const result of body.results) {
      expect(result.status).toBe("cleaned");
    }
  });
});
