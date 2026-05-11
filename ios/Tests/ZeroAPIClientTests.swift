import Foundation
import XCTest
@testable import Zero

final class ZeroAPIClientTests: XCTestCase {
    func testCreateSessionAddsFreshBearerTokenAndJSONBody() async throws {
        let session = CapturingURLSession(
            data: """
            {
              "session": {
                "id": "00000000-0000-0000-0000-000000000001",
                "orgId": "org_1",
                "userId": "user_1",
                "agentId": "00000000-0000-0000-0000-000000000002",
                "mode": "chat",
                "conversationSummary": null,
                "workingTasksSummary": null,
                "finishedTasksSummary": null,
                "summarySeq": 0,
                "summaryVersion": 0,
                "lastSummaryAt": null,
                "createdAt": "2026-05-11T00:00:00.000Z"
              },
              "recentTaskLogs": "",
              "finishedTasksFullText": "",
              "talkerInstructions": "talk",
              "talkerInstructionTokens": 1
            }
            """.data(using: .utf8)!
        )
        let client = ZeroAPIClient(
            baseURL: URL(string: "https://api.test")!,
            authTokenProvider: StaticAuthProvider(token: "clerk-session"),
            urlSession: session
        )

        let response = try await client.createSession(
            agentId: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        )

        XCTAssertEqual(response.talkerInstructions, "talk")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://api.test/api/zero/voice-chat"
        )
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer clerk-session"
        )
        let body = try XCTUnwrap(request.httpBody)
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: String]
        XCTAssertEqual(
            decoded?["agentId"],
            "00000000-0000-0000-0000-000000000002"
        )
    }

    func testThrowsAPIErrorBody() async throws {
        let session = CapturingURLSession(
            statusCode: 403,
            data: """
            {
              "error": {
                "message": "Voice chat is not enabled",
                "code": "FORBIDDEN"
              }
            }
            """.data(using: .utf8)!
        )
        let client = ZeroAPIClient(
            baseURL: URL(string: "https://api.test")!,
            authTokenProvider: StaticAuthProvider(token: "clerk-session"),
            urlSession: session
        )

        do {
            _ = try await client.listTasks(
                sessionId: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
            )
            XCTFail("Expected API error")
        } catch let error as ZeroAPIError {
            XCTAssertEqual(error.statusCode, 403)
            XCTAssertEqual(error.code, "FORBIDDEN")
            XCTAssertEqual(error.message, "Voice chat is not enabled")
        }
    }
}

private struct StaticAuthProvider: AuthTokenProvider {
    let token: String

    func bearerToken() async throws -> String {
        token
    }
}

private final class CapturingURLSession: URLSessioning, @unchecked Sendable {
    private let statusCode: Int
    private let data: Data
    private(set) var requests: [URLRequest] = []

    init(statusCode: Int = 200, data: Data) {
        self.statusCode = statusCode
        self.data = data
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: nil
        )!
        return (data, response)
    }
}
