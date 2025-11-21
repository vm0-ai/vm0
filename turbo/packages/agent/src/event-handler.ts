/**
 * Agent Event Handler
 * Supports multiple modes for collecting agent events:
 * - webhook: Real-time HTTP callbacks (local dev with ngrok, production)
 * - file: Write to filesystem and poll (CI, fallback)
 */

export type EventMode = "webhook" | "file";

export interface AgentEvent {
  type: string;
  timestamp: string;
  data: unknown;
}

export interface EventHandlerConfig {
  mode: EventMode;
  webhookUrl?: string;
  outputFile?: string;
}

/**
 * Determine the best event handler mode based on environment
 */
export function getEventHandlerConfig(): EventHandlerConfig {
  const isCI = process.env.CI === "true";
  const webhookUrl = process.env.WEBHOOK_BASE_URL;

  if (isCI) {
    // CI: Always use file mode
    return {
      mode: "file",
      outputFile: "/tmp/agent-events.jsonl",
    };
  }

  if (webhookUrl) {
    // Local dev with ngrok or production with real URL
    return {
      mode: "webhook",
      webhookUrl: `${webhookUrl}/api/webhooks/agent/events`,
    };
  }

  // Fallback to file mode
  console.warn(
    "No WEBHOOK_BASE_URL configured, falling back to file mode. " +
      "For local development, run: ./scripts/start-ngrok.sh",
  );
  return {
    mode: "file",
    outputFile: "/tmp/agent-events.jsonl",
  };
}

/**
 * Generate shell command arguments for run-agent.sh based on config
 */
export function getAgentCommandArgs(config: EventHandlerConfig): string[] {
  const args: string[] = [];

  if (config.mode === "webhook" && config.webhookUrl) {
    args.push("--webhook-url", config.webhookUrl);
  } else if (config.mode === "file" && config.outputFile) {
    args.push("--output-file", config.outputFile);
  }

  return args;
}
