import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunner } from '../agent-runner';
import { APIClient } from '../api-client';
import type { EventsResponse, TextEvent, ResultEvent } from '../types';
import { TimeoutError } from '../utils/errors';

describe('AgentRunner', () => {
  let runner: AgentRunner;
  let apiClient: APIClient;

  beforeEach(() => {
    apiClient = new APIClient({
      apiUrl: 'http://localhost:3000',
      apiKey: 'test-key',
    });
    runner = new AgentRunner(apiClient, {
      apiUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      pollInterval: 100,
      timeout: 1000,
    });
  });

  describe('event emission', () => {
    it('should emit events as they are received', async () => {
      const mockEvents: EventsResponse = {
        events: [
          {
            eventId: 'evt-1',
            sequenceNumber: 1,
            eventType: 'text',
            eventData: {
              type: 'text',
              content: 'Hello',
              timestamp: Date.now(),
            } as TextEvent,
            createdAt: '2025-11-17T10:00:00Z',
          },
        ],
        hasMore: false,
        nextSequence: 2,
      };

      const getEventsSpy = vi
        .spyOn(apiClient, 'getEvents')
        .mockResolvedValue(mockEvents);

      const textEvents: TextEvent[] = [];
      runner.on('text', (event) => {
        textEvents.push(event);
        runner.stop();
      });

      runner.start('rt-123');

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(textEvents.length).toBeGreaterThanOrEqual(1);
      expect(textEvents[0].content).toBe('Hello');
      expect(getEventsSpy).toHaveBeenCalled();
    });

    it('should emit wildcard events', async () => {
      const mockEvents: EventsResponse = {
        events: [
          {
            eventId: 'evt-1',
            sequenceNumber: 1,
            eventType: 'text',
            eventData: {
              type: 'text',
              content: 'Hello',
              timestamp: Date.now(),
            } as TextEvent,
            createdAt: '2025-11-17T10:00:00Z',
          },
        ],
        hasMore: false,
        nextSequence: 2,
      };

      const getEventsSpy = vi
        .spyOn(apiClient, 'getEvents')
        .mockResolvedValue(mockEvents);

      const allEvents: unknown[] = [];
      runner.on('*', (event) => {
        allEvents.push(event);
        runner.stop();
      });

      runner.start('rt-123');

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(allEvents.length).toBeGreaterThanOrEqual(1);
      expect(getEventsSpy).toHaveBeenCalled();
    });
  });

  describe('polling', () => {
    it('should stop polling after result event', async () => {
      const mockEvents: EventsResponse = {
        events: [
          {
            eventId: 'evt-1',
            sequenceNumber: 1,
            eventType: 'result',
            eventData: {
              type: 'result',
              content: {
                success: true,
                result: 'Done',
                durationMs: 1000,
                numTurns: 1,
                totalCostUsd: 0.01,
                usage: {
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
              },
              timestamp: Date.now(),
            } as ResultEvent,
            createdAt: '2025-11-17T10:00:00Z',
          },
        ],
        hasMore: false,
        nextSequence: 2,
      };

      const getEventsSpy = vi
        .spyOn(apiClient, 'getEvents')
        .mockResolvedValue(mockEvents);

      runner.start('rt-123');

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should only call once since result event stops polling
      expect(getEventsSpy).toHaveBeenCalledTimes(1);
    });

    it('should track sequence numbers correctly', async () => {
      const mockEvents1: EventsResponse = {
        events: [
          {
            eventId: 'evt-1',
            sequenceNumber: 1,
            eventType: 'text',
            eventData: {
              type: 'text',
              content: 'First',
              timestamp: Date.now(),
            } as TextEvent,
            createdAt: '2025-11-17T10:00:00Z',
          },
        ],
        hasMore: true,
        nextSequence: 2,
      };

      const mockEvents2: EventsResponse = {
        events: [
          {
            eventId: 'evt-2',
            sequenceNumber: 2,
            eventType: 'result',
            eventData: {
              type: 'result',
              content: {
                success: true,
                result: 'Done',
                durationMs: 1000,
                numTurns: 1,
                totalCostUsd: 0.01,
                usage: {
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
              },
              timestamp: Date.now(),
            } as ResultEvent,
            createdAt: '2025-11-17T10:00:00Z',
          },
        ],
        hasMore: false,
        nextSequence: 3,
      };

      const getEventsSpy = vi
        .spyOn(apiClient, 'getEvents')
        .mockResolvedValueOnce(mockEvents1)
        .mockResolvedValueOnce(mockEvents2);

      runner.start('rt-123');

      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(getEventsSpy).toHaveBeenCalledWith('rt-123', 0);
      expect(getEventsSpy).toHaveBeenCalledWith('rt-123', 1);
    });
  });

  describe('wait', () => {
    it('should resolve when result event is successful', async () => {
      const mockEvents: EventsResponse = {
        events: [
          {
            eventId: 'evt-1',
            sequenceNumber: 1,
            eventType: 'result',
            eventData: {
              type: 'result',
              content: {
                success: true,
                result: 'Done',
                durationMs: 1000,
                numTurns: 1,
                totalCostUsd: 0.01,
                usage: {
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
              },
              timestamp: Date.now(),
            } as ResultEvent,
            createdAt: '2025-11-17T10:00:00Z',
          },
        ],
        hasMore: false,
        nextSequence: 2,
      };

      vi.spyOn(apiClient, 'getEvents').mockResolvedValue(mockEvents);

      runner.start('rt-123');

      const result = await runner.wait();

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('result', 'Done');
    });

    it('should reject when result event is unsuccessful', async () => {
      const mockEvents: EventsResponse = {
        events: [
          {
            eventId: 'evt-1',
            sequenceNumber: 1,
            eventType: 'result',
            eventData: {
              type: 'result',
              content: {
                success: false,
                result: 'Failed',
                durationMs: 1000,
                numTurns: 1,
                totalCostUsd: 0.01,
                usage: {
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
              },
              timestamp: Date.now(),
            } as ResultEvent,
            createdAt: '2025-11-17T10:00:00Z',
          },
        ],
        hasMore: false,
        nextSequence: 2,
      };

      vi.spyOn(apiClient, 'getEvents').mockResolvedValue(mockEvents);

      runner.start('rt-123');

      await expect(runner.wait()).rejects.toThrow('Failed');
    });

    it('should reject on timeout', async () => {
      vi.spyOn(apiClient, 'getEvents').mockResolvedValue({
        events: [],
        hasMore: false,
        nextSequence: 1,
      });

      runner.start('rt-123');

      await expect(runner.wait()).rejects.toThrow(TimeoutError);
    });

    it('should reject on error', async () => {
      vi.spyOn(apiClient, 'getEvents').mockRejectedValue(
        new Error('Network error')
      );

      runner.start('rt-123');

      await expect(runner.wait()).rejects.toThrow('Network error');
    });
  });

  describe('stop', () => {
    it('should stop polling', async () => {
      const getEventsSpy = vi.spyOn(apiClient, 'getEvents').mockResolvedValue({
        events: [],
        hasMore: false,
        nextSequence: 1,
      });

      runner.start('rt-123');
      runner.stop();

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should only call once before stopping
      expect(getEventsSpy).toHaveBeenCalledTimes(1);
    });
  });
});
