import { logger } from "../../../lib/log";

const log = logger("zero:voice-chat:relay:transcript");

interface InputAudioTranscriptionCompleted {
  type: "conversation.item.input_audio_transcription.completed";
  item_id: string;
  transcript: string;
}
interface ResponseAudioTranscriptDone {
  type: "response.audio_transcript.done";
  item_id?: string;
  response_id?: string;
  transcript: string;
}
interface AssistantInterruptedSignal {
  type: "vm0.assistant_interrupted";
  assistantRealtimeItemId: string;
  heardText: string;
  audioEndMs: number;
}

export type ProviderTranscriptEvent =
  | InputAudioTranscriptionCompleted
  | ResponseAudioTranscriptDone
  | AssistantInterruptedSignal;

type Fetcher = typeof fetch;

interface IngestParams {
  voiceChatSessionId: string;
  event: ProviderTranscriptEvent;
  relayToken: string;
  webBaseUrl: string;
  fetcher?: Fetcher;
}

/**
 * Persist a relay-observed transcript event by POSTing the normalized body to
 * apps/web's internal `/api/internal/voice-chat/relay/[id]/items` route.
 * The route owns the DB write + Reasoner trigger; this module owns the
 * narrowing from raw provider event to normalized body.
 */
export async function ingestProviderTranscriptEvent(
  params: IngestParams,
): Promise<void> {
  const body = buildItemBody(params.event);
  if (!body) {
    return;
  }
  await postToInternalItemsRoute({
    voiceChatSessionId: params.voiceChatSessionId,
    body,
    relayToken: params.relayToken,
    webBaseUrl: params.webBaseUrl,
    fetcher: params.fetcher ?? fetch,
  });
}

interface ItemBody {
  role: "user" | "assistant" | "system_note";
  content: string;
  realtimeItemId: string;
}

function buildItemBody(event: ProviderTranscriptEvent): ItemBody | null {
  switch (event.type) {
    case "conversation.item.input_audio_transcription.completed": {
      const transcript = event.transcript;
      if (!transcript.trim()) {
        return null;
      }
      return {
        role: "user",
        content: transcript,
        realtimeItemId: event.item_id,
      };
    }
    case "response.audio_transcript.done": {
      const transcript = event.transcript;
      if (!transcript.trim()) {
        return null;
      }
      const id =
        event.item_id ??
        (event.response_id
          ? `${event.response_id}:${String(transcript.length)}`
          : null);
      if (!id) {
        return null;
      }
      return {
        role: "assistant",
        content: transcript,
        realtimeItemId: id,
      };
    }
    case "vm0.assistant_interrupted": {
      const noteContent = JSON.stringify({
        type: "assistant_interrupted",
        assistantRealtimeItemId: event.assistantRealtimeItemId,
        heardText: event.heardText.trim(),
        audioEndMs: event.audioEndMs,
      });
      return {
        role: "system_note",
        content: noteContent,
        realtimeItemId: `truncate:${event.assistantRealtimeItemId}`,
      };
    }
  }
}

async function postToInternalItemsRoute(opts: {
  voiceChatSessionId: string;
  body: ItemBody;
  relayToken: string;
  webBaseUrl: string;
  fetcher: Fetcher;
}): Promise<void> {
  const url = `${opts.webBaseUrl}/api/internal/voice-chat/relay/${opts.voiceChatSessionId}/items`;
  const response = await opts.fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.relayToken}`,
    },
    body: JSON.stringify(opts.body),
  });
  if (!response.ok) {
    log.warn(
      `transcript ingest failed: ${String(response.status)} for session ${opts.voiceChatSessionId} role=${opts.body.role}`,
    );
  }
}
