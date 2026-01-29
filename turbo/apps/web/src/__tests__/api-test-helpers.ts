/**
 * Test Helper Utilities for API-based Test Data Creation
 *
 * These utilities provide functions to create test data through API endpoints
 * instead of direct database operations. This ensures tests validate the
 * complete API flow, catching issues that direct DB operations might miss.
 */
import { NextRequest } from "next/server";
import type { AgentComposeYaml } from "../types/agent-compose";
import { generateSandboxToken } from "../lib/auth/sandbox-token";
import { cliTokens } from "../db/schema/cli-tokens";
import { eq } from "drizzle-orm";

// Route handlers - imported here so callers don't need to pass them
import { POST as createComposeRoute } from "../../app/api/agent/composes/route";
import { POST as createScopeRoute } from "../../app/api/scope/route";
import { POST as createRunRoute } from "../../app/api/agent/runs/route";
import { POST as createV1RunRoute } from "../../app/v1/runs/route";
import { GET as getRunRoute } from "../../app/v1/runs/[id]/route";
import { PUT as upsertModelProviderRoute } from "../../app/api/model-providers/route";
import { POST as checkpointWebhook } from "../../app/api/webhooks/agent/checkpoints/route";
import { POST as completeWebhook } from "../../app/api/webhooks/agent/complete/route";
import { POST as storagePrepareRoute } from "../../app/api/storages/prepare/route";
import { POST as storageCommitRoute } from "../../app/api/storages/commit/route";

/**
 * Helper to create a NextRequest for testing.
 * Uses actual NextRequest constructor so ts-rest handler gets nextUrl property.
 */
export function createTestRequest(
  url: string,
  options?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  },
): NextRequest {
  return new NextRequest(url, {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
    body: options?.body,
  });
}

interface ComposeConfigOptions {
  /** Override agent properties (merged with defaults) */
  overrides?: Partial<AgentComposeYaml["agents"][string]>;
  /** Skip adding default ANTHROPIC_API_KEY (creates empty environment: {}) */
  skipDefaultApiKey?: boolean;
  /** Skip adding environment block entirely (for testing auto-injection) */
  noEnvironmentBlock?: boolean;
}

/**
 * Default compose configuration for testing.
 * By default includes ANTHROPIC_API_KEY in environment.
 *
 * Options:
 * - skipDefaultApiKey: true  → environment: {} (empty object)
 * - noEnvironmentBlock: true → no environment key at all
 */
export function createDefaultComposeConfig(
  agentName: string,
  options?: ComposeConfigOptions | Partial<AgentComposeYaml["agents"][string]>,
): AgentComposeYaml {
  // Support both old signature (overrides only) and new signature (options object)
  const opts: ComposeConfigOptions =
    options &&
    ("skipDefaultApiKey" in options || "noEnvironmentBlock" in options)
      ? options
      : { overrides: options as Partial<AgentComposeYaml["agents"][string]> };

  // Build base agent config without environment
  const baseAgent: Record<string, unknown> = {
    image: "vm0/claude-code:dev",
    framework: "claude-code",
    working_dir: "/home/user/workspace",
  };

  // Add environment unless noEnvironmentBlock is set
  if (!opts.noEnvironmentBlock) {
    baseAgent.environment = opts.skipDefaultApiKey
      ? {}
      : { ANTHROPIC_API_KEY: "test-api-key" };
  }

  return {
    version: "1.0",
    agents: {
      [agentName]: {
        ...baseAgent,
        ...opts.overrides,
      } as AgentComposeYaml["agents"][string],
    },
  };
}

/**
 * Create a test sandbox JWT token for webhook endpoints
 * This generates a valid JWT that can be used to authenticate sandbox requests
 *
 * @param userId - The user ID to encode in the token
 * @param runId - The run ID to encode in the token
 * @returns A valid JWT token string
 */
export async function createTestSandboxToken(
  userId: string,
  runId: string,
): Promise<string> {
  return generateSandboxToken(userId, runId);
}

/**
 * Create a test CLI token in the database for authentication testing
 *
 * @param userId - The user ID to associate with the token
 * @param expiresAt - When the token expires (default: 1 hour from now)
 * @returns The generated token string
 */
export async function createTestCliToken(
  userId: string,
  expiresAt?: Date,
): Promise<string> {
  const token = `vm0_live_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const expiration = expiresAt || new Date(Date.now() + 60 * 60 * 1000); // 1 hour default

  await globalThis.services.db.insert(cliTokens).values({
    token,
    userId,
    name: "Test Token",
    expiresAt: expiration,
  });

  return token;
}

/**
 * Clean up test CLI token from database
 *
 * @param token - The token string to delete
 */
export async function deleteTestCliToken(token: string): Promise<void> {
  await globalThis.services.db
    .delete(cliTokens)
    .where(eq(cliTokens.token, token));
}

/**
 * Create a test scope via API route handler.
 *
 * @param slug - The scope slug
 * @returns The created scope with id and slug
 */
export async function createTestScope(
  slug: string,
): Promise<{ id: string; slug: string }> {
  const request = createTestRequest("http://localhost:3000/api/scope", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  const response = await createScopeRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create scope: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

/**
 * Create a test compose via API route handler.
 *
 * @param agentName - The agent name
 * @param options - Optional config options or overrides for the agent config
 * @returns The created compose with composeId and versionId
 */
export async function createTestCompose(
  agentName: string,
  options?: ComposeConfigOptions | Partial<AgentComposeYaml["agents"][string]>,
): Promise<{ composeId: string; versionId: string }> {
  const config = createDefaultComposeConfig(agentName, options);
  const request = createTestRequest(
    "http://localhost:3000/api/agent/composes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: config }),
    },
  );
  const response = await createComposeRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create compose: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

/**
 * Create a test model provider via API route handler.
 *
 * @param type - The provider type
 * @param credentialValue - The credential value
 * @returns The created provider with id and type
 */
export async function createTestModelProvider(
  type: string,
  credentialValue: string,
): Promise<{ id: string; type: string }> {
  const request = createTestRequest(
    "http://localhost:3000/api/model-providers",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, credential: credentialValue }),
    },
  );
  const response = await upsertModelProviderRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create model provider: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return data.provider;
}

/**
 * Create a test run via internal API route handler.
 *
 * @param agentComposeId - The compose ID to run
 * @param prompt - The prompt for the run
 * @param options - Optional run parameters
 * @returns The created run with runId and status
 */
export async function createTestRun(
  agentComposeId: string,
  prompt: string,
  options?: {
    vars?: Record<string, string>;
    secrets?: Record<string, string>;
    sessionId?: string;
    checkpointId?: string;
    modelProvider?: string;
  },
): Promise<{ runId: string; status: string }> {
  const request = createTestRequest("http://localhost:3000/api/agent/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentComposeId,
      prompt,
      ...options,
    }),
  });
  const response = await createRunRoute(request);
  return response.json();
}

/**
 * Create a test run via public v1 API route handler.
 *
 * @param agentId - The agent/compose ID to run
 * @param prompt - The prompt for the run
 * @returns The created run with id and status
 */
export async function createTestV1Run(
  agentId: string,
  prompt: string,
): Promise<{ id: string; status: string }> {
  const request = createTestRequest("http://localhost:3000/v1/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, prompt }),
  });
  const response = await createV1RunRoute(request);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `Failed to create v1 run: ${data.error?.message || response.status}`,
    );
  }
  return data;
}

/**
 * Get test run details via public API route handler.
 *
 * @param runId - The run ID to fetch
 * @returns The run details including status, error, etc.
 */
export async function getTestRun(runId: string): Promise<{
  id: string;
  status: string;
  error: string | null;
  completedAt: string | null;
}> {
  const request = createTestRequest(`http://localhost:3000/v1/runs/${runId}`);
  const response = await getRunRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to get run: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

/**
 * Create a test checkpoint via webhook route handler.
 * This is required before completing a run with exitCode=0.
 * Used internally by completeTestRun.
 */
async function createTestCheckpoint(
  userId: string,
  runId: string,
): Promise<{
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
}> {
  const sandboxToken = await generateSandboxToken(userId, runId);
  const request = createTestRequest(
    "http://localhost:3000/api/webhooks/agent/checkpoints",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        runId,
        cliAgentType: "test-agent",
        cliAgentSessionId: `test-session-${runId}`,
        cliAgentSessionHistory: JSON.stringify([
          { role: "user", content: "test" },
        ]),
      }),
    },
  );
  const response = await checkpointWebhook(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create checkpoint: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

/**
 * Complete a test run via checkpoint + complete webhooks.
 * Creates a checkpoint first, then completes the run with exitCode=0.
 * Sets the run status to "completed".
 *
 * @param userId - The user ID
 * @param runId - The run ID
 * @returns The checkpoint details
 */
export async function completeTestRun(
  userId: string,
  runId: string,
): Promise<{
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
}> {
  // First create checkpoint (required for completed status)
  const checkpoint = await createTestCheckpoint(userId, runId);

  // Then complete the run
  const sandboxToken = await generateSandboxToken(userId, runId);
  const request = createTestRequest(
    "http://localhost:3000/api/webhooks/agent/complete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        runId,
        exitCode: 0,
      }),
    },
  );
  const response = await completeWebhook(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to complete run: ${error.error?.message || response.status}`,
    );
  }

  return checkpoint;
}

interface TestFile {
  path: string;
  hash: string;
  size: number;
}

interface CreateTestStorageOptions {
  /** Storage type: "artifact" or "volume" */
  type?: "artifact" | "volume";
  /** Files to include in the storage */
  files?: TestFile[];
  /** Skip the commit step (creates storage in prepare-only state) */
  skipCommit?: boolean;
  /** Create an empty storage (no files) */
  empty?: boolean;
}

/**
 * Create a test storage (artifact or volume) via API route handlers.
 * Uses the prepare/commit flow that the CLI uses.
 *
 * Internal helper - use createTestArtifact for testing.
 *
 * @param name - Storage name
 * @param options - Optional configuration
 * @returns The created storage with versionId
 */
async function createTestStorage(
  name: string,
  options?: CreateTestStorageOptions,
): Promise<{
  versionId: string;
  name: string;
  size: number;
  fileCount: number;
}> {
  const storageType = options?.type ?? "artifact";
  const empty = options?.empty ?? false;

  // Default test files (single file for simplicity)
  const files: TestFile[] = empty
    ? []
    : (options?.files ?? [
        {
          path: "test.txt",
          hash: "a".repeat(64), // Valid SHA-256 format
          size: 100,
        },
      ]);

  // Step 1: Prepare upload
  const prepareRequest = createTestRequest(
    "http://localhost:3000/api/storages/prepare",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName: name,
        storageType,
        files,
      }),
    },
  );

  const prepareResponse = await storagePrepareRoute(prepareRequest);
  if (!prepareResponse.ok) {
    const error = await prepareResponse.json();
    throw new Error(
      `Failed to prepare storage: ${error.error?.message || prepareResponse.status}`,
    );
  }

  const prepareData = await prepareResponse.json();
  const { versionId, existing } = prepareData;

  // If version already exists (deduplication), skip commit
  if (existing || options?.skipCommit) {
    return {
      versionId,
      name,
      size: files.reduce((sum, f) => sum + f.size, 0),
      fileCount: files.length,
    };
  }

  // Step 2: Commit (S3 upload is mocked, so we just commit directly)
  const commitRequest = createTestRequest(
    "http://localhost:3000/api/storages/commit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName: name,
        storageType,
        versionId,
        files,
      }),
    },
  );

  const commitResponse = await storageCommitRoute(commitRequest);
  if (!commitResponse.ok) {
    const error = await commitResponse.json();
    throw new Error(
      `Failed to commit storage: ${error.error?.message || commitResponse.status}`,
    );
  }

  const commitData = await commitResponse.json();
  return {
    versionId: commitData.versionId,
    name: commitData.storageName,
    size: commitData.size,
    fileCount: commitData.fileCount,
  };
}

/**
 * Create a test artifact via API route handlers.
 * Convenience wrapper around createTestStorage with type="artifact".
 *
 * @param name - Artifact name
 * @param options - Optional configuration
 * @returns The created artifact with versionId
 */
export async function createTestArtifact(
  name: string,
  options?: Omit<CreateTestStorageOptions, "type">,
): Promise<{
  versionId: string;
  name: string;
  size: number;
  fileCount: number;
}> {
  return createTestStorage(name, { ...options, type: "artifact" });
}

/**
 * Create a test volume via API route handlers.
 * Convenience wrapper around createTestStorage with type="volume".
 *
 * @param name - Volume name
 * @param options - Optional configuration
 * @returns The created volume with versionId
 */
export async function createTestVolume(
  name: string,
  options?: Omit<CreateTestStorageOptions, "type">,
): Promise<{
  versionId: string;
  name: string;
  size: number;
  fileCount: number;
}> {
  return createTestStorage(name, { ...options, type: "volume" });
}
