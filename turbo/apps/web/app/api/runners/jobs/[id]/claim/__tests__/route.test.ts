import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCliToken,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

// OFFICIAL_RUNNER_SECRET is set in setup.ts
const OFFICIAL_RUNNER_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("POST /api/runners/jobs/:id/claim", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("Authentication - getRunnerAuth behavior", () => {
    const testRunId = randomUUID();

    describe("with no Authorization header", () => {
      it("should return 401", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });
    });

    describe("with non-Bearer token", () => {
      it("should return 401", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Basic sometoken",
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });
    });

    describe("with sandbox JWT token", () => {
      it("should return 401 (sandbox tokens rejected on runner endpoints)", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer header.payload.signature",
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });
    });

    describe("with official runner token", () => {
      it("should return 401 when secret does not match", async () => {
        const wrongSecret = "wrong_secret_that_does_not_match_at_all_here";
        const token = `vm0_official_${wrongSecret}`;

        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });

      it("should return 401 when secret has different length (timing-safe)", async () => {
        const shortSecret = "short";
        const token = `vm0_official_${shortSecret}`;

        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });

      it("should authenticate successfully with valid secret (job not found)", async () => {
        const token = `vm0_official_${OFFICIAL_RUNNER_SECRET}`;

        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        // Auth succeeds, but job not found (no job in queue)
        expect(response.status).toBe(404);
        expect(data.error.message).toContain("Job not found");
      });
    });

    describe("with CLI token", () => {
      it("should return 401 when token is not found in database", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer vm0_live_nonexistent_token",
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });

      it("should authenticate successfully with valid token (job not found)", async () => {
        const token = await createTestCliToken(user.userId);

        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        // Auth succeeds, but job not found (no job in queue)
        expect(response.status).toBe(404);
        expect(data.error.message).toContain("Job not found");
      });
    });

    describe("with unknown token format", () => {
      it("should return 401 for random string", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer random_unknown_token",
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });
    });
  });
});
