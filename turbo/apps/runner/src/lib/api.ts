/**
 * API client for VM0 server communication
 *
 * Provides methods for runner operations:
 * - registerRunner: Register/update runner with server
 * - pollForJob: Long-polling to fetch pending jobs
 * - claimJob: Claim a job for execution
 */

import { getToken, getApiUrl } from "./token.js";

export interface RunnerResponse {
  id: string;
  name: string;
  group: string;
  status: "online" | "offline" | "busy";
  lastHeartbeatAt: string | null;
  createdAt: string;
}

export interface Job {
  runId: string;
  prompt: string;
  agentComposeVersionId: string;
  vars: Record<string, string> | null;
  secretNames: string[] | null;
  checkpointId: string | null;
}

export interface ExecutionContext extends Job {
  sandboxToken: string;
  apiUrl: string;
}

interface ApiErrorResponse {
  error: {
    message: string;
    code: string;
  };
}

/**
 * Get authentication headers
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated. Run 'vm0-runner setup' first.");
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Get the API base URL
 */
async function getBaseUrl(): Promise<string> {
  const apiUrl = await getApiUrl();
  return apiUrl || "https://www.vm0.ai";
}

/**
 * Register or update a runner with the server
 */
export async function registerRunner(
  name: string,
  group: string,
): Promise<RunnerResponse> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();

  const response = await fetch(`${baseUrl}/api/runners/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, group }),
  });

  if (!response.ok) {
    const errorData = (await response.json()) as ApiErrorResponse;
    throw new Error(
      `Failed to register runner: ${errorData.error?.message || response.statusText}`,
    );
  }

  return response.json() as Promise<RunnerResponse>;
}

/**
 * Poll for pending jobs (long-polling)
 * Returns a job if available, null if timeout reached
 */
export async function pollForJob(group: string): Promise<Job | null> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();

  const response = await fetch(
    `${baseUrl}/api/runners/poll?group=${encodeURIComponent(group)}`,
    {
      method: "GET",
      headers,
    },
  );

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
  runId: string,
  runnerId: string,
): Promise<ExecutionContext> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();

  const response = await fetch(`${baseUrl}/api/runners/jobs/${runId}/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ runnerId }),
  });

  if (!response.ok) {
    const errorData = (await response.json()) as ApiErrorResponse;
    throw new Error(
      `Failed to claim job: ${errorData.error?.message || response.statusText}`,
    );
  }

  return response.json() as Promise<ExecutionContext>;
}
