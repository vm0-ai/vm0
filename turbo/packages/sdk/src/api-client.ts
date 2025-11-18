import type { RuntimeResponse, EventsResponse, SDKConfig } from './types';
import { APIError } from './utils/errors';

/**
 * HTTP client for VM0 API
 */
export class APIClient {
  private config: Required<SDKConfig>;

  constructor(config: SDKConfig) {
    this.config = {
      pollInterval: 1000,
      timeout: 60000,
      ...config,
    };
  }

  /**
   * Create a new agent runtime
   */
  async createRuntime(
    agentConfigId: string,
    prompt: string,
    dynamicVars?: Record<string, string>
  ): Promise<RuntimeResponse> {
    const response = await this.fetch('/api/agent-runtimes', {
      method: 'POST',
      body: JSON.stringify({
        agentConfigId,
        prompt,
        dynamicVars,
      }),
    });

    return response as RuntimeResponse;
  }

  /**
   * Get events for a runtime
   */
  async getEvents(
    runtimeId: string,
    since: number = 0
  ): Promise<EventsResponse> {
    const response = await this.fetch(
      `/api/agent-runtimes/${runtimeId}/events?since=${since}`
    );

    return response as EventsResponse;
  }

  /**
   * Get runtime status
   */
  async getRuntime(runtimeId: string): Promise<RuntimeResponse> {
    const response = await this.fetch(`/api/agent-runtimes/${runtimeId}`);

    return response as RuntimeResponse;
  }

  /**
   * Internal fetch wrapper
   */
  private async fetch(path: string, options?: RequestInit): Promise<unknown> {
    const url = `${this.config.apiUrl}${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.config.apiKey,
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new APIError(
        (error as { error?: { message?: string } }).error?.message ||
          `HTTP ${response.status}`,
        response.status,
        (error as { error?: { code?: string } }).error?.code
      );
    }

    return response.json();
  }
}
