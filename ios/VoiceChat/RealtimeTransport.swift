import Foundation

protocol RealtimeTransportDelegate: AnyObject {
    func realtimeTransportDidOpen(_ transport: RealtimeTransport)
    func realtimeTransportDidClose(_ transport: RealtimeTransport)
    func realtimeTransport(_ transport: RealtimeTransport, didReceive text: String)
    func realtimeTransport(_ transport: RealtimeTransport, didFail error: Error)
}

protocol RealtimeTransport: AnyObject {
    var delegate: RealtimeTransportDelegate? { get set }

    func connect(clientSecret: String) async throws
    func send(jsonString: String) throws
    func setMicrophoneMuted(_ muted: Bool)
    func close()
}

enum RealtimeTransportError: LocalizedError, Equatable {
    case missingLocalDescription
    case invalidServerResponse
    case dataChannelNotOpen
    case sdpExchangeFailed(Int)

    var errorDescription: String? {
        switch self {
        case .missingLocalDescription:
            return "Failed to create a local WebRTC offer."
        case .invalidServerResponse:
            return "OpenAI Realtime returned an invalid response."
        case .dataChannelNotOpen:
            return "Realtime data channel is not open."
        case .sdpExchangeFailed(let statusCode):
            return "OpenAI Realtime SDP exchange failed with status \(statusCode)."
        }
    }
}

struct RealtimeClientEvents {
    struct SessionUpdate: Encodable {
        struct Session: Encodable {
            let instructions: String
        }

        let type = "session.update"
        let session: Session
    }

    struct FunctionOutput: Encodable {
        struct Item: Encodable {
            let type = "function_call_output"
            let callId: String
            let output: String

            enum CodingKeys: String, CodingKey {
                case type
                case callId = "call_id"
                case output
            }
        }

        let type = "conversation.item.create"
        let item: Item
    }

    struct TruncateAssistantAudio: Encodable {
        let type = "conversation.item.truncate"
        let itemId: String
        let contentIndex: Int
        let audioEndMs: Int

        enum CodingKeys: String, CodingKey {
            case type
            case itemId = "item_id"
            case contentIndex = "content_index"
            case audioEndMs = "audio_end_ms"
        }
    }

    static func encode<Event: Encodable>(_ event: Event) throws -> String {
        let encoder = JSONEncoder()
        let data = try encoder.encode(event)
        return String(decoding: data, as: UTF8.self)
    }
}
