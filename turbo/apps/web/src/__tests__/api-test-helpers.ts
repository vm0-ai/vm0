/**
 * Test Helper Utilities for API-based Test Data Creation
 *
 * These utilities provide functions to create test data through API endpoints
 * instead of direct database operations. This ensures tests validate the
 * complete API flow, catching issues that direct DB operations might miss.
 */
import { randomUUID } from "crypto";
import { vi } from "vitest";
import { http as mswHttp, HttpResponse } from "msw";
import { NextRequest } from "next/server";
import type { AgentComposeYaml } from "../types/agent-compose";
import {
  generateSandboxToken,
  generateComposeJobToken,
} from "../lib/auth/sandbox-token";
import { server } from "../mocks/server";
import { reloadEnv } from "../env";
import { randomBytes } from "crypto";
import { cliTokens } from "../db/schema/cli-tokens";
import { deviceCodes } from "../db/schema/device-codes";
import { agentRuns } from "../db/schema/agent-run";
import { runnerJobQueue } from "../db/schema/runner-job-queue";
import { composeJobs } from "../db/schema/compose-job";
import { exportJobs } from "../db/schema/export-job";
import { storages, storageVersions } from "../db/schema/storage";
import { skills } from "../db/schema/skill";
import { usageDaily } from "../db/schema/usage-daily";
import { slackOrgInstallations } from "../db/schema/slack-org-installation";
import { slackOrgConnections } from "../db/schema/slack-org-connection";
import { githubInstallations } from "../db/schema/github-installation";
import { githubUserLinks } from "../db/schema/github-user-link";
import { githubIssueSessions } from "../db/schema/github-issue-session";
import { emailThreadSessions } from "../db/schema/email-thread-session";
import { agentRunCallbacks } from "../db/schema/agent-run-callback";
import { agentRunQueue } from "../db/schema/agent-run-queue";
import { agentSchedules } from "../db/schema/agent-schedule";
import { emailOutbox } from "../db/schema/email-outbox";
import type { EmailTemplate, PostSendAction } from "../lib/email/types";
import { telegramInstallations } from "../db/schema/telegram-installation";
import { telegramMessages } from "../db/schema/telegram-message";
import { telegramUserLinks } from "../db/schema/telegram-user-link";
import { orgCache } from "../db/schema/org-cache";
import { orgMembersCache } from "../db/schema/org-members-cache";
import { userCache } from "../db/schema/user-cache";
import { creditUsage } from "../db/schema/credit-usage";
import { creditPricing } from "../db/schema/credit-pricing";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { generateCallbackSecret } from "../lib/callback/hmac";
import { initServices } from "../lib/init-services";
import { encryptSecretsMap } from "../lib/crypto/secrets-encryption";
import {
  VOLUME_ORG_USER_ID,
  SYSTEM_ORG_ID,
  type StoredExecutionContext,
} from "@vm0/core";

// Route handlers - imported here so callers don't need to pass them
import { POST as createComposeRoute } from "../../app/api/agent/composes/route";
// POST /api/org removed in 5b-5 — org creation is now Clerk's responsibility
import { POST as createRunRoute } from "../../app/api/agent/runs/route";
import { GET as getRunByIdRoute } from "../../app/api/agent/runs/[id]/route";
import { PUT as upsertOrgModelProviderRoute } from "../../app/api/org/model-providers/route";
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
import { PUT as setSecretRoute } from "../../app/api/secrets/route";
import { PUT as setVariableRoute } from "../../app/api/variables/route";

import { GET as connectorCallbackRoute } from "../../app/api/connectors/[type]/callback/route";
import { connectors } from "../db/schema/connector";
import { connectorSessions } from "../db/schema/connector-session";
import { secrets } from "../db/schema/secret";
import { hashFileContent } from "../lib/storage/content-hash";
import {
  encryptSecretValue,
  decryptSecretValue,
} from "../lib/crypto/secrets-encryption";
import type { ConnectorType } from "@vm0/core";
import {
  agentSessions,
  type StoredChatMessage,
} from "../db/schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../db/schema/agent-compose";
import { conversations } from "../db/schema/conversation";
import { uniqueId, uniqueNumericId } from "./test-helpers";

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
    framework: "claude-code",
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
  orgSlug?: string;
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
    orgSlug: options?.orgSlug ?? null,
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
 * Create a test org by inserting into org_cache.
 *
 * Pre-populates org_cache so getOrgData() works without Clerk API calls.
 *
 * @param slug - The org slug
 * @returns The created org with id and slug
 */
export async function createTestOrg(
  slug: string,
): Promise<{ id: string; slug: string }> {
  initServices();

  // Use the mock Clerk orgId pattern from clerk-mock.ts
  const { userId } = await import("@clerk/nextjs/server").then((m) => m.auth());
  const orgId = `org_mock_${userId}`;

  // Pre-populate org_cache so getOrgData() works without Clerk API calls
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId,
      slug,
      tier: "free",
      credits: 0,
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug, tier: "free", credits: 0, cachedAt: new Date() },
    });

  return { id: orgId, slug };
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
 * Create a test org-level model provider via API route handler.
 * This creates an org-scoped provider (using ORG_SENTINEL_USER_ID internally).
 *
 * @param type - The provider type
 * @param secretValue - The secret value
 * @param selectedModel - Optional selected model for providers with model selection
 * @returns The created provider with id and type
 */
export async function createTestOrgModelProvider(
  type: string,
  secretValue: string,
  selectedModel?: string,
): Promise<{ id: string; type: string; selectedModel: string | null }> {
  const request = createTestRequest(
    "http://localhost:3000/api/org/model-providers",
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
  const response = await upsertOrgModelProviderRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create org model provider: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return data.provider;
}

/**
 * Create a test org-level multi-auth model provider via API route handler.
 * This creates an org-scoped provider (using ORG_SENTINEL_USER_ID internally).
 *
 * @param type - The provider type (e.g., "aws-bedrock")
 * @param authMethod - The auth method (e.g., "api-key", "access-keys")
 * @param secrets - Map of secret names to values
 * @param selectedModel - Optional selected model
 * @returns The created provider with id and type
 */
export async function createTestOrgMultiAuthModelProvider(
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
    "http://localhost:3000/api/org/model-providers",
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
  const response = await upsertOrgModelProviderRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create org multi-auth model provider: ${error.error?.message || response.status}`,
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
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) throw new Error(`Compose ${agentComposeId} not found`);
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({ userId, orgId: compose.orgId, agentComposeId })
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
 * Create a run with no compose version (simulates deleted compose).
 * Useful for testing that endpoints handle orphan runs gracefully.
 */
export async function createOrphanTestRun(
  userId: string,
  orgId: string,
  options?: { status?: string; prompt?: string },
): Promise<{ runId: string }> {
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: null,
      status: options?.status ?? "completed",
      prompt: options?.prompt ?? "orphan run prompt",
    })
    .returning({ id: agentRuns.id });
  return { runId: run!.id };
}

/**
 * Create a run record directly in the database.
 * Use this when you need a run without going through the API route
 * (e.g., for webhook tests where Clerk auth is disabled).
 */
async function createTestRunDirect(
  userId: string,
  versionId: string,
  orgId: string,
  options?: {
    status?: string;
    prompt?: string;
    continuedFromSessionId?: string;
    createdAt?: Date;
    startedAt?: Date;
    completedAt?: Date;
  },
): Promise<{ id: string }> {
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      status: options?.status ?? "running",
      prompt: options?.prompt ?? "test prompt",
      continuedFromSessionId: options?.continuedFromSessionId,
      ...(options?.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options?.startedAt ? { startedAt: options.startedAt } : {}),
      ...(options?.completedAt ? { completedAt: options.completedAt } : {}),
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
  // Look up orgId from the compose
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) {
    throw new Error(`Compose ${agentComposeId} not found`);
  }
  // Create compose version
  const versionId = await createTestComposeVersion(agentComposeId, userId);
  // Create run
  const run = await createTestRunDirect(userId, versionId, compose.orgId, {
    status: "completed",
  });
  // Create conversation
  const conversation = await createTestConversation(run.id);
  // Create session with conversation
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({
      userId,
      orgId: compose.orgId,
      agentComposeId,
      conversationId: conversation.id,
    })
    .returning({ id: agentSessions.id });
  return session!;
}

/**
 * Create a run record directly in the database, bypassing the API route and dispatch.
 * Use this when you need a run in a specific status without triggering dispatch logic
 * (e.g., for cron cleanup tests that need runs in pending/running state).
 */
export async function createTestRunInDb(
  userId: string,
  agentComposeId: string,
  options?: {
    status?: string;
    prompt?: string;
    continuedFromSessionId?: string;
    createdAt?: Date;
    orgId?: string;
    startedAt?: Date;
    completedAt?: Date;
  },
): Promise<{ runId: string }> {
  // Look up orgId from compose
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) {
    throw new Error(`Compose ${agentComposeId} not found`);
  }
  // Create a version for the run
  const versionId = await createTestComposeVersion(agentComposeId, userId);
  // Create run directly (use provided orgId or fall back to compose orgId)
  const run = await createTestRunDirect(
    userId,
    versionId,
    options?.orgId ?? compose.orgId,
    {
      status: options?.status ?? "pending",
      prompt: options?.prompt ?? "test prompt",
      continuedFromSessionId: options?.continuedFromSessionId,
      createdAt: options?.createdAt,
      startedAt: options?.startedAt,
      completedAt: options?.completedAt,
    },
  );
  return { runId: run.id };
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
    memoryName?: string;
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
 * Get test run details via internal API route handler.
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
  const request = createTestRequest(
    `http://localhost:3000/api/agent/runs/${runId}`,
  );
  const response = await getRunByIdRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to get run: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return {
    id: data.runId,
    status: data.status,
    error: data.error ?? null,
    completedAt: data.completedAt ?? null,
  };
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

/**
 * Fail a test run via the complete webhook (exitCode=1).
 *
 * Unlike completeTestRun, no checkpoint is needed for a failed run.
 */
export async function failTestRun(
  userId: string,
  runId: string,
  error?: string,
): Promise<void> {
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
        exitCode: 1,
        error: error ?? "test failure",
      }),
    },
  );
  const response = await completeWebhook(request);
  if (!response.ok) {
    const errorBody = await response.json();
    throw new Error(
      `Failed to fail run: ${(errorBody as { error?: { message?: string } }).error?.message || response.status}`,
    );
  }
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
 * Note: vars and secrets are now managed via server-side tables (vm0 secret set, vm0 var set)
 */
export async function createTestSchedule(
  composeId: string,
  name: string,
  options?: {
    cronExpression?: string;
    atTime?: string;
    intervalSeconds?: number;
    timezone?: string;
    prompt?: string;
    // vars and secrets removed - now managed via server-side tables
  },
): Promise<ScheduleResponse> {
  // Default to cron if no trigger specified
  const trigger =
    options?.cronExpression ||
    options?.atTime ||
    options?.intervalSeconds !== undefined
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
        intervalSeconds: options?.intervalSeconds,
        // vars and secrets no longer sent - managed via server-side tables
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
  /** Storage type: "artifact", "volume", or "memory" */
  type?: "artifact" | "volume" | "memory";
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
 * Create a volume storage directly in the DB for a specific org.
 * Unlike createTestVolume() which uses the mock user's org via API,
 * this allows creating storages under any org (e.g., SYSTEM_ORG_ID).
 *
 * @param orgId - The org to create the storage under
 * @param name - Storage name
 * @returns The created storage with versionId
 */
export async function createTestVolumeForOrg(
  orgId: string,
  name: string,
): Promise<{ storageId: string; versionId: string }> {
  const versionId = randomUUID().replace(/-/g, "").repeat(2).slice(0, 64);
  const s3Key = `${orgId}/${name}/${versionId}`;

  const [storage] = await globalThis.services.db
    .insert(storages)
    .values({
      orgId,
      userId: VOLUME_ORG_USER_ID,
      name,
      type: "volume",
      s3Prefix: `${orgId}/${name}`,
    })
    .returning();

  const storageId = storage!.id;

  await globalThis.services.db.insert(storageVersions).values({
    id: versionId,
    storageId,
    s3Key,
    size: 100,
    fileCount: 1,
    createdBy: "test",
  });

  await globalThis.services.db
    .update(storages)
    .set({ headVersionId: versionId })
    .where(eq(storages.id, storageId));

  return { storageId, versionId };
}

/**
 * Create a test memory storage via API route handlers.
 * Convenience wrapper around createTestStorage with type="memory".
 *
 * @param name - Memory storage name
 * @param options - Optional configuration
 * @returns The created memory storage with versionId
 */
export async function createTestMemory(
  name: string,
  options?: Omit<CreateTestStorageOptions, "type">,
): Promise<{
  versionId: string;
  name: string;
  size: number;
  fileCount: number;
}> {
  return createTestStorage(name, { ...options, type: "memory" });
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
 * Resolve orgId from a compose version ID.
 * Shared by test helpers that insert agent_runs records directly.
 */
async function getOrgIdFromVersion(versionId: string): Promise<string> {
  const [row] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposes.id, agentComposeVersions.composeId),
    )
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);
  if (!row) {
    throw new Error(`Compose version ${versionId} not found`);
  }
  return row.orgId;
}

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
  const orgId = await getOrgIdFromVersion(agentComposeVersionId);

  const staleCreatedAt = new Date(Date.now() - ageMs);
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
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
/**
 * Create a test connector via API routes.
 *
 * - api-token: calls POST /api/connectors/:type/token
 * - oauth: calls GET /api/connectors/:type/callback with MSW mocks
 *
 * @param options - Connector configuration
 */
export async function createTestConnector(options?: {
  type?: ConnectorType;
  authMethod?: "oauth" | "api-token";
  accessToken?: string;
  /** Secret name for api-token (e.g. "FIGMA_TOKEN"). Required for api-token. */
  secretName?: string;
  externalUsername?: string;
  externalId?: string | null;
  externalEmail?: string | null;
  oauthScopes?: string[];
  userId?: string;
}): Promise<void> {
  const authMethod = options?.authMethod ?? "oauth";

  if (authMethod === "api-token") {
    await createTestApiTokenConnector(options);
  } else {
    await createTestOAuthConnector(options);
  }
}

/**
 * Create an api-token connector by storing user secrets via PUT /api/secrets.
 * Api-token connector status is now derived from user secrets, not DB records.
 */
async function createTestApiTokenConnector(options?: {
  type?: ConnectorType;
  accessToken?: string;
  secretName?: string;
}): Promise<void> {
  const type = options?.type ?? "github";
  const tokenValue = options?.accessToken ?? "test-api-token";
  const secretName =
    options?.secretName ?? `${type.toUpperCase().replace(/-/g, "_")}_TOKEN`;

  const request = createTestRequest("http://localhost:3000/api/secrets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: secretName,
      value: tokenValue,
      description: `API token for ${type} connector`,
    }),
  });
  const response = await setSecretRoute(request);
  if (response.status !== 200 && response.status !== 201) {
    const data = await response.json();
    throw new Error(
      `Failed to create api-token connector user secret: ${data.error?.message ?? response.status}`,
    );
  }
}

// OAuth provider mock configurations for test setup
const OAUTH_PROVIDER_MOCKS: Record<
  string,
  {
    tokenUrl: string;
    userUrl: string;
    envVars: Record<string, string>;
    buildTokenResponse: (accessToken: string) => Record<string, unknown>;
    buildUserResponse: (opts: {
      userId?: number;
      username?: string;
      email?: string;
    }) => Record<string, unknown>;
  }
> = {
  github: {
    tokenUrl: "https://github.com/login/oauth/access_token",
    userUrl: "https://api.github.com/user",
    envVars: {
      GH_OAUTH_CLIENT_ID: "test-client-id",
      GH_OAUTH_CLIENT_SECRET: "test-client-secret",
    },
    buildTokenResponse: (accessToken) => ({
      access_token: accessToken,
      scope: "repo,project",
      token_type: "bearer",
    }),
    buildUserResponse: (opts) => ({
      id: opts.userId ?? 12345,
      login: opts.username ?? "testuser",
      email: opts.email ?? "test@example.com",
    }),
  },
  slack: {
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    userUrl: "https://slack.com/api/users.info",
    envVars: {},
    buildTokenResponse: (accessToken) => ({
      ok: true,
      authed_user: {
        id: "U12345",
        access_token: accessToken,
        scope: "channels:read,chat:write",
      },
    }),
    buildUserResponse: (opts) => ({
      ok: true,
      user: {
        id: opts.userId?.toString() ?? "U12345",
        name: opts.username ?? "testuser",
        real_name: opts.username ?? "Test User",
        profile: { email: opts.email ?? "test@example.com" },
      },
    }),
  },
  figma: {
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    userUrl: "https://api.figma.com/v1/me",
    envVars: {
      FIGMA_OAUTH_CLIENT_ID: "figma-test-client-id",
      FIGMA_OAUTH_CLIENT_SECRET: "figma-test-client-secret",
    },
    buildTokenResponse: (accessToken) => ({
      access_token: accessToken,
      refresh_token: "figma-refresh-token",
      expires_in: 7776000,
    }),
    buildUserResponse: (opts) => ({
      id: opts.userId?.toString() ?? "12345",
      email: opts.email ?? "test@example.com",
      handle: opts.username ?? "testuser",
    }),
  },
};

/**
 * Create an OAuth connector via GET /api/connectors/:type/callback with MSW mocks.
 */
async function createTestOAuthConnector(options?: {
  type?: ConnectorType;
  accessToken?: string;
  externalUsername?: string;
}): Promise<void> {
  const type = options?.type ?? "github";
  const accessToken = options?.accessToken ?? "test-github-token";
  const providerMock = OAUTH_PROVIDER_MOCKS[type];
  if (!providerMock) {
    throw new Error(
      `No OAuth mock config for connector type "${type}". ` +
        `Supported: ${Object.keys(OAUTH_PROVIDER_MOCKS).join(", ")}`,
    );
  }

  // Stub OAuth client env vars if the provider needs them
  for (const [key, value] of Object.entries(providerMock.envVars)) {
    vi.stubEnv(key, value);
  }
  reloadEnv();

  // Set up MSW handlers for token exchange + user info
  server.use(
    mswHttp.post(providerMock.tokenUrl, () =>
      HttpResponse.json(providerMock.buildTokenResponse(accessToken)),
    ),
    mswHttp.get(providerMock.userUrl, () =>
      HttpResponse.json(
        providerMock.buildUserResponse({
          username: options?.externalUsername ?? "testuser",
        }),
      ),
    ),
  );

  // Create callback request with proper cookies
  const state = "test-oauth-state";
  const url = new URL(`http://localhost:3000/api/connectors/${type}/callback`);
  url.searchParams.set("code", "test-code");
  url.searchParams.set("state", state);

  const request = createTestRequest(url.toString(), {
    headers: { Cookie: `connector_oauth_state=${state}` },
  });
  const response = await connectorCallbackRoute(request, {
    params: Promise.resolve({ type }),
  });

  // Callback redirects to /connector/success on success
  const location = response.headers.get("location") ?? "";
  if (!location.includes("/connector/success")) {
    throw new Error(
      `OAuth callback failed: status=${response.status} location=${location}`,
    );
  }
}

/**
 * Find and decrypt a connector secret token from the database.
 * Used for verifying that the correct token was stored during connector OAuth flow.
 *
 * @param orgId - The org ID to look up the secret for
 * @param secretName - The secret name (e.g. "SLACK_ACCESS_TOKEN")
 * @returns The decrypted token value, or undefined if not found
 */
export async function findTestConnectorSecret(
  orgId: string,
  secretName: string,
  type: "connector" | "user" = "connector",
): Promise<string | undefined> {
  const [storedSecret] = await globalThis.services.db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.name, secretName),
        eq(secrets.type, type),
      ),
    )
    .limit(1);

  if (!storedSecret) return undefined;

  return decryptSecretValue(
    storedSecret.encryptedValue,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );
}

/**
 * Get the tokenExpiresAt timestamp for a connector.
 * Used for verifying that token expiry was correctly stored during OAuth flow.
 *
 * @param orgId - The org ID
 * @param type - The connector type (e.g. "notion", "github")
 * @returns The tokenExpiresAt Date, or null if not set, or undefined if connector not found
 */
/**
 * Set the needsReconnect flag for a connector in the database.
 * Used for testing the needsReconnect feature without triggering a real token refresh failure.
 */
export async function setTestConnectorNeedsReconnect(
  orgId: string,
  userId: string,
  type: string,
  needsReconnect: boolean,
): Promise<void> {
  await globalThis.services.db
    .update(connectors)
    .set({ needsReconnect })
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        eq(connectors.type, type),
      ),
    );
}

export async function setTestConnectorOauthScopes(
  orgId: string,
  userId: string,
  type: string,
  scopes: string[],
): Promise<void> {
  await globalThis.services.db
    .update(connectors)
    .set({ oauthScopes: JSON.stringify(scopes) })
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        eq(connectors.type, type),
      ),
    );
}

export async function findTestConnectorTokenExpiresAt(
  orgId: string,
  type: string,
): Promise<Date | null | undefined> {
  const [row] = await globalThis.services.db
    .select({ tokenExpiresAt: connectors.tokenExpiresAt })
    .from(connectors)
    .where(and(eq(connectors.orgId, orgId), eq(connectors.type, type)))
    .limit(1);

  if (!row) return undefined;
  return row.tokenExpiresAt;
}

/**
 * Insert an encrypted connector secret into the database.
 * Used for setting up test state (e.g., access tokens, refresh tokens) without going through the OAuth flow.
 */
export async function insertTestConnectorSecret(
  orgId: string,
  userId: string,
  name: string,
  value: string,
): Promise<void> {
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  await globalThis.services.db.insert(secrets).values({
    name,
    encryptedValue: encryptSecretValue(value, encryptionKey),
    type: "connector",
    userId,
    orgId,
  });
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
 * Delete all pending and running compose jobs.
 * Used by cleanup cron tests to ensure test isolation, since the cron
 * route queries all jobs globally regardless of user.
 */
export async function deleteStaleTestComposeJobs(): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(composeJobs)
    .where(inArray(composeJobs.status, ["pending", "running"]));
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
  const orgId = await getOrgIdFromVersion(options.composeVersionId);

  const [row] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: options.userId,
      orgId,
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
  orgId: string,
  date: string,
): Promise<{ runCount: number; runTimeMs: number } | undefined> {
  const [row] = await globalThis.services.db
    .select({
      runCount: usageDaily.runCount,
      runTimeMs: usageDaily.runTimeMs,
    })
    .from(usageDaily)
    .where(
      and(
        eq(usageDaily.userId, userId),
        eq(usageDaily.orgId, orgId),
        eq(usageDaily.date, date),
      ),
    );
  return row;
}

/**
 * Find a storage volume by clerk org and name.
 * Volumes use the sentinel VOLUME_ORG_USER_ID for org-level sharing.
 * Returns the storage id and name, or undefined if not found.
 */
export async function findTestStorageByName(
  orgId: string,
  name: string,
): Promise<{ id: string; name: string; s3Prefix: string } | undefined> {
  const [result] = await globalThis.services.db
    .select({
      id: storages.id,
      name: storages.name,
      s3Prefix: storages.s3Prefix,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, name),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1);
  return result;
}
/**
 * Find a storage record by clerk org, name, and type.
 * Returns the storage userId and other details for verification.
 */
export async function findTestStorage(
  orgId: string,
  name: string,
  type: "volume" | "artifact" | "memory",
): Promise<
  { id: string; name: string; userId: string; s3Prefix: string } | undefined
> {
  const [result] = await globalThis.services.db
    .select({
      id: storages.id,
      name: storages.name,
      userId: storages.userId,
      s3Prefix: storages.s3Prefix,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.name, name),
        eq(storages.type, type),
      ),
    )
    .limit(1);
  return result;
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
 * Find agent runs by user ID where prompt contains the given substring.
 * Useful when the full prompt is not known (e.g., when attachments are appended).
 */
export async function findTestRunsByUserAndPromptContaining(
  userId: string,
  promptSubstring: string,
) {
  return globalThis.services.db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        like(agentRuns.prompt, `%${promptSubstring}%`),
      ),
    );
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
  const encryptedSecret = encryptSecretValue(secret, SECRETS_ENCRYPTION_KEY);

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
 * Direct DB read is required because the GET /api/agent/runs/:id endpoint
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

export async function findTestQueueEntry(runId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(agentRunQueue)
    .where(eq(agentRunQueue.runId, runId))
    .limit(1);
  return row;
}

export async function findTestSlackOrgInstallation(workspaceId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  return row;
}

export async function findTestSlackOrgConnection(
  slackUserId: string,
  workspaceId: string,
) {
  const [row] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    );
  return row;
}

export async function findTestSlackOrgConnections(
  slackUserId: string,
  workspaceId: string,
) {
  return globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    );
}

/**
 * Find a compose record with its org details.
 *
 * Direct DB read is required because the compose API does not expose
 * org slug in its response — it only returns compose-level fields.
 */
export async function findTestComposeWithOrg(composeId: string) {
  const [row] = await globalThis.services.db
    .select({
      composeId: agentComposes.id,
      composeName: agentComposes.name,
      orgSlug: orgCache.slug,
    })
    .from(agentComposes)
    .innerJoin(orgCache, eq(orgCache.orgId, agentComposes.orgId))
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return row;
}

/**
 * Create a runner job queue entry with an associated agent run.
 *
 * @param userId - The user who owns the run
 * @param versionId - The agent compose version ID
 * @param runnerGroup - The runner group (e.g., "org-slug/default")
 * @param contextOverrides - Optional overrides for the stored execution context
 * @param runOverrides - Optional overrides for the agent run record (e.g., appendSystemPrompt)
 * @returns The created run ID
 */
export async function createTestRunnerJob(
  userId: string,
  versionId: string,
  runnerGroup: string,
  contextOverrides?: Partial<StoredExecutionContext>,
  runOverrides?: { appendSystemPrompt?: string },
): Promise<{ runId: string }> {
  const orgId = await getOrgIdFromVersion(versionId);

  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      status: "pending",
      prompt: "test prompt",
      ...runOverrides,
    })
    .returning({ id: agentRuns.id });

  const encryptedSecrets = encryptSecretsMap(
    null,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );

  const storedContext: StoredExecutionContext = {
    workingDir: "/home/user",
    storageManifest: null,
    environment: null,
    resumeSession: null,
    encryptedSecrets,
    cliAgentType: "claude",
    ...contextOverrides,
  };

  await globalThis.services.db.insert(runnerJobQueue).values({
    runId: run!.id,
    runnerGroup,
    executionContext: storedContext,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
  });

  return { runId: run!.id };
}

/**
 * Update internal schedule state for testing edge cases.
 *
 * Direct DB write is required because the schedule API does not expose
 * an endpoint to set internal fields like consecutiveFailures — these
 * are managed by the callback system, not user actions.
 */
export async function updateTestScheduleState(
  scheduleId: string,
  state: {
    consecutiveFailures?: number;
    enabled?: boolean;
    nextRunAt?: Date | null;
  },
): Promise<void> {
  await globalThis.services.db
    .update(agentSchedules)
    .set(state)
    .where(eq(agentSchedules.id, scheduleId));
}

/**
 * Get internal schedule state by ID for verifying callback side-effects.
 *
 * Direct DB read is required because the schedule GET API requires
 * composeId + name, but callback tests only have the schedule ID from
 * the payload. Also exposes internal fields not in the API response.
 */
export async function findTestScheduleById(scheduleId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(eq(agentSchedules.id, scheduleId))
    .limit(1);
  return row;
}

/**
 * Insert a GitHub App installation record directly in the database.
 *
 * Direct DB insert is required because installations are created by the
 * GitHub OAuth callback route, which requires real GitHub API interaction.
 */
export async function insertTestGitHubInstallation(
  composeId: string,
  installationId?: string,
) {
  const id = installationId ?? uniqueNumericId();
  const encryptedToken = encryptSecretValue(
    "ghs_test_token",
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );

  const [row] = await globalThis.services.db
    .insert(githubInstallations)
    .values({
      installationId: id,
      encryptedAccessToken: encryptedToken,
      defaultComposeId: composeId,
    })
    .returning();

  return row!;
}

/**
 * Insert a pending GitHub installation record directly in the database.
 *
 * Direct DB insert is required because pending installations are created by the
 * GitHub OAuth callback route with setup_action=request, which requires a full
 * OAuth redirect flow.
 */
export async function insertTestPendingGitHubInstallation(
  composeId: string,
  targetId: string,
  targetType: string = "Organization",
) {
  const [row] = await globalThis.services.db
    .insert(githubInstallations)
    .values({
      installationId: null,
      encryptedAccessToken: null,
      status: "pending",
      targetId,
      targetType,
      defaultComposeId: composeId,
    })
    .returning();

  return row!;
}

/**
 * Find GitHub installations by installation ID.
 *
 * Direct DB read is required because the GET endpoint filters by userId
 * (authenticated user) and does not support querying by installation ID.
 */
export async function findTestGitHubInstallations(installationId: string) {
  return globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId));
}

/**
 * Find a GitHub installation by its primary key.
 *
 * Direct DB read is required because the DELETE endpoint removes the record,
 * and we need to verify deletion by checking the row no longer exists.
 */
export async function findTestGitHubInstallationById(id: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, id))
    .limit(1);
  return row;
}

/**
 * Create a GitHub installation with a user link and admin role.
 *
 * Combines insertTestGitHubInstallation + insertTestGitHubUserLink
 * and sets adminGithubUserId so the linked user is the admin.
 */
export async function insertTestGitHubInstallationWithAdmin(
  composeId: string,
  vm0UserId: string,
) {
  const githubUserId = uniqueId("gh-uid");
  const installation = await insertTestGitHubInstallation(composeId);

  // Set admin to the github user
  await globalThis.services.db
    .update(githubInstallations)
    .set({ adminGithubUserId: githubUserId })
    .where(eq(githubInstallations.id, installation.id));

  // Create user link inline (maps GitHub user to VM0 user for this installation)
  await globalThis.services.db
    .insert(githubUserLinks)
    .values({
      githubUserId,
      installationId: installation.id,
      vm0UserId,
    })
    .onConflictDoNothing();

  return { installation, githubUserId };
}

/**
 * Insert a GitHub user link record directly in the database.
 *
 * Direct DB insert is required because user links are created by the
 * GitHub OAuth callback which requires real GitHub API interaction.
 * This helper creates a link between a GitHub user and a VM0 user
 * for a given installation, used to test non-admin authorization paths.
 */
export async function insertTestGitHubUserLink(
  githubUserId: string,
  installationId: string,
  vm0UserId: string,
) {
  await globalThis.services.db
    .insert(githubUserLinks)
    .values({ githubUserId, installationId, vm0UserId })
    .onConflictDoNothing();
}

/**
 * Find GitHub installations by target ID.
 *
 * Direct DB read is required because pending installations have no
 * installation_id to query by, and the GET endpoint requires auth context.
 */
export async function findTestGitHubInstallationsByTargetId(targetId: string) {
  return globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.targetId, targetId));
}

/**
 * Insert a GitHub issue session record directly in the database.
 *
 * Direct DB insert is required because issue sessions are created by the
 * callback handler, and we need to pre-populate them for update path tests.
 */
export async function insertTestGitHubIssueSession(params: {
  userId: string;
  installationId: string;
  repo: string;
  issueNumber: number;
  agentSessionId: string;
  lastCommentId?: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(githubIssueSessions)
    .values({
      userId: params.userId,
      installationId: params.installationId,
      repo: params.repo,
      issueNumber: params.issueNumber,
      agentSessionId: params.agentSessionId,
      lastCommentId: params.lastCommentId,
    })
    .returning({ id: githubIssueSessions.id });
  return row!;
}

/**
 * Find a GitHub issue session by installation, repo, and issue number.
 *
 * Direct DB read is required because there is no API endpoint to query
 * issue sessions. Used to verify callback handler creates/updates records.
 */
export async function findTestGitHubIssueSession(
  installationId: string,
  repo: string,
  issueNumber: number,
) {
  const [row] = await globalThis.services.db
    .select()
    .from(githubIssueSessions)
    .where(
      and(
        eq(githubIssueSessions.installationId, installationId),
        eq(githubIssueSessions.repo, repo),
        eq(githubIssueSessions.issueNumber, issueNumber),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Create a Telegram installation with all required parent records.
 * Optionally auto-creates a user link for testing integration endpoints.
 * Returns the installation ID for use as a foreign key.
 */
export async function createTestTelegramInstallation(options?: {
  adminUserId?: string;
  vm0UserId?: string;
  telegramBotId?: string;
}): Promise<string> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;

  const suffix = uniqueId("tg");
  const adminUserId = options?.adminUserId ?? uniqueId("test-admin");

  const orgSlug = uniqueId("org");
  const orgId = uniqueId("org");

  // Pre-populate org cache for getOrgData()
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId,
      slug: orgSlug,
      tier: "free",
      credits: 0,
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug: orgSlug, tier: "free", credits: 0, cachedAt: new Date() },
    });

  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: adminUserId,
      orgId,
      name: uniqueId("compose"),
    })
    .returning();

  const [installation] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: options?.telegramBotId ?? suffix,
      botUsername: `bot_${options?.telegramBotId ?? suffix}`,
      encryptedBotToken: encryptSecretValue(
        "test-bot-token",
        SECRETS_ENCRYPTION_KEY,
      ),
      webhookSecret: uniqueId("secret"),
      defaultComposeId: compose!.id,
      adminUserId,
    })
    .returning();

  // Auto-create user link if vm0UserId is provided
  if (options?.vm0UserId) {
    await globalThis.services.db
      .insert(telegramUserLinks)
      .values({
        telegramUserId: suffix,
        installationId: installation!.id,
        vm0UserId: options.vm0UserId,
      })
      .onConflictDoNothing();
  }

  return installation!.id;
}

/**
 * Insert test telegram messages with a specific creation date.
 * Used by cleanup cron tests.
 */
export async function insertTestTelegramMessages(
  installationId: string,
  count: number,
  createdAt: Date,
): Promise<void> {
  const values = Array.from({ length: count }, (_, i) => ({
    installationId,
    chatId: "chat-1",
    messageId: `${createdAt.getTime()}-${i}`,
    fromUserId: "user-1",
    text: `message ${i}`,
    isBot: false,
    createdAt,
  }));

  await globalThis.services.db.insert(telegramMessages).values(values);
}

/**
 * Count telegram messages for a specific installation.
 */
export async function countTestTelegramMessages(
  installationId: string,
): Promise<number> {
  const result = await globalThis.services.db
    .select({ count: sql<number>`count(*)::int` })
    .from(telegramMessages)
    .where(eq(telegramMessages.installationId, installationId));
  return result[0]!.count;
}

export async function markRunningRunsAsCompleted(userId: string) {
  await globalThis.services.db
    .update(agentRuns)
    .set({ status: "completed", completedAt: new Date() })
    .where(
      and(
        eq(agentRuns.userId, userId),
        or(eq(agentRuns.status, "running"), eq(agentRuns.status, "pending")),
      ),
    );
}

export async function setTestRunStatus(
  runId: string,
  status: string,
): Promise<void> {
  await globalThis.services.db
    .update(agentRuns)
    .set({
      status,
      ...(["completed", "failed", "timeout", "cancelled"].includes(status)
        ? { completedAt: new Date() }
        : {}),
    })
    .where(eq(agentRuns.id, runId));
}

export async function setTestRunModelProvider(
  runId: string,
  modelProvider: string,
): Promise<void> {
  await globalThis.services.db
    .update(agentRuns)
    .set({ modelProvider })
    .where(eq(agentRuns.id, runId));
}

export async function expireQueueEntry(runId: string) {
  // Set expiresAt far enough in the past to avoid any timing issues in CI
  await globalThis.services.db
    .update(agentRunQueue)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(agentRunQueue.runId, runId));
}

/**
 * Insert a queue entry for a run that is in "queued" status.
 * Looks up the run's userId and orgId from the agent_runs table.
 *
 * @param runId - The run ID to enqueue
 * @param options - Optional overrides for createdAt and expiresAt
 */
export async function insertTestQueueEntry(
  runId: string,
  options?: {
    createdAt?: Date;
    expiresAt?: Date;
  },
) {
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }
  await globalThis.services.db.insert(agentRunQueue).values({
    runId,
    userId: run.userId,
    orgId: run.orgId,
    createdAt: options?.createdAt,
    expiresAt: options?.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
  });
}

// ============================================================================
// Direct DB Helpers for Schema-Level Tests
// ============================================================================

/**
 * Insert an agent compose record directly in the database.
 *
 * Direct DB insert is required for schema-level tests (e.g., CASCADE behavior)
 * that need precise control over record creation without API side effects.
 */
export async function insertTestAgentCompose(
  userId: string,
  orgId: string,
  name: string,
) {
  const [row] = await globalThis.services.db
    .insert(agentComposes)
    .values({ userId, orgId, name })
    .returning();
  return row!;
}

// ============================================================================
// Email Outbox Helpers
// ============================================================================

/**
 * Insert a raw email outbox item (bypasses enqueueEmail for direct state testing).
 */
export async function insertTestOutboxItem(values: {
  fromAddress: string;
  toAddresses: string | string[];
  subject: string;
  template: EmailTemplate;
  status?: string;
  attempts?: number;
  postSendAction?: PostSendAction;
  createdAt?: Date;
  resendId?: string;
}) {
  const [row] = await globalThis.services.db
    .insert(emailOutbox)
    .values({
      fromAddress: values.fromAddress,
      toAddresses: values.toAddresses,
      subject: values.subject,
      template: values.template,
      status: values.status ?? "pending",
      attempts: values.attempts ?? 0,
      postSendAction: values.postSendAction ?? null,
      createdAt: values.createdAt,
      resendId: values.resendId,
    })
    .returning({ id: emailOutbox.id });
  return row!;
}

/**
 * Find email outbox items by status.
 */
export async function findTestOutboxItems(status?: string) {
  if (status) {
    return globalThis.services.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.status, status));
  }
  return globalThis.services.db.select().from(emailOutbox);
}

/**
 * Find a single email outbox item by ID.
 */
export async function findTestOutboxItemById(id: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.id, id))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// org_cache helpers
// ---------------------------------------------------------------------------

/**
 * Insert a row into org_cache for testing cache behavior.
 */
export async function insertOrgCacheEntry(entry: {
  orgId: string;
  slug: string;
  tier?: string;
  credits?: number;
  cachedAt?: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId: entry.orgId,
      slug: entry.slug,
      tier: entry.tier ?? "free",
      credits: entry.credits ?? 0,
      cachedAt: entry.cachedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: {
        slug: entry.slug,
        tier: entry.tier ?? "free",
        credits: entry.credits ?? 0,
        cachedAt: entry.cachedAt ?? new Date(),
      },
    });
}

/**
 * Delete an org_cache row by orgId.
 * Useful for testing cache-miss behavior after createTestOrg pre-populates cache.
 */
export async function deleteOrgCacheEntry(orgId: string): Promise<void> {
  await globalThis.services.db
    .delete(orgCache)
    .where(eq(orgCache.orgId, orgId));
}

/**
 * Read an org_cache row by orgId.
 */
export async function getOrgCacheEntry(orgId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/**
 * Insert an org_members_cache entry for testing cache behavior.
 */
export async function insertOrgMembersCacheEntry(entry: {
  orgId: string;
  userId: string;
  role?: string;
  notifyEmail?: boolean;
  notifySlack?: boolean;
  cachedAt?: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgMembersCache)
    .values({
      orgId: entry.orgId,
      userId: entry.userId,
      role: entry.role ?? "member",
      notifyEmail: entry.notifyEmail ?? false,
      notifySlack: entry.notifySlack ?? true,
      cachedAt: entry.cachedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: {
        role: entry.role ?? "member",
        ...(entry.notifyEmail !== undefined && {
          notifyEmail: entry.notifyEmail,
        }),
        ...(entry.notifySlack !== undefined && {
          notifySlack: entry.notifySlack,
        }),
        cachedAt: entry.cachedAt ?? new Date(),
      },
    });
}

export async function findOrgMembersCacheEntry(orgId: string, userId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    )
    .limit(1);
  return row;
}

export async function findTestRunnerJobEntry(runId: string) {
  const rows = await globalThis.services.db
    .select()
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row,
    executionContext: row.executionContext as StoredExecutionContext,
  };
}

/**
 * Disable all enabled schedules in the database.
 * Prevents stale schedules from other test files consuming the limit(10)
 * batch in executeDueSchedules, which can cause test flakiness.
 */
export async function disableAllSchedules(): Promise<void> {
  await globalThis.services.db
    .update(agentSchedules)
    .set({ enabled: false })
    .where(eq(agentSchedules.enabled, true));
}

/**
 * Insert a user_cache row for testing.
 */
export async function insertUserCacheEntry(entry: {
  userId: string;
  email: string;
  cachedAt?: Date;
}): Promise<void> {
  await globalThis.services.db.insert(userCache).values({
    userId: entry.userId,
    email: entry.email,
    cachedAt: entry.cachedAt ?? new Date(),
  });
}

// ============================================================================
// Export Job Helpers
// ============================================================================

/**
 * Find an export job by ID.
 *
 * Direct DB read is required to verify job state after async export execution.
 */
export async function findTestExportJobById(id: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Insert a test compose with a version for export testing.
 *
 * Direct DB insert is required because the export test needs compose data
 * without going through the full compose creation API flow.
 */
export async function insertTestComposeWithVersion(
  userId: string,
  orgId: string,
  name: string,
  content: Record<string, unknown>,
) {
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({ userId, orgId, name })
    .returning();

  const versionId = hashFileContent(Buffer.from(uniqueId("ver")));
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content,
    createdBy: userId,
  });

  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, compose!.id));

  return { composeId: compose!.id, versionId };
}

/**
 * Insert a test agent session with chat messages for export testing.
 *
 * Direct DB insert is required because agent sessions are created by
 * the run flow, not by a standalone API endpoint.
 */
export async function insertTestAgentSessionWithMessages(
  userId: string,
  agentComposeId: string,
  chatMessages: StoredChatMessage[],
) {
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) throw new Error(`Compose ${agentComposeId} not found`);
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({ userId, orgId: compose.orgId, agentComposeId, chatMessages })
    .returning({ id: agentSessions.id });
  return session!;
}

/**
 * Insert a test artifact storage with a version for export testing.
 *
 * Direct DB insert is required because storage creation normally goes
 * through the prepare/commit flow, but we need a minimal record.
 */
export async function insertTestArtifactStorage(
  userId: string,
  orgId: string,
  name: string,
) {
  const versionId = hashFileContent(Buffer.from(uniqueId("sv")));

  const [storage] = await globalThis.services.db
    .insert(storages)
    .values({
      userId,
      orgId,
      name,
      type: "artifact",
      s3Prefix: `${userId}/artifact/${name}`,
      size: 1024,
      fileCount: 3,
    })
    .returning();

  await globalThis.services.db.insert(storageVersions).values({
    id: versionId,
    storageId: storage!.id,
    s3Key: `${userId}/artifact/${name}/${versionId}`,
    size: 1024,
    fileCount: 3,
    createdBy: userId,
  });

  await globalThis.services.db
    .update(storages)
    .set({ headVersionId: versionId })
    .where(eq(storages.id, storage!.id));

  return { storageId: storage!.id, versionId };
}

/**
 * Seed a skill record in the skills table for testing.
 */
export async function seedTestSkill(
  overrides: Partial<typeof skills.$inferInsert> = {},
) {
  initServices();
  const [row] = await globalThis.services.db
    .insert(skills)
    .values({
      url: "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
      name: "slack",
      fullPath: "vm0-ai/vm0-skills/tree/main/slack",
      versionHash:
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      frontmatter: {
        name: "Slack",
        description: "Slack integration",
        vm0_secrets: ["SLACK_BOT_TOKEN"],
        vm0_vars: [],
      },
      ...overrides,
    })
    .returning();
  return row;
}

/**
 * Delete all skills and system storages.
 * Used for test isolation in cron/sync-skills tests.
 */
export async function clearSkillsData(): Promise<void> {
  initServices();
  await globalThis.services.db.delete(skills);
  await globalThis.services.db
    .delete(storages)
    .where(eq(storages.orgId, SYSTEM_ORG_ID));
}

/**
 * Find a skill by its canonical URL.
 */
export async function findTestSkillByUrl(url: string) {
  const [skill] = await globalThis.services.db
    .select()
    .from(skills)
    .where(eq(skills.url, url))
    .limit(1);
  return skill ?? null;
}

/**
 * Get all skills from the database.
 */
export async function findAllTestSkills() {
  return globalThis.services.db.select().from(skills);
}

/**
 * Get all system storages (orgId = SYSTEM_ORG_ID).
 */
export async function findTestSystemStorages() {
  return globalThis.services.db
    .select()
    .from(storages)
    .where(eq(storages.orgId, SYSTEM_ORG_ID));
}

/**
 * Create an org-aware Slack installation for testing.
 *
 * Direct DB insert is required because the org Slack OAuth callback
 * requires real Slack API interaction that cannot be easily mocked.
 */
export async function createTestSlackOrgInstallation(opts: {
  workspaceId?: string;
  workspaceName?: string;
  orgId: string | null;
}): Promise<{
  slackWorkspaceId: string;
  slackWorkspaceName: string;
}> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;

  const workspaceId = opts.workspaceId ?? `T-${randomUUID().slice(0, 8)}`;
  const workspaceName = opts.workspaceName ?? "Test Org Workspace";

  const encryptedBotToken = encryptSecretValue(
    "xoxb-test-bot-token",
    SECRETS_ENCRYPTION_KEY,
  );

  await globalThis.services.db.insert(slackOrgInstallations).values({
    slackWorkspaceId: workspaceId,
    slackWorkspaceName: workspaceName,
    orgId: opts.orgId,
    encryptedBotToken,
    botUserId: `B-${randomUUID().slice(0, 8)}`,
  });

  return { slackWorkspaceId: workspaceId, slackWorkspaceName: workspaceName };
}

/**
 * Create an org-aware Slack connection for testing.
 *
 * Direct DB insert is required because the connect API requires
 * Slack workspace context that is only available during real OAuth.
 */
export async function createTestSlackOrgConnection(opts: {
  slackUserId?: string;
  slackWorkspaceId: string;
  vm0UserId: string;
}): Promise<{ slackUserId: string; connectionId: string }> {
  initServices();

  const slackUserId = opts.slackUserId ?? `U-${randomUUID().slice(0, 8)}`;

  const [installation] = await globalThis.services.db
    .select({ orgId: slackOrgInstallations.orgId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, opts.slackWorkspaceId))
    .limit(1);

  if (!installation?.orgId) {
    throw new Error(
      `No installation with orgId found for workspace ${opts.slackWorkspaceId}`,
    );
  }

  const [connection] = await globalThis.services.db
    .insert(slackOrgConnections)
    .values({
      slackUserId,
      slackWorkspaceId: opts.slackWorkspaceId,
      vm0UserId: opts.vm0UserId,
    })
    .returning({ id: slackOrgConnections.id });

  return { slackUserId, connectionId: connection!.id };
}

/**
 * Insert a credit_pricing record for testing.
 * Uses upsert so tests can safely set pricing for the same model.
 */
export async function insertTestCreditPricing(
  model: string,
  options?: {
    inputTokenPrice?: number;
    outputTokenPrice?: number;
    modelProvider?: string;
  },
): Promise<void> {
  initServices();
  const inputTokenPrice = options?.inputTokenPrice ?? 100;
  const outputTokenPrice = options?.outputTokenPrice ?? 200;
  const modelProvider = options?.modelProvider ?? "";

  await globalThis.services.db
    .insert(creditPricing)
    .values({ model, modelProvider, inputTokenPrice, outputTokenPrice })
    .onConflictDoUpdate({
      target: [creditPricing.model, creditPricing.modelProvider],
      set: { inputTokenPrice, outputTokenPrice },
    });
}

/**
 * Insert a credit_usage record for testing.
 * Creates the required compose, version, and run records as FK dependencies.
 *
 * @returns The credit_usage record ID
 */
export async function insertTestCreditUsage(
  orgId: string,
  options: {
    userId?: string;
    model?: string;
    modelProvider?: string;
    inputTokens?: number;
    outputTokens?: number;
    numEvents?: number;
    status?: string;
    creditsCharged?: number;
  },
): Promise<string> {
  initServices();
  const userId = options.userId ?? "test-user";

  // Create compose for the run
  const composeName = `compose-${randomBytes(4).toString("hex")}`;
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({ userId, orgId, name: composeName })
    .returning();

  // agentComposeVersions.id is a content-addressed SHA-256 hash
  const versionId = randomBytes(32).toString("hex");
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: {},
    createdBy: userId,
  });

  // Create a run (FK required by credit_usage)
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      prompt: "test",
      status: "completed",
    })
    .returning();

  const [record] = await globalThis.services.db
    .insert(creditUsage)
    .values({
      runId: run!.id,
      orgId,
      userId,
      model: options.model ?? "gpt-4",
      modelProvider: options.modelProvider ?? "",
      inputTokens: options.inputTokens ?? 1000,
      outputTokens: options.outputTokens ?? 500,
      numEvents: options.numEvents ?? 2,
      status: options.status ?? "pending",
      creditsCharged: options.creditsCharged ?? null,
    })
    .returning();

  return record!.id;
}

/**
 * Read a credit_usage record by ID.
 */
export async function findTestCreditUsage(id: string): Promise<
  | {
      id: string;
      status: string;
      creditsCharged: number | null;
      processedAt: Date | null;
      numEvents: number;
    }
  | undefined
> {
  initServices();
  const [record] = await globalThis.services.db
    .select({
      id: creditUsage.id,
      status: creditUsage.status,
      creditsCharged: creditUsage.creditsCharged,
      processedAt: creditUsage.processedAt,
      numEvents: creditUsage.numEvents,
    })
    .from(creditUsage)
    .where(eq(creditUsage.id, id))
    .limit(1);
  return record;
}

/**
 * Find a credit_usage record by runId.
 */
export async function findTestCreditUsageByRunId(runId: string): Promise<
  | {
      id: string;
      runId: string;
      orgId: string;
      userId: string;
      model: string;
      modelProvider: string;
      inputTokens: number;
      outputTokens: number;
      numEvents: number;
      status: string;
      creditsCharged: number | null;
    }
  | undefined
> {
  initServices();
  const [record] = await globalThis.services.db
    .select({
      id: creditUsage.id,
      runId: creditUsage.runId,
      orgId: creditUsage.orgId,
      userId: creditUsage.userId,
      model: creditUsage.model,
      modelProvider: creditUsage.modelProvider,
      inputTokens: creditUsage.inputTokens,
      outputTokens: creditUsage.outputTokens,
      numEvents: creditUsage.numEvents,
      status: creditUsage.status,
      creditsCharged: creditUsage.creditsCharged,
    })
    .from(creditUsage)
    .where(eq(creditUsage.runId, runId))
    .limit(1);
  return record;
}

/**
 * Delete a compose from the database.
 * Used to simulate a user deleting an agent compose.
 */
export async function deleteTestCompose(composeId: string): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(agentComposes)
    .where(eq(agentComposes.id, composeId));
}
