import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct DesktopRecorderDeliveryError: Error, Equatable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

/// Port of `deliverRecording`: prepare, presigned PUT and complete for the
/// video and the click track, then the review link.
public struct RecorderDelivery: Sendable {
    public static let videoContentType = "video/mp4"
    public static let clickTrackContentType = "application/json"

    public let apiBaseUrl: String
    public let appUrl: String
    public let userId: String
    /// Session-authenticated fetch against the Okou API.
    public let fetchWithSessionAuth: @Sendable (URL, String, [String: String], Data?) async throws -> DesktopHTTPResponse
    /// Unauthenticated fetch for the presigned PUT; session cookies must not
    /// reach storage.
    public let fetchUpload: @Sendable (URLRequest) async throws -> DesktopHTTPResponse
    public let readFile: @Sendable (String) throws -> Data

    public init(
        apiBaseUrl: String, appUrl: String, userId: String,
        fetchWithSessionAuth: @escaping @Sendable (URL, String, [String: String], Data?) async throws -> DesktopHTTPResponse,
        fetchUpload: @escaping @Sendable (URLRequest) async throws -> DesktopHTTPResponse,
        readFile: @escaping @Sendable (String) throws -> Data = { try Data(contentsOf: URL(fileURLWithPath: $0)) }
    ) {
        self.apiBaseUrl = apiBaseUrl
        self.appUrl = appUrl
        self.userId = userId
        self.fetchWithSessionAuth = fetchWithSessionAuth
        self.fetchUpload = fetchUpload
        self.readFile = readFile
    }

    struct PreparedUpload {
        let id: String
        let uploadUrl: String
        let uploadHeaders: [String: String]
    }

    struct UploadedFile {
        let id: String
        let name: String
        let size: Int
    }

    static func failureMessage(_ response: DesktopHTTPResponse, action: String) -> String {
        let detail = String(response.text.prefix(200))
        return "\(action) failed with \(response.status)" + (detail.isEmpty ? "" : ": \(detail)")
    }

    private func prepareUpload(name: String, contentType: String, size: Int) async throws -> PreparedUpload {
        let body = JSONValue.object(["filename": .string(name), "contentType": .string(contentType), "size": .number(Double(size))])
        let response = try await fetchWithSessionAuth(
            URL(string: apiBaseUrl + "/api/uploads/prepare")!, "POST", ["content-type": "application/json"], body.serializedData()
        )
        guard response.ok else {
            throw DesktopRecorderDeliveryError(Self.failureMessage(response, action: "Preparing the upload of \(name)"))
        }
        let json = try response.json()
        guard let id = json["id"]?.stringValue else {
            throw DesktopRecorderDeliveryError("Preparing the upload of \(name) returned no upload id")
        }
        guard let uploadUrl = json["uploadUrl"]?.stringValue else {
            throw DesktopRecorderDeliveryError("Preparing the upload of \(name) returned no direct upload URL")
        }
        var headers: [String: String] = [:]
        for (key, value) in json["uploadHeaders"]?.objectValue ?? [:] {
            if let string = value.stringValue {
                headers[key] = string
            }
        }
        return PreparedUpload(id: id, uploadUrl: uploadUrl, uploadHeaders: headers)
    }

    private func uploadFile(path: String, contentType: String) async throws -> UploadedFile {
        let name = (path as NSString).lastPathComponent
        let data = try readFile(path)
        let prepared = try await prepareUpload(name: name, contentType: contentType, size: data.count)
        guard let uploadUrl = URL(string: prepared.uploadUrl) else {
            throw DesktopRecorderDeliveryError("Uploading \(name) failed: invalid upload URL")
        }
        let putResponse = try await fetchUpload(URLRequest.desktop(url: uploadUrl, method: "PUT", headers: prepared.uploadHeaders, body: data))
        guard putResponse.ok else {
            throw DesktopRecorderDeliveryError(Self.failureMessage(putResponse, action: "Uploading \(name)"))
        }
        let completeBody = JSONValue.object(["id": .string(prepared.id), "contentType": .string(contentType)])
        let completeResponse = try await fetchWithSessionAuth(
            URL(string: apiBaseUrl + "/api/uploads/complete")!, "POST", ["content-type": "application/json"], completeBody.serializedData()
        )
        guard completeResponse.ok else {
            throw DesktopRecorderDeliveryError(Self.failureMessage(completeResponse, action: "Completing the upload of \(name)"))
        }
        return UploadedFile(id: prepared.id, name: name, size: data.count)
    }

    public func deliver(_ recording: DesktopRecorderRecording) async throws -> DeliveredRecording {
        let video = try await uploadFile(path: recording.videoPath, contentType: Self.videoContentType)
        let clicks = try await uploadFile(path: recording.clickTrackPath, contentType: Self.clickTrackContentType)
        guard let appUrl = URL(string: appUrl) else {
            throw DesktopRecorderDeliveryError("Review URL base is invalid: \(self.appUrl)")
        }
        let reviewUrl = DesktopURL.resolve(
            path: "/",
            query: [
                ("intro-video-recording", video.id),
                ("intro-video-recording-name", video.name),
                ("intro-video-recording-size", String(video.size)),
                ("intro-video-clicks", clicks.id),
                ("intro-video-clicks-name", clicks.name),
                ("intro-video-clicks-size", String(clicks.size)),
                ("intro-video-user", userId),
            ],
            against: appUrl
        )
        return DeliveredRecording(videoUploadId: video.id, clickTrackUploadId: clicks.id, reviewUrl: reviewUrl)
    }
}

/// Port of the `RecorderHelperClient` response validators.
public enum RecorderHelperResults {
    public static let requestTimeoutMs: Double = 15_000
    /// `recorder.stop` drains and finalizes the movie, well past the ordinary budget.
    public static let stopTimeoutMs: Double = 60_000

    public static func error(_ message: String) -> DesktopRecorderError {
        DesktopRecorderError(code: .captureFailed, message: message)
    }

    public static func requiredString(_ result: [String: JSONValue], _ key: String) throws -> String {
        guard let value = result[key]?.stringValue, !value.isEmpty else {
            throw error("Screen recorder helper returned an invalid \(key)")
        }
        return value
    }

    public static func requiredNumber(_ result: [String: JSONValue], _ key: String) throws -> Double {
        guard let value = result[key]?.doubleValue, value.isFinite else {
            throw error("Screen recorder helper returned an invalid \(key)")
        }
        return value
    }

    public static func requiredBoolean(_ result: [String: JSONValue], _ key: String) throws -> Bool {
        guard let value = result[key]?.boolValue else {
            throw error("Screen recorder helper returned an invalid \(key)")
        }
        return value
    }

    static func optionalString(_ result: [String: JSONValue], _ key: String) -> String? {
        guard let value = result[key]?.stringValue, !value.isEmpty else { return nil }
        return value
    }

    public static func capabilities(_ result: [String: JSONValue]) throws -> DesktopRecorderCapabilities {
        DesktopRecorderCapabilities(supportsMicrophone: try requiredBoolean(result, "supportsMicrophone"))
    }

    public static func sources(_ result: [String: JSONValue]) throws -> [DesktopRecorderSource] {
        guard let entries = result["sources"]?.arrayValue else {
            throw error("Screen recorder helper returned invalid sources")
        }
        return try entries.map { entry in
            guard let object = entry.objectValue else { throw error("Screen recorder helper returned an invalid source") }
            guard let kind = DesktopRecorderSourceKind(rawValue: object["kind"]?.stringValue ?? "") else {
                throw error("Screen recorder helper returned an invalid source kind")
            }
            return DesktopRecorderSource(
                id: try requiredString(object, "id"), kind: kind, title: try requiredString(object, "title"),
                appName: optionalString(object, "appName"), bundleId: optionalString(object, "bundleId")
            )
        }
    }

    public static func previews(_ result: [String: JSONValue]) throws -> [DesktopRecorderWindowPreview] {
        guard let entries = result["previews"]?.arrayValue else {
            throw error("Screen recorder helper returned invalid previews")
        }
        return try entries.map { entry in
            guard let object = entry.objectValue else { throw error("Screen recorder helper returned an invalid preview") }
            return DesktopRecorderWindowPreview(id: try requiredString(object, "id"), previewDataUrl: try requiredString(object, "previewDataUrl"))
        }
    }

    public static func prepareResult(_ result: [String: JSONValue]) throws -> DesktopRecorderPrepareResult {
        guard let geometry = result["geometry"]?.objectValue else {
            throw error("Screen recorder helper returned an invalid geometry")
        }
        return DesktopRecorderPrepareResult(
            sessionId: try requiredString(result, "sessionId"),
            geometry: DesktopRecorderCaptureGeometry(
                originX: try requiredNumber(geometry, "originX"), originY: try requiredNumber(geometry, "originY"),
                widthPoints: try requiredNumber(geometry, "widthPoints"), heightPoints: try requiredNumber(geometry, "heightPoints"),
                scale: try requiredNumber(geometry, "scale")
            ),
            width: try requiredNumber(result, "width"), height: try requiredNumber(result, "height")
        )
    }

    public static func failure(_ value: JSONValue?) -> DesktopRecorderError? {
        guard let object = value?.objectValue else { return nil }
        return DesktopRecorderError(
            code: DesktopRecorderErrorCode.fromHelper(object["code"]?.stringValue),
            message: object["message"]?.stringValue ?? "Screen recording failed"
        )
    }

    public static func recording(_ result: [String: JSONValue]) throws -> DesktopRecorderRecording {
        DesktopRecorderRecording(
            videoPath: try requiredString(result, "videoPath"), clickTrackPath: try requiredString(result, "clickTrackPath"),
            durationMs: try requiredNumber(result, "durationMs"), sizeBytes: try requiredNumber(result, "sizeBytes"),
            width: try requiredNumber(result, "width"), height: try requiredNumber(result, "height"),
            failure: failure(result["failure"])
        )
    }

    public static func status(_ result: [String: JSONValue]) throws -> DesktopRecorderNativeStatus {
        guard let status = DesktopRecorderNativeStatusKind(rawValue: result["status"]?.stringValue ?? "") else {
            throw error("Screen recorder helper returned an invalid status")
        }
        return DesktopRecorderNativeStatus(status: status, elapsedMs: try requiredNumber(result, "elapsedMs"), error: failure(result["error"]))
    }

    /// One stdout line as a correlated response frame, or nil when it is not one.
    public static func parseResponseLine(_ line: String) -> (id: String, value: JSONValue)? {
        guard let parsed = try? JSONValue.parse(line), let id = parsed["id"]?.stringValue else { return nil }
        return (id, parsed)
    }

    public static func responseResult(_ value: JSONValue) throws -> [String: JSONValue] {
        if value["status"]?.stringValue == "succeeded" {
            return value["result"]?.objectValue ?? [:]
        }
        let error = value["error"]
        throw DesktopRecorderError(
            code: DesktopRecorderErrorCode.fromHelper(error?["code"]?.stringValue),
            message: error?["message"]?.stringValue ?? "Screen recording failed"
        )
    }

    public static func prepareRequestPayload(_ request: DesktopRecorderPrepareRequest) -> [String: JSONValue] {
        var payload: [String: JSONValue] = [
            "sourceId": .string(request.sourceId), "sourceKind": .string(request.sourceKind.rawValue),
            "systemAudio": .bool(request.systemAudio), "microphone": .bool(request.microphone),
        ]
        if let area = request.area {
            payload["area"] = area.json
        }
        return payload
    }
}
