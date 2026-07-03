/**
 * Raw agent event as forwarded by the events webhook.
 */
export interface AgentEvent {
  readonly type: string;
  readonly sequenceNumber: number;
  readonly [key: string]: unknown;
}

export interface RunEventContext {
  readonly userId: string;
  readonly orgId: string;
}

export interface EventConsumerPayload {
  readonly runId: string;
  readonly events: readonly AgentEvent[];
  readonly context: RunEventContext;
}
