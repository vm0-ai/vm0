import { initClient } from "@ts-rest/core";
import { runsMainContract, type ApiErrorResponse } from "@vm0/core";
import { getApiUrl, getToken } from "./config";

// Import types from @vm0/core contracts
import type {
  RunStatus as CoreRunStatus,
  RunResult as CoreRunResult,
  RunState as CoreRunState,
  RunEvent as CoreRunEvent,
  EventsResponse,
  TelemetryMetric as CoreTelemetryMetric,
  SystemLogResponse,
  MetricsResponse,
  AgentEventsResponse,
  NetworkLogEntry as CoreNetworkLogEntry,
  NetworkLogsResponse,
  SessionResponse,
  CheckpointResponse,
  AgentComposeSnapshot as CoreAgentComposeSnapshot,
  ComposeResponse,
  ScopeResponse as CoreScopeResponse,
} from "@vm0/core";

// Re-export types with CLI naming conventions for backward compatibility
export type RunStatus = CoreRunStatus;
export type RunResult = CoreRunResult;
export type RunState = CoreRunState;
export type RunEvent = CoreRunEvent;
export type TelemetryMetric = CoreTelemetryMetric;
export type NetworkLogEntry = CoreNetworkLogEntry;
export type AgentComposeSnapshot = CoreAgentComposeSnapshot;
export type ApiError = ApiErrorResponse;
export type ScopeResponse = CoreScopeResponse;
export type GetSystemLogResponse = SystemLogResponse;
export type GetMetricsResponse = MetricsResponse;
export type GetAgentEventsResponse = AgentEventsResponse;
export type GetNetworkLogsResponse = NetworkLogsResponse;
export type GetSessionResponse = SessionResponse;
export type GetCheckpointResponse = CheckpointResponse;
export type GetComposeResponse = ComposeResponse;
export type GetEventsResponse = EventsResponse;

// CLI-specific types (not in @vm0/core or have different structure)
export interface CreateComposeResponse {
  composeId: string;
  name: string;
  versionId: string;
  action: "created" | "existing";
  createdAt?: string;
  updatedAt?: string;
}

/**
 * CreateRunResponse type
 * TODO: In future phases, this can be replaced with inferred type from @vm0/core
 */
export interface CreateRunResponse {
  runId: string;
  status: RunStatus;
  sandboxId?: string;
  output?: string;
  error?: string;
  executionTimeMs?: number;
  createdAt: string;
}

export interface GetComposeVersionResponse {
  versionId: string;
  tag?: string;
}

class ApiClient {
  private async getHeaders(): Promise<Record<string, string>> {
    const token = await getToken();
    if (!token) {
      throw new Error("Not authenticated. Run: vm0 auth login");
    }

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

  private async getBaseUrl(): Promise<string> {
    const apiUrl = await getApiUrl();
    if (!apiUrl) {
      throw new Error("API URL not configured");
    }
    return apiUrl;
  }

  async getComposeByName(
    name: string,
    scope?: string,
  ): Promise<GetComposeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const params = new URLSearchParams({ name });
    if (scope) {
      params.append("scope", scope);
    }

    const response = await fetch(
      `${baseUrl}/api/agent/composes?${params.toString()}`,
      {
        method: "GET",
        headers,
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || `Compose not found: ${name}`);
    }

    return (await response.json()) as GetComposeResponse;
  }

  async getComposeById(id: string): Promise<GetComposeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/agent/composes/${id}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || `Compose not found: ${id}`);
    }

    return (await response.json()) as GetComposeResponse;
  }

  /**
   * Resolve a version specifier to a full version ID
   * Supports: "latest", full hash (64 chars), or hash prefix (8+ chars)
   */
  async getComposeVersion(
    composeId: string,
    version: string,
  ): Promise<GetComposeVersionResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Quote the version as JSON string to prevent ts-rest's jsonQuery from
    // parsing hex strings like "52999e37" as scientific notation numbers
    const quotedVersion = JSON.stringify(version);
    const response = await fetch(
      `${baseUrl}/api/agent/composes/versions?composeId=${encodeURIComponent(composeId)}&version=${encodeURIComponent(quotedVersion)}`,
      {
        method: "GET",
        headers,
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || `Version not found: ${version}`);
    }

    return (await response.json()) as GetComposeVersionResponse;
  }

  async createOrUpdateCompose(body: {
    content: unknown;
  }): Promise<CreateComposeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/agent/composes`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to create compose");
    }

    return (await response.json()) as CreateComposeResponse;
  }

  /**
   * Create a run with unified request format
   * Supports new runs, checkpoint resume, and session continue
   * Note: Environment variables are expanded server-side from vars
   */
  async createRun(body: {
    // Shortcuts (mutually exclusive)
    checkpointId?: string;
    sessionId?: string;
    // Base parameters
    agentComposeId?: string;
    agentComposeVersionId?: string;
    conversationId?: string;
    artifactName?: string;
    artifactVersion?: string;
    vars?: Record<string, string>;
    secrets?: Record<string, string>;
    volumeVersions?: Record<string, string>;
    // Required
    prompt: string;
  }): Promise<CreateRunResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(runsMainContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.create({ body });

    // ts-rest returns discriminated union based on status code
    if (result.status === 201) {
      // Success - result.body is typed and validated
      return result.body;
    }

    // Error cases - result.body is typed as ApiErrorResponse
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to create run";
    throw new Error(message);
  }

  async getEvents(
    runId: string,
    options?: { since?: number; limit?: number },
  ): Promise<GetEventsResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const since = options?.since ?? 0;
    const limit = options?.limit ?? 100;

    const response = await fetch(
      `${baseUrl}/api/agent/runs/${runId}/events?since=${since}&limit=${limit}`,
      {
        method: "GET",
        headers,
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to fetch events");
    }

    return (await response.json()) as GetEventsResponse;
  }

  async getSystemLog(
    runId: string,
    options?: { since?: number; limit?: number; order?: "asc" | "desc" },
  ): Promise<GetSystemLogResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const params = new URLSearchParams();
    if (options?.since !== undefined) {
      params.set("since", String(options.since));
    }
    if (options?.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options?.order !== undefined) {
      params.set("order", options.order);
    }

    const queryString = params.toString();
    const url = `${baseUrl}/api/agent/runs/${runId}/telemetry/system-log${queryString ? `?${queryString}` : ""}`;

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to fetch system log");
    }

    return (await response.json()) as GetSystemLogResponse;
  }

  async getMetrics(
    runId: string,
    options?: { since?: number; limit?: number; order?: "asc" | "desc" },
  ): Promise<GetMetricsResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const params = new URLSearchParams();
    if (options?.since !== undefined) {
      params.set("since", String(options.since));
    }
    if (options?.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options?.order !== undefined) {
      params.set("order", options.order);
    }

    const queryString = params.toString();
    const url = `${baseUrl}/api/agent/runs/${runId}/telemetry/metrics${queryString ? `?${queryString}` : ""}`;

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to fetch metrics");
    }

    return (await response.json()) as GetMetricsResponse;
  }

  async getAgentEvents(
    runId: string,
    options?: { since?: number; limit?: number; order?: "asc" | "desc" },
  ): Promise<GetAgentEventsResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const params = new URLSearchParams();
    if (options?.since !== undefined) {
      params.set("since", String(options.since));
    }
    if (options?.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options?.order !== undefined) {
      params.set("order", options.order);
    }

    const queryString = params.toString();
    const url = `${baseUrl}/api/agent/runs/${runId}/telemetry/agent${queryString ? `?${queryString}` : ""}`;

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to fetch agent events");
    }

    return (await response.json()) as GetAgentEventsResponse;
  }

  async getNetworkLogs(
    runId: string,
    options?: { since?: number; limit?: number; order?: "asc" | "desc" },
  ): Promise<GetNetworkLogsResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const params = new URLSearchParams();
    if (options?.since !== undefined) {
      params.set("since", String(options.since));
    }
    if (options?.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options?.order !== undefined) {
      params.set("order", options.order);
    }

    const queryString = params.toString();
    const url = `${baseUrl}/api/agent/runs/${runId}/telemetry/network${queryString ? `?${queryString}` : ""}`;

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to fetch network logs");
    }

    return (await response.json()) as GetNetworkLogsResponse;
  }

  /**
   * Get current user's scope
   */
  async getScope(): Promise<ScopeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/scope`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to get scope");
    }

    return (await response.json()) as ScopeResponse;
  }

  /**
   * Create user's scope
   */
  async createScope(body: {
    slug: string;
    displayName?: string;
  }): Promise<ScopeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/scope`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to create scope");
    }

    return (await response.json()) as ScopeResponse;
  }

  /**
   * Update user's scope slug
   */
  async updateScope(body: {
    slug: string;
    force?: boolean;
  }): Promise<ScopeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/scope`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to update scope");
    }

    return (await response.json()) as ScopeResponse;
  }

  /**
   * Get session by ID
   * Used by run continue to fetch session info including secretNames
   */
  async getSession(sessionId: string): Promise<GetSessionResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/agent/sessions/${sessionId}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(
        error.error?.message || `Session not found: ${sessionId}`,
      );
    }

    return (await response.json()) as GetSessionResponse;
  }

  /**
   * Get checkpoint by ID
   * Used by run resume to fetch checkpoint info including secretNames
   */
  async getCheckpoint(checkpointId: string): Promise<GetCheckpointResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(
      `${baseUrl}/api/agent/checkpoints/${checkpointId}`,
      {
        method: "GET",
        headers,
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(
        error.error?.message || `Checkpoint not found: ${checkpointId}`,
      );
    }

    return (await response.json()) as GetCheckpointResponse;
  }

  /**
   * Generic GET request
   */
  async get(path: string): Promise<Response> {
    const baseUrl = await this.getBaseUrl();
    const token = await getToken();
    if (!token) {
      throw new Error("Not authenticated. Run: vm0 auth login");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    // Add Vercel bypass secret if available
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypassSecret) {
      headers["x-vercel-protection-bypass"] = bypassSecret;
    }

    return fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers,
    });
  }

  /**
   * Generic POST request
   */
  async post(
    path: string,
    options?: { body?: FormData | string },
  ): Promise<Response> {
    const baseUrl = await this.getBaseUrl();
    const token = await getToken();
    if (!token) {
      throw new Error("Not authenticated. Run: vm0 auth login");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    // Add Content-Type for JSON bodies (string bodies are assumed to be JSON)
    if (typeof options?.body === "string") {
      headers["Content-Type"] = "application/json";
    }

    // Add Vercel bypass secret if available
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypassSecret) {
      headers["x-vercel-protection-bypass"] = bypassSecret;
    }

    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: options?.body,
    });
  }

  /**
   * Generic DELETE request
   */
  async delete(path: string): Promise<Response> {
    const baseUrl = await this.getBaseUrl();
    const token = await getToken();
    if (!token) {
      throw new Error("Not authenticated. Run: vm0 auth login");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    // Add Vercel bypass secret if available
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypassSecret) {
      headers["x-vercel-protection-bypass"] = bypassSecret;
    }

    return fetch(`${baseUrl}${path}`, {
      method: "DELETE",
      headers,
    });
  }
}

// Note: Secrets API types are now defined in @vm0/core contracts
// and used via the type-safe client in ./secrets-client.ts

export const apiClient = new ApiClient();
