import Foundation

protocol URLSessioning: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: URLSessioning {}

struct ZeroAPIError: LocalizedError, Equatable {
    let statusCode: Int
    let code: String?
    let message: String

    var errorDescription: String? {
        message
    }
}

final class ZeroAPIClient: @unchecked Sendable {
    private let baseURL: URL
    private let authTokenProvider: AuthTokenProvider
    private let urlSession: URLSessioning
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(
        baseURL: URL,
        authTokenProvider: AuthTokenProvider,
        urlSession: URLSessioning = URLSession.shared
    ) {
        self.baseURL = baseURL
        self.authTokenProvider = authTokenProvider
        self.urlSession = urlSession
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    func createSession(agentId: UUID) async throws
        -> CreateVoiceChatSessionResponse
    {
        try await send(
            method: "POST",
            path: "/api/zero/voice-chat",
            body: CreateVoiceChatSessionRequest(agentId: agentId)
        )
    }

    func getSession(id: UUID) async throws -> GetVoiceChatSessionResponse {
        try await send(
            method: "GET",
            path: "/api/zero/voice-chat/\(id.uuidString)",
            body: EmptyBody?.none
        )
    }

    func mintRealtimeToken(
        sessionId: UUID,
        noiseReduction: NoiseReduction?
    ) async throws -> VoiceChatTokenResponse {
        try await send(
            method: "POST",
            path: "/api/zero/voice-chat/token",
            body: VoiceChatTokenRequest(
                sessionId: sessionId,
                noiseReduction: noiseReduction
            )
        )
    }

    func appendItem(
        sessionId: UUID,
        role: VoiceChatItemRole,
        content: String,
        realtimeItemId: String
    ) async throws {
        try await sendDiscardingResponse(
            method: "POST",
            path: "/api/zero/voice-chat/\(sessionId.uuidString)/items",
            body: AppendVoiceChatItemRequest(
                role: role,
                content: content,
                realtimeItemId: realtimeItemId
            )
        )
    }

    func createTask(
        sessionId: UUID,
        prompt: String,
        callId: String
    ) async throws -> VoiceChatTask {
        let response: CreateVoiceChatTaskResponse = try await send(
            method: "POST",
            path: "/api/zero/voice-chat/\(sessionId.uuidString)/tasks",
            body: CreateVoiceChatTaskRequest(prompt: prompt, callId: callId)
        )
        return response.task
    }

    func listTasks(sessionId: UUID) async throws -> [VoiceChatTask] {
        let response: VoiceChatTaskListResponse = try await send(
            method: "GET",
            path: "/api/zero/voice-chat/\(sessionId.uuidString)/tasks",
            body: EmptyBody?.none
        )
        return response.tasks
    }

    func sessionStarted(sessionId: UUID) async throws
        -> VoiceChatSessionStartedResponse
    {
        try await send(
            method: "POST",
            path: "/api/zero/voice-chat/\(sessionId.uuidString)/session-started",
            body: EmptyBody()
        )
    }

    func sessionEnded(sessionId: UUID, relaySessionId: UUID) async throws {
        let _: VoiceChatOKResponse = try await send(
            method: "POST",
            path: "/api/zero/voice-chat/\(sessionId.uuidString)/session-ended",
            body: VoiceChatSessionEndedRequest(relaySessionId: relaySessionId)
        )
    }

    func postUsageEvent(
        sessionId: UUID,
        event: VoiceChatUsageEvent
    ) async throws -> VoiceChatUsageEventResponse {
        try await send(
            method: "POST",
            path: "/api/zero/voice-chat/\(sessionId.uuidString)/usage",
            body: event
        )
    }

    private func send<RequestBody: Encodable, ResponseBody: Decodable>(
        method: String,
        path: String,
        body: RequestBody?
    ) async throws -> ResponseBody {
        let request = try await makeRequest(method: method, path: path, body: body)
        let (data, response) = try await urlSession.data(for: request)
        try validate(response: response, data: data)
        return try decoder.decode(ResponseBody.self, from: data)
    }

    private func sendDiscardingResponse<RequestBody: Encodable>(
        method: String,
        path: String,
        body: RequestBody?
    ) async throws {
        let request = try await makeRequest(method: method, path: path, body: body)
        let (data, response) = try await urlSession.data(for: request)
        try validate(response: response, data: data)
    }

    private func makeRequest<RequestBody: Encodable>(
        method: String,
        path: String,
        body: RequestBody?
    ) async throws -> URLRequest {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        let token = try await authTokenProvider.bearerToken()
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            "Bearer \(token)",
            forHTTPHeaderField: "Authorization"
        )
        if let body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ZeroAPIError(
                statusCode: 0,
                code: nil,
                message: "Invalid response from server"
            )
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let error = try? decoder.decode(APIErrorEnvelope.self, from: data)
            throw ZeroAPIError(
                statusCode: httpResponse.statusCode,
                code: error?.error.code,
                message: error?.error.message
                    ?? "Request failed with status \(httpResponse.statusCode)"
            )
        }
    }
}

private struct EmptyBody: Encodable {}
