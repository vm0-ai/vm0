/**
 * Webhook request/response types
 */

export interface AgentEvent {
  type: string;
  timestamp: number;
  sessionId?: string;
  data: Record<string, unknown>;
}

export interface WebhookRequest {
  runId: string;
  events: AgentEvent[];
}

export interface WebhookResponse {
  received: number;
  firstSequence: number;
  lastSequence: number;
}
