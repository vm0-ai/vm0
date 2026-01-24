import { describe, it, expect } from "vitest";
import {
  generateSandboxToken,
  verifySandboxToken,
  isSandboxToken,
} from "../sandbox-token";

// Set required environment variables before any imports
process.env.SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("sandbox-token", () => {
  describe("generateSandboxToken", () => {
    it("should generate a token with vm0_sbx_ prefix", async () => {
      const token = await generateSandboxToken("user-123", "run-456");

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.startsWith("vm0_sbx_")).toBe(true);
      // JWT portion should have 3 parts
      const jwt = token.slice("vm0_sbx_".length);
      expect(jwt.split(".")).toHaveLength(3);
    });

    it("should generate different tokens for different runs", async () => {
      const token1 = await generateSandboxToken("user-123", "run-456");
      const token2 = await generateSandboxToken("user-123", "run-789");

      expect(token1).not.toBe(token2);
    });

    it("should generate different tokens for different users", async () => {
      const token1 = await generateSandboxToken("user-123", "run-456");
      const token2 = await generateSandboxToken("user-789", "run-456");

      expect(token1).not.toBe(token2);
    });
  });

  describe("verifySandboxToken", () => {
    it("should verify a valid token and return auth info", async () => {
      const token = await generateSandboxToken("user-123", "run-456");
      const auth = verifySandboxToken(token);

      expect(auth).not.toBeNull();
      expect(auth?.userId).toBe("user-123");
      expect(auth?.runId).toBe("run-456");
    });

    it("should return null for token without prefix", () => {
      const auth = verifySandboxToken("not-a-jwt-token");
      expect(auth).toBeNull();
    });

    it("should return null for pure JWT without prefix", () => {
      // Pure JWT format should be rejected
      const auth = verifySandboxToken("header.payload.signature");
      expect(auth).toBeNull();
    });

    it("should return null for tampered token", async () => {
      const token = await generateSandboxToken("user-123", "run-456");
      // Tamper with the token by modifying the payload portion
      const prefix = "vm0_sbx_";
      const jwt = token.slice(prefix.length);
      const parts = jwt.split(".");
      parts[1] = parts[1] + "tampered";
      const tamperedToken = prefix + parts.join(".");

      const auth = verifySandboxToken(tamperedToken);

      expect(auth).toBeNull();
    });

    it("should return null for token with invalid signature", async () => {
      const token = await generateSandboxToken("user-123", "run-456");
      // Replace signature with invalid one
      const prefix = "vm0_sbx_";
      const jwt = token.slice(prefix.length);
      const parts = jwt.split(".");
      parts[2] = "invalid-signature";
      const invalidToken = prefix + parts.join(".");

      const auth = verifySandboxToken(invalidToken);

      expect(auth).toBeNull();
    });

    it("should return null for expired token", async () => {
      // Generate token with current time
      const token = await generateSandboxToken("user-123", "run-456");

      // Mock time to be 3 hours in the future (beyond 2 hour expiration)
      const realDateNow = Date.now;
      Date.now = () => realDateNow() + 3 * 60 * 60 * 1000;

      try {
        const auth = verifySandboxToken(token);
        expect(auth).toBeNull();
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should verify token that is still within expiration", async () => {
      const token = await generateSandboxToken("user-123", "run-456");

      // Mock time to be 1 hour in the future (within 2 hour expiration)
      const realDateNow = Date.now;
      Date.now = () => realDateNow() + 1 * 60 * 60 * 1000;

      try {
        const auth = verifySandboxToken(token);
        expect(auth).not.toBeNull();
        expect(auth?.userId).toBe("user-123");
      } finally {
        Date.now = realDateNow;
      }
    });
  });

  describe("isSandboxToken", () => {
    it("should return true for tokens with vm0_sbx_ prefix", () => {
      expect(isSandboxToken("vm0_sbx_a.b.c")).toBe(true);
      expect(isSandboxToken("vm0_sbx_header.payload.signature")).toBe(true);
      expect(isSandboxToken("vm0_sbx_anything")).toBe(true);
    });

    it("should return false for pure JWT without prefix", () => {
      expect(isSandboxToken("a.b.c")).toBe(false);
      expect(isSandboxToken("header.payload.signature")).toBe(false);
    });

    it("should return false for CLI tokens", () => {
      expect(isSandboxToken("vm0_live_abc123")).toBe(false);
    });

    it("should return false for official runner tokens", () => {
      expect(isSandboxToken("vm0_official_secret")).toBe(false);
    });

    it("should return false for random strings", () => {
      expect(isSandboxToken("not-a-token")).toBe(false);
      expect(isSandboxToken("")).toBe(false);
    });
  });

  describe("roundtrip", () => {
    it("should correctly roundtrip userId and runId", async () => {
      const testCases = [
        { userId: "user_123", runId: "run_456" },
        { userId: "user-with-dashes", runId: "run-with-dashes" },
        {
          userId: "very-long-user-id-that-is-quite-lengthy",
          runId: "very-long-run-id-that-is-quite-lengthy",
        },
      ];

      for (const { userId, runId } of testCases) {
        const token = await generateSandboxToken(userId, runId);
        const auth = verifySandboxToken(token);

        expect(auth).not.toBeNull();
        expect(auth?.userId).toBe(userId);
        expect(auth?.runId).toBe(runId);
      }
    });
  });
});

/**
 * E2E Integration tests for sandbox token flow.
 * Tests the complete flow: run creation → token generation → sandbox → webhook verification
 */
import { vi, beforeEach, afterEach } from "vitest";
import { POST as createRun } from "../../../../app/api/agent/runs/route";
import { POST as sendEvents } from "../../../../app/api/webhooks/agent/events/route";
import { POST as sendHeartbeat } from "../../../../app/api/webhooks/agent/heartbeat/route";
import { POST as createCompose } from "../../../../app/api/agent/composes/route";
import { NextRequest } from "next/server";
import { initServices } from "../../init-services";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentComposes } from "../../../db/schema/agent-compose";
import { scopes } from "../../../db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
} from "../../../__tests__/api-test-helpers";
import { Sandbox } from "@e2b/code-interpreter";
import * as s3Client from "../../s3/s3-client";

// Mock external dependencies for E2E tests
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

vi.mock("@e2b/code-interpreter");

vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

vi.mock("@axiomhq/js");

import { headers } from "next/headers";
import { mockClerk, clearClerkMock } from "../../../__tests__/clerk-mock";
import { Axiom } from "@axiomhq/js";
import * as axiomModule from "../../axiom";

const mockHeaders = vi.mocked(headers);

describe("Sandbox Token E2E Flow", () => {
  const testUserId = `test-user-token-e2e-${Date.now()}-${process.pid}`;
  const testAgentName = `test-agent-token-e2e-${Date.now()}`;
  const testScopeId = randomUUID();
  let testComposeId: string;

  // Capture token passed to E2B
  let capturedSandboxToken: string | null = null;
  let capturedRunId: string | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedSandboxToken = null;
    capturedRunId = null;

    initServices();

    mockClerk({ userId: testUserId });

    // Setup E2B SDK mock - capture envs including VM0_API_TOKEN
    const mockSandbox = {
      sandboxId: "test-sandbox-token-e2e",
      getHostname: () => "test-sandbox.e2b.dev",
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
      commands: {
        run: vi.fn().mockResolvedValue({
          stdout: "Mock output",
          stderr: "",
          exitCode: 0,
        }),
      },
      kill: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(Sandbox.create).mockImplementation(async (_template, options) => {
      const envs = options?.envs as Record<string, string> | undefined;
      if (envs) {
        capturedSandboxToken = envs.VM0_API_TOKEN || null;
        capturedRunId = envs.VM0_RUN_ID || null;
      }
      return mockSandbox as unknown as Sandbox;
    });

    // Setup S3 mocks
    vi.spyOn(s3Client, "generatePresignedUrl").mockResolvedValue(
      "https://mock-presigned-url",
    );
    vi.spyOn(s3Client, "listS3Objects").mockResolvedValue([]);
    vi.spyOn(s3Client, "uploadS3Buffer").mockResolvedValue(undefined);

    // Setup Axiom SDK mock
    const mockAxiomClient = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      ingest: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Axiom).mockImplementation(
      () => mockAxiomClient as unknown as Axiom,
    );
    vi.spyOn(axiomModule, "ingestToAxiom").mockResolvedValue(true);

    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Clean up test data
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
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test compose
    const config = createDefaultComposeConfig(testAgentName);
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await createCompose(request);
    const data = await response.json();
    testComposeId = data.composeId;
  });

  afterEach(async () => {
    clearClerkMock();
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  it("should capture sandbox token with vm0_sbx_ prefix from E2B create call", async () => {
    const createRunRequest = new NextRequest(
      "http://localhost:3000/api/agent/runs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test token capture",
        }),
      },
    );

    const runResponse = await createRun(createRunRequest);
    expect(runResponse.status).toBe(201);

    const runData = await runResponse.json();
    expect(runData.runId).toBeDefined();
    expect(runData.status).toBe("running");

    // Verify token was captured with correct prefix
    expect(capturedSandboxToken).not.toBeNull();
    expect(capturedSandboxToken).toMatch(/^vm0_sbx_/);
    expect(capturedRunId).toBe(runData.runId);
  });

  it("should accept captured token on webhook/events endpoint", async () => {
    const createRunRequest = new NextRequest(
      "http://localhost:3000/api/agent/runs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test webhook auth",
        }),
      },
    );

    const runResponse = await createRun(createRunRequest);
    expect(runResponse.status).toBe(201);
    const runData = await runResponse.json();

    expect(capturedSandboxToken).not.toBeNull();

    // Use captured token to call webhook
    mockHeaders.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "Authorization" ? `Bearer ${capturedSandboxToken}` : null,
      ),
    } as unknown as Headers);

    const webhookRequest = new NextRequest(
      "http://localhost:3000/api/webhooks/agent/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${capturedSandboxToken}`,
        },
        body: JSON.stringify({
          runId: runData.runId,
          events: [
            {
              type: "test_event",
              sequenceNumber: 0,
              timestamp: Date.now(),
              data: { message: "Hello from sandbox" },
            },
          ],
        }),
      },
    );

    const webhookResponse = await sendEvents(webhookRequest);
    expect(webhookResponse.status).toBe(200);
  });

  it("should accept captured token on webhook/heartbeat endpoint", async () => {
    const createRunRequest = new NextRequest(
      "http://localhost:3000/api/agent/runs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test heartbeat auth",
        }),
      },
    );

    const runResponse = await createRun(createRunRequest);
    expect(runResponse.status).toBe(201);
    const runData = await runResponse.json();

    expect(capturedSandboxToken).not.toBeNull();

    mockHeaders.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "Authorization" ? `Bearer ${capturedSandboxToken}` : null,
      ),
    } as unknown as Headers);

    const heartbeatRequest = new NextRequest(
      "http://localhost:3000/api/webhooks/agent/heartbeat",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${capturedSandboxToken}`,
        },
        body: JSON.stringify({
          runId: runData.runId,
        }),
      },
    );

    const heartbeatResponse = await sendHeartbeat(heartbeatRequest);
    expect(heartbeatResponse.status).toBe(200);
  });

  it("should reject token with mismatched runId", async () => {
    const createRunRequest = new NextRequest(
      "http://localhost:3000/api/agent/runs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test runId mismatch",
        }),
      },
    );

    const runResponse = await createRun(createRunRequest);
    expect(runResponse.status).toBe(201);

    expect(capturedSandboxToken).not.toBeNull();

    mockHeaders.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "Authorization" ? `Bearer ${capturedSandboxToken}` : null,
      ),
    } as unknown as Headers);

    const differentRunId = randomUUID();
    const webhookRequest = new NextRequest(
      "http://localhost:3000/api/webhooks/agent/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${capturedSandboxToken}`,
        },
        body: JSON.stringify({
          runId: differentRunId,
          events: [
            {
              type: "test_event",
              sequenceNumber: 0,
              timestamp: Date.now(),
              data: {},
            },
          ],
        }),
      },
    );

    const webhookResponse = await sendEvents(webhookRequest);
    expect(webhookResponse.status).toBe(401);
  });

  it("should reject CLI token (vm0_live_) on webhook endpoint", async () => {
    const createRunRequest = new NextRequest(
      "http://localhost:3000/api/agent/runs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test CLI token rejection",
        }),
      },
    );

    const runResponse = await createRun(createRunRequest);
    expect(runResponse.status).toBe(201);
    const runData = await runResponse.json();

    const cliToken = "vm0_live_fake_cli_token";
    mockHeaders.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "Authorization" ? `Bearer ${cliToken}` : null,
      ),
    } as unknown as Headers);

    const webhookRequest = new NextRequest(
      "http://localhost:3000/api/webhooks/agent/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cliToken}`,
        },
        body: JSON.stringify({
          runId: runData.runId,
          events: [
            {
              type: "test_event",
              sequenceNumber: 0,
              timestamp: Date.now(),
              data: {},
            },
          ],
        }),
      },
    );

    const webhookResponse = await sendEvents(webhookRequest);
    expect(webhookResponse.status).toBe(401);
  });
});
