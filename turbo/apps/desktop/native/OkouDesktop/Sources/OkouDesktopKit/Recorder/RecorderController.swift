import Foundation

public struct DesktopRecorderControllerError: Error, Equatable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

public struct DeliveredRecording: Equatable, Sendable {
    public var videoUploadId: String
    public var clickTrackUploadId: String
    public var reviewUrl: String

    public init(videoUploadId: String, clickTrackUploadId: String, reviewUrl: String) {
        self.videoUploadId = videoUploadId
        self.clickTrackUploadId = clickTrackUploadId
        self.reviewUrl = reviewUrl
    }
}

/// Port of `DesktopRecorderController`: the eight-state session machine,
/// external-stop collection, delivery and retry. Polling is driven by the
/// caller through `refreshRecordingStatus()`.
@MainActor
public final class DesktopRecorderController {
    private let createBackend: () -> RecorderNativeBackend
    private let createOutputPath: () -> String
    private let canDeliver: () async throws -> Bool
    private let deliver: (DesktopRecorderRecording) async throws -> DeliveredRecording
    private let openReview: (String) -> Void
    private let onChange: () -> Void
    private let logError: (Error) -> Void

    private var featureEnabled = false
    private var backend: RecorderNativeBackend? = nil
    private var status: DesktopRecorderStatus = .unavailable
    private var sessionId: String? = nil
    private var elapsedMs: Double = 0
    private var error: DesktopRecorderError? = nil
    private var lastRecording: DesktopRecorderRecording? = nil

    public init(
        createBackend: @escaping () -> RecorderNativeBackend,
        createOutputPath: @escaping () -> String,
        canDeliver: @escaping () async throws -> Bool,
        deliver: @escaping (DesktopRecorderRecording) async throws -> DeliveredRecording,
        openReview: @escaping (String) -> Void,
        onChange: @escaping () -> Void = {},
        logError: @escaping (Error) -> Void = { _ in }
    ) {
        self.createBackend = createBackend
        self.createOutputPath = createOutputPath
        self.canDeliver = canDeliver
        self.deliver = deliver
        self.openReview = openReview
        self.onChange = onChange
        self.logError = logError
    }

    public var state: DesktopRecorderState {
        guard featureEnabled else { return .unavailable }
        return DesktopRecorderState(
            available: true, status: status, sessionId: sessionId, elapsedMs: elapsedMs, error: error,
            lastRecording: lastRecording
        )
    }

    /// Turning the feature off releases the helper; an in-flight recording is
    /// stopped first so the file is finalized rather than truncated.
    public func setFeatureEnabled(_ enabled: Bool) {
        if featureEnabled == enabled { return }
        featureEnabled = enabled
        if enabled {
            status = .idle
            onChange()
            return
        }
        Task { await self.releaseAfterDisable() }
    }

    public func getCapabilities() async throws -> DesktopRecorderCapabilities {
        try await requireBackend().getCapabilities()
    }

    public func ensureScreenRecordingPermission() async throws {
        let granted = try await requireBackend().requestScreenRecordingPermission()
        if !granted {
            throw DesktopRecorderControllerError("Okou needs Screen Recording permission in System Settings")
        }
    }

    public func listSources() async throws -> [DesktopRecorderSource] {
        try await requireBackend().listSources()
    }

    public func listWindowPreviews() async throws -> [DesktopRecorderWindowPreview] {
        try await requireBackend().listWindowPreviews()
    }

    public func prepare(_ request: DesktopRecorderPrepareRequest) async throws {
        let backend = try requireBackend()
        try requireStatus(.idle)
        guard try await canDeliver() else {
            error = DesktopRecorderError(code: .signedOut, message: "Sign in to Okou before recording so the result can be delivered")
            onChange()
            throw DesktopRecorderControllerError("Cannot record while signed out of Okou")
        }
        setStatus(.preparing)
        let prepared: DesktopRecorderPrepareResult
        do {
            prepared = try await backend.prepare(request)
        } catch {
            // A denied grant must return the machine to idle or every later
            // attempt fails the idle check for the process lifetime.
            if featureEnabled {
                setStatus(.idle)
            }
            throw error
        }
        guard featureEnabled else { return }
        sessionId = prepared.sessionId
        error = nil
        setStatus(.ready)
    }

    public func start() async throws {
        let backend = try requireBackend()
        let sessionId = try requireSession()
        try requireStatus(.ready)
        try await backend.start(sessionId: sessionId, outputPath: createOutputPath())
        guard featureEnabled else { return }
        elapsedMs = 0
        setStatus(.recording)
    }

    public func pause() async throws {
        let backend = try requireBackend()
        let sessionId = try requireSession()
        try requireStatus(.recording)
        try await backend.pause(sessionId: sessionId)
        setStatus(.paused)
    }

    public func resume() async throws {
        let backend = try requireBackend()
        let sessionId = try requireSession()
        try requireStatus(.paused)
        try await backend.resume(sessionId: sessionId)
        setStatus(.recording)
    }

    /// Ends the capture and throws it away; nothing is kept for a retry.
    public func discard() async throws {
        let backend = try requireBackend()
        let sessionId = try requireSession()
        guard status == .recording || status == .paused else {
            throw DesktopRecorderControllerError("Screen recording is \(status.rawValue), expected recording")
        }
        try await backend.discard(sessionId: sessionId)
        self.sessionId = nil
        elapsedMs = 0
        error = nil
        lastRecording = nil
        setStatus(.idle)
    }

    @discardableResult
    public func stop() async throws -> DesktopRecorderRecording {
        let backend = try requireBackend()
        let sessionId = try requireSession()
        let resumeStatus = status
        guard resumeStatus == .recording || resumeStatus == .paused else {
            throw DesktopRecorderControllerError("Screen recording is \(status.rawValue), expected recording")
        }
        setStatus(.finalizing)
        let recording: DesktopRecorderRecording
        do {
            recording = try await backend.stop(sessionId: sessionId)
        } catch {
            // A rejected stop goes back to the previous status so it can be
            // retried instead of stranding the machine in finalizing.
            if featureEnabled {
                self.error = DesktopRecorderError(code: .captureFailed, message: String(describing: error))
                setStatus(resumeStatus)
                onChange()
            }
            throw error
        }
        guard featureEnabled else { return recording }
        lastRecording = recording
        self.sessionId = nil
        if let failure = recording.failure {
            failSession(failure)
            return recording
        }
        await runDelivery(recording)
        return recording
    }

    public func retryDelivery() async throws {
        guard let recording = lastRecording else {
            throw DesktopRecorderControllerError("There is no recording to deliver")
        }
        try requireStatus(.idle)
        await runDelivery(recording)
    }

    /// Delivery failures are captured into state: the files on disk are
    /// intact and retryable.
    private func runDelivery(_ recording: DesktopRecorderRecording) async {
        setStatus(.delivering)
        do {
            let delivered = try await deliver(recording)
            error = nil
            setStatus(.idle)
            openReview(delivered.reviewUrl)
        } catch {
            self.error = DesktopRecorderError(code: .deliveryFailed, message: String(describing: error))
            setStatus(.idle)
        }
    }

    /// Pulls the native status while a capture is in flight; a paused capture
    /// is deliberately left alone.
    public func refreshRecordingStatus() async throws {
        guard status == .recording, let sessionId, let backend else { return }
        let native = try await backend.getStatus(sessionId: sessionId)
        guard status == .recording, self.sessionId == sessionId else { return }
        switch native.status {
        case .stopped:
            await collectAfterExternalStop(sessionId: sessionId, failure: nil)
        case .failed:
            await collectAfterExternalStop(
                sessionId: sessionId,
                failure: native.error ?? DesktopRecorderError(code: .captureFailed, message: "Screen recording stopped unexpectedly")
            )
        case .ready, .recording, .paused:
            if native.elapsedMs != elapsedMs {
                elapsedMs = native.elapsedMs
                onChange()
            }
        }
    }

    private func collectAfterExternalStop(sessionId: String, failure: DesktopRecorderError?) async {
        guard let backend else { return }
        setStatus(.finalizing)
        let recording: DesktopRecorderRecording
        do {
            recording = try await backend.stop(sessionId: sessionId)
        } catch {
            logError(error)
            failSession(failure ?? DesktopRecorderError(code: .captureFailed, message: "Screen recording could not be finalized"))
            return
        }
        lastRecording = recording
        self.sessionId = nil
        elapsedMs = 0
        if let reason = failure ?? recording.failure {
            failSession(reason)
            return
        }
        await runDelivery(recording)
    }

    private func failSession(_ failure: DesktopRecorderError) {
        error = failure
        sessionId = nil
        elapsedMs = 0
        setStatus(.idle)
    }

    private func setStatus(_ next: DesktopRecorderStatus) {
        if status == next { return }
        status = next
        onChange()
    }

    private func requireBackend() throws -> RecorderNativeBackend {
        guard featureEnabled else {
            throw DesktopRecorderControllerError("Desktop screen recording is disabled")
        }
        if let backend { return backend }
        let created = createBackend()
        backend = created
        return created
    }

    private func requireSession() throws -> String {
        guard let sessionId else {
            throw DesktopRecorderControllerError("No prepared screen recording session")
        }
        return sessionId
    }

    private func requireStatus(_ expected: DesktopRecorderStatus) throws {
        guard status == expected else {
            throw DesktopRecorderControllerError("Screen recording is \(status.rawValue), expected \(expected.rawValue)")
        }
    }

    private func releaseAfterDisable() async {
        let sessionId = self.sessionId
        let wasRecording = status == .recording
        status = .unavailable
        self.sessionId = nil
        elapsedMs = 0
        error = nil
        lastRecording = nil
        onChange()
        guard let backend else { return }
        self.backend = nil
        if let sessionId, wasRecording {
            do {
                _ = try await backend.stop(sessionId: sessionId)
            } catch {
                logError(error)
            }
        }
        backend.dispose()
    }
}
