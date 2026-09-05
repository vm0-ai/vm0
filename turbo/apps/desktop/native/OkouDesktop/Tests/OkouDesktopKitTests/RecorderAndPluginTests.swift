import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

@testable import OkouDesktopKit

final class FakeRecorderBackend: RecorderNativeBackend, @unchecked Sendable {
    var statuses: [DesktopRecorderNativeStatus] = []
    var stopResult: Result<DesktopRecorderRecording, Error> = .success(
        DesktopRecorderRecording(videoPath: "/tmp/v.mp4", clickTrackPath: "/tmp/v.clicks.json", durationMs: 1000, sizeBytes: 10, width: 2, height: 2, failure: nil)
    )
    var permissionGranted = true
    var disposed = false
    var calls: [String] = []

    func dispose() { disposed = true }
    func getCapabilities() async throws -> DesktopRecorderCapabilities { DesktopRecorderCapabilities(supportsMicrophone: true) }
    func requestScreenRecordingPermission() async throws -> Bool { permissionGranted }
    func listSources() async throws -> [DesktopRecorderSource] { [] }
    func listWindowPreviews() async throws -> [DesktopRecorderWindowPreview] { [] }
    func prepare(_ request: DesktopRecorderPrepareRequest) async throws -> DesktopRecorderPrepareResult {
        calls.append("prepare")
        return DesktopRecorderPrepareResult(sessionId: "s1", geometry: DesktopRecorderCaptureGeometry(originX: 0, originY: 0, widthPoints: 1, heightPoints: 1, scale: 2), width: 2, height: 2)
    }
    func start(sessionId: String, outputPath: String) async throws { calls.append("start:\(outputPath)") }
    func pause(sessionId: String) async throws { calls.append("pause") }
    func resume(sessionId: String) async throws { calls.append("resume") }
    func discard(sessionId: String) async throws { calls.append("discard") }
    func stop(sessionId: String) async throws -> DesktopRecorderRecording { calls.append("stop"); return try stopResult.get() }
    func getStatus(sessionId: String) async throws -> DesktopRecorderNativeStatus {
        statuses.isEmpty ? DesktopRecorderNativeStatus(status: .recording, elapsedMs: 500, error: nil) : statuses.removeFirst()
    }
}

@MainActor
final class RecorderAndPluginTests: XCTestCase {
    func testRecorderSessionLifecycleAndDelivery() async throws {
        let backend = FakeRecorderBackend()
        var opened: [String] = []
        var deliveries = 0
        let controller = DesktopRecorderController(
            createBackend: { backend }, createOutputPath: { "/tmp/out.mp4" }, canDeliver: { true },
            deliver: { _ in deliveries += 1; return DeliveredRecording(videoUploadId: "v", clickTrackUploadId: "c", reviewUrl: "https://app.okou.ai/?x") },
            openReview: { opened.append($0) }
        )
        XCTAssertEqual(controller.state, .unavailable)
        controller.setFeatureEnabled(true)
        XCTAssertEqual(controller.state.status, .idle)
        try await controller.prepare(DesktopRecorderPrepareRequest(sourceId: "display:1", sourceKind: .display, systemAudio: true, microphone: false, area: nil))
        XCTAssertEqual(controller.state.status, .ready)
        try await controller.start()
        XCTAssertEqual(controller.state.status, .recording)
        try await controller.refreshRecordingStatus()
        XCTAssertEqual(controller.state.elapsedMs, 500)
        try await controller.pause()
        XCTAssertEqual(controller.state.status, .paused)
        try await controller.resume()
        try await controller.stop()
        XCTAssertEqual(controller.state.status, .idle)
        XCTAssertEqual(deliveries, 1)
        XCTAssertEqual(opened, ["https://app.okou.ai/?x"])
        XCTAssertEqual(backend.calls, ["prepare", "start:/tmp/out.mp4", "pause", "resume", "stop"])

        // External stop with a failed capture keeps the file for retry.
        try await controller.prepare(DesktopRecorderPrepareRequest(sourceId: "display:1", sourceKind: .display, systemAudio: true, microphone: false, area: nil))
        try await controller.start()
        backend.statuses = [DesktopRecorderNativeStatus(status: .failed, elapsedMs: 900, error: DesktopRecorderError(code: .sourceLost, message: "gone"))]
        try await controller.refreshRecordingStatus()
        XCTAssertEqual(controller.state.status, .idle)
        XCTAssertEqual(controller.state.error?.code, .sourceLost)
        XCTAssertNotNil(controller.state.lastRecording)
        XCTAssertEqual(deliveries, 1)
        try await controller.retryDelivery()
        XCTAssertEqual(deliveries, 2)
        XCTAssertNil(controller.state.error)
    }

    func testRecorderSignedOutAndDeniedPermission() async throws {
        let backend = FakeRecorderBackend()
        let controller = DesktopRecorderController(
            createBackend: { backend }, createOutputPath: { "/tmp/out.mp4" }, canDeliver: { false },
            deliver: { _ in DeliveredRecording(videoUploadId: "", clickTrackUploadId: "", reviewUrl: "") }, openReview: { _ in }
        )
        controller.setFeatureEnabled(true)
        do {
            try await controller.prepare(DesktopRecorderPrepareRequest(sourceId: "display:1", sourceKind: .display, systemAudio: true, microphone: false, area: nil))
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(String(describing: error), "Cannot record while signed out of Okou")
        }
        XCTAssertEqual(controller.state.error?.code, .signedOut)
        XCTAssertEqual(controller.state.status, .idle)
        backend.permissionGranted = false
        do {
            try await controller.ensureScreenRecordingPermission()
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(String(describing: error), "Okou needs Screen Recording permission in System Settings")
        }
        controller.setFeatureEnabled(false)
        XCTAssertEqual(controller.state, .unavailable)
    }

    func testDeliveryUploadsBothFilesAndBuildsReviewUrl() async throws {
        var calls: [(String, String, JSONValue?)] = []
        var uploads: [(String, Int)] = []
        let delivery = RecorderDelivery(
            apiBaseUrl: "https://api.vm0.ai", appUrl: "https://app.okou.ai", userId: "user-1",
            fetchWithSessionAuth: { url, method, _, body in
                let json = body.flatMap { try? JSONValue.parse($0) }
                calls.append((url.path, method, json))
                if url.path == "/api/uploads/prepare" {
                    let name = json?["filename"]?.stringValue ?? ""
                    return DesktopHTTPResponse(status: 200, body: Data(#"{"id":"up-\#(name)","uploadUrl":"https://r2.example/\#(name)","uploadHeaders":{"content-type":"x"}}"#.utf8))
                }
                return DesktopHTTPResponse(status: 200)
            },
            fetchUpload: { request in
                uploads.append((request.url!.absoluteString, request.httpBody?.count ?? -1))
                XCTAssertEqual(request.httpMethod, "PUT")
                XCTAssertNil(request.value(forHTTPHeaderField: "cookie"))
                return DesktopHTTPResponse(status: 200)
            },
            readFile: { path in Data(path.utf8) }
        )
        let delivered = try await delivery.deliver(DesktopRecorderRecording(
            videoPath: "/tmp/screen-recording-1.mp4", clickTrackPath: "/tmp/screen-recording-1.clicks.json",
            durationMs: 1, sizeBytes: 1, width: 1, height: 1, failure: nil
        ))
        XCTAssertEqual(uploads.map(\.0), ["https://r2.example/screen-recording-1.mp4", "https://r2.example/screen-recording-1.clicks.json"])
        XCTAssertEqual(calls.map(\.0), ["/api/uploads/prepare", "/api/uploads/complete", "/api/uploads/prepare", "/api/uploads/complete"])
        XCTAssertEqual(calls[0].2?["contentType"]?.stringValue, "video/mp4")
        XCTAssertEqual(calls[1].2, ["id": "up-screen-recording-1.mp4", "contentType": "video/mp4"])
        XCTAssertEqual(
            delivered.reviewUrl,
            "https://app.okou.ai/?intro-video-recording=up-screen-recording-1.mp4&intro-video-recording-name=screen-recording-1.mp4&intro-video-recording-size=27&intro-video-clicks=up-screen-recording-1.clicks.json&intro-video-clicks-name=screen-recording-1.clicks.json&intro-video-clicks-size=35&intro-video-user=user-1"
        )
    }

    func testDeliveryFailureMessages() async {
        let delivery = RecorderDelivery(
            apiBaseUrl: "https://api.vm0.ai", appUrl: "https://app.okou.ai", userId: "u",
            fetchWithSessionAuth: { _, _, _, _ in DesktopHTTPResponse(status: 500, body: Data(String(repeating: "x", count: 300).utf8)) },
            fetchUpload: { _ in DesktopHTTPResponse(status: 200) },
            readFile: { _ in Data() }
        )
        do {
            _ = try await delivery.deliver(DesktopRecorderRecording(videoPath: "/tmp/a.mp4", clickTrackPath: "/tmp/a.json", durationMs: 0, sizeBytes: 0, width: 0, height: 0, failure: nil))
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(String(describing: error), "Preparing the upload of a.mp4 failed with 500: " + String(repeating: "x", count: 200))
        }
    }

    func testPluginToolResultNormalization() {
        let context = PluginToolResultContext(plugin: "filesystem", tool: "read_text_file")
        let inline = PluginToolResults.normalize(context, result: McpCallToolResult(content: [.text("hello"), .text("world")], isError: false))
        XCTAssertEqual(inline.result?["content"]?.stringValue, "hello\nworld")
        XCTAssertEqual(inline.result?["sizeBytes"]?.intValue, 11)
        XCTAssertEqual(inline.result?["truncated"]?.boolValue, false)
        XCTAssertEqual(inline.result?["plugin"]?.stringValue, "filesystem")

        let large = PluginToolResults.normalize(context, result: McpCallToolResult(content: [.text(String(repeating: "a", count: 70_000))], isError: false))
        XCTAssertEqual(large.result?["offloaded"]?.boolValue, true)
        XCTAssertEqual(large.result?["summary"]?.stringValue, "Saved 70000 bytes")
        XCTAssertEqual(large.result?["pluginContent"]?["fileName"]?.stringValue, "read_text_file.txt")
        XCTAssertEqual(large.result?["pluginContent"]?["mimeType"]?.stringValue, "text/plain; charset=utf-8")

        let errored = PluginToolResults.normalize(
            PluginToolResultContext(plugin: "filesystem", tool: "write_file", mapErrorCode: { $0.contains("outside") ? .pathDenied : .mcpError }),
            result: McpCallToolResult(content: [.text("Path is outside allowed directory")], isError: true)
        )
        XCTAssertEqual(errored.failure, ComputerUseCommandFailure(code: .pathDenied, message: "Path is outside allowed directory"))

        let image = PluginToolResults.normalize(
            PluginToolResultContext(plugin: "mcp", tool: "shot", server: "figma"),
            result: McpCallToolResult(content: [.text("x"), .image(data: Data([1, 2, 3]).base64EncodedString(), mimeType: "image/png")], isError: false)
        )
        XCTAssertEqual(image.result?["server"]?.stringValue, "figma")
        XCTAssertEqual(image.result?["sizeBytes"]?.intValue, 3)
        XCTAssertEqual(image.result?["pluginContent"]?["fileName"]?.stringValue, "plugin-result.txt")

        let resource = PluginToolResults.normalize(
            context, result: McpCallToolResult(content: [.resource(uri: "file:///a/b/report.md", mimeType: nil, text: "# hi", blob: nil), .text("t")], isError: false)
        )
        XCTAssertEqual(resource.result?["pluginContent"]?["fileName"]?.stringValue, "report.md")
        XCTAssertEqual(resource.result?["pluginContent"]?["mimeType"]?.stringValue, "text/plain; charset=utf-8")

        let tooLarge = PluginToolResults.contentResult(context, dataBase64: "", mimeType: "x", fileName: "f", sizeBytes: 11 * 1024 * 1024)
        XCTAssertEqual(tooLarge.failure?.code, .resultTooLarge)
        XCTAssertEqual(tooLarge.failure?.message, "Plugin result is 11534336 bytes and exceeds the 10485760 byte limit.")

        let empty = PluginToolResults.normalize(context, result: McpCallToolResult(content: [], isError: true))
        XCTAssertEqual(empty.failure?.message, "Plugin tool read_text_file failed")
    }

    func testRecorderHelperResultValidation() throws {
        let stop = try RecorderHelperResults.recording([
            "videoPath": "/v.mp4", "clickTrackPath": "/v.clicks.json", "durationMs": 1200, "sizeBytes": 5, "width": 1920, "height": 1080,
            "failure": ["code": "weird", "message": "m"],
        ])
        XCTAssertEqual(stop.failure, DesktopRecorderError(code: .captureFailed, message: "m"))
        XCTAssertThrowsError(try RecorderHelperResults.recording(["videoPath": "/v.mp4"]))
        XCTAssertNil(RecorderHelperResults.parseResponseLine("not json"))
        XCTAssertNil(RecorderHelperResults.parseResponseLine(#"{"status":"succeeded"}"#))
        let frame = RecorderHelperResults.parseResponseLine(#"{"id":"recorder_1","status":"failed","error":{"code":"permission_denied","message":"no"}}"#)
        XCTAssertEqual(frame?.id, "recorder_1")
        XCTAssertThrowsError(try RecorderHelperResults.responseResult(frame!.value)) { error in
            XCTAssertEqual(error as? DesktopRecorderError, DesktopRecorderError(code: .permissionDenied, message: "no"))
        }
        let status = try RecorderHelperResults.status(["status": "stopped", "elapsedMs": 10])
        XCTAssertEqual(status.status, .stopped)
    }
}
