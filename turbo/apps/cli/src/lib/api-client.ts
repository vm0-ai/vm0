import type { CLIConfig, VM0Config } from "../types/config";

export class APIClient {
  constructor(private config: CLIConfig) {}

  /**
   * Build URL with Vercel bypass token if available
   */
  private buildUrl(path: string): string {
    const baseUrl = `${this.config.apiUrl}${path}`;
    const bypassToken = process.env.VM0_VERCEL_BYPASS;

    if (bypassToken) {
      const url = new URL(baseUrl);
      url.searchParams.set("x-vercel-protection-bypass", bypassToken);
      return url.toString();
    }

    return baseUrl;
  }

  /**
   * Create agent config
   * POST /api/agent-configs
   */
  async createAgentConfig(config: VM0Config): Promise<{
    agentConfigId: string;
    createdAt: string;
  }> {
    const response = await fetch(this.buildUrl("/api/agent-configs"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": this.config.apiKey,
      },
      body: JSON.stringify({ config }),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const errorMessage = error.error?.message || response.statusText;
      throw new Error(`HTTP ${response.status}: ${errorMessage}`);
    }

    return response.json() as Promise<{
      agentConfigId: string;
      createdAt: string;
    }>;
  }

  /**
   * Create agent runtime
   * POST /api/agent-runtimes
   */
  async createRuntime(
    agentConfigId: string,
    prompt: string,
    dynamicVars?: Record<string, string>,
  ): Promise<{
    runtimeId: string;
    status: string;
    sandboxId: string;
    output: string;
    executionTimeMs: number;
    error?: string;
  }> {
    const response = await fetch(this.buildUrl("/api/agent-runtimes"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": this.config.apiKey,
      },
      body: JSON.stringify({
        agentConfigId,
        prompt,
        dynamicVars,
      }),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const errorMessage = error.error?.message || response.statusText;
      throw new Error(`HTTP ${response.status}: ${errorMessage}`);
    }

    return response.json() as Promise<{
      runtimeId: string;
      status: string;
      sandboxId: string;
      output: string;
      executionTimeMs: number;
      error?: string;
    }>;
  }
}

/**
 * Get API configuration from environment
 */
export function getAPIConfig(): CLIConfig {
  const apiUrl = process.env.VM0_API_URL || "http://localhost:3000";
  const apiKey = process.env.VM0_API_KEY;

  if (!apiKey) {
    throw new Error(
      "VM0_API_KEY environment variable is required.\n\n" +
        "Set it with:\n" +
        "  export VM0_API_KEY=your-api-key",
    );
  }

  return { apiUrl, apiKey };
}
