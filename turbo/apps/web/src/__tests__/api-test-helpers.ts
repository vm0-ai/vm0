/**
 * Test Helper Utilities for API-based Test Data Creation
 *
 * These utilities provide functions to create test data through API endpoints
 * instead of direct database operations. This ensures tests validate the
 * complete API flow, catching issues that direct DB operations might miss.
 *
 * Usage:
 *   import { createTestRequest, createDefaultComposeConfig, createTestSandboxToken } from "@/test/api-test-helpers";
 *
 *   const config = createDefaultComposeConfig("my-agent");
 *   const token = await createTestSandboxToken(userId, runId);
 *   const request = createTestRequest("http://localhost:3000/api/agent/composes", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
 *     body: JSON.stringify({ content: config }),
 *   });
 */
import { NextRequest } from "next/server";
import type { AgentComposeYaml } from "../types/agent-compose";
import { generateSandboxToken } from "../lib/auth/sandbox-token";
import { initServices } from "../lib/init-services";
import { cliTokens } from "../db/schema/cli-tokens";
import { eq } from "drizzle-orm";

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

  initServices();
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
  initServices();
  await globalThis.services.db
    .delete(cliTokens)
    .where(eq(cliTokens.token, token));
}
