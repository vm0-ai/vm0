import { initClient } from "@ts-rest/core";
import {
  runsMainContract,
  runEventsContract,
  runSystemLogContract,
  runMetricsContract,
  runAgentEventsContract,
  runNetworkLogsContract,
  composesMainContract,
  composesByIdContract,
  composesVersionsContract,
  sessionsByIdContract,
  checkpointsByIdContract,
  scopeContract,
  agentComposeContentSchema,
  type ApiErrorResponse,
} from "@vm0/core";
import type { z } from "zod";
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

    // Create ts-rest client with config
    const client = initClient(composesMainContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.getByName({
      query: {
        name,
        scope,
      },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || `Compose not found: ${name}`;
    throw new Error(message);
  }

  async getComposeById(id: string): Promise<GetComposeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(composesByIdContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.getById({
      params: { id },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || `Compose not found: ${id}`;
    throw new Error(message);
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

    // Create ts-rest client with config
    // Note: jsonQuery: true handles scientific notation edge cases automatically
    const client = initClient(composesVersionsContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.resolveVersion({
      query: {
        composeId,
        version,
      },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || `Version not found: ${version}`;
    throw new Error(message);
  }

  async createOrUpdateCompose(body: {
    content: unknown;
  }): Promise<CreateComposeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(composesMainContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.create({
      body: body as { content: z.infer<typeof agentComposeContentSchema> },
    });

    // ts-rest returns discriminated union based on status code
    // Both 200 and 201 are success cases
    if (result.status === 200 || result.status === 201) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to create compose";
    throw new Error(message);
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

    // Create ts-rest client with config
    const client = initClient(runEventsContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.getEvents({
      params: { id: runId },
      query: {
        since: options?.since ?? 0,
        limit: options?.limit ?? 100,
      },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to fetch events";
    throw new Error(message);
  }

  async getSystemLog(
    runId: string,
    options?: { since?: number; limit?: number; order?: "asc" | "desc" },
  ): Promise<GetSystemLogResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(runSystemLogContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.getSystemLog({
      params: { id: runId },
      query: {
        since: options?.since,
        limit: options?.limit,
        order: options?.order,
      },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to fetch system log";
    throw new Error(message);
  }

  async getMetrics(
    runId: string,
    options?: { since?: number; limit?: number; order?: "asc" | "desc" },
  ): Promise<GetMetricsResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(runMetricsContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.getMetrics({
      params: { id: runId },
      query: {
        since: options?.since,
        limit: options?.limit,
        order: options?.order,
      },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to fetch metrics";
    throw new Error(message);
  }

  async getAgentEvents(
    runId: string,
    options?: { since?: number; limit?: number; order?: "asc" | "desc" },
  ): Promise<GetAgentEventsResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(runAgentEventsContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.getAgentEvents({
      params: { id: runId },
      query: {
        since: options?.since,
        limit: options?.limit,
        order: options?.order,
      },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to fetch agent events";
    throw new Error(message);
  }

  async getNetworkLogs(
    runId: string,
    options?: { since?: number; limit?: number; order?: "asc" | "desc" },
  ): Promise<GetNetworkLogsResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(runNetworkLogsContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.getNetworkLogs({
      params: { id: runId },
      query: {
        since: options?.since,
        limit: options?.limit,
        order: options?.order,
      },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to fetch network logs";
    throw new Error(message);
  }

  /**
   * Get current user's scope
   */
  async getScope(): Promise<ScopeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(scopeContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.get();

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to get scope";
    throw new Error(message);
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

    // Create ts-rest client with config
    const client = initClient(scopeContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.create({ body });

    // ts-rest returns discriminated union based on status code
    if (result.status === 201) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to create scope";
    throw new Error(message);
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

    // Create ts-rest client with config
    const client = initClient(scopeContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.update({ body });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to update scope";
    throw new Error(message);
  }

  /**
   * Get session by ID
   * Used by run continue to fetch session info including secretNames
   */
  async getSession(sessionId: string): Promise<GetSessionResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(sessionsByIdContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.getById({
      params: { id: sessionId },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message =
      errorBody.error?.message || `Session not found: ${sessionId}`;
    throw new Error(message);
  }

  /**
   * Get checkpoint by ID
   * Used by run resume to fetch checkpoint info including secretNames
   */
  async getCheckpoint(checkpointId: string): Promise<GetCheckpointResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(checkpointsByIdContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const result = await client.getById({
      params: { id: checkpointId },
    });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message =
      errorBody.error?.message || `Checkpoint not found: ${checkpointId}`;
    throw new Error(message);
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
