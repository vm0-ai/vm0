import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { POST, GET } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  createTestRequest,
  insertTestExportJob,
} from "../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";

const context = testContext();

async function seedCompletedExport(user: {
  readonly userId: string;
  readonly orgId: string;
}) {
  return insertTestExportJob(user.orgId, {
    userId: user.userId,
    status: "completed",
    s3Key: `exports/${user.userId}/data.zip`,
    completedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

describe("POST /api/user/export", () => {
  it("forwards the request to the api backend", async () => {
    const forwardedHeaders: Headers[] = [];
    const handler = http.post(
      "http://localhost:3001/api/user/export",
      async ({ request }) => {
        forwardedHeaders.push(request.headers);
        return HttpResponse.json(
          { jobId: "11111111-1111-4111-8111-111111111111", status: "pending" },
          { status: 202 },
        );
      },
    );
    server.use(handler.handler);

    const response = await POST(
      new Request("http://localhost:3000/api/user/export", {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          cookie: "__session=session-token",
        },
      }),
    );

    await expect(response.json()).resolves.toStrictEqual({
      jobId: "11111111-1111-4111-8111-111111111111",
      status: "pending",
    });
    expect(response.status).toBe(202);
    expect(forwardedHeaders[0]?.get("authorization")).toBe(
      "Bearer clerk-session",
    );
    expect(forwardedHeaders[0]?.get("cookie")).toBe("__session=session-token");
    expect(forwardedHeaders[0]?.get("x-forwarded-host")).toBe("localhost:3000");
    expect(forwardedHeaders[0]?.get("x-forwarded-proto")).toBe("http");
  });
});

function createGetExportRequest() {
  return createTestRequest("http://localhost:3000/api/user/export", {
    method: "GET",
  });
}

describe("GET /api/user/export", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("Authentication", () => {
    it("should reject unauthenticated request", async () => {
      mockClerk({ userId: null });

      const response = await GET(createGetExportRequest());

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("No previous exports", () => {
    it("should return null job and canExport true", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      const response = await GET(createGetExportRequest());

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.job).toBeNull();
      expect(data.canExport).toBe(true);
      expect(data.nextExportAt).toBeNull();
    });
  });

  describe("Completed export with download URL", () => {
    it("should return job with downloadUrl when completed and not expired", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      await seedCompletedExport(user);

      const response = await GET(createGetExportRequest());

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.job).toBeDefined();
      expect(data.job.status).toBe("completed");
      expect(data.job.downloadUrl).toBeDefined();
      expect(data.job.completedAt).toBeDefined();
      expect(data.job.expiresAt).toBeDefined();
      expect(data.canExport).toBe(false);
      expect(data.nextExportAt).toBeDefined();
    });
  });

  describe("Pending/running export", () => {
    it("should return pending job and canExport false", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      await insertTestExportJob(user.orgId, {
        userId: user.userId,
        status: "pending",
      });

      const response = await GET(createGetExportRequest());

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.job).toBeDefined();
      expect(data.job.status).toBe("pending");
      expect(data.job.downloadUrl).toBeNull();
      expect(data.canExport).toBe(false);
    });
  });

  describe("Rate limited state", () => {
    it("should return canExport false and nextExportAt when rate limited", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      await seedCompletedExport(user);

      const response = await GET(createGetExportRequest());

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.job?.status).toBe("completed");
      expect(data.canExport).toBe(false);
      expect(data.nextExportAt).toBeDefined();
    });
  });

  describe("Can export after cooldown", () => {
    it("should return canExport true after 24 hours", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      await seedCompletedExport(user);

      // Time travel 25 hours
      const twentyFiveHoursLater = new Date(Date.now() + 25 * 60 * 60 * 1000);
      context.mocks.date.setSystemTime(twentyFiveHoursLater);

      const response = await GET(createGetExportRequest());

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.canExport).toBe(true);
    });
  });

  describe("Failed export", () => {
    it("should return failed job with error", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      await insertTestExportJob(user.orgId, {
        userId: user.userId,
        status: "failed",
        error: "S3 upload failed",
      });

      const response = await GET(createGetExportRequest());

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.job).toBeDefined();
      expect(data.job.status).toBe("failed");
      expect(data.job.error).toBeDefined();
      expect(data.canExport).toBe(true);
    });
  });
});
