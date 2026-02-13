/**
 * Test Helper Utilities for API-based Test Data Creation
 *
 * These utilities provide functions to create test data through API endpoints
 * instead of direct database operations. This ensures tests validate the
 * complete API flow, catching issues that direct DB operations might miss.
 */
import { NextRequest } from "next/server";
import type { AgentComposeYaml } from "../types/agent-compose";
import {
  generateSandboxToken,
  generateComposeJobToken,
} from "../lib/auth/sandbox-token";
import { cliTokens } from "../db/schema/cli-tokens";
import { deviceCodes } from "../db/schema/device-codes";
import { agentRuns } from "../db/schema/agent-run";
import { composeJobs } from "../db/schema/compose-job";
import { storages, storageVersions } from "../db/schema/storage";
import { usageDaily } from "../db/schema/usage-daily";
import { slackComposeRequests } from "../db/schema/slack-compose-request";
import { slackInstallations } from "../db/schema/slack-installation";
import { slackThreadSessions } from "../db/schema/slack-thread-session";
import { emailThreadSessions } from "../db/schema/email-thread-session";
import { agentRunCallbacks } from "../db/schema/agent-run-callback";
import { and, eq } from "drizzle-orm";
import { generateCallbackSecret } from "../lib/callback/hmac";

// Route handlers - imported here so callers don't need to pass them
import { POST as createComposeRoute } from "../../app/api/agent/composes/route";
import { POST as createScopeRoute } from "../../app/api/scope/route";
import { POST as createRunRoute } from "../../app/api/agent/runs/route";
import { POST as createV1RunRoute } from "../../app/v1/runs/route";
import { GET as getRunRoute } from "../../app/v1/runs/[id]/route";
import { PUT as upsertModelProviderRoute } from "../../app/api/model-providers/route";
import { POST as checkpointWebhook } from "../../app/api/webhooks/agent/checkpoints/route";
import { POST as completeWebhook } from "../../app/api/webhooks/agent/complete/route";
import {
  POST as deployScheduleRoute,
  GET as listSchedulesRoute,
} from "../../app/api/agent/schedules/route";
import {
  GET as getScheduleRoute,
  DELETE as deleteScheduleRoute,
} from "../../app/api/agent/schedules/[name]/route";
import { POST as enableScheduleRoute } from "../../app/api/agent/schedules/[name]/enable/route";
import { POST as disableScheduleRoute } from "../../app/api/agent/schedules/[name]/disable/route";
import { GET as getScheduleRunsRoute } from "../../app/api/agent/schedules/[name]/runs/route";
import type { ScheduleResponse } from "../lib/schedule/schedule-service";
import { POST as storagePrepareRoute } from "../../app/api/storages/prepare/route";
import { POST as storageCommitRoute } from "../../app/api/storages/commit/route";
import { DELETE as deleteModelProviderRoute } from "../../app/api/model-providers/[type]/route";
import { GET as listModelProvidersRoute } from "../../app/api/model-providers/route";
import {
  GET as listSecretsRoute,
  PUT as setSecretRoute,
} from "../../app/api/secrets/route";
import { PUT as setVariableRoute } from "../../app/api/variables/route";
import { POST as addPermissionRoute } from "../../app/api/agent/composes/[id]/permissions/route";
import { connectors } from "../db/schema/connector";
import { connectorSessions } from "../db/schema/connector-session";
import { secrets } from "../db/schema/secret";
import { encryptCredentialValue } from "../lib/crypto/secrets-encryption";
import type { ConnectorType } from "@vm0/core";
import { agentSessions } from "../db/schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../db/schema/agent-compose";
import { agentPermissions } from "../db/schema/agent-permission";
import { scopes } from "../db/schema/scope";
import { conversations } from "../db/schema/conversation";
import { uniqueId } from "./test-helpers";

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
    ("skipDefaultApiKey" in options ||
      "noEnvironmentBlock" in options ||
      "overrides" in options)
      ? options
      : { overrides: options as Partial<AgentComposeYaml["agents"][string]> };

  // Build base agent config without environment
  const baseAgent: Record<string, unknown> = {
    image: "vm0/claude-code:latest",
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

// ============================================================================
// CLI Token Test Helpers
// ============================================================================

/**
 * Create a test compose job JWT token for webhook endpoints
 * This generates a valid JWT that can be used to authenticate compose job sandbox requests
 *
 * @param userId - The user ID to encode in the token
 * @param jobId - The compose job ID to encode in the token
 * @returns A valid JWT token string
 */
export async function createTestComposeJobToken(
  userId: string,
  jobId: string,
): Promise<string> {
  return generateComposeJobToken(userId, jobId);
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
 * Create a test device code directly in the database.
 * Uses direct DB insert because no API route exists for creating
 * denied/expired device codes — the POST /api/cli/auth/device route
 * always creates "pending" codes with server-controlled expiration.
 *
 * @param options - Device code options
 * @param options.status - The device code status (default: "pending")
 * @param options.userId - The user ID (required for "authenticated" status)
 * @param options.expiresAt - When the code expires (default: 15 minutes from now)
 * @returns The device code string
 */
export async function createTestDeviceCode(options?: {
  status?: "pending" | "authenticated" | "expired" | "denied";
  userId?: string;
  expiresAt?: Date;
}): Promise<string> {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const part = () =>
    Array.from(
      { length: 4 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
  const code = `${part()}-${part()}`;

  const status = options?.status ?? "pending";
  const expiresAt = options?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000);

  await globalThis.services.db.insert(deviceCodes).values({
    code,
    status,
    userId: options?.userId ?? null,
    expiresAt,
  });

  return code;
}

/**
 * Find a device code by its code string.
 *
 * @param code - The device code to look up
 * @returns The device code row or undefined
 */
export async function findTestDeviceCode(code: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.code, code))
    .limit(1);
  return row;
}

/**
 * Find a CLI token by its token string.
 *
 * @param token - The token to look up
 * @returns The CLI token row or undefined
 */
export async function findTestCliToken(token: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(cliTokens)
    .where(eq(cliTokens.token, token))
    .limit(1);
  return row;
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
 * @param secretValue - The secret value
 * @param selectedModel - Optional selected model for providers with model selection
 * @returns The created provider with id and type
 */
export async function createTestModelProvider(
  type: string,
  secretValue: string,
  selectedModel?: string,
): Promise<{ id: string; type: string; selectedModel: string | null }> {
  const request = createTestRequest(
    "http://localhost:3000/api/model-providers",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        secret: secretValue,
        selectedModel,
      }),
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
 * Create a test multi-auth model provider via API route handler.
 *
 * @param type - The provider type (e.g., "aws-bedrock")
 * @param authMethod - The auth method (e.g., "api-key", "access-keys")
 * @param secrets - Map of secret names to values
 * @param selectedModel - Optional selected model
 * @returns The created provider with id and type
 */
export async function createTestMultiAuthModelProvider(
  type: string,
  authMethod: string,
  secrets: Record<string, string>,
  selectedModel?: string,
): Promise<{
  id: string;
  type: string;
  authMethod: string | null;
  secretNames: string[] | null;
  selectedModel: string | null;
}> {
  const request = createTestRequest(
    "http://localhost:3000/api/model-providers",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        authMethod,
        secrets,
        selectedModel,
      }),
    },
  );
  const response = await upsertModelProviderRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create multi-auth model provider: ${error.error?.message || response.status}`,
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
export async function createTestAgentSession(
  userId: string,
  agentComposeId: string,
): Promise<{ id: string }> {
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({ userId, agentComposeId })
    .returning({ id: agentSessions.id });
  return session!;
}

/**
 * Create a compose version for a compose.
 * Internal helper for createTestSessionWithConversation.
 */
async function createTestComposeVersion(
  composeId: string,
  userId: string,
): Promise<string> {
  const versionId = uniqueId("version");
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: { name: "test-agent", model: "claude-3-5-sonnet-20241022" },
    createdBy: userId,
  });
  // Update compose to point to this version
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, composeId));
  return versionId;
}

/**
 * Create a run record directly in the database.
 * Internal helper for createTestSessionWithConversation.
 */
async function createTestRunRecord(
  userId: string,
  versionId: string,
): Promise<{ id: string }> {
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      agentComposeVersionId: versionId,
      status: "completed",
      prompt: "test prompt",
    })
    .returning({ id: agentRuns.id });
  return run!;
}

/**
 * Create a conversation record for a run.
 * Internal helper for createTestSessionWithConversation.
 */
async function createTestConversation(runId: string): Promise<{ id: string }> {
  const [conversation] = await globalThis.services.db
    .insert(conversations)
    .values({
      runId,
      cliAgentType: "claude",
      cliAgentSessionId: uniqueId("cli-session"),
      cliAgentSessionHistory: "[]",
    })
    .returning({ id: conversations.id });
  return conversation!;
}

/**
 * Create an agent session with a linked conversation.
 * This creates the full data chain required by validateAgentSession:
 * compose version -> run -> conversation -> session
 */
export async function createTestSessionWithConversation(
  userId: string,
  agentComposeId: string,
): Promise<{ id: string }> {
  // Create compose version
  const versionId = await createTestComposeVersion(agentComposeId, userId);
  // Create run
  const run = await createTestRunRecord(userId, versionId);
  // Create conversation
  const conversation = await createTestConversation(run.id);
  // Create session with conversation
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({
      userId,
      agentComposeId,
      conversationId: conversation.id,
    })
    .returning({ id: agentSessions.id });
  return session!;
}

export async function createTestRun(
  agentComposeId: string,
  prompt: string,
  options?: {
    vars?: Record<string, string>;
    secrets?: Record<string, string>;
    sessionId?: string;
    checkpointId?: string;
    modelProvider?: string;
    checkEnv?: boolean;
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

// ============================================================================
// Schedule Test Helpers
// ============================================================================

/**
 * Create a test schedule via API route handler.
 *
 * @param composeId - The compose ID to attach the schedule to
 * @param name - The schedule name
 * @param options - Optional schedule parameters
 * @returns The created schedule response
 */
/**
 * Create a test schedule via API route handler.
 * Note: vars and secrets are now managed via platform tables (vm0 secret set, vm0 var set)
 */
export async function createTestSchedule(
  composeId: string,
  name: string,
  options?: {
    cronExpression?: string;
    atTime?: string;
    timezone?: string;
    prompt?: string;
    // vars and secrets removed - now managed via platform tables
  },
): Promise<ScheduleResponse> {
  // Default to cron if neither trigger specified
  const trigger =
    options?.cronExpression || options?.atTime
      ? {}
      : { cronExpression: "0 0 * * *" };

  const request = createTestRequest(
    "http://localhost:3000/api/agent/schedules",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        composeId,
        name,
        timezone: options?.timezone ?? "UTC",
        prompt: options?.prompt ?? "Test schedule prompt",
        cronExpression: options?.cronExpression,
        atTime: options?.atTime,
        // vars and secrets no longer sent - managed via platform tables
        ...trigger,
      }),
    },
  );
  const response = await deployScheduleRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create schedule: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return data.schedule;
}

/**
 * Get a test schedule by name via API route handler.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 * @returns The schedule response
 */
export async function getTestSchedule(
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  const request = createTestRequest(
    `http://localhost:3000/api/agent/schedules/${encodeURIComponent(name)}?composeId=${composeId}`,
  );
  const response = await getScheduleRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to get schedule: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

/**
 * List all schedules for the current user via API route handler.
 *
 * @returns Array of schedule responses
 */
export async function listTestSchedules(): Promise<ScheduleResponse[]> {
  const request = createTestRequest(
    "http://localhost:3000/api/agent/schedules",
  );
  const response = await listSchedulesRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to list schedules: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return data.schedules;
}

/**
 * Enable a test schedule via API route handler.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 * @returns The updated schedule response
 */
export async function enableTestSchedule(
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  const request = createTestRequest(
    `http://localhost:3000/api/agent/schedules/${encodeURIComponent(name)}/enable`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ composeId }),
    },
  );
  const response = await enableScheduleRoute(request, {
    params: Promise.resolve({ name }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to enable schedule: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

/**
 * Disable a test schedule via API route handler.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 * @returns The updated schedule response
 */
export async function disableTestSchedule(
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  const request = createTestRequest(
    `http://localhost:3000/api/agent/schedules/${encodeURIComponent(name)}/disable`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ composeId }),
    },
  );
  const response = await disableScheduleRoute(request, {
    params: Promise.resolve({ name }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to disable schedule: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

/**
 * Delete a test schedule via API route handler.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 */
export async function deleteTestSchedule(
  composeId: string,
  name: string,
): Promise<void> {
  const request = createTestRequest(
    `http://localhost:3000/api/agent/schedules/${encodeURIComponent(name)}?composeId=${composeId}`,
    { method: "DELETE" },
  );
  const response = await deleteScheduleRoute(request);
  if (!response.ok && response.status !== 204) {
    const error = await response.json();
    throw new Error(
      `Failed to delete schedule: ${error.error?.message || response.status}`,
    );
  }
}

/**
 * Get runs for a test schedule via API route handler.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 * @param limit - Optional limit (default 5, max 100)
 * @returns Object with runs array
 */
export async function getTestScheduleRuns(
  composeId: string,
  name: string,
  limit?: number,
): Promise<{
  runs: Array<{
    id: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    error: string | null;
  }>;
}> {
  const params = new URLSearchParams({ composeId });
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  const request = createTestRequest(
    `http://localhost:3000/api/agent/schedules/${encodeURIComponent(name)}/runs?${params}`,
  );
  const response = await getScheduleRunsRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to get schedule runs: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

// ============================================================================
// Storage Test Helpers
// ============================================================================

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

/**
 * Insert an extra storage version record with a controlled ID.
 * Used to create deterministic ambiguous-prefix test scenarios where
 * two versions share the same prefix but the content hash is different.
 *
 * @param storageName - Name of an existing storage (must already have a version)
 * @param versionId - The 64-char hex version ID to insert
 */
export async function insertStorageVersion(
  storageName: string,
  versionId: string,
): Promise<void> {
  const [storage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(eq(storages.name, storageName))
    .limit(1);

  if (!storage) {
    throw new Error(`Storage "${storageName}" not found`);
  }

  await globalThis.services.db
    .insert(storageVersions)
    .values({
      id: versionId,
      storageId: storage.id,
      s3Key: `test/${versionId}`,
      size: 0,
      fileCount: 0,
      createdBy: "test",
    })
    .onConflictDoUpdate({
      target: storageVersions.id,
      set: { storageId: storage.id },
    });
}

// ============================================================================
// Model Provider Test Helpers
// ============================================================================

/**
 * Delete a model provider via API route handler.
 *
 * @param type - The provider type to delete
 */
export async function deleteTestModelProvider(type: string): Promise<void> {
  const request = createTestRequest(
    `http://localhost:3000/api/model-providers/${type}`,
    { method: "DELETE" },
  );
  const response = await deleteModelProviderRoute(request);
  if (!response.ok && response.status !== 204) {
    const error = await response.json();
    throw new Error(
      `Failed to delete model provider: ${error.error?.message || response.status}`,
    );
  }
}

/**
 * List all model providers via API route handler.
 *
 * @returns Array of model provider info
 */
export async function listTestModelProviders(): Promise<
  Array<{
    id: string;
    type: string;
    framework: string;
    secretName: string | null;
    authMethod: string | null;
    secretNames: string[] | null;
    isDefault: boolean;
    selectedModel: string | null;
  }>
> {
  const request = createTestRequest(
    "http://localhost:3000/api/model-providers",
  );
  const response = await listModelProvidersRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to list model providers: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return data.modelProviders;
}

// ============================================================================
// Secret Test Helpers
// ============================================================================

/**
 * Create or update a platform secret via API route handler.
 *
 * @param name - The secret name (uppercase with underscores)
 * @param value - The secret value
 * @param description - Optional description
 * @returns The created/updated secret info
 */
export async function createTestSecret(
  name: string,
  value: string,
  description?: string,
): Promise<{
  id: string;
  name: string;
  description: string | null;
  type: string;
  createdAt: string;
  updatedAt: string;
}> {
  const request = createTestRequest("http://localhost:3000/api/secrets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, value, description }),
  });
  const response = await setSecretRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create secret: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

/**
 * List all secrets via API route handler.
 *
 * @returns Array of secret info
 */
export async function listTestSecrets(): Promise<
  Array<{
    id: string;
    name: string;
    description: string | null;
    type: string;
    createdAt: string;
    updatedAt: string;
  }>
> {
  const request = createTestRequest("http://localhost:3000/api/secrets");
  const response = await listSecretsRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to list secrets: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return data.secrets;
}

// Variable Test Helpers
// ============================================================================

/**
 * Create or update a platform variable via API route handler.
 *
 * @param name - The variable name (uppercase with underscores)
 * @param value - The variable value
 * @param description - Optional description
 * @returns The created/updated variable info
 */
export async function createTestVariable(
  name: string,
  value: string,
  description?: string,
): Promise<{
  id: string;
  name: string;
  value: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}> {
  const request = createTestRequest("http://localhost:3000/api/variables", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, value, description }),
  });
  const response = await setVariableRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create variable: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

// Direct Database Test Helpers
// ============================================================================

/**
 * Insert a stale pending run directly into the database.
 * This simulates a run stuck in "pending" state past the cleanup TTL,
 * which cannot be reproduced through normal API flows since the route
 * handler immediately transitions runs to "running" or "failed".
 *
 * @param userId - The user ID who owns the run
 * @param agentComposeVersionId - The compose version ID
 * @param ageMs - How old the run should be in milliseconds (default: 20 minutes)
 * @returns The inserted run ID
 */
export async function insertStalePendingRun(
  userId: string,
  agentComposeVersionId: string,
  ageMs: number = 20 * 60 * 1000,
): Promise<string> {
  const staleCreatedAt = new Date(Date.now() - ageMs);
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      agentComposeVersionId,
      status: "pending",
      prompt: "Stale pending run",
      createdAt: staleCreatedAt,
      lastHeartbeatAt: staleCreatedAt,
    })
    .returning({ id: agentRuns.id });

  if (!run) {
    throw new Error("Failed to insert stale pending run");
  }

  return run.id;
}

/**
 * Create a permission for an agent compose via API route handler.
 *
 * @param composeId - The compose ID to add permission to
 * @param granteeType - The permission type ('public' or 'email')
 * @param granteeEmail - The email address (required if granteeType is 'email')
 */
export async function createTestPermission(
  composeId: string,
  granteeType: "public" | "email",
  granteeEmail?: string,
): Promise<void> {
  const body: { granteeType: string; granteeEmail?: string } = { granteeType };
  if (granteeType === "email" && granteeEmail) {
    body.granteeEmail = granteeEmail;
  }

  const request = createTestRequest(
    `http://localhost:3000/api/agent/composes/${composeId}/permissions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const response = await addPermissionRoute(request, {
    params: Promise.resolve({ id: composeId }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create permission: ${error.error?.message || response.status}`,
    );
  }
}

/**
 * Create a test connector directly in the database.
 * Used for setting up test data for connector API tests.
 *
 * @param scopeId - The scope ID to associate with the connector
 * @param options - Optional overrides for connector properties
 */
export async function createTestConnector(
  scopeId: string,
  options?: {
    type?: ConnectorType;
    authMethod?: "oauth" | "pat";
    externalId?: string;
    externalUsername?: string;
    externalEmail?: string;
    oauthScopes?: string[];
    accessToken?: string;
  },
): Promise<typeof connectors.$inferSelect> {
  const type = options?.type ?? "github";

  const [connector] = await globalThis.services.db
    .insert(connectors)
    .values({
      scopeId,
      type,
      authMethod: options?.authMethod ?? "oauth",
      externalId: options?.externalId ?? "12345",
      externalUsername: options?.externalUsername ?? "testuser",
      externalEmail: options?.externalEmail ?? "test@example.com",
      oauthScopes: JSON.stringify(options?.oauthScopes ?? ["repo"]),
    })
    .returning();

  // Also create the associated secret with proper encryption
  const secretName = `${type.toUpperCase()}_ACCESS_TOKEN`;
  const tokenValue = options?.accessToken ?? "test-github-token";
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptCredentialValue(tokenValue, encryptionKey);

  await globalThis.services.db.insert(secrets).values({
    scopeId,
    name: secretName,
    type: "connector",
    encryptedValue,
    description: `OAuth token for ${type} connector`,
  });

  return connector!;
}

/**
 * Generate a unique session code for testing (format: XXXX-XXXX, max 9 chars)
 */
function generateTestSessionCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Create a test connector session directly in the database.
 * Used for setting up test data for session status tests.
 *
 * @param userId - The user ID to associate with the session
 * @param type - The connector type
 * @param options - Session configuration options
 */
export async function createTestConnectorSession(
  userId: string,
  type: ConnectorType,
  options?: {
    status?: "pending" | "complete" | "error";
    errorMessage?: string;
    expiresAt?: Date;
    completedAt?: Date;
  },
): Promise<typeof connectorSessions.$inferSelect> {
  const expiresAt = options?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000); // 15 minutes default

  const [session] = await globalThis.services.db
    .insert(connectorSessions)
    .values({
      code: generateTestSessionCode(),
      type,
      userId,
      status: options?.status ?? "pending",
      errorMessage: options?.errorMessage,
      expiresAt,
      completedAt: options?.completedAt,
    })
    .returning();

  return session!;
}

// ============================================================================
// Compose Job Test Helpers
// ============================================================================

/**
 * Insert a compose job directly into DB for test setup.
 * Uses direct DB insert because compose jobs are created by internal
 * server logic (sandbox spawn), not by a user-facing API route.
 *
 * @returns The compose job ID
 */
export async function createTestComposeJob(options: {
  status: string;
  createdAt: Date;
  userId?: string;
}): Promise<string> {
  const [row] = await globalThis.services.db
    .insert(composeJobs)
    .values({
      userId: options.userId ?? "test-user",
      githubUrl: "https://github.com/test/repo",
      status: options.status,
      createdAt: options.createdAt,
    })
    .returning({ id: composeJobs.id });
  return row!.id;
}

/**
 * Look up a compose job's status and error for verification.
 */
export async function findTestComposeJob(
  jobId: string,
): Promise<{ status: string; error: string | null } | undefined> {
  const [row] = await globalThis.services.db
    .select({ status: composeJobs.status, error: composeJobs.error })
    .from(composeJobs)
    .where(eq(composeJobs.id, jobId));
  return row;
}

/**
 * Create a completed agent run with controlled timestamps.
 *
 * Direct DB insert is required because createdAt uses PostgreSQL defaultNow()
 * which cannot be controlled via the API or JavaScript fake timers. Tests for
 * date-range logic (cron aggregation, usage API boundaries) need runs placed
 * at specific historical dates.
 */
export async function createCompletedTestRun(options: {
  composeVersionId: string;
  userId: string;
  createdAt: Date;
  startedAt: Date;
  completedAt: Date;
}): Promise<string> {
  const [row] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: options.userId,
      agentComposeVersionId: options.composeVersionId,
      status: "completed",
      prompt: "test",
      createdAt: options.createdAt,
      startedAt: options.startedAt,
      completedAt: options.completedAt,
    })
    .returning({ id: agentRuns.id });
  return row!.id;
}

/**
 * Look up a usage_daily record for verification in tests.
 */
export async function findUsageDaily(
  userId: string,
  date: string,
): Promise<{ runCount: number; runTimeMs: number } | undefined> {
  const [row] = await globalThis.services.db
    .select({
      runCount: usageDaily.runCount,
      runTimeMs: usageDaily.runTimeMs,
    })
    .from(usageDaily)
    .where(and(eq(usageDaily.userId, userId), eq(usageDaily.date, date)));
  return row;
}

/**
 * Insert a slack_compose_requests record for test setup.
 */
export async function createTestSlackComposeRequest(options: {
  composeJobId: string;
  slackWorkspaceId: string;
  slackUserId: string;
  slackChannelId: string;
}) {
  const [row] = await globalThis.services.db
    .insert(slackComposeRequests)
    .values(options)
    .returning();
  return row!;
}

/**
 * Find slack_compose_requests by composeJobId for verification.
 */
/**
 * Find artifact storage for a scope, including its HEAD version details.
 */
export async function findTestArtifactStorage(scopeId: string) {
  const [storage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.scopeId, scopeId),
        eq(storages.name, "artifact"),
        eq(storages.type, "artifact"),
      ),
    )
    .limit(1);

  if (!storage) return null;

  const version = storage.headVersionId
    ? (
        await globalThis.services.db
          .select()
          .from(storageVersions)
          .where(eq(storageVersions.id, storage.headVersionId))
          .limit(1)
      )[0]
    : null;

  return { storage, version: version ?? null };
}

export async function findTestSlackComposeRequest(composeJobId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(slackComposeRequests)
    .where(eq(slackComposeRequests.composeJobId, composeJobId))
    .limit(1);
  return row;
}

/**
 * Link an existing run to a schedule by setting its scheduleId.
 */
export async function linkRunToSchedule(
  runId: string,
  scheduleId: string,
): Promise<void> {
  await globalThis.services.db
    .update(agentRuns)
    .set({ scheduleId })
    .where(eq(agentRuns.id, runId));
}

/**
 * Create a thread session for testing (e.g., notification-created sessions with null bindingId).
 */
export async function createTestThreadSession(params: {
  userLinkId: string;
  channelId: string;
  threadTs: string;
  agentSessionId: string;
  lastProcessedMessageTs?: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(slackThreadSessions)
    .values({
      slackUserLinkId: params.userLinkId,
      slackChannelId: params.channelId,
      slackThreadTs: params.threadTs,
      agentSessionId: params.agentSessionId,
      lastProcessedMessageTs: params.lastProcessedMessageTs ?? params.threadTs,
    })
    .returning({ id: slackThreadSessions.id });
  return row!;
}

export async function findTestThreadSession(channelId: string): Promise<{
  id: string;
  slackChannelId: string;
  slackUserLinkId: string;
  agentSessionId: string | null;
} | null> {
  const [row] = await globalThis.services.db
    .select({
      id: slackThreadSessions.id,
      slackChannelId: slackThreadSessions.slackChannelId,
      slackUserLinkId: slackThreadSessions.slackUserLinkId,
      agentSessionId: slackThreadSessions.agentSessionId,
    })
    .from(slackThreadSessions)
    .where(eq(slackThreadSessions.slackChannelId, channelId))
    .limit(1);
  return row ?? null;
}

// ============================================================================
// Email Thread Session Test Helpers
// ============================================================================

/**
 * Create an email thread session directly in the database for test setup.
 */
export async function createTestEmailThreadSession(params: {
  userId: string;
  composeId: string;
  agentSessionId: string;
  replyToToken: string;
  lastEmailMessageId?: string | null;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(emailThreadSessions)
    .values({
      userId: params.userId,
      composeId: params.composeId,
      agentSessionId: params.agentSessionId,
      replyToToken: params.replyToToken,
      lastEmailMessageId: params.lastEmailMessageId ?? null,
    })
    .returning({ id: emailThreadSessions.id });
  return row!;
}

/**
 * Find an email thread session by its reply-to token.
 */
export async function findTestEmailThreadSession(replyToToken: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(emailThreadSessions)
    .where(eq(emailThreadSessions.replyToToken, replyToToken))
    .limit(1);
  return row ?? null;
}

/**
 * Find agent runs matching a given userId and prompt.
 */
export async function findTestRunsByUserAndPrompt(
  userId: string,
  prompt: string,
) {
  return globalThis.services.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.prompt, prompt)));
}

/**
 * Create a test callback record for agent run completion
 * Returns the callback ID and the plaintext secret for signing test requests
 */
export async function createTestCallback(params: {
  runId: string;
  url: string;
  payload?: Record<string, unknown>;
}): Promise<{ callbackId: string; secret: string }> {
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const secret = generateCallbackSecret();
  const encryptedSecret = encryptCredentialValue(
    secret,
    SECRETS_ENCRYPTION_KEY,
  );

  const [callback] = await globalThis.services.db
    .insert(agentRunCallbacks)
    .values({
      runId: params.runId,
      url: params.url,
      encryptedSecret,
      payload: params.payload ?? null,
    })
    .returning({ id: agentRunCallbacks.id });

  return { callbackId: callback!.id, secret };
}

/**
 * Find all callback records for a given run ID.
 */
export async function findTestCallbacksByRunId(runId: string) {
  return globalThis.services.db
    .select()
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
}

/**
 * Look up a full agent run record by ID for verification in tests.
 *
 * Direct DB read is required because the public GET /v1/runs/:id endpoint
 * does not expose internal fields like `vars`, `secretNames`, `scheduleId`,
 * or `lastHeartbeatAt` that integration tests need to verify.
 */
export async function findTestRunRecord(
  runId: string,
): Promise<typeof agentRuns.$inferSelect | undefined> {
  const [row] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row;
}

/**
 * Look up agent run callback records by run ID for verification in tests.
 *
 * Direct DB read is required because no API endpoint exposes callback
 * records — they are internal implementation details of the run dispatch.
 */
export async function findTestRunCallbacks(
  runId: string,
): Promise<Array<typeof agentRunCallbacks.$inferSelect>> {
  return globalThis.services.db
    .select()
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
}

/**
 * Find the first run that matches the given status for verification in tests.
 *
 * Direct DB read is required because no API endpoint supports filtering
 * runs by status — the public API only looks up by specific run ID.
 */
export async function findTestRunByStatus(
  status: string,
): Promise<typeof agentRuns.$inferSelect | undefined> {
  const [row] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.status, status))
    .limit(1);
  return row;
}

export async function findTestSlackInstallation(workspaceId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  return row;
}

/**
 * Find agent permissions for a compose and email.
 *
 * Direct DB read is required because no API endpoint lists permissions
 * filtered by compose + grantee email.
 */
export async function findTestAgentPermissions(
  composeId: string,
  granteeEmail: string,
) {
  return globalThis.services.db
    .select()
    .from(agentPermissions)
    .where(
      and(
        eq(agentPermissions.agentComposeId, composeId),
        eq(agentPermissions.granteeType, "email"),
        eq(agentPermissions.granteeEmail, granteeEmail),
      ),
    );
}

/**
 * Insert an agent permission directly in the database.
 *
 * Direct DB insert is required because the permissions API route uses the
 * current user as grantedBy. Tests that simulate permissions granted by
 * external flows (e.g., CLI share) need to set arbitrary grantedBy values.
 */
export async function insertTestAgentPermission(
  composeId: string,
  granteeEmail: string,
  grantedBy: string,
) {
  await globalThis.services.db
    .insert(agentPermissions)
    .values({
      agentComposeId: composeId,
      granteeType: "email",
      granteeEmail,
      grantedBy,
    })
    .onConflictDoNothing();
}

/**
 * Find a compose record with its scope details.
 *
 * Direct DB read is required because the compose API does not expose
 * scope slug in its response — it only returns compose-level fields.
 */
export async function findTestComposeWithScope(composeId: string) {
  const [row] = await globalThis.services.db
    .select({
      composeId: agentComposes.id,
      composeName: agentComposes.name,
      scopeSlug: scopes.slug,
    })
    .from(agentComposes)
    .innerJoin(scopes, eq(scopes.id, agentComposes.scopeId))
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return row;
}
