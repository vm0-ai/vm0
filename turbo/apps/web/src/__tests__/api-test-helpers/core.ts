import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type { AgentComposeYaml } from "../../lib/infra/agent-compose/types";
import { generateSandboxToken } from "../../lib/auth/sandbox-token";
import { createSingleFileTar } from "../../lib/infra/tar";

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

export interface ComposeConfigOptions {
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

/**
 * Create a tar file containing a single file, for testing tar-related functionality.
 *
 * @param filename - The filename within the tar archive
 * @param content - The file content as a Buffer
 * @returns The tar archive as a Buffer
 */
export function createTestTarFile(filename: string, content: Buffer): Buffer {
  return createSingleFileTar(filename, content);
}

/**
 * Get the test auth context (userId + orgId) from the mock Clerk setup.
 */
export async function getTestAuthContext(): Promise<{
  userId: string;
  orgId: string;
}> {
  const { userId } = await auth();
  if (!userId) throw new Error("Mock Clerk userId is null");
  return { userId, orgId: `org_mock_${userId}` };
}
