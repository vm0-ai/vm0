import Foundation

/// The runtime surface the controller drives.
@MainActor
public protocol ComputerUseRuntimeLike: AnyObject {
    func start() async
    func stop() async
    func drainAndStop() async
    var state: ComputerUseHostRuntimeState { get }
}

extension ComputerUseHostRuntime: ComputerUseRuntimeLike {}

/// Port of `ComputerUseRuntimeController`: owns the runtime lifecycle across
/// start/stop, sign-out and quit.
@MainActor
public final class ComputerUseRuntimeController {
    nonisolated public static let defaultQuitStopTimeoutMs: Double = 1_000

    private let createRuntime: () -> ComputerUseRuntimeLike
    private let refreshPermissions: () async throws -> ComputerUsePermissionState
    private let getAuthState: () async throws -> DesktopAuthState
    private let setHostRuntimeOnline: (Bool) -> Void
    private let onChange: () -> Void
    private let quitStopTimeoutMs: Double

    private var runtime: ComputerUseRuntimeLike? = nil
    private var blockedHostState: ComputerUseHostRuntimeState? = nil
    private var manualStopRequested = false
    private var quitStopStarted = false

    public init(
        createRuntime: @escaping () -> ComputerUseRuntimeLike,
        refreshPermissions: @escaping () async throws -> ComputerUsePermissionState,
        getAuthState: @escaping () async throws -> DesktopAuthState,
        setHostRuntimeOnline: @escaping (Bool) -> Void,
        onChange: @escaping () -> Void = {},
        quitStopTimeoutMs: Double = ComputerUseRuntimeController.defaultQuitStopTimeoutMs
    ) {
        self.createRuntime = createRuntime
        self.refreshPermissions = refreshPermissions
        self.getAuthState = getAuthState
        self.setHostRuntimeOnline = setHostRuntimeOnline
        self.onChange = onChange
        self.quitStopTimeoutMs = quitStopTimeoutMs
    }

    public var hostState: ComputerUseHostRuntimeState {
        runtime?.state ?? blockedHostState ?? .offline
    }

    public var isRuntimeOnline: Bool {
        runtime?.state.status == .online
    }

    /// Non-user-initiated starts are suppressed after a manual stop.
    public func start(userInitiated: Bool = false) async throws {
        if manualStopRequested, !userInitiated { return }
        manualStopRequested = false

        let permissions = try await refreshPermissions()
        if !permissions.hasRequired {
            await detachRuntime()
            return
        }
        let authState = try await getAuthState()
        switch resolveComputerUseStartupGate(authState: authState, permissions: permissions) {
        case .ready:
            break
        case .missingPermissions:
            await detachRuntime()
            return
        case let .blocked(host):
            await detachRuntime()
            blockedHostState = host
            onChange()
            return
        }
        blockedHostState = nil
        if runtime == nil {
            runtime = createRuntime()
        }
        await runtime?.start()
        setHostRuntimeOnline(runtime?.state.status == .online)
    }

    public func stop() async {
        manualStopRequested = true
        setHostRuntimeOnline(false)
        await runtime?.stop()
        onChange()
    }

    public func drainAndStop() async {
        manualStopRequested = true
        await runtime?.drainAndStop()
        setHostRuntimeOnline(false)
        onChange()
    }

    public func stopForAuthChange() async {
        await detachRuntime()
    }

    public func clearBlockedHostState() {
        blockedHostState = nil
    }

    public var quitStopRequired: Bool {
        runtime != nil && !quitStopStarted
    }

    /// Bounded by the quit-stop timeout; concurrent quit paths share one attempt.
    public func stopForQuit() async {
        if quitStopStarted { return }
        quitStopStarted = true
        guard let runtime else { return }
        setHostRuntimeOnline(false)
        let timeoutMs = quitStopTimeoutMs
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor in await runtime.stop() }
            group.addTask { try? await Task.sleep(nanoseconds: UInt64(timeoutMs * 1_000_000)) }
            await group.next()
            group.cancelAll()
        }
    }

    private func detachRuntime() async {
        let runtime = self.runtime
        self.runtime = nil
        blockedHostState = nil
        setHostRuntimeOnline(false)
        await runtime?.stop()
        onChange()
    }
}
