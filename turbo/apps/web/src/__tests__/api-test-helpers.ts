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
import { PUT as setCredentialRoute } from "../../app/api/credentials/route";
import { PUT as upsertModelProviderRoute } from "../../app/api/model-providers/route";

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

/**
 * Default compose configuration for testing
 * Includes ANTHROPIC_API_KEY in environment to satisfy model provider validation
 */
export function createDefaultComposeConfig(
  agentName: string,
  overrides?: Partial<AgentComposeYaml["agents"][string]>,
): AgentComposeYaml {
  return {
    version: "1.0",
    agents: {
      [agentName]: {
        image: "vm0/claude-code:dev",
        framework: "claude-code",
        working_dir: "/home/user/workspace",
        environment: {
          ANTHROPIC_API_KEY: "test-api-key",
        },
        ...overrides,
      },
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
 * Generate a unique test ID for test isolation.
 * Each test gets a unique prefix to avoid data collision without cleanup.
 *
 * Format: "t" + timestamp (base36) + random (4 hex chars)
 * Example: "t1abc2def3gh4i5j6k7l"
 *
 * This approach eliminates the need for beforeEach/afterEach cleanup
 * as each test operates on completely isolated data.
 *
 * @returns A unique test ID string
 */
export function generateTestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(16).substring(2, 6);
  return `t${timestamp}${random}`;
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
 * @param overrides - Optional overrides for the agent config
 * @returns The created compose with composeId and versionId
 */
export async function createTestCompose(
  agentName: string,
  overrides?: Partial<AgentComposeYaml["agents"][string]>,
): Promise<{ composeId: string; versionId: string }> {
  const config = createDefaultComposeConfig(agentName, overrides);
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
 * Create a test credential via API route handler.
 *
 * @param name - The credential name
 * @param value - The credential value
 * @param description - Optional description
 * @returns The created credential with id and name
 */
export async function createTestCredential(
  name: string,
  value: string,
  description?: string,
): Promise<{ id: string; name: string }> {
  const request = createTestRequest("http://localhost:3000/api/credentials", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, value, description }),
  });
  const response = await setCredentialRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create credential: ${error.error?.message || response.status}`,
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
