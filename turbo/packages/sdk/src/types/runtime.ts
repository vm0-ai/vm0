/**
 * Runtime-related types
 */

export interface CreateRuntimeOptions {
  agentConfigId: string;
  dynamicVars?: Record<string, string>;
}

export interface RunOptions {
  prompt: string;
}

export interface RuntimeResponse {
  runtimeId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
}

export interface EventsResponse {
  events: Array<{
    eventId: string;
    sequenceNumber: number;
    eventType: string;
    eventData: unknown;
    createdAt: string;
  }>;
  hasMore: boolean;
  nextSequence: number;
}
