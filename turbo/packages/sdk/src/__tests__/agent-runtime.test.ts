import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRuntime } from '../agent-runtime';
import { AgentRunner } from '../agent-runner';

describe('AgentRuntime', () => {
  beforeEach(() => {
    // Reset environment variables
    delete process.env.VM0_API_URL;
    delete process.env.VM0_API_KEY;

    // Mock fetch
    global.fetch = vi.fn();
  });

  describe('create', () => {
    it('should create runtime with provided config', () => {
      const runtime = AgentRuntime.create(
        'cfg-123',
        { userKey: 'user-456' },
        {
          apiUrl: 'http://localhost:3000',
          apiKey: 'test-key',
        }
      );

      expect(runtime).toBeInstanceOf(AgentRuntime);
    });

    it('should use environment variables as defaults', () => {
      process.env.VM0_API_URL = 'http://env-url:3000';
      process.env.VM0_API_KEY = 'env-key';

      const runtime = AgentRuntime.create('cfg-123');

      expect(runtime).toBeInstanceOf(AgentRuntime);
    });

    it('should throw error if API key is missing', () => {
      expect(() => {
        AgentRuntime.create('cfg-123');
      }).toThrow('VM0_API_KEY is required');
    });

    it('should override environment variables with provided config', () => {
      process.env.VM0_API_URL = 'http://env-url:3000';
      process.env.VM0_API_KEY = 'env-key';

      const runtime = AgentRuntime.create('cfg-123', undefined, {
        apiUrl: 'http://custom-url:3000',
        apiKey: 'custom-key',
      });

      expect(runtime).toBeInstanceOf(AgentRuntime);
    });
  });

  describe('run', () => {
    it('should return AgentRunner instance', () => {
      const runtime = AgentRuntime.create('cfg-123', undefined, {
        apiUrl: 'http://localhost:3000',
        apiKey: 'test-key',
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          runtimeId: 'rt-123',
          status: 'pending',
          createdAt: '2025-11-17T10:00:00Z',
        }),
      });

      const runner = runtime.run('test prompt');

      expect(runner).toBeInstanceOf(AgentRunner);
    });

    it('should start runtime creation in background', async () => {
      const runtime = AgentRuntime.create('cfg-123', { userKey: 'user-456' }, {
        apiUrl: 'http://localhost:3000',
        apiKey: 'test-key',
      });

      const mockResponse = {
        runtimeId: 'rt-123',
        status: 'pending',
        createdAt: '2025-11-17T10:00:00Z',
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const runner = runtime.run('test prompt');

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent-runtimes',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            agentConfigId: 'cfg-123',
            prompt: 'test prompt',
            dynamicVars: { userKey: 'user-456' },
          }),
        })
      );

      runner.stop();
    });

    it('should emit error if runtime creation fails', async () => {
      const runtime = AgentRuntime.create('cfg-123', undefined, {
        apiUrl: 'http://localhost:3000',
        apiKey: 'test-key',
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error')
      );

      const runner = runtime.run('test prompt');

      const errors: Error[] = [];
      runner.on('error', (error) => {
        errors.push(error);
      });

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Network error');
    });
  });

  describe('integration', () => {
    it('should handle full lifecycle', async () => {
      const runtime = AgentRuntime.create('cfg-123', undefined, {
        apiUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        pollInterval: 50,
      });

      // Mock runtime creation
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          runtimeId: 'rt-123',
          status: 'pending',
          createdAt: '2025-11-17T10:00:00Z',
        }),
      });

      // Mock events polling
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          events: [],
          hasMore: false,
          nextSequence: 1,
        }),
      });

      const runner = runtime.run('test prompt');

      const events: string[] = [];
      runner.on('*', (event) => {
        events.push(event.type);
      });

      // Wait for runtime to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      runner.stop();

      // Should have called fetch for runtime creation
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent-runtimes',
        expect.anything()
      );
    });
  });
});
