import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APIClient } from '../api-client';
import { APIError } from '../utils/errors';

describe('APIClient', () => {
  let client: APIClient;

  beforeEach(() => {
    client = new APIClient({
      apiUrl: 'http://localhost:3000',
      apiKey: 'test-key',
    });

    // Mock fetch
    global.fetch = vi.fn();
  });

  describe('createRuntime', () => {
    it('should create runtime successfully', async () => {
      const mockResponse = {
        runtimeId: 'rt-123',
        status: 'pending',
        createdAt: '2025-11-17T10:00:00Z',
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.createRuntime('cfg-123', 'test prompt');

      expect(result.runtimeId).toBe('rt-123');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent-runtimes',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Api-Key': 'test-key',
          }),
        })
      );
    });

    it('should include dynamic vars in request', async () => {
      const mockResponse = {
        runtimeId: 'rt-123',
        status: 'pending',
        createdAt: '2025-11-17T10:00:00Z',
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await client.createRuntime('cfg-123', 'test prompt', {
        userKey: 'user-456',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent-runtimes',
        expect.objectContaining({
          body: JSON.stringify({
            agentConfigId: 'cfg-123',
            prompt: 'test prompt',
            dynamicVars: { userKey: 'user-456' },
          }),
        })
      );
    });
  });

  describe('getEvents', () => {
    it('should get events successfully', async () => {
      const mockResponse = {
        events: [
          {
            eventId: 'evt-1',
            sequenceNumber: 1,
            eventType: 'text',
            eventData: { type: 'text', content: 'hello' },
            createdAt: '2025-11-17T10:00:00Z',
          },
        ],
        hasMore: false,
        nextSequence: 2,
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.getEvents('rt-123', 0);

      expect(result.events).toHaveLength(1);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent-runtimes/rt-123/events?since=0',
        expect.anything()
      );
    });
  });

  describe('getRuntime', () => {
    it('should get runtime status successfully', async () => {
      const mockResponse = {
        runtimeId: 'rt-123',
        status: 'running',
        createdAt: '2025-11-17T10:00:00Z',
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.getRuntime('rt-123');

      expect(result.status).toBe('running');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent-runtimes/rt-123',
        expect.anything()
      );
    });
  });

  describe('error handling', () => {
    it('should handle API errors with message', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Unauthorized' } }),
      });

      try {
        await client.createRuntime('cfg-123', 'test');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).statusCode).toBe(401);
        expect((error as APIError).message).toBe('Unauthorized');
      }
    });

    it('should handle API errors without message', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      try {
        await client.createRuntime('cfg-123', 'test');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).statusCode).toBe(500);
        expect((error as APIError).message).toBe('HTTP 500');
      }
    });

    it('should handle malformed JSON responses', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      try {
        await client.createRuntime('cfg-123', 'test');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).statusCode).toBe(500);
      }
    });
  });
});
