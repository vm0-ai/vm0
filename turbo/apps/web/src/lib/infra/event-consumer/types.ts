/**
 * A raw agent event as received from the sandbox.
 */
export interface AgentEvent {
  type: string;
  sequenceNumber: number;
  [key: string]: unknown;
}

/**
 * Context about the run that produced the events.
 * Resolved once by the events webhook and forwarded to all consumers.
 */
export interface RunEventContext {
  userId: string;
  orgId: string;
  modelProvider?: string;
  selectedModel?: string;
}

/**
 * Payload POSTed to each event consumer endpoint.
 */
export interface EventConsumerPayload {
  runId: string;
  events: AgentEvent[];
  context: RunEventContext;
}

/**
 * Static registration entry for an event consumer.
 */
export interface EventConsumerConfig {
  /** Human-readable name for logging. */
  name: string;
  /** Route path relative to the API base URL. */
  path: string;
  /**
   * When set, only events whose `type` is in this list are forwarded.
   * When omitted/empty, ALL events are forwarded.
   */
  eventTypes?: string[];
}
