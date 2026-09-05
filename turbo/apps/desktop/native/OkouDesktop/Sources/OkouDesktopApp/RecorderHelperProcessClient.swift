#if canImport(AppKit)
import Foundation
import OkouDesktopKit

/// Line-protocol client for `screen-recorder-helper`. Port of
/// `RecorderHelperClient`: unlike the Computer Use client a timed-out request
/// never kills the helper, because the process owns the in-flight capture.
final class RecorderHelperProcessClient: RecorderNativeBackend, @unchecked Sendable {
    static let stderrTailLimit = 2_000

    private struct Pending {
        let continuation: CheckedContinuation<[String: JSONValue], Error>
        let timeout: Task<Void, Never>
    }

    private let helperPath: String
    private let requestTimeoutMs: Double
    private let lock = NSLock()
    private var process: Process? = nil
    private var stdin: Pipe? = nil
    private var stdoutBuffer = Data()
    private var stderrTail = ""
    private var requestCounter = 0
    private var closed = false
    private var pending: [String: Pending] = [:]

    init(helperPath: String, requestTimeoutMs: Double = RecorderHelperResults.requestTimeoutMs) {
        self.helperPath = helperPath
        self.requestTimeoutMs = requestTimeoutMs
    }

    private static func unavailable(_ message: String) -> DesktopRecorderError {
        DesktopRecorderError(code: .helperUnavailable, message: message)
    }

    // MARK: Protocol

    private func request(_ kind: String, _ payload: [String: JSONValue] = [:], timeoutMs: Double? = nil) async throws -> [String: JSONValue] {
        if lock.withLock({ closed }) {
            throw Self.unavailable("Screen recorder helper is closed")
        }
        let stdin = try ensureChild()
        let id: String = lock.withLock {
            requestCounter += 1
            return "recorder_\(requestCounter)"
        }
        let line = JSONValue.object(["id": .string(id), "kind": .string(kind), "payload": .object(payload)]).serialized() + "\n"
        let budget = timeoutMs ?? requestTimeoutMs
        return try await withCheckedThrowingContinuation { continuation in
            let timeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(budget * 1_000_000))
                guard !Task.isCancelled, let self, let pending = self.takePending(id) else { return }
                pending.continuation.resume(throwing: DesktopRecorderError(code: .captureFailed, message: "Screen recorder helper timed out running \(kind)"))
            }
            lock.withLock { pending[id] = Pending(continuation: continuation, timeout: timeout) }
            do {
                try stdin.fileHandleForWriting.write(contentsOf: Data(line.utf8))
            } catch {
                if let pending = takePending(id) {
                    pending.continuation.resume(throwing: Self.unavailable("Screen recorder helper is unavailable: \(error.localizedDescription)"))
                }
            }
        }
    }

    private func takePending(_ id: String) -> Pending? {
        lock.withLock {
            guard let value = pending.removeValue(forKey: id) else { return nil }
            value.timeout.cancel()
            return value
        }
    }

    private func ensureChild() throws -> Pipe {
        if let stdin = lock.withLock({ self.stdin }) {
            return stdin
        }
        let process = Process()
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: helperPath)
        process.arguments = ["serve"]
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self?.handleStdout(data)
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            let text = String(decoding: data, as: UTF8.self)
            NSLog("[screen-recorder-helper] %@", text.trimmingCharacters(in: .whitespacesAndNewlines))
            self?.lock.withLock {
                guard let self else { return }
                self.stderrTail = String((self.stderrTail + text).suffix(Self.stderrTailLimit))
            }
        }
        process.terminationHandler = { [weak self] process in
            self?.handleClose(status: process.terminationStatus, reason: process.terminationReason)
        }
        lock.withLock {
            self.process = process
            self.stdin = stdin
            self.stdoutBuffer = Data()
        }
        do {
            try process.run()
        } catch {
            lock.withLock {
                self.process = nil
                self.stdin = nil
            }
            throw Self.unavailable("Screen recorder helper failed to start: \(error.localizedDescription)")
        }
        return stdin
    }

    private func handleStdout(_ data: Data) {
        var lines: [String] = []
        lock.withLock {
            stdoutBuffer.append(data)
            while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
                let lineData = stdoutBuffer.subdata(in: stdoutBuffer.startIndex..<newline)
                stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...newline)
                let line = String(decoding: lineData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                if !line.isEmpty {
                    lines.append(line)
                }
            }
        }
        for line in lines {
            // Anything that is not a correlated frame is dropped; every
            // request has its own timeout to fall back on.
            guard let frame = RecorderHelperResults.parseResponseLine(line), let pending = takePending(frame.id) else { continue }
            do {
                pending.continuation.resume(returning: try RecorderHelperResults.responseResult(frame.value))
            } catch {
                pending.continuation.resume(throwing: error)
            }
        }
    }

    private func handleClose(status: Int32, reason: Process.TerminationReason) {
        let (requests, message): ([Pending], String) = lock.withLock {
            let all = Array(pending.values)
            pending.removeAll()
            process = nil
            stdin = nil
            let tail = stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
            let base = reason == .uncaughtSignal
                ? "Screen recorder helper exited with signal \(status)"
                : "Screen recorder helper exited with code \(status)"
            return (all, tail.isEmpty ? base : "\(base): \(tail)")
        }
        for request in requests {
            request.timeout.cancel()
            request.continuation.resume(throwing: Self.unavailable(message))
        }
    }

    // MARK: RecorderNativeBackend

    func dispose() {
        let (requests, process): ([Pending], Process?) = lock.withLock {
            closed = true
            let all = Array(pending.values)
            pending.removeAll()
            let running = self.process
            self.process = nil
            self.stdin = nil
            return (all, running)
        }
        for request in requests {
            request.timeout.cancel()
            request.continuation.resume(throwing: Self.unavailable("Screen recorder helper was closed"))
        }
        if let process, process.isRunning {
            process.terminate()
        }
    }

    func getCapabilities() async throws -> DesktopRecorderCapabilities {
        try RecorderHelperResults.capabilities(try await request("recorder.capabilities"))
    }

    func requestScreenRecordingPermission() async throws -> Bool {
        try RecorderHelperResults.requiredBoolean(try await request("recorder.requestPermission"), "granted")
    }

    func listSources() async throws -> [DesktopRecorderSource] {
        try RecorderHelperResults.sources(try await request("recorder.sources"))
    }

    func listWindowPreviews() async throws -> [DesktopRecorderWindowPreview] {
        try RecorderHelperResults.previews(try await request("recorder.windowPreviews"))
    }

    func prepare(_ prepareRequest: DesktopRecorderPrepareRequest) async throws -> DesktopRecorderPrepareResult {
        try RecorderHelperResults.prepareResult(try await request("recorder.prepare", RecorderHelperResults.prepareRequestPayload(prepareRequest)))
    }

    func start(sessionId: String, outputPath: String) async throws {
        _ = try await request("recorder.start", ["sessionId": .string(sessionId), "outputPath": .string(outputPath)])
    }

    func pause(sessionId: String) async throws {
        _ = try await request("recorder.pause", ["sessionId": .string(sessionId)])
    }

    func resume(sessionId: String) async throws {
        _ = try await request("recorder.resume", ["sessionId": .string(sessionId)])
    }

    func discard(sessionId: String) async throws {
        _ = try await request("recorder.discard", ["sessionId": .string(sessionId)])
    }

    func stop(sessionId: String) async throws -> DesktopRecorderRecording {
        try RecorderHelperResults.recording(try await request("recorder.stop", ["sessionId": .string(sessionId)], timeoutMs: RecorderHelperResults.stopTimeoutMs))
    }

    func getStatus(sessionId: String) async throws -> DesktopRecorderNativeStatus {
        try RecorderHelperResults.status(try await request("recorder.state", ["sessionId": .string(sessionId)]))
    }
}
#endif
