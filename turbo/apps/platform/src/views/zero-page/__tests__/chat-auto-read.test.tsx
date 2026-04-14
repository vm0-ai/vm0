import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { ttsPlayingMessageId$ } from "../../../signals/voice-io/voice-io-tts.ts";
import { toggleAutoRead$ } from "../../../signals/voice-io/voice-io-settings.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

function mockWebAudio() {
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function () {
      return {
        currentTime: 0,
        destination: {},
        resume: vi.fn().mockResolvedValue(undefined),
        createBuffer: vi.fn(
          (_channels: number, length: number, sampleRate: number) => {
            return {
              getChannelData: vi.fn(() => {
                return new Float32Array(length);
              }),
              duration: length / sampleRate,
            };
          },
        ),
        createBufferSource: vi.fn(() => {
          return {
            buffer: null as unknown,
            onended: null as (() => void) | null,
            connect: vi.fn(),
            start: vi.fn(),
            addEventListener: vi.fn(),
          };
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
  );
}

function mockTtsEndpoint() {
  let fetchCount = 0;
  server.use(
    http.post("*/api/zero/voice-io/tts", () => {
      fetchCount++;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x00, 0x01, 0x00, 0x02]));
          controller.close();
        },
      });
      return new HttpResponse(body, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }),
  );
  return {
    getFetchCount: () => {
      return fetchCount;
    },
  };
}

// AUTO-READ-001: checkAutoRead$ is triggered after sendMessage$ completes
describe("chat auto-read — triggered after send", () => {
  it("calls TTS after run completes when auto-read is enabled (AUTO-READ-001)", async () => {
    context.store.set(toggleAutoRead$);
    mockWebAudio();
    const { getFetchCount } = mockTtsEndpoint();

    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello auto-read");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    ctrl.completeRun("Auto-read response");

    // Wait for TTS to be triggered after run completion
    await waitFor(() => {
      expect(getFetchCount()).toBeGreaterThan(0);
    });
  });
});

// AUTO-READ-002: checkAutoRead$ is NOT triggered when auto-read is disabled
describe("chat auto-read — skipped when disabled", () => {
  it("does not call TTS after run completes when auto-read is disabled (AUTO-READ-002)", async () => {
    // auto-read disabled by default (no localStorage entry set)
    mockWebAudio();
    const { getFetchCount } = mockTtsEndpoint();

    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello no auto-read");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    ctrl.completeRun("No auto-read response");

    await waitFor(() => {
      expect(screen.getByText("No auto-read response")).toBeInTheDocument();
    });

    // TTS should not be called
    expect(getFetchCount()).toBe(0);
    expect(context.store.get(ttsPlayingMessageId$)).toBeNull();
  });
});

// AUTO-READ-003: markMessageLoading$ guard prevents TTS for messages not seen loading
describe("chat auto-read — markMessageLoading$ guard", () => {
  it("does not trigger TTS for static messages never seen loading (AUTO-READ-003)", async () => {
    context.store.set(toggleAutoRead$);
    mockWebAudio();
    const { getFetchCount } = mockTtsEndpoint();

    server.use(
      http.get("*/api/zero/chat-threads/thread-static-1", () => {
        return HttpResponse.json({
          id: "thread-static-1",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [
            {
              role: "user",
              content: "Static question",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              role: "assistant",
              content: "Static answer",
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
          latestSessionId: null,
          unsavedRuns: [],
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-static-1" });

    await waitFor(() => {
      expect(screen.getByText("Static answer")).toBeInTheDocument();
    });

    // Static messages were never seen loading, so TTS must not be called
    expect(getFetchCount()).toBe(0);
  });
});
