import { EventEmitter } from 'events';
import type {
  AgentEvent,
  EventCallback,
  EventType,
  InitEvent,
  TextEvent,
  ToolUseEvent,
  ToolResultEvent,
  ResultEvent,
  SDKConfig,
} from './types';
import type { APIClient } from './api-client';
import { TimeoutError } from './utils/errors';

/**
 * Agent runner - manages event polling and callbacks
 */
export class AgentRunner extends EventEmitter {
  private runtimeId?: string;
  private lastSequence = 0;
  private pollInterval: number;
  private polling = false;
  private pollTimer?: NodeJS.Timeout;
  private startTime: number;
  private timeout: number;

  constructor(
    private apiClient: APIClient,
    private config: Required<SDKConfig>
  ) {
    super();
    this.pollInterval = config.pollInterval;
    this.timeout = config.timeout;
    this.startTime = Date.now();
  }

  /**
   * Start the runner with a runtime ID
   */
  start(runtimeId: string): void {
    this.runtimeId = runtimeId;
    this.polling = true;
    void this.poll();
  }

  /**
   * Stop polling
   */
  stop(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
  }

  /**
   * Wait for the agent to complete
   */
  async wait(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.on('result', (event) => {
        this.stop();
        if (event.content.success) {
          resolve(event.content);
        } else {
          reject(new Error(event.content.result));
        }
      });

      this.on('error', (error) => {
        this.stop();
        reject(error);
      });

      // Timeout
      setTimeout(() => {
        if (this.polling) {
          this.stop();
          reject(new TimeoutError());
        }
      }, this.timeout);
    });
  }

  /**
   * Poll for new events
   */
  private async poll(): Promise<void> {
    if (!this.polling || !this.runtimeId) {
      return;
    }

    try {
      // Check timeout
      if (Date.now() - this.startTime > this.timeout) {
        this.emit('error', new TimeoutError());
        this.stop();
        return;
      }

      // Get events
      const response = await this.apiClient.getEvents(
        this.runtimeId,
        this.lastSequence
      );

      // Process events
      for (const event of response.events) {
        this.lastSequence = event.sequenceNumber;

        // Parse and emit event
        const parsedEvent = this.parseEvent(event.eventData);
        if (parsedEvent) {
          this.emit(parsedEvent.type, parsedEvent);
          this.emit('*', parsedEvent); // Emit all events
        }

        // Stop if result event
        if (event.eventType === 'result') {
          this.stop();
          return;
        }
      }

      // Schedule next poll
      if (this.polling) {
        this.pollTimer = setTimeout(() => {
          void this.poll();
        }, this.pollInterval);
      }
    } catch (error) {
      this.emit('error', error);
      this.stop();
    }
  }

  /**
   * Parse raw event data into typed event
   */
  private parseEvent(eventData: unknown): AgentEvent | null {
    // For MVP, pass through the event data
    // Future: Use ClaudeCodeParser to parse JSONL
    return eventData as AgentEvent;
  }

}

// Type-safe event listener overloads
export interface AgentRunner {
  on(event: 'init', listener: EventCallback<InitEvent>): this;
  on(event: 'text', listener: EventCallback<TextEvent>): this;
  on(event: 'tool_use', listener: EventCallback<ToolUseEvent>): this;
  on(event: 'tool_result', listener: EventCallback<ToolResultEvent>): this;
  on(event: 'result', listener: EventCallback<ResultEvent>): this;
  on(event: '*', listener: EventCallback<AgentEvent>): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}
