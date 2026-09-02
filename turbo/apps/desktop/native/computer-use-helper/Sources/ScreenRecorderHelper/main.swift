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

private func requiredArea(_ request: [String: Any]) throws -> AreaRect {
    guard
        let area = request["area"] as? [String: Any],
        let x = area["x"] as? Double,
        let y = area["y"] as? Double,
        let width = area["width"] as? Double,
        let height = area["height"] as? Double
    else {
        throw HelperFailure(
            code: "capture_failed",
            message: "Recording an area requires an area rectangle in screen points"
        )
    }
    return AreaRect(x: x, y: y, width: width, height: height)
}

private func displayArea(_ display: SCDisplay) -> AreaRect {
    return AreaRect(
        x: display.frame.origin.x,
        y: display.frame.origin.y,
        width: display.frame.width,
        height: display.frame.height
    )
}

private func resolveDisplay(
    _ content: SCShareableContent,
    sourceId: String
) throws -> SCDisplay {
    guard
        let rawID = UInt32(sourceId.replacingOccurrences(of: "display:", with: "")),
        let display = content.displays.first(where: { $0.displayID == rawID })
    else {
        throw HelperFailure(
            code: "source_lost",
            message: "Display is no longer available: \(sourceId)"
        )
    }
    return display
}

// MARK: - Source discovery

/// One screen read, kept briefly so the picker and the capture that follows it
/// do not each pay for their own.
private final class ShareableContentCache: @unchecked Sendable {
    private let lock = NSLock()
    private var content: SCShareableContent?
    private var coversEverySpace = false
    private var readAt = Date.distantPast

    /// How long one read stays good for. Opening the picker reads the screen
    /// twice in a row and preparing the capture reads it a third time; a
    /// window that closes inside this span still fails cleanly as
    /// `source_lost`, the same as one that closes a moment later.
    private let lifetime: TimeInterval = 20

    func reuse(onScreenWindowsOnly: Bool) -> SCShareableContent? {
        lock.lock()
        defer { lock.unlock() }
        guard let content, Date().timeIntervalSince(readAt) < lifetime else {
            return nil
        }
        // A read of every Space answers a request for the current one too.
        guard coversEverySpace || onScreenWindowsOnly else {
            return nil
        }
        return content
    }

    func store(_ content: SCShareableContent, coversEverySpace: Bool) {
        lock.lock()
        defer { lock.unlock() }
        self.content = content
        self.coversEverySpace = coversEverySpace
        readAt = Date()
    }
}

private let shareableContentCache = ShareableContentCache()

/// Reads what ScreenCaptureKit can share.
///
/// `onScreenWindowsOnly` is off by default because "on screen" means the active
/// Space: a full-screen editor or browser on its own Space would otherwise be
/// missing from the picker and unresolvable as a capture target. Callers that
/// only need displays pass `true`, because the wide read walks every window on
/// every Space and is the slowest part of starting a recording.
private func shareableContent(
    timeout: TimeInterval = 10,
    onScreenWindowsOnly: Bool = false
) throws -> SCShareableContent {
    // Asking ScreenCaptureKit without the grant makes the system put its own
    // prompt on screen, every single time. Once the answer is already no, say
    // so instead: the app can then offer Settings rather than the user being
    // asked the same question again on the next click.
    guard CGPreflightScreenCaptureAccess() else {
        throw HelperFailure(
            code: "permission_denied",
            message: "Okou needs Screen Recording permission in System Settings"
        )
    }
    if let cached = shareableContentCache.reuse(onScreenWindowsOnly: onScreenWindowsOnly) {
        return cached
    }
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<SCShareableContent>()
    SCShareableContent.getExcludingDesktopWindows(
        true,
        onScreenWindowsOnly: onScreenWindowsOnly
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
    shareableContentCache.store(content, coversEverySpace: !onScreenWindowsOnly)
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

/// ScreenCaptureKit only gained microphone capture in macOS 15. On 14 the
/// recorder has no way to reach the microphone that shares the video's clock,
/// so the option is reported as unsupported rather than half-implemented.
private func microphoneSupported() -> Bool {
    if #available(macOS 15.0, *) {
        return true
    }
    return false
}

/// What this system can record, without asking what is on screen.
///
/// Kept apart from `recorder.sources` because reading the window list makes
/// ScreenCaptureKit demand the screen recording grant, and the bar only wants
/// to know whether the microphone toggle is usable. Prompting for a permission
/// the moment the bar opens, before anything is being recorded, is not a thing
/// to do to someone.
private func handleCapabilities() -> [String: Any] {
    return ["supportsMicrophone": microphoneSupported()]
}

/// Asks the system for the screen recording grant, once, on purpose.
///
/// This is the only place that may raise the system prompt, and it runs when
/// the user asked for it rather than as a side effect of listing windows.
private func handleRequestPermission() -> [String: Any] {
    return ["granted": CGRequestScreenCaptureAccess()]
}

/// The windows a person could plausibly mean to record.
///
/// `recorder.sources` and `recorder.windowPreviews` both go through this so the
/// two lists line up by window id. `RecordableWindowPolicy` owns the rule.
private func recordableWindows(_ content: SCShareableContent) -> [SCWindow] {
    return content.windows.filter { window in
        return RecordableWindowPolicy.isRecordable(
            title: window.title,
            windowLayer: window.windowLayer
        )
    }
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

    for window in recordableWindows(content) {
        guard let title = window.title else {
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

/// Largest preview the picker shows, in pixels. Big enough to recognise a
/// window by, small enough that capturing a screenful of them stays quick.
private let windowPreviewMaxWidth = 400.0
private let windowPreviewMaxHeight = 250.0
/// Upper bound on how many windows are captured for one picker opening.
private let windowPreviewLimit = 24
/// Budget for the whole command. The client gives every request 15 seconds, so
/// a per-capture wait alone is not a bound: 24 slow windows would blow past it
/// and the picker would report a timeout while this is still working.
private let windowPreviewBudget: TimeInterval = 8

/// Captures one window as a PNG data URL, or `nil` when the system declines.
///
/// ScreenCaptureKit is used rather than Electron's capturer because this is the
/// process that already holds the screen recording grant the recording itself
/// depends on; asking through a second API means a second thing that can be
/// refused.
@available(macOS 14.0, *)
private func windowPreview(_ window: SCWindow) -> String? {
    let frame = window.frame
    guard frame.width > 1, frame.height > 1 else {
        return nil
    }
    let scale = min(
        windowPreviewMaxWidth / frame.width,
        windowPreviewMaxHeight / frame.height,
        1
    )
    let configuration = SCStreamConfiguration()
    configuration.width = max(Int(frame.width * scale), 1)
    configuration.height = max(Int(frame.height * scale), 1)
    configuration.showsCursor = false

    let box = ResultBox<CGImage>()
    let semaphore = DispatchSemaphore(value: 0)
    SCScreenshotManager.captureImage(
        contentFilter: SCContentFilter(desktopIndependentWindow: window),
        configuration: configuration
    ) { image, error in
        box.set(value: image, error: error)
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 2) == .success, let image = box.value
    else {
        return nil
    }

    let representation = NSBitmapImageRep(cgImage: image)
    guard let png = representation.representation(using: .png, properties: [:])
    else {
        return nil
    }
    return "data:image/png;base64,\(png.base64EncodedString())"
}

/// Previews for the windows the picker can offer.
///
/// Windows without a title are skipped the same way `recorder.sources` skips
/// them, so the two lists line up by window id.
private func handleWindowPreviews() throws -> [String: Any] {
    guard #available(macOS 14.0, *) else {
        throw HelperFailure(
            code: "capture_failed",
            message: "Window previews need macOS 14 or later"
        )
    }
    let content = try shareableContent()
    let deadline = Date().addingTimeInterval(windowPreviewBudget)
    var previews: [[String: Any]] = []
    for window in recordableWindows(content) {
        guard previews.count < windowPreviewLimit, Date() < deadline else {
            break
        }
        guard let dataUrl = windowPreview(window) else {
            continue
        }
        previews.append([
            "id": "window:\(window.windowID)",
            "previewDataUrl": dataUrl,
        ])
    }
    return ["previews": previews]
}

/// Capture rate for the stream, and the rate the click track reports so a
/// downstream editor can convert `tMs` into a frame index. One value so the two
/// cannot drift.
private let captureFrameRate: CMTimeScale = 30

/// The writer's failure as a message worth reading.
///
/// AVFoundation wraps most writer failures as `-11800`, "The operation could
/// not be completed", and keeps the status that actually says what happened
/// one level down as the underlying error. Both are spelled out so the tray
/// shows something that can be looked up rather than only the wrapper.
private func writerFailureMessage(_ assetWriter: AVAssetWriter) -> String {
    guard let error = assetWriter.error as NSError? else {
        return "The screen recording could not be written"
    }
    var parts = ["\(error.domain) \(error.code)"]
    var underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError
    while let next = underlying {
        parts.append("\(next.domain) \(next.code)")
        underlying = next.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return "\(error.localizedDescription) (\(parts.joined(separator: " / ")))"
}

// MARK: - Capture session

private final class RecorderSession: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    let id: String
    private let lock = NSLock()
    private let filter: SCContentFilter
    private let configuration: SCStreamConfiguration
    private let geometry: CaptureGeometry
    private let outputSize: OutputSize
    private let audioPlan: AudioTrackPlan
    private let sampleQueue = DispatchQueue(label: "ai.okou.recorder.samples")

    private let clickTracker = ClickTrackRecorder()
    private var timebase = mach_timebase_info_data_t()

    private var state: RecorderSessionState = .ready
    /// Set when the stream ended without `stop` being called. The session stays
    /// finalizable so the partial recording and its click track are still
    /// written; only the reported status changes.
    private var externalStop: (reason: StreamStopReason, code: String, message: String)?
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var systemAudioInput: AVAssetWriterInput?
    private var microphoneInput: AVAssetWriterInput?
    private var outputURL: URL?
    private var sessionStartedAt: CMTime?
    private var latestSampleAt: CMTime?
    /// Media time of the last sample written to each track, keyed by the
    /// writer input, so a sample that would not advance its track is refused
    /// before the writer refuses it and fails.
    private var lastWrittenSeconds: [ObjectIdentifier: Double] = [:]
    /// The format description each track was started with, keyed by writer
    /// input. A sample whose format differs from it is the leading way a
    /// window capture can turn into a sample the writer refuses.
    private var firstFormat: [ObjectIdentifier: CMFormatDescription] = [:]
    private var clickTimeline: ClickTimeline?
    private var pauseTimeline = PauseTimeline()
    private var startedAtUnixMs = 0

    init(
        id: String,
        filter: SCContentFilter,
        configuration: SCStreamConfiguration,
        geometry: CaptureGeometry,
        outputSize: OutputSize,
        audioPlan: AudioTrackPlan
    ) {
        self.id = id
        self.filter = filter
        self.configuration = configuration
        self.geometry = geometry
        self.outputSize = outputSize
        self.audioPlan = audioPlan
        super.init()
        mach_timebase_info(&timebase)
    }

    /// Converts a host-clock presentation timestamp back into the raw mach tick
    /// units `CGEvent.timestamp` reports, so clicks and frames share one origin.
    ///
    /// Returns `nil` rather than a zero anchor when the timestamp cannot be
    /// converted: anchoring at tick 0 would place every click at its offset from
    /// system boot instead of from the recording, which is a confidently wrong
    /// answer. The caller leaves the timeline unset and the track comes out
    /// empty.
    private func hostTicks(from time: CMTime) -> UInt64? {
        let nanoseconds = CMTimeGetSeconds(time) * 1_000_000_000
        guard nanoseconds > 0, timebase.numer > 0 else {
            return nil
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

    private func addAudioTrack(to assetWriter: AVAssetWriter) -> AVAssetWriterInput? {
        let input = AVAssetWriterInput(
            mediaType: .audio,
            outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 2,
                AVSampleRateKey: 48000,
            ]
        )
        input.expectsMediaDataInRealTime = true
        guard assetWriter.canAdd(input) else {
            return nil
        }
        assetWriter.add(input)
        return input
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

        // One writer input per requested track, so system audio and narration
        // stay separable in the finished file.
        let systemAudio = audioPlan.systemAudio ? addAudioTrack(to: assetWriter) : nil
        let microphone = audioPlan.microphone ? addAudioTrack(to: assetWriter) : nil

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
        if audioPlan.systemAudio {
            try captureStream.addStreamOutput(
                self,
                type: .audio,
                sampleHandlerQueue: sampleQueue
            )
        }
        if audioPlan.microphone, #available(macOS 15.0, *) {
            try captureStream.addStreamOutput(
                self,
                type: .microphone,
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
        systemAudioInput = systemAudio
        microphoneInput = microphone
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

    func pause() throws {
        try transition(.pause)
        lock.lock()
        if let start = sessionStartedAt, let latest = latestSampleAt {
            pauseTimeline.pause(
                at: max(0, CMTimeGetSeconds(CMTimeSubtract(latest, start)))
            )
        }
        lock.unlock()
    }

    func resume() throws {
        try transition(.resume)
        lock.lock()
        if let start = sessionStartedAt, let latest = latestSampleAt {
            pauseTimeline.resume(
                at: max(0, CMTimeGetSeconds(CMTimeSubtract(latest, start)))
            )
        }
        lock.unlock()
    }

    /// Ends the capture and removes what was written. Nothing is handed back,
    /// so a discarded recording cannot be delivered by mistake.
    func discard() throws {
        try transition(.discard)
        clickTracker.stop()

        lock.lock()
        let captureStream = stream
        let assetWriter = writer
        let url = outputURL
        stream = nil
        writer = nil
        videoInput = nil
        systemAudioInput = nil
        microphoneInput = nil
        lock.unlock()

        if let captureStream {
            let semaphore = DispatchSemaphore(value: 0)
            captureStream.stopCapture { _ in
                semaphore.signal()
            }
            _ = semaphore.wait(timeout: .now() + 10)
        }
        assetWriter?.cancelWriting()
        if let url {
            try? FileManager.default.removeItem(at: url)
            try? FileManager.default.removeItem(
                at: url.deletingPathExtension().appendingPathExtension("clicks.json")
            )
        }
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
        let systemAudio = systemAudioInput
        let microphone = microphoneInput
        let url = outputURL
        let duration = elapsedSecondsLocked()
        let timeline = clickTimeline
        let startedAt = startedAtUnixMs
        writer = nil
        videoInput = nil
        systemAudioInput = nil
        microphoneInput = nil
        lock.unlock()

        video?.markAsFinished()
        systemAudio?.markAsFinished()
        microphone?.markAsFinished()

        var writerFailure: String?
        if let assetWriter {
            let semaphore = DispatchSemaphore(value: 0)
            assetWriter.finishWriting {
                semaphore.signal()
            }
            _ = semaphore.wait(timeout: .now() + 30)
            if assetWriter.status == .failed {
                writerFailure = writerFailureMessage(assetWriter)
            }
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

        var result: [String: Any] = [
            "videoPath": url.path,
            "clickTrackPath": clickTrackPath,
            "durationMs": Int(duration * 1000),
            "sizeBytes": size,
            "width": outputSize.width,
            "height": outputSize.height,
        ]
        // The file is handed back either way — it holds whatever was written
        // before the failure — but the caller must not deliver it as a finished
        // recording. Reported here as well as through `recorder.state`, because
        // a stop that races the poll would otherwise ship it.
        lock.lock()
        let failure = externalStop.flatMap { $0.reason == .failed ? $0 : nil }
        lock.unlock()
        if let writerFailure {
            result["failure"] = ["code": "capture_failed", "message": writerFailure]
        } else if let failure {
            result["failure"] = ["code": failure.code, "message": failure.message]
        }
        return result
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
                    pauses: pauseTimeline,
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
                    "frameRate": Int(captureFrameRate),
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
            "status": reportedStatusLocked(),
            "elapsedMs": Int(elapsedSecondsLocked() * 1000),
        ]
        if let externalStop, externalStop.reason == .failed {
            described["error"] = [
                "code": externalStop.code,
                "message": externalStop.message,
            ]
        }
        return described
    }

    /// The status the caller sees. An externally ended stream is reported as
    /// finished or failed straight away, while `state` stays `.recording` so
    /// the caller can still run `stop` to finalize the file it already has.
    private func reportedStatusLocked() -> String {
        guard let externalStop, state == .recording else {
            return state.rawValue
        }
        return externalStop.reason == .userStopped ? "stopped" : "failed"
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

    /// Routes a sample to the track it belongs to. Microphone samples arrive on
    /// their own output type, so they must not be appended to the system audio
    /// track or the two would be interleaved into one.
    private func writerInputLocked(for type: SCStreamOutputType) -> AVAssetWriterInput? {
        if type == .screen {
            return videoInput
        }
        if #available(macOS 15.0, *), type == .microphone {
            return microphoneInput
        }
        return systemAudioInput
    }

    /// Rewrites a sample's presentation time without touching its payload.
    private func retimedSampleBuffer(
        _ sampleBuffer: CMSampleBuffer,
        to presentationTime: CMTime
    ) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(
            duration: CMSampleBufferGetDuration(sampleBuffer),
            presentationTimeStamp: presentationTime,
            decodeTimeStamp: .invalid
        )
        var copy: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &copy
        )
        return status == noErr ? copy : nil
    }

    private func elapsedSecondsLocked() -> Double {
        guard let start = sessionStartedAt, let latest = latestSampleAt else {
            return 0
        }
        let captureSeconds = max(0, CMTimeGetSeconds(CMTimeSubtract(latest, start)))
        // Report how long the recording is, not how long ago it started, so a
        // paused capture stops advancing its clock.
        return max(0, captureSeconds - pauseTimeline.pausedSecondsBefore(captureSeconds))
    }

    /// Why the first frame cannot go on the video track, or `nil` when it can.
    private func frameSizeMismatch(_ sampleBuffer: CMSampleBuffer) -> String? {
        guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return "The screen capture delivered a frame with no image"
        }
        let width = CVPixelBufferGetWidth(image)
        let height = CVPixelBufferGetHeight(image)
        guard width == outputSize.width, height == outputSize.height else {
            return
                "The screen capture delivered \(width)×\(height) frames "
                + "but the recording was prepared for \(outputSize.width)×\(outputSize.height)"
        }
        return nil
    }

    /// Whether a screen sample is a finished picture rather than a status
    /// marker. A sample without the attachment at all is treated as complete:
    /// that is how a frame arrives from a filter the system does not annotate.
    private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: rawStatus)
        else {
            return true
        }
        return status == .complete
    }

    /// Records that the stream ended on its own.
    ///
    /// Deliberately does not move to a terminal state: the writer still holds
    /// frames that were captured before the stream ended, and discarding them
    /// would throw away the recording the user just made. `stop` finalizes as
    /// usual, and the reported status tells the caller to run it.
    private func noteExternalStop(
        reason: StreamStopReason,
        code: String = "source_lost",
        message: String
    ) {
        lock.lock()
        if externalStop == nil {
            externalStop = (reason, code, message)
        }
        let captureStream = stream
        stream = nil
        lock.unlock()
        captureStream?.stopCapture { _ in }
        // The tap outlives the stream unless it is torn down here.
        clickTracker.stop()
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // Ending the share from the system indicator arrives here as an error
        // like any other, so the code decides whether this is a finish or a
        // fault. Reporting a deliberate stop as a failure was wrong.
        let nsError = error as NSError
        noteExternalStop(
            reason: StreamStopClassifier.classify(
                domain: nsError.domain,
                code: nsError.code
            ),
            message: error.localizedDescription
        )
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
        // ScreenCaptureKit also delivers frames that carry no new picture —
        // idle, blank, and the bookkeeping frames around start and stop. They
        // are not images the encoder can take, and handing one to the writer
        // is a way to fail it. Only a complete frame goes on.
        if type == .screen, !isCompleteFrame(sampleBuffer) {
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
            // A frame of the wrong size fails the writer with nothing but
            // "the operation could not be completed". Refusing it here names
            // both sizes instead, before the session is anchored on it.
            if let mismatch = frameSizeMismatch(sampleBuffer) {
                lock.unlock()
                noteExternalStop(reason: .failed, code: "capture_failed", message: mismatch)
                return
            }
            assetWriter.startSession(atSourceTime: timestamp)
            sessionStartedAt = timestamp
            // Anchor clicks on the very same frame the video starts on rather
            // than on when `start` was called, so the two timelines cannot drift.
            if let startTicks = hostTicks(from: timestamp) {
                clickTimeline = ClickTimeline(
                    startTicks: startTicks,
                    timebaseNumerator: timebase.numer,
                    timebaseDenominator: timebase.denom
                )
            }
        }
        let input = writerInputLocked(for: type)
        let start = sessionStartedAt
        let timeline = pauseTimeline
        let lastWritten = input.map { lastWrittenSeconds[ObjectIdentifier($0)] } ?? nil
        lock.unlock()

        // A writer that has failed answers `isReadyForMoreMediaData` with false
        // for the rest of its life. Treating that like ordinary back-pressure
        // dropped every later frame in silence while the clock kept running,
        // and `stop` then delivered a recording holding its first fragment.
        if assetWriter.status == .failed {
            noteWriterFailure(assetWriter, sample: sampleBuffer, type: type, at: nil)
            return
        }
        guard let input, input.isReadyForMoreMediaData, let start else {
            return
        }
        // Frames keep arriving while paused; they are dropped, and everything
        // after a pause is shifted back so the movie has no frozen stretch. A
        // sample stamped before the anchor frame, or one that would not move
        // its track forward, is dropped too: the writer would refuse it and
        // then refuse everything after it. `SampleTimingPolicy` owns the rule.
        let captureSeconds = CMTimeGetSeconds(CMTimeSubtract(timestamp, start))
        guard
            let mediaSeconds = SampleTimingPolicy.mediaTime(
                captureSeconds: captureSeconds,
                pauses: timeline,
                lastWrittenSeconds: lastWritten
            )
        else {
            return
        }
        // Retimed in the sample's own timebase, not a coarser one: rounding
        // 48 kHz audio onto a 600 Hz grid could move neighbouring buffers onto
        // each other.
        guard
            let retimed = retimedSampleBuffer(
                sampleBuffer,
                to: CMTimeAdd(
                    start,
                    CMTime(seconds: mediaSeconds, preferredTimescale: timestamp.timescale)
                )
            )
        else {
            return
        }
        if input.append(retimed) {
            lock.lock()
            latestSampleAt = timestamp
            lastWrittenSeconds[ObjectIdentifier(input)] = mediaSeconds
            if firstFormat[ObjectIdentifier(input)] == nil,
                let format = CMSampleBufferGetFormatDescription(sampleBuffer)
            {
                firstFormat[ObjectIdentifier(input)] = format
            }
            lock.unlock()
        } else if assetWriter.status == .failed {
            noteWriterFailure(assetWriter, sample: sampleBuffer, type: type, at: mediaSeconds)
        }
    }

    /// Describes a sample the way the failure message needs it: which track,
    /// what format, and whether that format is the one the track began with.
    private func describeSample(
        _ sampleBuffer: CMSampleBuffer,
        type: SCStreamOutputType,
        at mediaSeconds: Double?
    ) -> String {
        var parts: [String] = [type == .screen ? "screen" : "audio"]
        if let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            parts.append(describeFormat(format))
            lock.lock()
            let first = writerInputLocked(for: type).flatMap { firstFormat[ObjectIdentifier($0)] }
            lock.unlock()
            if let first, !CMFormatDescriptionEqual(first, format) {
                parts.append("format changed from \(describeFormat(first))")
            }
        } else {
            parts.append("no format description")
        }
        let duration = CMSampleBufferGetDuration(sampleBuffer)
        parts.append(
            duration.isValid && duration.seconds > 0
                ? String(format: "duration %.1fms", duration.seconds * 1000)
                : "no duration"
        )
        if let mediaSeconds {
            parts.append(String(format: "at %.2fs", mediaSeconds))
        }
        return parts.joined(separator: ", ")
    }

    private func describeFormat(_ format: CMFormatDescription) -> String {
        let subtype = CMFormatDescriptionGetMediaSubType(format)
        let code = String(
            [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((subtype >> $0) & 0xff))) }
        )
        switch CMFormatDescriptionGetMediaType(format) {
        case kCMMediaType_Video:
            let size = CMVideoFormatDescriptionGetDimensions(format)
            return "\(size.width)×\(size.height) \(code)"
        case kCMMediaType_Audio:
            guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
            else {
                return code
            }
            return "\(Int(asbd.mSampleRate)) Hz \(asbd.mChannelsPerFrame) ch \(code)"
        default:
            return code
        }
    }

    /// Ends the capture because the file can no longer be written to.
    ///
    /// Reported as `capture_failed` rather than `source_lost`: the source is
    /// still there, it is the output that broke. What was written before the
    /// failure is kept for `stop` to finalize, the same as any other external
    /// end.
    private func noteWriterFailure(
        _ assetWriter: AVAssetWriter,
        sample: CMSampleBuffer,
        type: SCStreamOutputType,
        at mediaSeconds: Double?
    ) {
        noteExternalStop(
            reason: .failed,
            code: "capture_failed",
            message: writerFailureMessage(assetWriter)
                + " while writing \(describeSample(sample, type: type, at: mediaSeconds))"
        )
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
    let microphone = optionalBool(request, "microphone")
    let audioPlan = AudioTrackPolicy.plan(
        systemAudio: systemAudio,
        microphone: microphone,
        microphoneSupported: microphoneSupported()
    )
    // Only a window capture has to find its target among every Space's
    // windows; a display or area capture is aimed at a display and pays for
    // the wide read with nothing but a slower start.
    let content = try shareableContent(onScreenWindowsOnly: sourceKind != "window")

    let filter: SCContentFilter
    let geometry: CaptureGeometry

    var croppedArea: AreaRect?

    if sourceKind == "display" {
        let display = try resolveDisplay(content, sourceId: sourceId)
        filter = SCContentFilter(display: display, excludingWindows: [])
        geometry = CaptureGeometry(
            originX: display.frame.origin.x,
            originY: display.frame.origin.y,
            widthPoints: display.frame.width,
            heightPoints: display.frame.height,
            scale: backingScaleFactor(forDisplayID: display.displayID)
        )
    } else if sourceKind == "area" {
        // An area is a display capture with a crop: ScreenCaptureKit has no
        // region filter, so the whole display is filtered and `sourceRect`
        // narrows it.
        let display = try resolveDisplay(content, sourceId: sourceId)
        let requested = try requiredArea(request)
        guard
            let area = CaptureAreaPolicy.clamp(requested, toDisplay: displayArea(display))
        else {
            throw HelperFailure(
                code: "capture_failed",
                message: "The selected area is not on this display, or is too small to record"
            )
        }
        croppedArea = area
        filter = SCContentFilter(display: display, excludingWindows: [])
        // The geometry describes the crop, not the display, so clicks map into
        // the cropped frame rather than the full screen.
        geometry = CaptureGeometry(
            originX: area.x,
            originY: area.y,
            widthPoints: area.width,
            heightPoints: area.height,
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
    // The video track is built for exactly `outputSize`, and the writer fails
    // on the first frame of any other size. A whole display is always scaled
    // into the configured size, but a window or a cropped region is delivered
    // at its own pixel size unless the stream is told to scale it, which is
    // why display captures worked while window and area captures did not.
    configuration.scalesToFit = sourceKind != "display"
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: captureFrameRate)
    configuration.showsCursor = true
    configuration.queueDepth = 6
    configuration.capturesAudio = audioPlan.systemAudio
    if audioPlan.microphone, #available(macOS 15.0, *) {
        configuration.captureMicrophone = true
    }
    if let croppedArea {
        let display = try resolveDisplay(content, sourceId: sourceId)
        let relative = CaptureAreaPolicy.relativeToDisplay(
            croppedArea,
            display: displayArea(display)
        )
        configuration.sourceRect = CGRect(
            x: relative.x,
            y: relative.y,
            width: relative.width,
            height: relative.height
        )
    }

    let session = RecorderSession(
        id: sessionStore.nextSessionID(),
        filter: filter,
        configuration: configuration,
        geometry: geometry,
        outputSize: outputSize,
        audioPlan: audioPlan
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
    // `stop` reaches its terminal state before any of the work that can throw,
    // so a finalize that fails partway leaves a session that can never be
    // stopped again. Releasing on the way out either way is what keeps the
    // store bounded; the caller gives up on a rejected stop and never retries.
    defer {
        if session.isTerminal {
            sessionStore.remove(sessionId)
        }
    }
    return try session.stop()
}

private func handlePause(_ request: [String: Any]) throws -> [String: Any] {
    let session = try sessionStore.session(try requiredString(request, "sessionId"))
    try session.pause()
    return [:]
}

private func handleResume(_ request: [String: Any]) throws -> [String: Any] {
    let session = try sessionStore.session(try requiredString(request, "sessionId"))
    try session.resume()
    return [:]
}

private func handleDiscard(_ request: [String: Any]) throws -> [String: Any] {
    let sessionId = try requiredString(request, "sessionId")
    let session = try sessionStore.session(sessionId)
    try session.discard()
    sessionStore.remove(sessionId)
    return [:]
}

private func handleState(_ request: [String: Any]) throws -> [String: Any] {
    let sessionId = try requiredString(request, "sessionId")
    let session = try sessionStore.session(sessionId)
    // A stream that ended on its own is reported here but deliberately left in
    // the store: it still holds the frames the user captured, and only `stop`
    // can finalize them. `handleStop` is what releases it.
    return session.describedState()
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
    case "recorder.capabilities":
        return handleCapabilities()
    case "recorder.requestPermission":
        return handleRequestPermission()
    case "recorder.sources":
        return try handleSources()
    case "recorder.windowPreviews":
        return try handleWindowPreviews()
    case "recorder.prepare":
        return try handlePrepare(payload)
    case "recorder.start":
        return try handleStart(payload)
    case "recorder.pause":
        return try handlePause(payload)
    case "recorder.resume":
        return try handleResume(payload)
    case "recorder.discard":
        return try handleDiscard(payload)
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

/// Connects this process to the window server before any request is served.
///
/// CoreGraphics makes that connection lazily, on whichever thread first asks
/// for it, and on current macOS it asserts (`CGS_REQUIRE_INIT`) rather than
/// connecting when that first ask comes from a background thread. Every
/// request here is served on one, so the picker's window enumeration and
/// previews could abort the whole helper mid-session. The connection is made
/// here, on the main thread, the way a non-AppKit process is expected to. The
/// activation policy keeps the helper out of the Dock and off the app switcher.
private func connectToWindowServer() {
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    _ = CGMainDisplayID()
}

private func runStdioSession() {
    connectToWindowServer()
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
