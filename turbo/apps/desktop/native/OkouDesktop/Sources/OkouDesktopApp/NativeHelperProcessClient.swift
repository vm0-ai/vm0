#if canImport(AppKit)
import Foundation
import OkouDesktopKit

/// Long-lived `computer-use-helper serve` process. Port of
/// `ComputerUseNativeRuntimeClient`: newline-delimited JSON over stdio, one
/// request in flight at a time, a wedged helper replaced on timeout, and a
/// stdin-EOF → SIGTERM → SIGKILL shutdown ladder.
final class NativeHelperProcessClient: ComputerUseNativeBackend, @unchecked Sendable {
    static let defaultRequestTimeoutMs: Double = 60_000
    static let defaultShutdownGraceMs: Double = 1_000
    static let stderrLimit = 8_000

    enum TerminationReason: String {
        case dispose
        case appQuit = "app_quit"
        case updateRelaunch = "update_relaunch"
        case timeoutReplace = "timeout_replace"
        case unexpectedExit = "unexpected_exit"
    }

    final class HelperProcess {
        let process = Process()
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        var stdoutBuffer = Data()
        var stderrText = ""
        var closed = false
        var terminalErrorReported = false
        var stopReason: TerminationReason? = nil
        var sentSignal: Int32? = nil
    }

    private struct PendingRequest {
        let kind: String
        let runtime: HelperProcess
        let continuation: CheckedContinuation<[String: JSONValue], Error>
        let timeout: Task<Void, Never>
    }

    private enum State {
        case open
        case closing
        case closed
    }

    let helperPath: String
    private let requestTimeoutMs: Double
    private let shutdownGraceMs: Double
    private let onRuntimeError: (ComputerUseNativeHelperError, [String: String]) -> Void
    private let lock = NSLock()
    private var runtime: HelperProcess? = nil
    private var requestCounter = 0
    private var state: State = .open
    private var pending: [String: PendingRequest] = [:]
    private var queueTail: Task<Void, Never> = Task {}
    private var disposeTask: Task<Void, Never>? = nil

    init(
        helperPath: String,
        requestTimeoutMs: Double = NativeHelperProcessClient.defaultRequestTimeoutMs,
        shutdownGraceMs: Double = NativeHelperProcessClient.defaultShutdownGraceMs,
        onRuntimeError: @escaping (ComputerUseNativeHelperError, [String: String]) -> Void = { _, _ in }
    ) {
        self.helperPath = helperPath
        self.requestTimeoutMs = requestTimeoutMs
        self.shutdownGraceMs = shutdownGraceMs
        self.onRuntimeError = onRuntimeError
    }

    /// Bundled helper first, then the SwiftPM build products for development.
    static func resolveHelperPath(name: String) -> String {
        var candidates: [String] = []
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("native").appendingPathComponent(name).path)
        }
        if let override = ProcessInfo.processInfo.environment["OKOU_DESKTOP_NATIVE_DIR"], !override.isEmpty {
            candidates.append((override as NSString).appendingPathComponent(name))
        }
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return candidates.first ?? name
    }

    private static func closedError() -> ComputerUseNativeHelperError {
        ComputerUseNativeHelperError(message: "Native Computer Use runtime is closed")
    }

    // MARK: Requests

    func run(kind: String, payload: [String: JSONValue]) async throws -> [String: JSONValue] {
        let previous: Task<Void, Never> = lock.withLock {
            let tail = queueTail
            return tail
        }
        guard lock.withLock({ state == .open }) else {
            throw Self.closedError()
        }
        let request = Task<[String: JSONValue], Error> { [self] in
            await previous.value
            guard lock.withLock({ state == .open }) else {
                throw Self.closedError()
            }
            return try await dispatch(kind: kind, payload: payload)
        }
        lock.withLock {
            queueTail = Task { _ = try? await request.value }
        }
        return try await request.value
    }

    private func dispatch(kind: String, payload: [String: JSONValue]) async throws -> [String: JSONValue] {
        let runtime = try ensureRuntime(kind: kind)
        let id: String = lock.withLock {
            requestCounter += 1
            return "desktop_\(requestCounter)"
        }
        let line = JSONValue.object(["id": .string(id), "kind": .string(kind), "payload": .object(payload)]).serialized() + "\n"
        return try await withCheckedThrowingContinuation { continuation in
            let timeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(self?.requestTimeoutMs ?? 0) * 1_000_000)
                guard !Task.isCancelled else { return }
                self?.timeOut(id: id, kind: kind, runtime: runtime)
            }
            lock.withLock {
                pending[id] = PendingRequest(kind: kind, runtime: runtime, continuation: continuation, timeout: timeout)
            }
            do {
                try runtime.stdin.fileHandleForWriting.write(contentsOf: Data(line.utf8))
            } catch {
                if let request = takePending(id: id), request.runtime === runtime {
                    let helperError = ComputerUseNativeHelperError(message: "Unable to write to native Computer Use runtime: \(error.localizedDescription)")
                    report(helperError, ["mode": "serve", "requestKind": kind, "stage": "write"])
                    request.continuation.resume(throwing: helperError)
                }
            }
        }
    }

    private func takePending(id: String) -> PendingRequest? {
        lock.withLock {
            guard let request = pending.removeValue(forKey: id) else { return nil }
            request.timeout.cancel()
            return request
        }
    }

    private func timeOut(id: String, kind: String, runtime: HelperProcess) {
        guard let request = takePending(id: id) else { return }
        lock.withLock {
            if self.runtime === runtime {
                self.runtime = nil
            }
            runtime.stopReason = .timeoutReplace
            runtime.terminalErrorReported = true
        }
        signal(runtime, SIGKILL)
        let helperError = ComputerUseNativeHelperError(message: "Native Computer Use runtime timed out running \(kind)")
        report(helperError, ["mode": "serve", "requestKind": kind, "stage": "timeout", "terminationReason": "timeout_replace"])
        request.continuation.resume(throwing: helperError)
    }

    // MARK: Process lifecycle

    private func ensureRuntime(kind: String) throws -> HelperProcess {
        if let existing = lock.withLock({ runtime }) {
            return existing
        }
        guard lock.withLock({ state == .open }) else {
            throw Self.closedError()
        }
        let runtime = HelperProcess()
        let process = runtime.process
        process.executableURL = URL(fileURLWithPath: helperPath)
        process.arguments = ["serve"]
        process.standardInput = runtime.stdin
        process.standardOutput = runtime.stdout
        process.standardError = runtime.stderr
        runtime.stdout.fileHandleForReading.readabilityHandler = { [weak self, weak runtime] handle in
            guard let self, let runtime else { return }
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self.handleStdout(runtime, data)
        }
        runtime.stderr.fileHandleForReading.readabilityHandler = { [weak self, weak runtime] handle in
            guard let self, let runtime else { return }
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self.lock.withLock {
                runtime.stderrText += String(decoding: data, as: UTF8.self)
                if runtime.stderrText.count > Self.stderrLimit {
                    runtime.stderrText = String(runtime.stderrText.suffix(Self.stderrLimit))
                }
            }
        }
        process.terminationHandler = { [weak self, weak runtime] process in
            guard let self, let runtime else { return }
            self.handleClose(runtime, status: process.terminationStatus, reason: process.terminationReason)
        }
        lock.withLock { self.runtime = runtime }
        do {
            try process.run()
        } catch {
            lock.withLock {
                runtime.closed = true
                if self.runtime === runtime { self.runtime = nil }
            }
            let helperError = ComputerUseNativeHelperError(message: "Unable to start native Computer Use runtime: \(error.localizedDescription)")
            report(helperError, ["mode": "serve", "requestKind": kind, "stage": "spawn"])
            throw helperError
        }
        return runtime
    }

    private func handleStdout(_ runtime: HelperProcess, _ data: Data) {
        var lines: [String] = []
        lock.withLock {
            runtime.stdoutBuffer.append(data)
            while let newline = runtime.stdoutBuffer.firstIndex(of: 0x0A) {
                let lineData = runtime.stdoutBuffer.subdata(in: runtime.stdoutBuffer.startIndex..<newline)
                runtime.stdoutBuffer.removeSubrange(runtime.stdoutBuffer.startIndex...newline)
                let line = String(decoding: lineData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                if !line.isEmpty {
                    lines.append(line)
                }
            }
        }
        for line in lines {
            handleResponseLine(runtime, line)
        }
    }

    private func handleResponseLine(_ runtime: HelperProcess, _ line: String) {
        var requestKind = "runtime"
        do {
            let parsed = try JSONValue.parse(line)
            guard let id = parsed["id"]?.stringValue else {
                throw ComputerUseNativeHelperError(message: "Native Computer Use runtime returned an uncorrelated response")
            }
            let request: PendingRequest? = lock.withLock {
                guard let candidate = pending[id], candidate.runtime === runtime else { return nil }
                pending.removeValue(forKey: id)
                candidate.timeout.cancel()
                return candidate
            }
            guard let request else { return }
            requestKind = request.kind
            switch try NativeHelperResults.parseResponse(parsed) {
            case let .succeeded(result):
                request.continuation.resume(returning: result)
            case let .failed(code, message):
                request.continuation.resume(throwing: NativeHelperResults.failure(code: code, message: message))
            }
        } catch {
            let helperError = (error as? ComputerUseNativeHelperError) ?? ComputerUseNativeHelperError(message: String(describing: error))
            report(helperError, ["mode": "serve", "requestKind": requestKind, "stage": "protocol", "stderr": stderrTail(runtime)])
            rejectRuntime(runtime, helperError)
        }
    }

    private func stderrTail(_ runtime: HelperProcess) -> String {
        lock.withLock { runtime.stderrText.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private func handleClose(_ runtime: HelperProcess, status: Int32, reason: Process.TerminationReason) {
        let shouldReport: Bool = lock.withLock {
            runtime.closed = true
            if self.runtime === runtime {
                self.runtime = nil
            }
            if runtime.terminalErrorReported || isExpectedExit(runtime, status: status, reason: reason) {
                return false
            }
            runtime.terminalErrorReported = true
            return true
        }
        guard shouldReport else { return }
        let stderr = stderrTail(runtime)
        let fallback = reason == .uncaughtSignal
            ? "Native Computer Use runtime terminated by signal \(status)"
            : "Native Computer Use runtime exited with status \(status)"
        let helperError = ComputerUseNativeHelperError(message: stderr.isEmpty ? fallback : stderr)
        report(helperError, [
            "mode": "serve", "requestKind": "runtime", "stage": "exit", "exitCode": "\(status)",
            "terminationReason": "unexpected_exit", "stderr": stderr,
        ])
        rejectRuntime(runtime, helperError)
    }

    private func isExpectedExit(_ runtime: HelperProcess, status: Int32, reason: Process.TerminationReason) -> Bool {
        guard let stopReason = runtime.stopReason else { return false }
        if reason == .exit, status == 0 { return true }
        if reason == .uncaughtSignal, let sent = runtime.sentSignal, sent == status { return true }
        switch stopReason {
        case .dispose, .appQuit, .updateRelaunch:
            return reason == .uncaughtSignal && (status == SIGTERM || status == SIGINT)
        case .timeoutReplace, .unexpectedExit:
            return false
        }
    }

    private func signal(_ runtime: HelperProcess, _ signal: Int32) {
        let pid: Int32? = lock.withLock {
            guard !runtime.closed, runtime.process.isRunning else { return nil }
            runtime.sentSignal = signal
            return runtime.process.processIdentifier
        }
        guard let pid else { return }
        kill(pid, signal)
    }

    private func report(_ error: ComputerUseNativeHelperError, _ context: [String: String]) {
        var merged = context
        merged["helperPath"] = helperPath
        merged["pendingRequestCount"] = lock.withLock { "\(pending.count)" }
        onRuntimeError(error, merged)
    }

    private func rejectRuntime(_ runtime: HelperProcess, _ error: ComputerUseNativeHelperError) {
        let requests: [PendingRequest] = lock.withLock {
            let matching = pending.filter { $0.value.runtime === runtime }
            for key in matching.keys {
                pending.removeValue(forKey: key)
            }
            return Array(matching.values)
        }
        for request in requests {
            request.timeout.cancel()
            request.continuation.resume(throwing: error)
        }
    }

    private func rejectAll(_ error: ComputerUseNativeHelperError) {
        let requests: [PendingRequest] = lock.withLock {
            let all = Array(pending.values)
            pending.removeAll()
            return all
        }
        for request in requests {
            request.timeout.cancel()
            request.continuation.resume(throwing: error)
        }
    }

    // MARK: Shutdown

    func dispose(reason: ComputerUseNativeShutdownReason) async {
        let task: Task<Void, Never> = lock.withLock {
            if let disposeTask { return disposeTask }
            state = .closing
            let runtime = self.runtime
            let created = Task { [self] in
                rejectAll(Self.closedError())
                if let runtime {
                    await stopRuntime(runtime, reason: reason)
                }
                lock.withLock {
                    if self.runtime === runtime { self.runtime = nil }
                    state = .closed
                }
            }
            disposeTask = created
            return created
        }
        await task.value
    }

    private func stopRuntime(_ runtime: HelperProcess, reason: ComputerUseNativeShutdownReason) async {
        let stopReason: TerminationReason
        switch reason {
        case .dispose: stopReason = .dispose
        case .appQuit: stopReason = .appQuit
        case .updateRelaunch: stopReason = .updateRelaunch
        }
        let alreadyClosed: Bool = lock.withLock {
            runtime.stopReason = stopReason
            return runtime.closed
        }
        if alreadyClosed { return }
        // stdin EOF is the graceful shutdown request; escalate only if ignored.
        try? runtime.stdin.fileHandleForWriting.close()
        if await waitForClose(runtime) { return }
        signal(runtime, SIGTERM)
        if await waitForClose(runtime) { return }
        signal(runtime, SIGKILL)
        if await waitForClose(runtime) { return }
        lock.withLock { runtime.terminalErrorReported = true }
        report(
            ComputerUseNativeHelperError(message: "Native Computer Use runtime did not exit after SIGKILL"),
            ["mode": "serve", "requestKind": "runtime", "stage": "shutdown", "terminationReason": stopReason.rawValue]
        )
    }

    private func waitForClose(_ runtime: HelperProcess) async -> Bool {
        let deadline = Date().addingTimeInterval(shutdownGraceMs / 1000)
        while Date() < deadline {
            if lock.withLock({ runtime.closed }) { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return lock.withLock { runtime.closed }
    }
}
#endif
