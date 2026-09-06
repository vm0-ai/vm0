import Foundation

public enum DesktopRecorderStatus: String, Sendable, Codable {
    case delivering
    case finalizing
    case idle
    case paused
    case preparing
    case ready
    case recording
    case unavailable
}

public enum DesktopRecorderErrorCode: String, Sendable, Codable {
    case captureFailed = "capture_failed"
    case deliveryFailed = "delivery_failed"
    case helperUnavailable = "helper_unavailable"
    case permissionDenied = "permission_denied"
    case signedOut = "signed_out"
    case sourceLost = "source_lost"

    /// Codes the helper is allowed to emit; anything else coerces to `capture_failed`.
    public static func fromHelper(_ raw: String?) -> DesktopRecorderErrorCode {
        switch raw {
        case "capture_failed": return .captureFailed
        case "helper_unavailable": return .helperUnavailable
        case "permission_denied": return .permissionDenied
        case "source_lost": return .sourceLost
        default: return .captureFailed
        }
    }
}

public struct DesktopRecorderError: Error, Equatable, Sendable {
    public var code: DesktopRecorderErrorCode
    public var message: String

    public init(code: DesktopRecorderErrorCode, message: String) {
        self.code = code
        self.message = message
    }
}

public enum DesktopRecorderSourceKind: String, Sendable, Codable {
    case display
    case window
}

public enum DesktopRecorderCaptureKind: String, Sendable, Codable {
    case display
    case window
    case area
}

/// A region in global screen points, top-left origin.
public struct DesktopRecorderArea: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var json: JSONValue {
        .object(["x": .number(x), "y": .number(y), "width": .number(width), "height": .number(height)])
    }
}

public struct DesktopRecorderAudioChoice: Equatable, Sendable {
    public var systemAudio: Bool
    public var microphone: Bool

    public init(systemAudio: Bool, microphone: Bool) {
        self.systemAudio = systemAudio
        self.microphone = microphone
    }
}

public enum DesktopRecorderCaptureTarget: Equatable, Sendable {
    case display
    case window(sourceId: String)
}

public struct DesktopRecorderCaptureRequest: Equatable, Sendable {
    public var target: DesktopRecorderCaptureTarget
    public var audio: DesktopRecorderAudioChoice

    public init(target: DesktopRecorderCaptureTarget, audio: DesktopRecorderAudioChoice) {
        self.target = target
        self.audio = audio
    }
}

public struct DesktopRecorderAreaSelection: Equatable, Sendable {
    public var displayId: UInt32
    public var area: DesktopRecorderArea

    public init(displayId: UInt32, area: DesktopRecorderArea) {
        self.displayId = displayId
        self.area = area
    }
}

public struct DesktopRecorderWindowPreview: Equatable, Sendable {
    public var id: String
    public var previewDataUrl: String

    public init(id: String, previewDataUrl: String) {
        self.id = id
        self.previewDataUrl = previewDataUrl
    }
}

public struct DesktopRecorderWindowOption: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var appName: String
    public var previewDataUrl: String

    public init(id: String, title: String, appName: String, previewDataUrl: String) {
        self.id = id
        self.title = title
        self.appName = appName
        self.previewDataUrl = previewDataUrl
    }
}

public struct DesktopRecorderWindowChoice: Equatable, Sendable {
    public var sourceId: String
    public var title: String

    public init(sourceId: String, title: String) {
        self.sourceId = sourceId
        self.title = title
    }
}

public struct DesktopRecorderCapabilities: Equatable, Sendable {
    public var supportsMicrophone: Bool

    public init(supportsMicrophone: Bool) {
        self.supportsMicrophone = supportsMicrophone
    }
}

public struct DesktopRecorderSource: Equatable, Sendable {
    public var id: String
    public var kind: DesktopRecorderSourceKind
    public var title: String
    public var appName: String?
    public var bundleId: String?

    public init(id: String, kind: DesktopRecorderSourceKind, title: String, appName: String?, bundleId: String?) {
        self.id = id
        self.kind = kind
        self.title = title
        self.appName = appName
        self.bundleId = bundleId
    }
}

public struct DesktopRecorderCaptureGeometry: Equatable, Sendable {
    public var originX: Double
    public var originY: Double
    public var widthPoints: Double
    public var heightPoints: Double
    public var scale: Double

    public init(originX: Double, originY: Double, widthPoints: Double, heightPoints: Double, scale: Double) {
        self.originX = originX
        self.originY = originY
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
        self.scale = scale
    }
}

public struct DesktopRecorderRecording: Equatable, Sendable {
    public var videoPath: String
    public var clickTrackPath: String
    public var durationMs: Double
    public var sizeBytes: Double
    public var width: Double
    public var height: Double
    public var failure: DesktopRecorderError?

    public init(
        videoPath: String, clickTrackPath: String, durationMs: Double, sizeBytes: Double,
        width: Double, height: Double, failure: DesktopRecorderError?
    ) {
        self.videoPath = videoPath
        self.clickTrackPath = clickTrackPath
        self.durationMs = durationMs
        self.sizeBytes = sizeBytes
        self.width = width
        self.height = height
        self.failure = failure
    }
}

public struct DesktopRecorderState: Equatable, Sendable {
    public var available: Bool
    public var status: DesktopRecorderStatus
    public var sessionId: String?
    public var elapsedMs: Double
    public var error: DesktopRecorderError?
    public var lastRecording: DesktopRecorderRecording?

    public init(
        available: Bool, status: DesktopRecorderStatus, sessionId: String?, elapsedMs: Double,
        error: DesktopRecorderError?, lastRecording: DesktopRecorderRecording?
    ) {
        self.available = available
        self.status = status
        self.sessionId = sessionId
        self.elapsedMs = elapsedMs
        self.error = error
        self.lastRecording = lastRecording
    }

    public static let unavailable = DesktopRecorderState(
        available: false, status: .unavailable, sessionId: nil, elapsedMs: 0, error: nil, lastRecording: nil
    )
}

public struct DesktopRecorderPrepareRequest: Equatable, Sendable {
    public var sourceId: String
    public var sourceKind: DesktopRecorderCaptureKind
    public var systemAudio: Bool
    public var microphone: Bool
    public var area: DesktopRecorderArea?

    public init(sourceId: String, sourceKind: DesktopRecorderCaptureKind, systemAudio: Bool, microphone: Bool, area: DesktopRecorderArea?) {
        self.sourceId = sourceId
        self.sourceKind = sourceKind
        self.systemAudio = systemAudio
        self.microphone = microphone
        self.area = area
    }
}

public struct DesktopRecorderPrepareResult: Equatable, Sendable {
    public var sessionId: String
    public var geometry: DesktopRecorderCaptureGeometry
    public var width: Double
    public var height: Double

    public init(sessionId: String, geometry: DesktopRecorderCaptureGeometry, width: Double, height: Double) {
        self.sessionId = sessionId
        self.geometry = geometry
        self.width = width
        self.height = height
    }
}

public enum DesktopRecorderNativeStatusKind: String, Sendable, Codable {
    case failed
    case paused
    case ready
    case recording
    case stopped
}

public struct DesktopRecorderNativeStatus: Equatable, Sendable {
    public var status: DesktopRecorderNativeStatusKind
    public var elapsedMs: Double
    public var error: DesktopRecorderError?

    public init(status: DesktopRecorderNativeStatusKind, elapsedMs: Double, error: DesktopRecorderError?) {
        self.status = status
        self.elapsedMs = elapsedMs
        self.error = error
    }
}

/// The native capture helper as the session controller sees it.
public protocol RecorderNativeBackend: AnyObject {
    func dispose()
    func getCapabilities() async throws -> DesktopRecorderCapabilities
    func requestScreenRecordingPermission() async throws -> Bool
    func listSources() async throws -> [DesktopRecorderSource]
    func listWindowPreviews() async throws -> [DesktopRecorderWindowPreview]
    func prepare(_ request: DesktopRecorderPrepareRequest) async throws -> DesktopRecorderPrepareResult
    func start(sessionId: String, outputPath: String) async throws
    func pause(sessionId: String) async throws
    func resume(sessionId: String) async throws
    func discard(sessionId: String) async throws
    func stop(sessionId: String) async throws -> DesktopRecorderRecording
    func getStatus(sessionId: String) async throws -> DesktopRecorderNativeStatus
}

public enum DesktopRecorderShortcut {
    /// Global stop shortcut, registered only while recording or paused.
    public static let stopAcceleratorLabel = "⌃⇧R"
}
