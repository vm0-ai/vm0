import { initClient } from "@ts-rest/core";
import {
  runsMainContract,
  runEventsContract,
  runSystemLogContract,
  runMetricsContract,
  runAgentEventsContract,
  runNetworkLogsContract,
  logsSearchContract,
  composesMainContract,
  composesByIdContract,
  composesVersionsContract,
  sessionsByIdContract,
  checkpointsByIdContract,
  orgContract,
  storagesPrepareContract,
  storagesCommitContract,
  storagesDownloadContract,
  storagesListContract,
  schedulesMainContract,
  schedulesByNameContract,
  schedulesEnableContract,
  scheduleRunsContract,
  agentComposeApiContentSchema,
  type ApiErrorResponse,
  type ScheduleResponse,
  type ScheduleListResponse,
  type DeployScheduleResponse,
  type ScheduleRunsResponse,
} from "@vm0/core";
import type { z } from "zod";
import { getApiUrl, getActiveToken } from "./config";
import { handleError } from "./core/client-factory";

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
  OrgResponse as CoreOrgResponse,
  LogsSearchResponse as CoreLogsSearchResponse,
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
export type OrgResponse = CoreOrgResponse;
export type GetSystemLogResponse = SystemLogResponse;
export type GetMetricsResponse = MetricsResponse;
export type GetAgentEventsResponse = AgentEventsResponse;
export type GetNetworkLogsResponse = NetworkLogsResponse;
export type GetSessionResponse = SessionResponse;
export type GetCheckpointResponse = CheckpointResponse;
export type GetComposeResponse = ComposeResponse;
export type GetEventsResponse = EventsResponse;
export type LogsSearchResponse = CoreLogsSearchResponse;

// Usage API types
export interface UsageResponse {
  period: { start: string; end: string };
  summary: { total_runs: number; total_run_time_ms: number };
  daily: Array<{ date: string; run_count: number; run_time_ms: number }>;
}

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
    const token = await getActiveToken();
    if (!token) {
      throw new Error("Not authenticated. Run: vm0 auth login");
    }

    // Note: Don't set Content-Type here - ts-rest automatically adds it for requests with body.
    // Setting Content-Type for bodyless requests (GET, DELETE) can cause server-side parsing issues.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
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
    org?: string,
  ): Promise<GetComposeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(composesMainContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.getByName({
      query: {
        name,
        org,
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
      jsonQuery: false,
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
    const client = initClient(composesVersionsContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
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
      jsonQuery: false,
    });

    const result = await client.create({
      body: body as { content: z.infer<typeof agentComposeApiContentSchema> },
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
    // Debug flag (internal use only)
    debugNoMockClaude?: boolean;
    // Required
    prompt: string;
  }): Promise<CreateRunResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(runsMainContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
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
      jsonQuery: false,
    });

    const result = await client.getEvents({
      params: { id: runId },
      query: {
        since: options?.since ?? -1,
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
      jsonQuery: false,
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
      jsonQuery: false,
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
      jsonQuery: false,
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
      jsonQuery: false,
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
   * Get current user's default org
   */
  async getScope(): Promise<OrgResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(orgContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.get({ headers: {} });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to get org";
    throw new Error(message);
  }

  /**
   * Update user's default org slug
   */
  async updateScope(body: {
    slug: string;
    force?: boolean;
  }): Promise<OrgResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    // Create ts-rest client with config
    const client = initClient(orgContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.update({ body });

    // ts-rest returns discriminated union based on status code
    if (result.status === 200) {
      return result.body;
    }

    // Error cases
    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to update org";
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
      jsonQuery: false,
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
      jsonQuery: false,
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
   * Prepare storage for direct S3 upload
   */
  async prepareStorage(body: {
    storageName: string;
    storageType: "volume" | "artifact" | "memory";
    files: Array<{ path: string; hash: string; size: number }>;
    force?: boolean;
  }): Promise<{
    versionId: string;
    existing: boolean;
    uploads?: {
      archive: { key: string; presignedUrl: string };
      manifest: { key: string; presignedUrl: string };
    };
  }> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(storagesPrepareContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.prepare({ body });

    if (result.status === 200) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to prepare storage";
    throw new Error(message);
  }

  /**
   * Commit storage after S3 upload
   */
  async commitStorage(body: {
    storageName: string;
    storageType: "volume" | "artifact" | "memory";
    versionId: string;
    files: Array<{ path: string; hash: string; size: number }>;
  }): Promise<{
    success: true;
    versionId: string;
    storageName: string;
    size: number;
    fileCount: number;
    deduplicated?: boolean;
  }> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(storagesCommitContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.commit({ body });

    if (result.status === 200) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to commit storage";
    throw new Error(message);
  }

  /**
   * Get download URL for storage (volume or artifact)
   */
  async getStorageDownload(query: {
    name: string;
    type: "volume" | "artifact" | "memory";
    version?: string;
  }): Promise<
    | {
        url: string;
        versionId: string;
        fileCount: number;
        size: number;
      }
    | {
        empty: true;
        versionId: string;
        fileCount: 0;
        size: 0;
      }
  > {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(storagesDownloadContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.download({
      query: {
        name: query.name,
        type: query.type,
        version: query.version,
      },
    });

    if (result.status === 200) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message =
      errorBody.error?.message || `Storage "${query.name}" not found`;
    throw new Error(message);
  }

  /**
   * List storages (volumes or artifacts)
   */
  async listStorages(query: {
    type: "volume" | "artifact" | "memory";
  }): Promise<
    Array<{
      name: string;
      size: number;
      fileCount: number;
      updatedAt: string;
    }>
  > {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(storagesListContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.list({ query });

    if (result.status === 200) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || `Failed to list ${query.type}s`;
    throw new Error(message);
  }

  /**
   * Deploy schedule (create or update)
   * Note: vars and secrets are now managed via platform tables (vm0 secret set, vm0 var set)
   */
  async deploySchedule(body: {
    name: string;
    cronExpression?: string;
    atTime?: string;
    timezone?: string;
    prompt: string;
    // vars and secrets removed - now managed via platform tables
    artifactName?: string;
    artifactVersion?: string;
    volumeVersions?: Record<string, string>;
    composeId: string;
  }): Promise<DeployScheduleResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(schedulesMainContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.deploy({ body });

    if (result.status === 200 || result.status === 201) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to deploy schedule";
    throw new Error(message);
  }

  /**
   * List all schedules
   */
  async listSchedules(): Promise<ScheduleListResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(schedulesMainContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.list({ headers: {} });

    if (result.status === 200) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message = errorBody.error?.message || "Failed to list schedules";
    throw new Error(message);
  }

  /**
   * Get schedule by name
   */
  async getScheduleByName(params: {
    name: string;
    composeId: string;
  }): Promise<ScheduleResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(schedulesByNameContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.getByName({
      params: { name: params.name },
      query: { composeId: params.composeId },
    });

    if (result.status === 200) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message =
      errorBody.error?.message || `Schedule "${params.name}" not found`;
    throw new Error(message);
  }

  /**
   * Delete schedule by name
   */
  async deleteSchedule(params: {
    name: string;
    composeId: string;
  }): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(schedulesByNameContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.delete({
      params: { name: params.name },
      query: { composeId: params.composeId },
    });

    if (result.status === 204) {
      return;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message =
      errorBody.error?.message ||
      `Schedule "${params.name}" not found on remote`;
    throw new Error(message);
  }

  /**
   * Enable schedule
   */
  async enableSchedule(params: {
    name: string;
    composeId: string;
  }): Promise<ScheduleResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(schedulesEnableContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.enable({
      params: { name: params.name },
      body: { composeId: params.composeId },
    });

    if (result.status === 200) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message =
      errorBody.error?.message || `Failed to enable schedule "${params.name}"`;
    throw new Error(message);
  }

  /**
   * Disable schedule
   */
  async disableSchedule(params: {
    name: string;
    composeId: string;
  }): Promise<ScheduleResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(schedulesEnableContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.disable({
      params: { name: params.name },
      body: { composeId: params.composeId },
    });

    if (result.status === 200) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message =
      errorBody.error?.message || `Failed to disable schedule "${params.name}"`;
    throw new Error(message);
  }

  /**
   * List recent runs for a schedule
   */
  async listScheduleRuns(params: {
    name: string;
    composeId: string;
    limit?: number;
  }): Promise<ScheduleRunsResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(scheduleRunsContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.listRuns({
      params: { name: params.name },
      query: {
        composeId: params.composeId,
        limit: params.limit ?? 5,
      },
    });

    if (result.status === 200) {
      return result.body;
    }

    const errorBody = result.body as ApiErrorResponse;
    const message =
      errorBody.error?.message ||
      `Failed to list runs for schedule "${params.name}"`;
    throw new Error(message);
  }

  /**
   * Get usage statistics
   */
  async getUsage(options: {
    startDate: string;
    endDate: string;
  }): Promise<UsageResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const params = new URLSearchParams({
      start_date: options.startDate,
      end_date: options.endDate,
    });

    const response = await fetch(`${baseUrl}/api/usage?${params}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as { error?: { message?: string } };
      throw new Error(error.error?.message || "Failed to fetch usage data");
    }

    return response.json() as Promise<UsageResponse>;
  }

  /**
   * Generic GET request
   */
  async get(path: string): Promise<Response> {
    const baseUrl = await this.getBaseUrl();
    const token = await getActiveToken();
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
    const token = await getActiveToken();
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
    const token = await getActiveToken();
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

  async searchLogs(options: {
    keyword: string;
    agent?: string;
    runId?: string;
    since?: number;
    limit?: number;
    before?: number;
    after?: number;
  }): Promise<LogsSearchResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const client = initClient(logsSearchContract, {
      baseUrl,
      baseHeaders: headers,
      jsonQuery: false,
    });

    const result = await client.searchLogs({
      query: {
        keyword: options.keyword,
        agent: options.agent,
        runId: options.runId,
        since: options.since,
        limit: options.limit,
        before: options.before,
        after: options.after,
      },
    });

    if (result.status === 200) {
      return result.body;
    }

    handleError(result, "Failed to search logs");
  }
}

// Note: Secrets API types are now defined in @vm0/core contracts
// and used via the type-safe client in ./secrets-client.ts

export const apiClient = new ApiClient();
