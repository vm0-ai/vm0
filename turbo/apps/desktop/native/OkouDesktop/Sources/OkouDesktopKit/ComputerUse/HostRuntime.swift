import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public enum SystemInfo {
    private static func utsnameField<T>(_ field: T) -> String {
        var copy = field
        return withUnsafePointer(to: &copy) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: MemoryLayout<T>.size) { String(cString: $0) }
        }
    }

    /// `${os.type()} ${os.release()}`, e.g. `Darwin 24.5.0`.
    public static func osVersionString() -> String {
        var info = utsname()
        uname(&info)
        let sysname = utsnameField(info.sysname)
        let release = utsnameField(info.release)
        return "\(sysname) \(release)"
    }

    public static func hostname() -> String {
        var buffer = [CChar](repeating: 0, count: 256)
        guard gethostname(&buffer, buffer.count) == 0 else { return "" }
        return String(cString: buffer)
    }

    /// `os.hostname().trim().replace(/\s+/g, " ") || fallback`.
    public static func systemHostName(fallback: String) -> String {
        let name = hostname().split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        return name.isEmpty ? fallback : name
    }

    /// Hostname with a trailing `.local` stripped, shown under the online status.
    public static func friendlyDeviceName() -> String? {
        let name = hostname().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        if name.lowercased().hasSuffix(".local") {
            return String(name.dropLast(".local".count))
        }
        return name
    }
}

public struct ComputerUseHttpError: Error, CustomStringConvertible {
    public let message: String
    public let status: Int
    public let retryAfterMs: Double?

    public init(message: String, response: DesktopHTTPResponse, nowMs: Double) {
        self.message = message
        self.status = response.status
        self.retryAfterMs = ComputerUseHostRuntime.retryAfterDelayMs(response, nowMs: nowMs)
    }

    public var description: String { message }
}

struct ComputerUseHostTokenUnavailableError: Error, CustomStringConvertible {
    var description: String { "Computer Use host token is not available" }
}

struct ComputerUseHostRequestTimeoutError: Error, CustomStringConvertible {
    let label: String
    let timeoutMs: Double

    var description: String { "Computer Use \(label) timed out after \(Int(timeoutMs))ms" }
}

/// Port of `ComputerUseHostRuntime`: registration, heartbeat, adaptive
/// command polling, completion retries and recovery backoff.
@MainActor
public final class ComputerUseHostRuntime {
    public static let heartbeatPollMs: Double = 2_000
    public static let commandColdPollMs: Double = 5_000
    public static let commandBurstPollMs: Double = 500
    public static let commandBurstWindowMs: Double = 10_000
    public static let commandActivePollMs: Double = 1_000
    public static let commandActiveWindowMs: Double = 60_000
    public static let recoveryRetryBaseMs: Double = 2_000
    public static let recoveryRetryMaxMs: Double = 60_000
    public static let recoveryRetryAfterMaxMs: Double = 5 * 60_000
    public static let heartbeatRequestTimeoutMs: Double = 10_000
    public static let commandPollRequestTimeoutMs: Double = 30_000
    public static let commandCompletionRequestTimeoutMs: Double = 60_000
    public static let commandCompletionRetryDelayMs: Double = 2_000
    public static let commandCompletionMaxAttempts = 3
    public static let errorLogLimit = 20
    public static let localCommandLogLimit = 20
    public static let localCommandLogOmittedResultKeys: Set<String> = ["appState", "elements", "screenshot", "visibleElements"]

    public struct Options {
        public var platformUrl: URL
        public var installationId: String
        public var hostName: String
        public var appVersion: String
        public var sessionFetch: DesktopFetch
        public var hostFetch: DesktopFetch
        public var clientHeaders: DesktopClientHeaders
        public var getPermissions: () async throws -> ComputerUsePermissionState
        public var getSupportedCapabilities: () -> [String]
        public var executeCommand: (ComputerUseCommand, ComputerUsePermissionState) async throws -> ComputerUseCommandExecutionResult
        public var onCommandFailure: (ComputerUseCommand, ComputerUseCommandFailure) -> Void
        public var onChange: () -> Void
        public var now: () -> Double
        public var sleep: (Double) async -> Void

        public init(
            platformUrl: URL, installationId: String, hostName: String, appVersion: String,
            sessionFetch: @escaping DesktopFetch, hostFetch: @escaping DesktopFetch, clientHeaders: DesktopClientHeaders,
            getPermissions: @escaping () async throws -> ComputerUsePermissionState,
            getSupportedCapabilities: @escaping () -> [String] = { ComputerUseCapabilities.supported },
            executeCommand: @escaping (ComputerUseCommand, ComputerUsePermissionState) async throws -> ComputerUseCommandExecutionResult,
            onCommandFailure: @escaping (ComputerUseCommand, ComputerUseCommandFailure) -> Void = { _, _ in },
            onChange: @escaping () -> Void = {},
            now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
            sleep: @escaping (Double) async -> Void = { ms in
                try? await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000))
            }
        ) {
            self.platformUrl = platformUrl
            self.installationId = installationId
            self.hostName = hostName
            self.appVersion = appVersion
            self.sessionFetch = sessionFetch
            self.hostFetch = hostFetch
            self.clientHeaders = clientHeaders
            self.getPermissions = getPermissions
            self.getSupportedCapabilities = getSupportedCapabilities
            self.executeCommand = executeCommand
            self.onCommandFailure = onCommandFailure
            self.onChange = onChange
            self.now = now
            self.sleep = sleep
        }
    }

    private let options: Options
    private let apiBaseUrl: String
    private var running = false
    private var heartbeatTimer: Task<Void, Never>? = nil
    private var commandTimer: Task<Void, Never>? = nil
    private var recoveryTimer: Task<Void, Never>? = nil
    private var commandExecutionRunning = false
    private var draining = false
    private var lastCommandActivityAtMs: Double? = nil
    private var lastCommandCompletionAtMs: Double? = nil
    private var hostToken: String? = nil
    private var nextErrorLogId = 0
    public private(set) var state = ComputerUseHostRuntimeState.offline

    public init(options: Options) {
        self.options = options
        self.apiBaseUrl = resolveComputerUseApiBaseUrl(options.platformUrl)
    }

    // MARK: Helpers

    nonisolated static func retryDelayForAttempt(_ attempt: Int) -> Double {
        min(recoveryRetryMaxMs, recoveryRetryBaseMs * pow(2, Double(max(0, attempt - 1))))
    }

    nonisolated static func retryAfterDelayMs(_ response: DesktopHTTPResponse, nowMs: Double) -> Double? {
        guard let value = response.header("retry-after"), !value.isEmpty else { return nil }
        if let seconds = Double(value.trimmingCharacters(in: .whitespaces)), seconds.isFinite, seconds >= 0 {
            return min(seconds * 1_000, recoveryRetryAfterMaxMs)
        }
        guard let retryAtMs = HTTPDate.milliseconds(value) else { return nil }
        return min(max(0, retryAtMs - nowMs), recoveryRetryAfterMaxMs)
    }

    nonisolated static func isRetryableStatus(_ status: Int) -> Bool {
        status == 408 || status == 429 || status >= 500
    }

    nonisolated static func isRetryableRuntimeError(_ error: Error) -> Bool {
        if let httpError = error as? ComputerUseHttpError {
            return isRetryableStatus(httpError.status)
        }
        if error is ComputerUseHostTokenUnavailableError {
            return false
        }
        return true
    }

    nonisolated static func errorMessage(_ error: Error) -> String {
        String(describing: error)
    }

    nonisolated static func localCommandLogResult(_ result: [String: JSONValue]) -> [String: JSONValue] {
        var next: [String: JSONValue] = [:]
        var omitted: [String] = []
        for key in result.keys.sorted() {
            if localCommandLogOmittedResultKeys.contains(key) {
                omitted.append(key)
            } else {
                next[key] = result[key]
            }
        }
        if !omitted.isEmpty {
            next["omittedResultFields"] = .array(omitted.map(JSONValue.string))
        }
        return next
    }

    nonisolated public static func runtimeBody(
        installationId: String, hostName: String, appVersion: String, permissions: ComputerUsePermissionState,
        supportedCapabilities: [String]
    ) -> JSONValue {
        .object([
            "installationId": .string(installationId),
            "hostName": .string(hostName),
            "appVersion": .string(appVersion),
            "osVersion": .string(SystemInfo.osVersionString()),
            "supportedCapabilities": .array(supportedCapabilities.map(JSONValue.string)),
            "permissions": permissions.json,
        ])
    }

    private func runtimeBody() async throws -> JSONValue {
        Self.runtimeBody(
            installationId: options.installationId, hostName: options.hostName, appVersion: options.appVersion,
            permissions: try await options.getPermissions(), supportedCapabilities: options.getSupportedCapabilities()
        )
    }

    private func nowIso() -> String {
        ISOTimestamp.string(from: Date(timeIntervalSince1970: options.now() / 1000))
    }

    private func notify() {
        options.onChange()
    }

    // MARK: Public lifecycle

    public func start() async {
        if running { return }
        running = true
        draining = false
        do {
            guard let nextDelay = try await startHost() else {
                running = false
                return
            }
            scheduleHeartbeat(delayMs: nextDelay)
            scheduleCommandPoll(delayMs: commandPollDelayMs())
        } catch {
            _ = handleRuntimeFailure(phase: .start, error: error)
        }
    }

    public func stop() async {
        running = false
        draining = false
        clearHeartbeatTimer()
        clearCommandTimer()
        clearRecoveryTimer()
        lastCommandActivityAtMs = nil
        lastCommandCompletionAtMs = nil
        let token = hostToken
        state.status = .offline
        state.hostId = nil
        state.lastError = nil
        state.recovery = nil
        notify()
        guard let token else { return }
        hostToken = nil
        do {
            try await stopHost(token: token)
        } catch {
            setRuntimeErrorState(source: .stop, error: error)
        }
    }

    public func drainAndStop() async {
        draining = true
        clearCommandTimer()
        while commandExecutionRunning {
            await options.sleep(50)
        }
        await stop()
    }

    // MARK: State

    private func appendErrorLog(source: ComputerUseRuntimeErrorSource, message: String, hostId: String?) -> ComputerUseRuntimeErrorLogEntry {
        let occurredAt = nowIso()
        let entry = ComputerUseRuntimeErrorLogEntry(
            id: "\(occurredAt)-\(nextErrorLogId)", source: source, message: message, occurredAt: occurredAt, hostId: hostId
        )
        nextErrorLogId += 1
        state.errorLog = Array(([entry] + state.errorLog).prefix(Self.errorLogLimit))
        notify()
        return entry
    }

    private func setRuntimeErrorState(source: ComputerUseRuntimeErrorSource, error: Error, hostId: String?? = nil) {
        setRuntimeErrorState(source: source, message: Self.errorMessage(error), hostId: hostId)
    }

    private func setRuntimeErrorState(source: ComputerUseRuntimeErrorSource, message: String, hostId: String?? = nil) {
        let resolvedHostId: String? = hostId.map { $0 } ?? state.hostId
        let entry = appendErrorLog(source: source, message: message, hostId: resolvedHostId)
        state.status = .error
        state.hostId = resolvedHostId
        state.lastError = entry.message
        state.recovery = nil
        notify()
    }

    private func deactivateInvalidHostToken(source: ComputerUseRuntimeErrorSource) {
        hostToken = nil
        running = false
        clearHeartbeatTimer()
        clearCommandTimer()
        clearRecoveryTimer()
        let entry = appendErrorLog(source: source, message: ComputerUseStartupMessages.unauthenticated, hostId: nil)
        state.status = .unauthenticated
        state.hostId = nil
        state.lastError = entry.message
        state.recovery = nil
        notify()
    }

    private func setRuntimeRecoveryState(phase: ComputerUseRuntimeRecoveryPhase, error: Error, retryDelayMs: Double) {
        let entry = appendErrorLog(source: Self.errorSource(for: phase), message: Self.errorMessage(error), hostId: state.hostId)
        let lastRetryAtMs = options.now()
        let attempt = state.recovery?.phase == phase ? (state.recovery!.attempt + 1) : 1
        state.status = .recovering
        state.lastError = entry.message
        state.recovery = ComputerUseRuntimeRecoveryState(
            phase: phase,
            attempt: attempt,
            nextRetryAt: ISOTimestamp.string(from: Date(timeIntervalSince1970: (lastRetryAtMs + retryDelayMs) / 1000)),
            lastRetryAt: ISOTimestamp.string(from: Date(timeIntervalSince1970: lastRetryAtMs / 1000)),
            retryDelayMs: retryDelayMs
        )
        notify()
    }

    nonisolated static func errorSource(for phase: ComputerUseRuntimeRecoveryPhase) -> ComputerUseRuntimeErrorSource {
        switch phase {
        case .start: return .start
        case .heartbeat: return .heartbeat
        case .commandPoll: return .commandPoll
        }
    }

    private func startLocalCommandLogEntry(_ command: ComputerUseCommand, startedAt: String) {
        let entry = ComputerUseLocalCommandLogEntry(
            commandId: command.id, kind: command.kind, app: command.payload["app"]?.stringValue, status: .running,
            payload: command.payload, result: nil, error: nil, startedAt: startedAt, completedAt: nil, durationMs: nil
        )
        let others = state.localCommandLog.filter { $0.commandId != command.id }
        state.localCommandLog = Array(([entry] + others).prefix(Self.localCommandLogLimit))
        notify()
    }

    private func finishLocalCommandLogEntry(
        commandId: String, status: ComputerUseLocalCommandLogStatus, result: [String: JSONValue]?, error: [String: JSONValue]?,
        completedAt: String, durationMs: Double
    ) {
        state.localCommandLog = state.localCommandLog.map { entry in
            guard entry.commandId == commandId else { return entry }
            var updated = entry
            updated.status = status
            updated.result = result.map(Self.localCommandLogResult)
            updated.error = error
            updated.completedAt = completedAt
            updated.durationMs = durationMs
            return updated
        }
        notify()
    }

    // MARK: Timers

    private func clearHeartbeatTimer() {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
    }

    private func clearCommandTimer() {
        commandTimer?.cancel()
        commandTimer = nil
    }

    private func clearRecoveryTimer() {
        recoveryTimer?.cancel()
        recoveryTimer = nil
    }

    private func scheduleRecovery(phase: ComputerUseRuntimeRecoveryPhase, error: Error) {
        guard running else { return }
        clearRecoveryTimer()
        let nextAttempt = state.recovery?.phase == phase ? (state.recovery!.attempt + 1) : 1
        let retryDelayMs = (error as? ComputerUseHttpError)?.retryAfterMs ?? Self.retryDelayForAttempt(nextAttempt)
        setRuntimeRecoveryState(phase: phase, error: error, retryDelayMs: retryDelayMs)
        let sleep = options.sleep
        recoveryTimer = Task { @MainActor [weak self] in
            await sleep(retryDelayMs)
            guard !Task.isCancelled, let self else { return }
            self.recoveryTimer = nil
            await self.recoverRuntime(phase: phase)
        }
    }

    private enum FailureOutcome {
        case scheduledRecovery
        case stopped
    }

    private func handleRuntimeFailure(phase: ComputerUseRuntimeRecoveryPhase, error: Error) -> FailureOutcome {
        guard running else { return .stopped }
        if !Self.isRetryableRuntimeError(error) {
            setRuntimeErrorState(source: Self.errorSource(for: phase), error: error)
            running = false
            clearHeartbeatTimer()
            clearCommandTimer()
            clearRecoveryTimer()
            return .stopped
        }
        if phase != .commandPoll {
            clearCommandTimer()
        }
        scheduleRecovery(phase: phase, error: error)
        return .scheduledRecovery
    }

    private func clearRecoveryState(phase: ComputerUseRuntimeRecoveryPhase) {
        guard state.recovery?.phase == phase else { return }
        clearRecoveryTimer()
        state.status = .online
        state.lastError = nil
        state.recovery = nil
        notify()
    }

    private func recoverRuntime(phase: ComputerUseRuntimeRecoveryPhase) async {
        guard running else { return }
        switch phase {
        case .start:
            await recoverStart()
        case .heartbeat:
            await recoverHeartbeat()
        case .commandPoll:
            await commandLoop()
        }
    }

    private func recoverStart() async {
        do {
            guard let nextDelay = try await startHost() else {
                running = false
                return
            }
            scheduleHeartbeat(delayMs: nextDelay)
            scheduleCommandPoll(delayMs: commandPollDelayMs())
        } catch {
            _ = handleRuntimeFailure(phase: .start, error: error)
        }
    }

    private func recoverHeartbeat() async {
        do {
            guard hostToken != nil, try await heartbeat() else {
                running = false
                clearCommandTimer()
                return
            }
            scheduleHeartbeat(delayMs: Self.heartbeatPollMs)
            scheduleCommandPoll(delayMs: 0)
        } catch {
            _ = handleRuntimeFailure(phase: .heartbeat, error: error)
        }
    }

    private func scheduleHeartbeat(delayMs: Double) {
        guard running else { return }
        let sleep = options.sleep
        heartbeatTimer = Task { @MainActor [weak self] in
            await sleep(delayMs)
            guard !Task.isCancelled, let self else { return }
            self.heartbeatTimer = nil
            await self.heartbeatLoop()
        }
    }

    private func scheduleCommandPoll(delayMs: Double) {
        guard running, !draining, commandTimer == nil else { return }
        let sleep = options.sleep
        commandTimer = Task { @MainActor [weak self] in
            await sleep(delayMs)
            guard !Task.isCancelled, let self else { return }
            self.commandTimer = nil
            await self.commandLoop()
        }
    }

    private func heartbeatLoop() async {
        do {
            guard hostToken != nil, try await heartbeat() else {
                running = false
                clearCommandTimer()
                return
            }
            scheduleHeartbeat(delayMs: Self.heartbeatPollMs)
        } catch {
            _ = handleRuntimeFailure(phase: .heartbeat, error: error)
        }
    }

    private func commandLoop() async {
        if commandExecutionRunning { return }
        commandExecutionRunning = true
        var scheduleNextPoll = true
        var pollImmediately = false
        do {
            pollImmediately = try await claimAndExecuteCommand() == .completed
        } catch {
            scheduleNextPoll = handleRuntimeFailure(phase: .commandPoll, error: error) != .scheduledRecovery
        }
        commandExecutionRunning = false
        if scheduleNextPoll, running, !draining, hostToken != nil, state.recovery?.phase != .commandPoll {
            scheduleCommandPoll(delayMs: pollImmediately ? 0 : commandPollDelayMs())
        }
    }

    private func commandPollDelayMs() -> Double {
        let now = options.now()
        if let completion = lastCommandCompletionAtMs, now - completion < Self.commandBurstWindowMs {
            return Self.commandBurstPollMs
        }
        if let activity = lastCommandActivityAtMs, now - activity < Self.commandActiveWindowMs {
            return Self.commandActivePollMs
        }
        return Self.commandColdPollMs
    }

    // MARK: Requests

    private func startHost() async throws -> Double? {
        state.status = .connecting
        state.lastError = nil
        notify()
        let body = try await runtimeBody()
        let response = try await options.sessionFetch(
            URLRequest.desktopJSON(url: URL(string: "\(apiBaseUrl)/api/computer-use/hosts/start")!, method: "POST", json: body)
        )
        if response.status == 401 {
            if try await hasAuthenticatedSession() {
                state.status = .needsOrganization
                state.lastError = ComputerUseStartupMessages.needsOrganization
            } else {
                state.status = .unauthenticated
                state.lastError = ComputerUseStartupMessages.unauthenticated
            }
            state.recovery = nil
            notify()
            return nil
        }
        if response.status == 403 {
            state.status = .disabled
            state.lastError = "Computer Use is disabled for this account."
            state.recovery = nil
            notify()
            return nil
        }
        if response.status == 409 {
            setRuntimeErrorState(source: .start, message: "Computer Use is already active in another Desktop session.", hostId: .some(nil))
            return nil
        }
        guard response.ok else {
            throw ComputerUseHttpError(message: "Failed to start Computer Use host: \(response.status)", response: response, nowMs: options.now())
        }
        let payload = try response.json()
        guard let hostId = payload["hostId"]?.stringValue, let token = payload["hostToken"]?.stringValue else {
            throw ComputerUseHttpError(message: "Failed to start Computer Use host: invalid response", response: response, nowMs: options.now())
        }
        hostToken = token
        lastCommandActivityAtMs = nil
        lastCommandCompletionAtMs = nil
        clearRecoveryTimer()
        state.status = .online
        state.hostId = hostId
        state.lastHeartbeatAt = nowIso()
        state.lastError = nil
        state.recovery = nil
        notify()
        return Self.heartbeatPollMs
    }

    private func hasAuthenticatedSession() async throws -> Bool {
        let response = try await options.sessionFetch(
            URLRequest.desktop(url: URL(string: "\(apiBaseUrl)\(DesktopAuthSession.authMePath)")!, method: "GET")
        )
        return response.ok
    }

    private func runHostRequestWithTimeout(
        label: String, timeoutMs: Double, request: @escaping @Sendable () async throws -> DesktopHTTPResponse
    ) async throws -> DesktopHTTPResponse {
        try await withThrowingTaskGroup(of: DesktopHTTPResponse.self) { group in
            group.addTask { try await request() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutMs * 1_000_000))
                throw ComputerUseHostRequestTimeoutError(label: label, timeoutMs: timeoutMs)
            }
            do {
                let response = try await group.next()!
                group.cancelAll()
                return response
            } catch {
                group.cancelAll()
                if error is CancellationError {
                    throw ComputerUseHostRequestTimeoutError(label: label, timeoutMs: timeoutMs)
                }
                throw error
            }
        }
    }

    private func hostRequest(path: String, json: JSONValue) throws -> URLRequest {
        guard let token = hostToken else {
            throw ComputerUseHostTokenUnavailableError()
        }
        var request = URLRequest.desktopJSON(url: URL(string: "\(apiBaseUrl)\(path)")!, method: "POST", json: json)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        options.clientHeaders.apply(to: &request)
        return request
    }

    private func heartbeat() async throws -> Bool {
        let request = try hostRequest(path: "/api/computer-use/heartbeat", json: try await runtimeBody())
        let hostFetch = options.hostFetch
        let response = try await runHostRequestWithTimeout(label: "heartbeat", timeoutMs: Self.heartbeatRequestTimeoutMs) {
            try await hostFetch(request)
        }
        if response.status == 401 {
            deactivateInvalidHostToken(source: .heartbeat)
            return false
        }
        if response.status == 409 {
            hostToken = nil
            setRuntimeErrorState(source: .heartbeat, message: "Computer Use is already active in another Desktop session.", hostId: .some(nil))
            return false
        }
        guard response.ok else {
            throw ComputerUseHttpError(message: "Computer Use heartbeat failed: \(response.status)", response: response, nowMs: options.now())
        }
        let commandPollRecovery = state.recovery?.phase == .commandPoll ? state.recovery : nil
        state.status = commandPollRecovery != nil ? .recovering : .online
        state.lastHeartbeatAt = nowIso()
        state.lastError = commandPollRecovery != nil ? state.lastError : nil
        state.recovery = commandPollRecovery
        notify()
        return true
    }

    private enum ClaimOutcome {
        case idle
        case completed
    }

    private func claimAndExecuteCommand() async throws -> ClaimOutcome {
        let request = try hostRequest(
            path: "/api/computer-use/host/commands/next",
            json: .object(["supportedCapabilities": .array(options.getSupportedCapabilities().map(JSONValue.string))])
        )
        let hostFetch = options.hostFetch
        let next = try await runHostRequestWithTimeout(label: "command poll", timeoutMs: Self.commandPollRequestTimeoutMs) {
            try await hostFetch(request)
        }
        if next.status == 401 {
            deactivateInvalidHostToken(source: .commandPoll)
            return .idle
        }
        guard next.ok else {
            throw ComputerUseHttpError(message: "Computer Use command claim failed: \(next.status)", response: next, nowMs: options.now())
        }
        let body = try next.json()
        guard body["status"]?.stringValue == "command", let commandValue = body["command"],
            let command = ComputerUseCommand.parse(commandValue)
        else {
            if running, hostToken != nil {
                clearRecoveryState(phase: .commandPoll)
            }
            return .idle
        }

        let startedAtMs = options.now()
        lastCommandActivityAtMs = startedAtMs
        startLocalCommandLogEntry(command, startedAt: ISOTimestamp.string(from: Date(timeIntervalSince1970: startedAtMs / 1000)))

        var completed: ComputerUseCommandExecutionResult
        do {
            completed = try await options.executeCommand(command, try await options.getPermissions())
        } catch {
            completed = .failure(.accessibilityUnavailable, Self.errorMessage(error))
        }
        let completedAtMs = options.now()
        finishLocalCommandLogEntry(
            commandId: command.id,
            status: completed.isSucceeded ? .succeeded : .failed,
            result: completed.result,
            error: completed.failure.map { ["code": .string($0.code.rawValue), "message": .string($0.message)] },
            completedAt: ISOTimestamp.string(from: Date(timeIntervalSince1970: completedAtMs / 1000)),
            durationMs: completedAtMs - startedAtMs
        )
        if let failure = completed.failure {
            options.onCommandFailure(command, failure)
        }
        guard running, hostToken != nil else { return .idle }
        try await completeCommandWithRetry(commandId: command.id, completed: completed)
        guard running, hostToken != nil else { return .idle }
        let activityAtMs = options.now()
        lastCommandActivityAtMs = activityAtMs
        lastCommandCompletionAtMs = activityAtMs
        state.status = .online
        state.lastCommandAt = ISOTimestamp.string(from: Date(timeIntervalSince1970: activityAtMs / 1000))
        state.lastError = nil
        state.recovery = nil
        notify()
        return .completed
    }

    private func completeCommandWithRetry(commandId: String, completed: ComputerUseCommandExecutionResult) async throws {
        var lastError: Error? = nil
        for attempt in 1...Self.commandCompletionMaxAttempts {
            do {
                let request = try hostRequest(path: "/api/computer-use/host/commands/\(commandId)/complete", json: completed.json)
                let hostFetch = options.hostFetch
                let response = try await runHostRequestWithTimeout(
                    label: "command completion", timeoutMs: Self.commandCompletionRequestTimeoutMs
                ) {
                    try await hostFetch(request)
                }
                if response.ok { return }
                if response.status == 401 {
                    deactivateInvalidHostToken(source: .commandPoll)
                    return
                }
                if response.status == 409 { return }
                lastError = ComputerUseHttpError(
                    message: "Computer Use command completion failed: \(response.status)", response: response, nowMs: options.now()
                )
            } catch {
                lastError = error
            }
            if attempt < Self.commandCompletionMaxAttempts {
                await options.sleep(Self.commandCompletionRetryDelayMs)
            }
        }
        throw lastError ?? DesktopConfigError("Computer Use command completion failed")
    }

    private func stopHost(token: String) async throws {
        var request = URLRequest.desktopJSON(url: URL(string: "\(apiBaseUrl)/api/computer-use/host/stop")!, method: "POST", json: .object([:]))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        options.clientHeaders.apply(to: &request)
        let response = try await options.hostFetch(request)
        if response.status == 401 { return }
        guard response.ok else {
            throw DesktopConfigError("Computer Use host stop failed: \(response.status)")
        }
    }
}

/// RFC 7231 HTTP-date parsing for `Retry-After`.
public enum HTTPDate {
    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter
    }()

    public static func milliseconds(_ value: String) -> Double? {
        guard let date = formatter.date(from: value.trimmingCharacters(in: .whitespaces)) else { return nil }
        return date.timeIntervalSince1970 * 1000
    }
}
