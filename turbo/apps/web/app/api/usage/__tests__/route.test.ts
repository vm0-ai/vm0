import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import {
  mockClerk,
  clearClerkMock,
} from "../../../../src/__tests__/clerk-mock";

describe("/api/usage", () => {
  const testUserId = `test-user-usage-${Date.now()}-${process.pid}`;
  const testScopeId = randomUUID();
  let testComposeId: string;
  let testVersionId: string;

  beforeAll(async () => {
    // Initialize real services
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-scope-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create test compose
    const composes = await globalThis.services.db
      .insert(agentComposes)
      .values({
        userId: testUserId,
        scopeId: testScopeId,
        name: "test-compose",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    testComposeId = composes[0]!.id;

    // Create test version (with content-addressed hash ID)
    // Use randomUUID to generate unique hash per test run
    const versionHash =
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: versionHash,
      composeId: testComposeId,
      content: { version: "1.0", agents: {} },
      createdBy: testUserId,
      createdAt: new Date(),
    });
    testVersionId = versionHash;
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock Clerk auth to return test user by default
    mockClerk({ userId: testUserId });
  });

  afterEach(async () => {
    clearClerkMock();
    // Clean up runs created during tests
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));
  });

  describe("GET /api/usage", () => {
    it("should require authentication", async () => {
      // Mock Clerk auth to return no user
      mockClerk({ userId: null });

      const request = new NextRequest("http://localhost:3000/api/usage", {
        method: "GET",
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return usage data with default 7 day range", async () => {
      // Mock Clerk auth to return test user
      mockClerk({ userId: testUserId });

      // Create test runs with completed data
      const now = new Date();
      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

      const threeDaysAgo = new Date(now);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      // Create 2 completed runs
      await globalThis.services.db.insert(agentRuns).values([
        {
          userId: testUserId,
          agentComposeVersionId: testVersionId,
          status: "completed",
          prompt: "Test prompt 1",
          createdAt: twoDaysAgo,
          startedAt: twoDaysAgo,
          completedAt: new Date(twoDaysAgo.getTime() + 60000), // 1 minute
        },
        {
          userId: testUserId,
          agentComposeVersionId: testVersionId,
          status: "completed",
          prompt: "Test prompt 2",
          createdAt: threeDaysAgo,
          startedAt: threeDaysAgo,
          completedAt: new Date(threeDaysAgo.getTime() + 120000), // 2 minutes
        },
      ]);

      const request = new NextRequest("http://localhost:3000/api/usage", {
        method: "GET",
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.period).toBeDefined();
      expect(data.period.start).toBeDefined();
      expect(data.period.end).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(data.summary.total_runs).toBe(2);
      expect(data.summary.total_run_time_ms).toBe(180000); // 60000 + 120000
      expect(data.daily).toBeDefined();
      expect(Array.isArray(data.daily)).toBe(true);
      expect(data.daily.length).toBeGreaterThan(0);
    });

    it("should accept custom date range", async () => {
      mockClerk({ userId: testUserId });

      const now = new Date();
      const threeDaysAgo = new Date(now);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      const request = new NextRequest(
        `http://localhost:3000/api/usage?start_date=${threeDaysAgo.toISOString()}&end_date=${now.toISOString()}`,
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.period.start).toBeDefined();
      expect(data.period.end).toBeDefined();
    });

    it("should reject invalid start_date format", async () => {
      mockClerk({ userId: testUserId });

      const request = new NextRequest(
        "http://localhost:3000/api/usage?start_date=invalid",
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Invalid start_date format");
    });

    it("should reject invalid end_date format", async () => {
      mockClerk({ userId: testUserId });

      const request = new NextRequest(
        "http://localhost:3000/api/usage?end_date=invalid",
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Invalid end_date format");
    });

    it("should reject start_date after end_date", async () => {
      mockClerk({ userId: testUserId });

      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);

      const request = new NextRequest(
        `http://localhost:3000/api/usage?start_date=${now.toISOString()}&end_date=${yesterday.toISOString()}`,
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain(
        "start_date must be before end_date",
      );
    });

    it("should reject range exceeding 30 days", async () => {
      mockClerk({ userId: testUserId });

      const now = new Date();
      const fortyDaysAgo = new Date(now);
      fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);

      const request = new NextRequest(
        `http://localhost:3000/api/usage?start_date=${fortyDaysAgo.toISOString()}&end_date=${now.toISOString()}`,
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("exceeds maximum of 30 days");
    });

    it("should return daily breakdown with run counts and run times", async () => {
      mockClerk({ userId: testUserId });

      // Create test runs on different days
      const now = new Date();
      const oneDayAgo = new Date(now);
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);

      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

      await globalThis.services.db.insert(agentRuns).values([
        {
          userId: testUserId,
          agentComposeVersionId: testVersionId,
          status: "completed",
          prompt: "Test prompt 3",
          createdAt: oneDayAgo,
          startedAt: oneDayAgo,
          completedAt: new Date(oneDayAgo.getTime() + 30000), // 30 seconds
        },
        {
          userId: testUserId,
          agentComposeVersionId: testVersionId,
          status: "completed",
          prompt: "Test prompt 4",
          createdAt: twoDaysAgo,
          startedAt: twoDaysAgo,
          completedAt: new Date(twoDaysAgo.getTime() + 45000), // 45 seconds
        },
      ]);

      const request = new NextRequest("http://localhost:3000/api/usage", {
        method: "GET",
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);

      // Check that daily data has expected structure
      expect(data.daily.length).toBeGreaterThan(0);
      for (const day of data.daily) {
        expect(day.date).toBeDefined();
        expect(typeof day.run_count).toBe("number");
        expect(typeof day.run_time_ms).toBe("number");
      }

      // Verify summary totals
      expect(data.summary.total_runs).toBe(2);
      expect(data.summary.total_run_time_ms).toBe(75000); // 30000 + 45000
    });
  });
});
