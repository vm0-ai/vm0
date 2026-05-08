import { describe, it, expect } from "vitest";
import {
  ingestProviderTranscriptEvent,
  type ProviderTranscriptEvent,
} from "../transcript-ingestor";

const SESSION = "session_abc";
const TOKEN = "relay-token-stub";
const BASE_URL = "http://web.test";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetcher(response: { status: number; body?: unknown }) {
  const calls: CapturedCall[] = [];
  const fetcher = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers).entries()) {
        headers[k] = v;
      }
    }
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : init?.body,
    });
    return Promise.resolve(
      new Response(JSON.stringify(response.body ?? {}), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetcher, calls };
}

async function run(event: ProviderTranscriptEvent) {
  const { fetcher, calls } = makeFetcher({ status: 200 });
  await ingestProviderTranscriptEvent({
    voiceChatSessionId: SESSION,
    event,
    relayToken: TOKEN,
    webBaseUrl: BASE_URL,
    fetcher: fetcher as unknown as typeof fetch,
  });
  return calls;
}

describe("ingestProviderTranscriptEvent — input_audio_transcription.completed", () => {
  it("posts a user item with the transcript and item_id", async () => {
    const calls = await run({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "hello world",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${BASE_URL}/api/internal/voice-chat/relay/${SESSION}/items`,
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.body).toStrictEqual({
      role: "user",
      content: "hello world",
      realtimeItemId: "item_1",
    });
  });

  it("skips empty (whitespace-only) transcripts", async () => {
    const calls = await run({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "   ",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("ingestProviderTranscriptEvent — response.audio_transcript.done", () => {
  it("posts an assistant item with the explicit item_id", async () => {
    const calls = await run({
      type: "response.audio_transcript.done",
      item_id: "msg_42",
      transcript: "yes I can do that",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toStrictEqual({
      role: "assistant",
      content: "yes I can do that",
      realtimeItemId: "msg_42",
    });
  });

  it("synthesizes id from response_id + transcript length when item_id is missing", async () => {
    const calls = await run({
      type: "response.audio_transcript.done",
      response_id: "resp_1",
      transcript: "hi",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toStrictEqual({
      role: "assistant",
      content: "hi",
      realtimeItemId: "resp_1:2",
    });
  });

  it("skips when transcript is whitespace-only", async () => {
    const calls = await run({
      type: "response.audio_transcript.done",
      item_id: "msg_42",
      transcript: "   ",
    });
    expect(calls).toHaveLength(0);
  });

  it("skips when no item_id and no response_id are available", async () => {
    const calls = await run({
      type: "response.audio_transcript.done",
      transcript: "hi",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("ingestProviderTranscriptEvent — vm0.assistant_interrupted", () => {
  it("posts a system_note keyed by truncate:<itemId> with the JSON body", async () => {
    const calls = await run({
      type: "vm0.assistant_interrupted",
      assistantRealtimeItemId: "msg_1",
      heardText: "okay let me",
      audioEndMs: 1234,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toStrictEqual({
      role: "system_note",
      content: JSON.stringify({
        type: "assistant_interrupted",
        assistantRealtimeItemId: "msg_1",
        heardText: "okay let me",
        audioEndMs: 1234,
      }),
      realtimeItemId: "truncate:msg_1",
    });
  });

  it("trims heardText before persisting", async () => {
    const calls = await run({
      type: "vm0.assistant_interrupted",
      assistantRealtimeItemId: "msg_1",
      heardText: "   okay   ",
      audioEndMs: 0,
    });
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as { content: string };
    expect(body.content).toContain('"heardText":"okay"');
  });
});

describe("ingestProviderTranscriptEvent — failure handling", () => {
  it("does not throw when the upstream route returns 5xx", async () => {
    const { fetcher } = makeFetcher({ status: 500 });
    await expect(
      ingestProviderTranscriptEvent({
        voiceChatSessionId: SESSION,
        event: {
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_1",
          transcript: "hi",
        },
        relayToken: TOKEN,
        webBaseUrl: BASE_URL,
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});
