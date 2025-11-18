import { APIClient } from './api-client';
import { AgentRunner } from './agent-runner';
import type { SDKConfig } from './types';

/**
 * Agent runtime - main entry point for SDK
 */
export class AgentRuntime {
  private apiClient: APIClient;
  private config: Required<SDKConfig>;

  private constructor(
    private agentConfigId: string,
    private dynamicVars: Record<string, string> | undefined,
    config: SDKConfig
  ) {
    this.config = {
      pollInterval: 1000,
      timeout: 60000,
      ...config,
    };
    this.apiClient = new APIClient(this.config);
  }

  /**
   * Create a new agent runtime
   */
  static create(
    agentConfigId: string,
    dynamicVars?: Record<string, string>,
    config?: Partial<SDKConfig>
  ): AgentRuntime {
    const fullConfig: SDKConfig = {
      apiUrl: process.env.VM0_API_URL || 'http://localhost:3000',
      apiKey: process.env.VM0_API_KEY || '',
      ...config,
    };

    if (!fullConfig.apiKey) {
      throw new Error('VM0_API_KEY is required');
    }

    return new AgentRuntime(agentConfigId, dynamicVars, fullConfig);
  }

  /**
   * Run the agent with a prompt
   */
  run(prompt: string): AgentRunner {
    const runner = new AgentRunner(this.apiClient, this.config);

    // Start runtime creation in background
    void this.startRuntime(prompt, runner);

    return runner;
  }

  /**
   * Start runtime and begin polling
   */
  private async startRuntime(
    prompt: string,
    runner: AgentRunner
  ): Promise<void> {
    try {
      const response = await this.apiClient.createRuntime(
        this.agentConfigId,
        prompt,
        this.dynamicVars
      );

      runner.start(response.runtimeId);
    } catch (error) {
      runner.emit('error', error);
    }
  }
}
