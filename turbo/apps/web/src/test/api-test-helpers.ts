/**
 * Test Helper Utilities for API-based Test Data Creation
 *
 * These utilities provide functions to create test data through API endpoints
 * instead of direct database operations. This ensures tests validate the
 * complete API flow, catching issues that direct DB operations might miss.
 *
 * Usage:
 *   import { createTestRequest, createDefaultComposeConfig } from "@/test/api-test-helpers";
 *
 *   const config = createDefaultComposeConfig("my-agent");
 *   const request = createTestRequest("http://localhost:3000/api/agent/composes", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify({ content: config }),
 *   });
 */
import { NextRequest } from "next/server";
import type { AgentComposeYaml } from "../types/agent-compose";

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
        image: "vm0-claude-code-dev",
        provider: "claude-code",
        working_dir: "/home/user/workspace",
        ...overrides,
      },
    },
  };
}
