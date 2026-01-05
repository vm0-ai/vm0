/**
 * API client for VM0 server communication
 *
 * Provides methods for runner operations:
 * - pollForJob: Long-polling to fetch pending jobs
 * - claimJob: Claim a job for execution
 */

import type {
  Job,
  ExecutionContext,
  StorageManifest,
  ResumeSession,
} from "@vm0/core";

// Re-export types for consumers
export type { Job, ExecutionContext, StorageManifest, ResumeSession };

/**
 * Runner-specific server configuration
 */
export interface ServerConfig {
  url: string;
  token: string;
}

/**
 * Internal API error response type
 */
interface ApiErrorResponse {
  error: {
    message: string;
    code: string;
  };
}

/**
 * Get authentication headers
 * Includes Vercel bypass secret if available (for CI/preview deployments)
 */
function getAuthHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Add Vercel bypass secret if available (for CI/preview deployments)
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  return headers;
}

/**
 * Poll for pending jobs (long-polling)
 * Returns a job if available, null if timeout reached
 *
 * NOTE: Uses POST instead of GET to avoid CDN caching issues on preview deployments.
 * POST requests are never cached, ensuring the Authorization header is always read fresh.
 */
export async function pollForJob(
  server: ServerConfig,
  group: string,
): Promise<Job | null> {
  const headers = getAuthHeaders(server.token);

  const response = await fetch(`${server.url}/api/runners/poll`, {
    method: "POST",
    headers,
    body: JSON.stringify({ group }),
  });

  if (!response.ok) {
    const errorData = (await response.json()) as ApiErrorResponse;
    throw new Error(
      `Failed to poll for jobs: ${errorData.error?.message || response.statusText}`,
    );
  }

  const data = (await response.json()) as { job: Job | null };
  return data.job;
}

/**
 * Claim a job for execution
 * Returns execution context with sandbox token
 */
export async function claimJob(
  server: ServerConfig,
  runId: string,
): Promise<ExecutionContext> {
  const headers = getAuthHeaders(server.token);

  const response = await fetch(
    `${server.url}/api/runners/jobs/${runId}/claim`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    const errorData = (await response.json()) as ApiErrorResponse;
    throw new Error(
      `Failed to claim job: ${errorData.error?.message || response.statusText}`,
    );
  }

  return response.json() as Promise<ExecutionContext>;
}

export interface CompleteJobResult {
  success: boolean;
  status: "completed" | "failed";
}

/**
 * Report job completion to the server
 * Uses the sandbox token for authentication
 * apiUrl comes from runner config, not from execution context
 */
export async function completeJob(
  apiUrl: string,
  context: ExecutionContext,
  exitCode: number,
  error?: string,
): Promise<CompleteJobResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${context.sandboxToken}`,
    "Content-Type": "application/json",
  };

  // Add Vercel bypass secret if available (for CI/preview deployments)
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  const response = await fetch(`${apiUrl}/api/webhooks/agent/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      runId: context.runId,
      exitCode,
      error,
    }),
  });

  if (!response.ok) {
    const errorData = (await response.json()) as ApiErrorResponse;
    throw new Error(
      `Failed to complete job: ${errorData.error?.message || response.statusText}`,
    );
  }

  return response.json() as Promise<CompleteJobResult>;
}
