import Foundation

enum NoiseReduction: String, Codable, Equatable {
    case nearField = "near_field"
    case farField = "far_field"
}

enum BargeInMode: Equatable {
    case speechStarted
    case transcriptConfirmed
}

struct VoiceChatAudioConfig: Equatable {
    let noiseReduction: NoiseReduction
    let bargeInMode: BargeInMode
}

enum VoiceChatItemRole: String, Codable, Equatable {
    case user
    case assistant
    case taskResult = "task_result"
    case systemNote = "system_note"
}

enum VoiceChatTaskStatus: String, Codable, Equatable {
    case pending
    case queued
    case running
    case done
    case failed
}

struct VoiceChatSession: Codable, Equatable, Identifiable {
    let id: UUID
    let orgId: String
    let userId: String
    let agentId: UUID?
    let mode: String
    let conversationSummary: String?
    let workingTasksSummary: String?
    let finishedTasksSummary: String?
    let summarySeq: Int
    let summaryVersion: Int
    let lastSummaryAt: String?
    let createdAt: String
}

struct VoiceChatTaskResultEntry: Codable, Equatable {
    let type: String
    let content: String
    let at: String
}

struct VoiceChatTask: Codable, Equatable, Identifiable {
    let id: UUID
    let sessionId: UUID
    let runId: UUID?
    let callId: String
    let prompt: String
    let status: VoiceChatTaskStatus
    let result: String?
    let resultUpdatedAt: String?
    let assistantMessages: [VoiceChatTaskResultEntry]
    let error: String?
    let createdAt: String
    let startedAt: String?
    let finishedAt: String?
}

struct CreateVoiceChatSessionRequest: Encodable, Equatable {
    let agentId: UUID
}

struct CreateVoiceChatSessionResponse: Decodable, Equatable {
    let session: VoiceChatSession
    let recentTaskLogs: String
    let finishedTasksFullText: String
    let talkerInstructions: String
    let talkerInstructionTokens: Int
}

struct GetVoiceChatSessionResponse: Decodable, Equatable {
    let session: VoiceChatSession
    let recentTaskLogs: String
    let finishedTasksFullText: String
    let talkerInstructions: String
    let talkerInstructionTokens: Int
}

struct VoiceChatTokenRequest: Encodable, Equatable {
    let sessionId: UUID
    let noiseReduction: NoiseReduction?
}

struct VoiceChatTokenResponse: Decodable, Equatable {
    struct ClientSecret: Decodable, Equatable {
        let value: String
        let expiresAt: Int

        enum CodingKeys: String, CodingKey {
            case value
            case expiresAt = "expires_at"
        }
    }

    let clientSecret: ClientSecret

    enum CodingKeys: String, CodingKey {
        case clientSecret = "client_secret"
    }
}

struct AppendVoiceChatItemRequest: Encodable, Equatable {
    let role: VoiceChatItemRole
    let content: String
    let realtimeItemId: String
}

struct CreateVoiceChatTaskRequest: Encodable, Equatable {
    let prompt: String
    let callId: String
}

struct CreateVoiceChatTaskResponse: Decodable, Equatable {
    let task: VoiceChatTask
}

struct VoiceChatTaskListResponse: Decodable, Equatable {
    let tasks: [VoiceChatTask]
}

struct VoiceChatSessionStartedResponse: Decodable, Equatable {
    let id: UUID?
}

struct VoiceChatSessionEndedRequest: Encodable, Equatable {
    let relaySessionId: UUID
}

struct VoiceChatOKResponse: Decodable, Equatable {
    let ok: Bool
}

enum VoiceChatUsageEventType: String, Codable, Equatable {
    case responseDone = "response.done"
    case transcriptionCompleted = "transcription.completed"
}

struct VoiceChatUsageEvent: Codable, Equatable {
    let providerEventId: String
    let eventType: VoiceChatUsageEventType
    var inputTextTokens: Int?
    var inputAudioTokens: Int?
    var inputCachedTextTokens: Int?
    var inputCachedAudioTokens: Int?
    var outputTextTokens: Int?
    var outputAudioTokens: Int?
}

struct VoiceChatUsageEventResponse: Decodable, Equatable {
    let creditsExhausted: Bool
}

struct APIErrorEnvelope: Decodable, Equatable {
    struct Body: Decodable, Equatable {
        let message: String
        let code: String?
    }

    let error: Body
}
