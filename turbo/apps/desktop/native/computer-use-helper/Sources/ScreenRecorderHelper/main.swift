import AVFoundation
import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit
import ScreenRecorderCore

// MARK: - Failures

struct HelperFailure: Error {
    let code: String
    let message: String
}

private func failureResponse(code: String, message: String) -> [String: Any] {
    return [
        "status": "failed",
        "error": [
            "code": code,
            "message": message,
        ],
    ]
}

// MARK: - Request helpers

private func isRecord(_ value: Any) -> [String: Any]? {
    return value as? [String: Any]
}

private func requiredString(_ request: [String: Any], _ key: String) throws -> String {
    guard let value = request[key] as? String, !value.isEmpty else {
        throw HelperFailure(
            code: "capture_failed",
            message: "Screen recorder helper requires \(key)"
        )
    }
    return value
}

private func optionalBool(_ request: [String: Any], _ key: String) -> Bool {
    return (request[key] as? Bool) ?? false
}

// MARK: - Source discovery

private func shareableContent(timeout: TimeInterval = 10) throws -> SCShareableContent {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<SCShareableContent>()
    SCShareableContent.getExcludingDesktopWindows(
        true,
        onScreenWindowsOnly: true
    ) { content, error in
        box.set(value: content, error: error)
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + timeout) == .success else {
        throw HelperFailure(
            code: "capture_failed",
            message: "Timed out reading shareable screen content"
        )
    }
    if let error = box.error {
        // ScreenCaptureKit reports a missing TCC grant as a generic failure, so
        // preflight decides the code rather than parsing the message.
        throw HelperFailure(
            code: CGPreflightScreenCaptureAccess() ? "capture_failed" : "permission_denied",
            message: error.localizedDescription
        )
    }
    guard let content = box.value else {
        throw HelperFailure(
            code: "permission_denied",
            message: "Screen recording permission is not granted"
        )
    }
    return content
}

private final class ResultBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storedValue: Value?
    private var storedError: Error?

    func set(value: Value?, error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        storedValue = value
        storedError = error
    }

    var value: Value? {
        lock.lock()
        defer { lock.unlock() }
        return storedValue
    }

    var error: Error? {
        lock.lock()
        defer { lock.unlock() }
        return storedError
    }
}

private func backingScaleFactor(forDisplayID displayID: CGDirectDisplayID) -> Double {
    for screen in NSScreen.screens {
        let number = screen.deviceDescription[
            NSDeviceDescriptionKey("NSScreenNumber")
        ] as? NSNumber
        if number?.uint32Value == displayID {
            return Double(screen.backingScaleFactor)
        }
    }
    return 1
}

private func handleSources() throws -> [String: Any] {
    let content = try shareableContent()
    var sources: [[String: Any]] = []

    for display in content.displays {
        sources.append([
            "id": "display:\(display.displayID)",
            "kind": "display",
            "title": "Display \(display.displayID)",
        ])
    }

    for window in content.windows {
        guard let title = window.title, !title.isEmpty else {
            continue
        }
        var source: [String: Any] = [
            "id": "window:\(window.windowID)",
            "kind": "window",
            "title": title,
        ]
        if let application = window.owningApplication {
            source["appName"] = application.applicationName
            source["bundleId"] = application.bundleIdentifier
        }
        sources.append(source)
    }

    return ["sources": sources]
}

// MARK: - Capture session

private final class RecorderSession: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    let id: String
    private let lock = NSLock()
    private let filter: SCContentFilter
    private let configuration: SCStreamConfiguration
    private let geometry: CaptureGeometry
    private let outputSize: OutputSize
    private let capturesAudio: Bool
    private let sampleQueue = DispatchQueue(label: "ai.okou.recorder.samples")

    private let clickTracker = ClickTrackRecorder()
    private var timebase = mach_timebase_info_data_t()

    private var state: RecorderSessionState = .ready
    private var failure: HelperFailure?
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var outputURL: URL?
    private var sessionStartedAt: CMTime?
    private var latestSampleAt: CMTime?
    private var clickTimeline: ClickTimeline?
    private var startedAtUnixMs = 0

    init(
        id: String,
        filter: SCContentFilter,
        configuration: SCStreamConfiguration,
        geometry: CaptureGeometry,
        outputSize: OutputSize,
        capturesAudio: Bool
    ) {
        self.id = id
        self.filter = filter
        self.configuration = configuration
        self.geometry = geometry
        self.outputSize = outputSize
        self.capturesAudio = capturesAudio
        super.init()
        mach_timebase_info(&timebase)
    }

    /// Converts a host-clock presentation timestamp back into the raw mach tick
    /// units `CGEvent.timestamp` reports, so clicks and frames share one origin.
    private func hostTicks(from time: CMTime) -> UInt64 {
        let nanoseconds = CMTimeGetSeconds(time) * 1_000_000_000
        guard nanoseconds > 0, timebase.numer > 0 else {
            return 0
        }
        return UInt64(nanoseconds * Double(timebase.denom) / Double(timebase.numer))
    }

    var describedGeometry: [String: Any] {
        return [
            "originX": geometry.originX,
            "originY": geometry.originY,
            "widthPoints": geometry.widthPoints,
            "heightPoints": geometry.heightPoints,
            "scale": geometry.scale,
        ]
    }

    func start(outputPath: String) throws {
        try transition(.start)

        let url = URL(fileURLWithPath: outputPath)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? FileManager.default.removeItem(at: url)

        let assetWriter = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // Fragmented output keeps the file playable if this process dies mid
        // capture; an unfinalized plain MP4 would be unreadable.
        assetWriter.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)

        let video = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: outputSize.width,
                AVVideoHeightKey: outputSize.height,
            ]
        )
        video.expectsMediaDataInRealTime = true
        guard assetWriter.canAdd(video) else {
            throw HelperFailure(
                code: "capture_failed",
                message: "Unable to configure the screen recording video track"
            )
        }
        assetWriter.add(video)

        var audio: AVAssetWriterInput?
        if capturesAudio {
            let input = AVAssetWriterInput(
                mediaType: .audio,
                outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVNumberOfChannelsKey: 2,
                    AVSampleRateKey: 48000,
                ]
            )
            input.expectsMediaDataInRealTime = true
            if assetWriter.canAdd(input) {
                assetWriter.add(input)
                audio = input
            }
        }

        let captureStream = SCStream(
            filter: filter,
            configuration: configuration,
            delegate: self
        )
        try captureStream.addStreamOutput(
            self,
            type: .screen,
            sampleHandlerQueue: sampleQueue
        )
        if capturesAudio {
            try captureStream.addStreamOutput(
                self,
                type: .audio,
                sampleHandlerQueue: sampleQueue
            )
        }

        guard assetWriter.startWriting() else {
            throw HelperFailure(
                code: "capture_failed",
                message: assetWriter.error?.localizedDescription
                    ?? "Unable to start writing the screen recording"
            )
        }

        lock.lock()
        writer = assetWriter
        videoInput = video
        audioInput = audio
        stream = captureStream
        outputURL = url
        lock.unlock()

        let startBox = ResultBox<Bool>()
        let semaphore = DispatchSemaphore(value: 0)
        captureStream.startCapture { error in
            startBox.set(value: error == nil, error: error)
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + 10) == .success else {
            throw HelperFailure(
                code: "capture_failed",
                message: "Timed out starting the screen capture stream"
            )
        }
        if let error = startBox.error {
            throw HelperFailure(
                code: "capture_failed",
                message: error.localizedDescription
            )
        }

        lock.lock()
        startedAtUnixMs = Int(Date().timeIntervalSince1970 * 1000)
        lock.unlock()
        clickTracker.start()
    }

    func stop() throws -> [String: Any] {
        try transition(.stop)
        clickTracker.stop()

        lock.lock()
        let captureStream = stream
        stream = nil
        lock.unlock()

        if let captureStream {
            let semaphore = DispatchSemaphore(value: 0)
            captureStream.stopCapture { _ in
                semaphore.signal()
            }
            _ = semaphore.wait(timeout: .now() + 10)
        }

        lock.lock()
        let assetWriter = writer
        let video = videoInput
        let audio = audioInput
        let url = outputURL
        let duration = elapsedSecondsLocked()
        let timeline = clickTimeline
        let startedAt = startedAtUnixMs
        writer = nil
        videoInput = nil
        audioInput = nil
        lock.unlock()

        video?.markAsFinished()
        audio?.markAsFinished()

        if let assetWriter {
            let semaphore = DispatchSemaphore(value: 0)
            assetWriter.finishWriting {
                semaphore.signal()
            }
            _ = semaphore.wait(timeout: .now() + 30)
        }

        guard let url else {
            throw HelperFailure(
                code: "capture_failed",
                message: "Screen recording produced no output file"
            )
        }
        // `finishWriting` has returned, so the file must be readable. Reporting
        // a fabricated 0 here would hand delivery a plausible wrong number
        // instead of surfacing the broken output.
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        guard let size = (attributes?[.size] as? NSNumber)?.intValue else {
            throw HelperFailure(
                code: "capture_failed",
                message: "Screen recording output file is unreadable"
            )
        }
        let clickTrackPath = try writeClickTrack(
            besideVideoAt: url,
            timeline: timeline,
            durationMs: Int(duration * 1000),
            startedAtUnixMs: startedAt
        )

        return [
            "videoPath": url.path,
            "clickTrackPath": clickTrackPath,
            "durationMs": Int(duration * 1000),
            "sizeBytes": size,
            "width": outputSize.width,
            "height": outputSize.height,
        ]
    }

    private func writeClickTrack(
        besideVideoAt videoURL: URL,
        timeline: ClickTimeline?,
        durationMs: Int,
        startedAtUnixMs: Int
    ) throws -> String {
        // A recording that never produced a frame has no timeline to project
        // clicks onto, so the track is empty rather than guessed.
        let projected =
            timeline.map {
                clickTracker.track(
                    timeline: $0,
                    geometry: geometry,
                    outputSize: outputSize
                )
            } ?? (clicks: [], droppedOutOfFrame: 0, warnings: [])

        let payload: [String: Any] = [
            "version": 1,
            "recording": [
                "startedAtUnixMs": startedAtUnixMs,
                "durationMs": durationMs,
                "video": [
                    "width": outputSize.width,
                    "height": outputSize.height,
                    "frameRate": 30,
                ],
                "capture": describedGeometry,
            ],
            "clicks": projected.clicks,
            "droppedOutOfFrameClicks": projected.droppedOutOfFrame,
            "warnings": projected.warnings,
        ]

        let trackURL = videoURL.deletingPathExtension()
            .appendingPathExtension("clicks.json")
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        try data.write(to: trackURL, options: .atomic)
        return trackURL.path
    }

    func describedState() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        var described: [String: Any] = [
            "status": state.rawValue,
            "elapsedMs": Int(elapsedSecondsLocked() * 1000),
        ]
        if let failure {
            described["error"] = [
                "code": failure.code,
                "message": failure.message,
            ]
        }
        return described
    }

    var isTerminal: Bool {
        lock.lock()
        defer { lock.unlock() }
        return RecorderTransitionPolicy.isTerminal(state)
    }

    private func transition(_ command: RecorderCommand) throws {
        lock.lock()
        defer { lock.unlock() }
        switch RecorderTransitionPolicy.next(from: state, command: command) {
        case .success(let next):
            state = next
        case .failure(let rejection):
            throw HelperFailure(code: rejection.code, message: rejection.message)
        }
    }

    private func elapsedSecondsLocked() -> Double {
        guard let start = sessionStartedAt, let latest = latestSampleAt else {
            return 0
        }
        return max(0, CMTimeGetSeconds(CMTimeSubtract(latest, start)))
    }

    private func markFailed(code: String, message: String) {
        lock.lock()
        state = .failed
        failure = HelperFailure(code: code, message: message)
        let captureStream = stream
        stream = nil
        lock.unlock()
        captureStream?.stopCapture { _ in }
        // The tap outlives the stream unless it is torn down here: a failed
        // session is never stopped by the caller.
        clickTracker.stop()
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        markFailed(code: "source_lost", message: error.localizedDescription)
    }

    // MARK: SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard
            CMSampleBufferIsValid(sampleBuffer),
            CMSampleBufferDataIsReady(sampleBuffer)
        else {
            return
        }
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        lock.lock()
        guard state == .recording, let assetWriter = writer else {
            lock.unlock()
            return
        }
        if sessionStartedAt == nil {
            guard type == .screen else {
                // Anchor the timeline on the first video frame so audio that
                // arrives first cannot start the session before the picture.
                lock.unlock()
                return
            }
            assetWriter.startSession(atSourceTime: timestamp)
            sessionStartedAt = timestamp
            // Anchor clicks on the very same frame the video starts on rather
            // than on when `start` was called, so the two timelines cannot drift.
            clickTimeline = ClickTimeline(
                startTicks: hostTicks(from: timestamp),
                timebaseNumerator: timebase.numer,
                timebaseDenominator: timebase.denom
            )
        }
        latestSampleAt = timestamp
        let input = type == .screen ? videoInput : audioInput
        lock.unlock()

        guard let input, input.isReadyForMoreMediaData else {
            return
        }
        input.append(sampleBuffer)
    }
}

// MARK: - Session store

private final class RecorderSessionStore: @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: [String: RecorderSession] = [:]
    private var counter = 0

    func nextSessionID() -> String {
        lock.lock()
        defer { lock.unlock() }
        counter += 1
        return "recorder-session-\(counter)"
    }

    func insert(_ session: RecorderSession) {
        lock.lock()
        defer { lock.unlock() }
        sessions[session.id] = session
    }

    func session(_ id: String) throws -> RecorderSession {
        lock.lock()
        defer { lock.unlock() }
        guard let session = sessions[id] else {
            throw HelperFailure(
                code: "capture_failed",
                message: "Unknown screen recording session: \(id)"
            )
        }
        return session
    }

    func remove(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        sessions.removeValue(forKey: id)
    }
}

private let sessionStore = RecorderSessionStore()

// MARK: - Command handlers

private func handlePrepare(_ request: [String: Any]) throws -> [String: Any] {
    let sourceId = try requiredString(request, "sourceId")
    let sourceKind = try requiredString(request, "sourceKind")
    let systemAudio = optionalBool(request, "systemAudio")
    let content = try shareableContent()

    let filter: SCContentFilter
    let geometry: CaptureGeometry

    if sourceKind == "display" {
        guard
            let rawID = UInt32(sourceId.replacingOccurrences(of: "display:", with: "")),
            let display = content.displays.first(where: { $0.displayID == rawID })
        else {
            throw HelperFailure(
                code: "source_lost",
                message: "Display is no longer available: \(sourceId)"
            )
        }
        filter = SCContentFilter(display: display, excludingWindows: [])
        geometry = CaptureGeometry(
            originX: display.frame.origin.x,
            originY: display.frame.origin.y,
            widthPoints: display.frame.width,
            heightPoints: display.frame.height,
            scale: backingScaleFactor(forDisplayID: display.displayID)
        )
    } else if sourceKind == "window" {
        guard
            let rawID = UInt32(sourceId.replacingOccurrences(of: "window:", with: "")),
            let window = content.windows.first(where: { $0.windowID == rawID })
        else {
            throw HelperFailure(
                code: "source_lost",
                message: "Window is no longer available: \(sourceId)"
            )
        }
        filter = SCContentFilter(desktopIndependentWindow: window)
        geometry = CaptureGeometry(
            originX: window.frame.origin.x,
            originY: window.frame.origin.y,
            widthPoints: window.frame.width,
            heightPoints: window.frame.height,
            scale: 2
        )
    } else {
        throw HelperFailure(
            code: "capture_failed",
            message: "Unsupported screen recording source kind: \(sourceKind)"
        )
    }

    let outputSize = CaptureSizePolicy.outputSize(for: geometry)
    let configuration = SCStreamConfiguration()
    configuration.width = outputSize.width
    configuration.height = outputSize.height
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    configuration.showsCursor = true
    configuration.queueDepth = 6
    configuration.capturesAudio = systemAudio

    let session = RecorderSession(
        id: sessionStore.nextSessionID(),
        filter: filter,
        configuration: configuration,
        geometry: geometry,
        outputSize: outputSize,
        capturesAudio: systemAudio
    )
    sessionStore.insert(session)

    return [
        "sessionId": session.id,
        "width": outputSize.width,
        "height": outputSize.height,
        "geometry": session.describedGeometry,
    ]
}

private func handleStart(_ request: [String: Any]) throws -> [String: Any] {
    let sessionId = try requiredString(request, "sessionId")
    let outputPath = try requiredString(request, "outputPath")
    let session = try sessionStore.session(sessionId)
    try session.start(outputPath: outputPath)
    return [:]
}

private func handleStop(_ request: [String: Any]) throws -> [String: Any] {
    let sessionId = try requiredString(request, "sessionId")
    let session = try sessionStore.session(sessionId)
    let result = try session.stop()
    sessionStore.remove(sessionId)
    return result
}

private func handleState(_ request: [String: Any]) throws -> [String: Any] {
    let sessionId = try requiredString(request, "sessionId")
    let session = try sessionStore.session(sessionId)
    let described = session.describedState()
    if session.isTerminal {
        // A session that failed on the delegate queue is never stopped by the
        // caller, so releasing it here is what keeps the store bounded.
        sessionStore.remove(sessionId)
    }
    return described
}

private func handle(_ request: [String: Any]) throws -> [String: Any] {
    guard let kind = request["kind"] as? String else {
        throw HelperFailure(
            code: "capture_failed",
            message: "Screen recorder helper requires a command kind"
        )
    }
    let payload = isRecord(request["payload"] ?? [:]) ?? [:]
    switch kind {
    case "recorder.sources":
        return try handleSources()
    case "recorder.prepare":
        return try handlePrepare(payload)
    case "recorder.start":
        return try handleStart(payload)
    case "recorder.stop":
        return try handleStop(payload)
    case "recorder.state":
        return try handleState(payload)
    default:
        throw HelperFailure(
            code: "capture_failed",
            message: "Unsupported screen recorder command: \(kind)"
        )
    }
}

// MARK: - Transport

private func writeJSONObject(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func responseObject(for request: [String: Any]) -> [String: Any] {
    var response: [String: Any]
    do {
        response = [
            "status": "succeeded",
            "result": try handle(request),
        ]
    } catch let failure as HelperFailure {
        response = failureResponse(code: failure.code, message: failure.message)
    } catch {
        response = failureResponse(
            code: "capture_failed",
            message: String(describing: error)
        )
    }
    if let id = request["id"] {
        response["id"] = id
    }
    return response
}

private func runStdioSession() {
    let mainRunLoop = CFRunLoopGetCurrent()
    DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                continue
            }
            do {
                let parsed = try JSONSerialization.jsonObject(
                    with: Data(trimmed.utf8),
                    options: []
                )
                guard let request = isRecord(parsed) else {
                    throw HelperFailure(
                        code: "capture_failed",
                        message: "Screen recorder helper requires a JSON object request"
                    )
                }
                try writeJSONObject(responseObject(for: request))
            } catch let failure as HelperFailure {
                try? writeJSONObject(
                    failureResponse(code: failure.code, message: failure.message)
                )
            } catch {
                try? writeJSONObject(
                    failureResponse(
                        code: "capture_failed",
                        message: String(describing: error)
                    )
                )
            }
        }
        CFRunLoopStop(mainRunLoop)
    }
    CFRunLoopRun()
}

runStdioSession()
