import Foundation

enum RealtimeEventAction: Equatable {
    case assistantMessageStarted(itemId: String)
    case assistantTranscriptDelta(String)
    case assistantTranscriptDone(itemId: String, transcript: String)
    case functionCall(name: String, callId: String, arguments: String)
    case responseDone(VoiceChatUsageEvent)
    case speechStarted
    case userTranscriptCompleted(
        itemId: String,
        transcript: String,
        usage: VoiceChatUsageEvent?
    )
}

struct RealtimeEventParser {
    private let decoder = JSONDecoder()

    func parse(_ text: String) throws -> RealtimeEventAction? {
        guard let data = text.data(using: .utf8) else {
            return nil
        }
        return try parse(data)
    }

    func parse(_ data: Data) throws -> RealtimeEventAction? {
        let event = try decoder.decode(RealtimeServerEvent.self, from: data)
        switch event.type {
        case "conversation.item.created":
            guard
                event.item?.type == "message",
                event.item?.role == "assistant",
                let itemId = event.item?.id
            else {
                return nil
            }
            return .assistantMessageStarted(itemId: itemId)

        case "conversation.item.input_audio_transcription.completed":
            guard let itemId = event.itemId else {
                return nil
            }
            return .userTranscriptCompleted(
                itemId: itemId,
                transcript: event.transcript ?? "",
                usage: extractTranscriptionUsage(event)
            )

        case "response.audio_transcript.delta":
            guard let delta = event.delta, !delta.isEmpty else {
                return nil
            }
            return .assistantTranscriptDelta(delta)

        case "response.audio_transcript.done":
            guard let itemId = event.itemId ?? event.responseId else {
                return nil
            }
            return .assistantTranscriptDone(
                itemId: itemId,
                transcript: event.transcript ?? ""
            )

        case "input_audio_buffer.speech_started":
            return .speechStarted

        case "response.function_call_arguments.done":
            guard
                let name = event.name,
                let callId = event.callId,
                let arguments = event.arguments
            else {
                return nil
            }
            return .functionCall(
                name: name,
                callId: callId,
                arguments: arguments
            )

        case "response.done":
            guard let usage = extractResponseDoneUsage(event) else {
                return nil
            }
            return .responseDone(usage)

        default:
            return nil
        }
    }

    private func extractResponseDoneUsage(
        _ event: RealtimeServerEvent
    ) -> VoiceChatUsageEvent? {
        guard let usage = event.response?.usage else {
            return nil
        }
        return VoiceChatUsageEvent(
            providerEventId: deriveProviderEventId(
                event,
                fallbackPrefix: "response.done"
            ),
            eventType: .responseDone,
            inputTextTokens: usage.inputTokenDetails?.textTokens,
            inputAudioTokens: usage.inputTokenDetails?.audioTokens,
            inputCachedTextTokens:
                usage.inputTokenDetails?.cachedTokensDetails?.textTokens,
            inputCachedAudioTokens:
                usage.inputTokenDetails?.cachedTokensDetails?.audioTokens,
            outputTextTokens: usage.outputTokenDetails?.textTokens,
            outputAudioTokens: usage.outputTokenDetails?.audioTokens
        )
    }

    private func extractTranscriptionUsage(
        _ event: RealtimeServerEvent
    ) -> VoiceChatUsageEvent? {
        guard let usage = event.usage, usage.type == "tokens" else {
            return nil
        }
        return VoiceChatUsageEvent(
            providerEventId: deriveProviderEventId(
                event,
                fallbackPrefix: "transcription"
            ),
            eventType: .transcriptionCompleted,
            inputTextTokens: usage.inputTokenDetails?.textTokens,
            inputAudioTokens: usage.inputTokenDetails?.audioTokens,
            inputCachedTextTokens: nil,
            inputCachedAudioTokens: nil,
            outputTextTokens: usage.outputTokens,
            outputAudioTokens: nil
        )
    }

    private func deriveProviderEventId(
        _ event: RealtimeServerEvent,
        fallbackPrefix: String
    ) -> String {
        if let eventId = event.eventId {
            return eventId
        }
        if let responseId = event.response?.id {
            return responseId
        }
        if let itemId = event.itemId {
            return "\(itemId):\(event.contentIndex ?? 0)"
        }
        return "\(fallbackPrefix):\(UUID().uuidString)"
    }
}

private struct RealtimeServerEvent: Decodable {
    struct Item: Decodable {
        let id: String
        let type: String
        let role: String?
    }

    struct Response: Decodable {
        let id: String?
        let status: String?
        let usage: RealtimeUsageBreakdown?
    }

    let type: String
    let eventId: String?
    let itemId: String?
    let item: Item?
    let transcript: String?
    let responseId: String?
    let delta: String?
    let callId: String?
    let name: String?
    let arguments: String?
    let contentIndex: Int?
    let response: Response?
    let usage: TranscriptionUsage?

    enum CodingKeys: String, CodingKey {
        case type
        case eventId = "event_id"
        case itemId = "item_id"
        case item
        case transcript
        case responseId = "response_id"
        case delta
        case callId = "call_id"
        case name
        case arguments
        case contentIndex = "content_index"
        case response
        case usage
    }
}

private struct RealtimeUsageBreakdown: Decodable {
    struct InputTokenDetails: Decodable {
        struct CachedTokensDetails: Decodable {
            let textTokens: Int?
            let audioTokens: Int?

            enum CodingKeys: String, CodingKey {
                case textTokens = "text_tokens"
                case audioTokens = "audio_tokens"
            }
        }

        let textTokens: Int?
        let audioTokens: Int?
        let cachedTokens: Int?
        let cachedTokensDetails: CachedTokensDetails?

        enum CodingKeys: String, CodingKey {
            case textTokens = "text_tokens"
            case audioTokens = "audio_tokens"
            case cachedTokens = "cached_tokens"
            case cachedTokensDetails = "cached_tokens_details"
        }
    }

    struct OutputTokenDetails: Decodable {
        let textTokens: Int?
        let audioTokens: Int?

        enum CodingKeys: String, CodingKey {
            case textTokens = "text_tokens"
            case audioTokens = "audio_tokens"
        }
    }

    let totalTokens: Int?
    let inputTokens: Int?
    let outputTokens: Int?
    let inputTokenDetails: InputTokenDetails?
    let outputTokenDetails: OutputTokenDetails?

    enum CodingKeys: String, CodingKey {
        case totalTokens = "total_tokens"
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case inputTokenDetails = "input_token_details"
        case outputTokenDetails = "output_token_details"
    }
}

private struct TranscriptionUsage: Decodable {
    struct InputTokenDetails: Decodable {
        let textTokens: Int?
        let audioTokens: Int?

        enum CodingKeys: String, CodingKey {
            case textTokens = "text_tokens"
            case audioTokens = "audio_tokens"
        }
    }

    let type: String?
    let inputTokens: Int?
    let outputTokens: Int?
    let totalTokens: Int?
    let inputTokenDetails: InputTokenDetails?

    enum CodingKeys: String, CodingKey {
        case type
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case totalTokens = "total_tokens"
        case inputTokenDetails = "input_token_details"
    }
}
