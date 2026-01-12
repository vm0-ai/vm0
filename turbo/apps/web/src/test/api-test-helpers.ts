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
        provider: "claude-code",
        working_dir: "/home/user/workspace",
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
