import { getApiUrl, getToken } from "./config";

export interface CreateComposeResponse {
  composeId: string;
  name: string;
  versionId: string;
  action: "created" | "existing";
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateRunResponse {
  runId: string;
  status: "pending" | "running" | "completed" | "failed";
  sandboxId: string;
  output: string;
  error?: string;
  executionTimeMs: number;
  createdAt: string;
}

export interface GetComposeResponse {
  id: string;
  name: string;
  headVersionId: string | null;
  content: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: {
    message: string;
    code: string;
  };
}

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout";

/**
 * Run result stored when status = 'completed'
 * Contains checkpoint and artifact information for session continuation
 */
export interface RunResult {
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
  artifact: Record<string, string>;
  volumes?: Record<string, string>;
}

/**
 * Run state information returned by events API
 * Replaces the previous vm0_start/vm0_result/vm0_error events
 */
export interface RunState {
  status: RunStatus;
  result?: RunResult;
  error?: string;
}

export interface GetEventsResponse {
  events: Array<{
    sequenceNumber: number;
    eventType: string;
    eventData: unknown;
    createdAt: string;
  }>;
  hasMore: boolean;
  nextSequence: number;
  /** Run state information (replaces previous vm0_* events) */
  run: RunState;
  /** Provider type from compose configuration */
  provider: string;
}

export interface GetComposeVersionResponse {
  versionId: string;
  tag?: string;
}

export interface TelemetryMetric {
  ts: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

export interface GetTelemetryResponse {
  systemLog: string;
  metrics: TelemetryMetric[];
}

export interface GetSystemLogResponse {
  systemLog: string;
  hasMore: boolean;
}

export interface GetMetricsResponse {
  metrics: TelemetryMetric[];
  hasMore: boolean;
}

export interface RunEvent {
  sequenceNumber: number;
  eventType: string;
  eventData: unknown;
  createdAt: string;
}

export interface GetAgentEventsResponse {
  events: RunEvent[];
  hasMore: boolean;
  /** Provider type from compose configuration */
  provider: string;
}

export interface NetworkLogEntry {
  timestamp: string;
  method: string;
  url: string;
  status: number;
  latency_ms: number;
  request_size: number;
  response_size: number;
}

export interface GetNetworkLogsResponse {
  networkLogs: NetworkLogEntry[];
  hasMore: boolean;
}

export interface CreateImageResponse {
  buildId: string;
  imageId: string;
  alias: string;
  versionId: string;
}

export interface ScopeResponse {
  id: string;
  slug: string;
  type: "personal" | "organization" | "system";
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Session response from GET /api/agent/sessions/{id}
 */
export interface GetSessionResponse {
  id: string;
  agentComposeId: string;
  agentComposeVersionId: string | null;
  conversationId: string | null;
  artifactName: string | null;
  vars: Record<string, string> | null;
  secretNames: string[] | null;
  volumeVersions: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Agent compose snapshot stored in checkpoints
 */
export interface AgentComposeSnapshot {
  agentComposeVersionId: string;
  vars?: Record<string, string>;
  secretNames?: string[];
}

/**
 * Checkpoint response from GET /api/agent/checkpoints/{id}
 */
export interface GetCheckpointResponse {
  id: string;
  runId: string;
  conversationId: string;
  agentComposeSnapshot: AgentComposeSnapshot;
  artifactSnapshot: { artifactName: string; artifactVersion: string } | null;
  volumeVersionsSnapshot: { versions: Record<string, string> } | null;
  createdAt: string;
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

    const response = await fetch(
      `${baseUrl}/api/agent/composes/versions?composeId=${encodeURIComponent(composeId)}&version=${encodeURIComponent(version)}`,
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

    const response = await fetch(`${baseUrl}/api/agent/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      const message = error.error?.message || "Failed to create run";
      throw new Error(message);
    }

    return (await response.json()) as CreateRunResponse;
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

  async getTelemetry(runId: string): Promise<GetTelemetryResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(
      `${baseUrl}/api/agent/runs/${runId}/telemetry`,
      {
        method: "GET",
        headers,
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to fetch telemetry");
    }

    return (await response.json()) as GetTelemetryResponse;
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

  async createImage(body: {
    dockerfile: string;
    alias: string;
    deleteExisting?: boolean;
  }): Promise<CreateImageResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/images`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to create image");
    }

    return (await response.json()) as CreateImageResponse;
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
