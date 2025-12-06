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

export interface AgentSessionResponse {
  session: {
    id: string;
    userId: string;
    agentComposeId: string;
    conversationId: string | null;
    artifactName: string;
    createdAt: string;
    updatedAt: string;
    conversation?: {
      id: string;
      cliAgentType: string;
      cliAgentSessionId: string;
      cliAgentSessionHistory: string;
    } | null;
  };
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

export interface GetEventsResponse {
  events: Array<{
    sequenceNumber: number;
    eventType: string;
    eventData: unknown;
    createdAt: string;
  }>;
  hasMore: boolean;
  nextSequence: number;
  status: RunStatus;
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

  async getComposeByName(name: string): Promise<GetComposeResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(
      `${baseUrl}/api/agent/composes?name=${encodeURIComponent(name)}`,
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
   * Note: Environment variables are expanded server-side from templateVars
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
    templateVars?: Record<string, string>;
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

  async getAgentSession(id: string): Promise<AgentSessionResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/agent/sessions/${id}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to get agent session");
    }

    return (await response.json()) as AgentSessionResponse;
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

/**
 * Response types for secrets API
 */
export interface SecretInfo {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListSecretsResponse {
  secrets: SecretInfo[];
}

export interface SetSecretResponse {
  name: string;
  action: "created" | "updated";
}

export interface DeleteSecretResponse {
  name: string;
  deleted: boolean;
}

export const apiClient = new ApiClient();
