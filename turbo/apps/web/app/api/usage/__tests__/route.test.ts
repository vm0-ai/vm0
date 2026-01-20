import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

// Mock the auth module
let mockUserId: string | null = "test-user-usage-api";
vi.mock("../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

// Mock the init-services module
vi.mock("../../../../src/lib/init-services", () => ({
  initServices: vi.fn(),
}));

// Mock database queries
const mockDailyResults = [
  { date: "2026-01-18", run_count: 5, run_time_ms: 300000 },
  { date: "2026-01-17", run_count: 3, run_time_ms: 180000 },
];

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    sql: actual.sql,
    and: actual.and,
    gte: actual.gte,
    lt: actual.lt,
    eq: actual.eq,
    isNotNull: actual.isNotNull,
  };
});

// Set up mock database
const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        groupBy: vi.fn(() => ({
          orderBy: vi.fn(() => Promise.resolve(mockDailyResults)),
        })),
      })),
    })),
  })),
};

// Mock globalThis.services
beforeEach(() => {
  mockUserId = "test-user-usage-api";
  (globalThis as Record<string, unknown>).services = {
    db: mockDb,
  };
});

describe("/api/usage", () => {
  describe("GET /api/usage", () => {
    it("should require authentication", async () => {
      mockUserId = null;

      const request = new NextRequest("http://localhost:3000/api/usage", {
        method: "GET",
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return usage data with default 7 day range", async () => {
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
      expect(data.summary.total_runs).toBe(8); // 5 + 3
      expect(data.summary.total_run_time_ms).toBe(480000); // 300000 + 180000
      expect(data.daily).toBeDefined();
      expect(Array.isArray(data.daily)).toBe(true);
    });

    it("should accept custom date range", async () => {
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
    });
  });
});
