/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { initServices } from "../../init-services";
import { agentConfigs } from "../../../db/schema/agent-config";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentRunEvents } from "../../../db/schema/agent-run-event";
import { cliTokens } from "../../../db/schema/cli-tokens";
import { eq, and } from "drizzle-orm";
import { e2bService } from "../e2b-service";
import { generateSandboxToken } from "../../auth/sandbox-token";

// Mock the auth module
const mockUserId = "test-webhook-user-123";
vi.mock("../../auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("E2B Sandbox to Webhook Integration Test", () => {
  const testUserId = mockUserId;
  let testConfigId: string;
  let testRunId: string;
  let sandboxToken: string;

  beforeAll(async () => {
    // Initialize services
    initServices();

    // Verify required environment variables
    if (!process.env.E2B_API_KEY) {
      throw new Error("E2B_API_KEY is required for integration tests");
    }

    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    console.log(`[Test] DATABASE_URL host: ${new URL(process.env.DATABASE_URL).host}`);

    // Get webhook URL from environment
    const apiUrl = process.env.VM0_API_URL || process.env.VERCEL_URL;
    if (!apiUrl) {
      throw new Error(
        "VM0_API_URL or VERCEL_URL must be set for webhook integration test. " +
          "This test requires a deployed API endpoint to receive webhooks from E2B sandbox.",
      );
    }

    console.log(`[Test] Using API URL: ${apiUrl}`);
    console.log(`[Test] Webhook endpoint: ${apiUrl}/api/webhooks/agent-events`);

    // Set VM0_API_URL for e2b service
    if (!globalThis.services.env) {
      globalThis.services.env = {} as never;
    }
    (globalThis.services.env as Record<string, string>).VM0_API_URL =
      apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`;

    // Create test agent config
    const configName = `test-webhook-integration-${Date.now()}`;
    const [insertedConfig] = await globalThis.services.db
      .insert(agentConfigs)
      .values({
        userId: testUserId,
        name: configName,
        config: {
          version: "1.0",
          agent: {
            name: configName,
            instructions: "Test agent for webhook integration",
          },
        },
      })
      .returning();

    if (!insertedConfig) {
      throw new Error("Failed to create test config");
    }
    testConfigId = insertedConfig.id;
    console.log(`[Test] Created test config: ${testConfigId}`);

    // Create test agent run
    const [insertedRun] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "pending",
        prompt: "Say hello",
      })
      .returning();

    if (!insertedRun) {
      throw new Error("Failed to create test run");
    }
    testRunId = insertedRun.id;
    console.log(`[Test] Created test run: ${testRunId}`);

    // Generate sandbox token for authentication
    sandboxToken = await generateSandboxToken(testUserId, testRunId);
    console.log(`[Test] Generated sandbox token`);
  });

  afterAll(async () => {
    // Cleanup: Delete test data in correct order (foreign key constraints)
    console.log(`[Test] Cleaning up test data...`);

    // Delete events first (references runs)
    await globalThis.services.db
      .delete(agentRunEvents)
      .where(eq(agentRunEvents.runId, testRunId));

    // Delete run (references config)
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    // Delete config
    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.id, testConfigId));

    // Delete sandbox tokens
    await globalThis.services.db
      .delete(cliTokens)
      .where(
        and(
          eq(cliTokens.userId, testUserId),
          eq(cliTokens.token, sandboxToken),
        ),
      );

    console.log(`[Test] Cleanup complete`);
  });

  it("should send events from E2B sandbox to webhook and store in database", async () => {
    console.log(`[Test] Starting E2B sandbox execution...`);
    console.log(`[Test] Run ID: ${testRunId}`);
    console.log(`[Test] Config ID: ${testConfigId}`);

    // Execute E2B sandbox
    const result = await e2bService.createRun(testRunId, {
      agentConfigId: testConfigId,
      sandboxToken: sandboxToken,
      prompt: "Say hello",
    });

    // Verify sandbox execution completed
    expect(result).toBeDefined();
    expect(result.runId).toBe(testRunId);
    expect(result.sandboxId).toBeDefined();
    expect(result.sandboxId).not.toBe("unknown");
    expect(result.status).toBe("completed");

    console.log(`[Test] Sandbox execution completed`);
    console.log(`[Test] Sandbox ID: ${result.sandboxId}`);
    console.log(`[Test] Execution time: ${result.executionTimeMs}ms`);

    // Give webhook a moment to process any final batches
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Query database for events
    console.log(`[Test] Querying database for events...`);
    const events = await globalThis.services.db
      .select()
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, testRunId));

    console.log(`[Test] Found ${events.length} events in database`);

    // Verify events were stored
    expect(events.length).toBeGreaterThan(0);

    // Verify event structure
    events.forEach((event, index) => {
      console.log(
        `[Test] Event ${index + 1}: type=${event.eventType}, seq=${event.sequenceNumber}`,
      );

      // Check required fields
      expect(event.runId).toBe(testRunId);
      expect(event.sequenceNumber).toBeGreaterThan(0);
      expect(event.eventType).toBeDefined();
      expect(event.eventType).toBeTruthy();
      expect(event.eventData).toBeDefined();

      // Verify eventData is an object
      expect(typeof event.eventData).toBe("object");
    });

    // Verify sequence numbers are sequential
    const sequenceNumbers = events
      .map((e) => e.sequenceNumber)
      .sort((a, b) => a - b);
    for (let i = 0; i < sequenceNumbers.length; i++) {
      expect(sequenceNumbers[i]).toBe(i + 1);
    }

    console.log(`[Test] All validations passed`);
  }, 600000); // 10 minute timeout for E2B execution
});
