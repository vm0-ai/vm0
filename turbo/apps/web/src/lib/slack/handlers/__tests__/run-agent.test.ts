import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testContext } from "../../../../__tests__/test-helpers";
import { initServices } from "../../../../lib/init-services";
import { agentRuns } from "../../../../db/schema/agent-run";
import {
  givenLinkedSlackUser,
  givenUserHasAgentWithConfig,
} from "../../__tests__/helpers";
import { runAgentForSlack } from "../run-agent";

// Mock external dependencies (at package boundary)
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

// Use vi.hoisted to create mocks that can be referenced in vi.mock factories
const { mockBuildExecutionContext, mockPrepareAndDispatchRun } = vi.hoisted(
  () => ({
    mockBuildExecutionContext: vi.fn().mockResolvedValue({
      runId: "test-run-id",
      agentComposeVersionId: "test-version-id",
      agentCompose: {},
      prompt: "test prompt",
      agentName: "test-agent",
      sandboxToken: "test-token",
      artifactName: "artifact",
    }),
    mockPrepareAndDispatchRun: vi.fn().mockResolvedValue({
      runId: "test-run-id",
      status: "running",
      createdAt: new Date().toISOString(),
    }),
  }),
);

// Mock internal dependencies that require complex setup
vi.mock("../../../auth/sandbox-token", () => ({
  generateSandboxToken: vi.fn().mockResolvedValue("test-sandbox-token"),
}));

vi.mock("../../../scope/scope-service", () => ({
  getUserScopeByClerkId: vi.fn().mockResolvedValue({
    id: "test-scope-id",
    slug: "test-scope",
    type: "personal",
    ownerId: "test-user",
  }),
}));

vi.mock("../../../secret/secret-service", () => ({
  getSecretValues: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../../run", () => ({
  buildExecutionContext: mockBuildExecutionContext,
  prepareAndDispatchRun: mockPrepareAndDispatchRun,
}));

const context = testContext();

describe("runAgentForSlack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    context.setupMocks();
  });

  describe("Scenario: Agent execution with artifact name", () => {
    it("should pass artifactName: 'artifact' to buildExecutionContext", async () => {
      // This test verifies the fix for #2375: Slack run missing artifact name parameter
      // The artifactName should be "artifact" to match the cook command behavior
      //
      // Note: This test mocks buildExecutionContext because testing the full run flow
      // requires extensive infrastructure setup (model providers, variables table, etc.)
      // that isn't available in the test database.

      // Given a linked user with an agent that has working_dir configured
      const { userLink } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgentWithConfig(userLink.id, {
        agentName: "test-agent",
        description: "A test agent",
        composeConfig: {
          version: "1",
          agents: {
            "test-agent": {
              model: "claude-sonnet-4-20250514",
              prompt: "Test prompt",
              working_dir: "/home/user/project",
            },
          },
        },
      });

      initServices();

      // When running the agent - start the promise but don't wait for completion
      // The function will wait for run completion (30min timeout), so we need to
      // handle this in parallel
      const runPromise = runAgentForSlack({
        binding: { id: binding.id, composeId: binding.composeId },
        sessionId: undefined,
        prompt: "test prompt",
        threadContext: "",
        userId: userLink.vm0UserId,
      });

      // Give the async function time to call buildExecutionContext
      // This is a short wait since we've mocked the dependencies
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Then buildExecutionContext should be called with artifactName: "artifact"
      expect(mockBuildExecutionContext).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactName: "artifact",
        }),
      );

      // Complete the run so the function returns
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.userId, userLink.vm0UserId))
        .limit(1);

      if (run) {
        await globalThis.services.db
          .update(agentRuns)
          .set({ status: "completed" })
          .where(eq(agentRuns.id, run.id));
      }

      // Wait for completion (with timeout to prevent hanging)
      const result = await Promise.race([
        runPromise,
        new Promise<{ response: string; runId: undefined }>((resolve) =>
          setTimeout(
            () => resolve({ response: "timeout", runId: undefined }),
            1000,
          ),
        ),
      ]);

      // The function may complete or timeout - either is fine for this test
      // What matters is that buildExecutionContext was called with the right params
      expect(result).toBeDefined();
    });
  });
});
