/**
 * Slack Test Mocks - Mock utilities for testing Slack handlers
 *
 * This module provides mock utilities for testing Slack integration handlers
 * without making actual Slack API calls.
 */
import { vi, type Mock } from "vitest";
import type { WebClient } from "@slack/web-api";

/**
 * Captured Slack API call for verification
 */
export interface SlackApiCall {
  method: string;
  args: unknown;
  timestamp: number;
}

/**
 * Mock Slack WebClient with all methods tracked
 */
export interface MockSlackClient {
  client: WebClient;
  calls: SlackApiCall[];
  reset: () => void;
  getCalls: (method: string) => SlackApiCall[];
}

/**
 * Creates a mock Slack WebClient that captures all API calls.
 * Use this to verify Slack API interactions in tests.
 *
 * @example
 * ```ts
 * const mockClient = createMockSlackClient();
 *
 * // Use mockClient.client in your handler
 * await handleAppMention(context, mockClient.client);
 *
 * // Verify calls were made
 * const postCalls = mockClient.getCalls("chat.postMessage");
 * expect(postCalls).toHaveLength(1);
 * expect(postCalls[0].args).toMatchObject({ channel: "C123" });
 * ```
 */
export function createMockSlackClient(): MockSlackClient {
  const calls: SlackApiCall[] = [];

  const recordCall = (method: string) => {
    return vi.fn().mockImplementation((args: unknown) => {
      calls.push({ method, args, timestamp: Date.now() });

      // Return appropriate mock responses based on method
      switch (method) {
        case "chat.postMessage":
          return Promise.resolve({
            ok: true,
            ts: `${Date.now()}.000000`,
            channel: (args as { channel: string }).channel,
          });
        case "chat.update":
          return Promise.resolve({
            ok: true,
            ts: (args as { ts: string }).ts,
            channel: (args as { channel: string }).channel,
          });
        case "reactions.add":
        case "reactions.remove":
          return Promise.resolve({ ok: true });
        case "conversations.replies":
          return Promise.resolve({
            ok: true,
            messages: [],
          });
        case "conversations.history":
          return Promise.resolve({
            ok: true,
            messages: [],
          });
        case "views.open":
          return Promise.resolve({
            ok: true,
            view: { id: "V123" },
          });
        case "views.update":
          return Promise.resolve({
            ok: true,
            view: { id: "V123" },
          });
        case "users.info":
          return Promise.resolve({
            ok: true,
            user: {
              id: (args as { user: string }).user,
              name: "testuser",
              real_name: "Test User",
            },
          });
        default:
          return Promise.resolve({ ok: true });
      }
    });
  };

  const client = {
    chat: {
      postMessage: recordCall("chat.postMessage"),
      update: recordCall("chat.update"),
      delete: recordCall("chat.delete"),
    },
    reactions: {
      add: recordCall("reactions.add"),
      remove: recordCall("reactions.remove"),
    },
    conversations: {
      replies: recordCall("conversations.replies"),
      history: recordCall("conversations.history"),
    },
    views: {
      open: recordCall("views.open"),
      update: recordCall("views.update"),
      push: recordCall("views.push"),
    },
    users: {
      info: recordCall("users.info"),
    },
  } as unknown as WebClient;

  return {
    client,
    calls,
    reset: () => {
      calls.length = 0;
    },
    getCalls: (method: string) => calls.filter((c) => c.method === method),
  };
}

/**
 * Type for runAgentForSlack mock result
 */
export interface MockAgentResult {
  response: string;
  sessionId?: string;
}

/**
 * Creates a mock for runAgentForSlack function.
 * Returns a spy that can be configured to return different results.
 *
 * @example
 * ```ts
 * const mockRun = createMockRunAgentForSlack({
 *   response: "Agent response",
 *   sessionId: "session-123",
 * });
 *
 * // Test the handler
 * await handleAppMention(context);
 *
 * // Verify runAgentForSlack was called correctly
 * expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({
 *   prompt: "test message",
 * }));
 * ```
 */
export function createMockRunAgentForSlack(
  defaultResult: MockAgentResult = { response: "Mock agent response" },
): Mock<
  (params: {
    binding: { id: string; composeId: string; encryptedSecrets: string | null };
    sessionId: string | undefined;
    prompt: string;
    threadContext: string;
    userId: string;
    encryptionKey: string;
  }) => Promise<MockAgentResult>
> {
  return vi.fn().mockResolvedValue(defaultResult);
}

/**
 * Sets up mock for thread context fetching.
 * Returns mock messages for conversations.replies.
 */
export function setupMockThreadContext(
  mockClient: MockSlackClient,
  messages: Array<{ user: string; text: string; ts: string }>,
): void {
  (mockClient.client.conversations.replies as Mock).mockResolvedValue({
    ok: true,
    messages: messages.map((m) => ({
      type: "message",
      user: m.user,
      text: m.text,
      ts: m.ts,
    })),
  });
}

/**
 * Sets up mock for channel history fetching.
 * Returns mock messages for conversations.history.
 */
export function setupMockChannelContext(
  mockClient: MockSlackClient,
  messages: Array<{ user: string; text: string; ts: string }>,
): void {
  (mockClient.client.conversations.history as Mock).mockResolvedValue({
    ok: true,
    messages: messages.map((m) => ({
      type: "message",
      user: m.user,
      text: m.text,
      ts: m.ts,
    })),
  });
}

/**
 * Sets up mock to simulate Slack API error.
 */
export function setupMockSlackApiError(
  mockClient: MockSlackClient,
  method: string,
  error: string,
): void {
  const methodParts = method.split(".");
  let target: unknown = mockClient.client;
  for (let i = 0; i < methodParts.length - 1; i++) {
    target = (target as Record<string, unknown>)[methodParts[i] as string];
  }
  const finalMethod = methodParts[methodParts.length - 1] as string;
  ((target as Record<string, Mock>)[finalMethod] as Mock).mockRejectedValueOnce(
    new Error(error),
  );
}
