import { getApiUrl, getToken } from "./config";

export interface CreateConfigResponse {
  configId: string;
  name: string;
  action: "created" | "updated";
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

export interface ResumeRunResponse {
  runId: string;
  status: string;
  createdAt: string;
}

export interface GetConfigResponse {
  id: string;
  name: string;
  config: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: {
    message: string;
    code: string;
  };
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

  async getConfigByName(name: string): Promise<GetConfigResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(
      `${baseUrl}/api/agent/configs?name=${encodeURIComponent(name)}`,
      {
        method: "GET",
        headers,
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || `Config not found: ${name}`);
    }

    return (await response.json()) as GetConfigResponse;
  }

  async createOrUpdateConfig(body: {
    config: unknown;
  }): Promise<CreateConfigResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/agent/configs`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to create config");
    }

    return (await response.json()) as CreateConfigResponse;
  }

  async createRun(body: {
    agentConfigId: string;
    prompt: string;
    dynamicVars?: Record<string, string>;
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

  async resumeRun(body: {
    checkpointId: string;
    prompt: string;
  }): Promise<ResumeRunResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/api/agent/runs/resume`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = (await response.json()) as ApiError;
      throw new Error(error.error?.message || "Failed to resume run");
    }

    return (await response.json()) as ResumeRunResponse;
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
}

export const apiClient = new ApiClient();
