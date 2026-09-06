import Foundation

/// Port of `DesktopComputerUseAutoStartSupervisor`: debounced host start that
/// also self-heals an `unauthenticated` host once the session refreshes.
public final class DesktopComputerUseAutoStartSupervisor {
    public static let autoStartStatuses: Set<ComputerUseHostRuntimeStatus> = [.unauthenticated]

    private let getState: () -> DesktopComputerUseState
    private let start: () async throws -> Void
    private let logError: (Error) -> Void
    private var scheduled = false
    private var running = false

    public init(
        getState: @escaping () -> DesktopComputerUseState,
        start: @escaping () async throws -> Void,
        logError: @escaping (Error) -> Void
    ) {
        self.getState = getState
        self.start = start
        self.logError = logError
    }

    public func requestStart() {
        if scheduled || running { return }
        scheduled = true
        Task { @MainActor in
            self.scheduled = false
            await self.run()
        }
    }

    public func restartRecoverableRuntimeState() {
        if Self.autoStartStatuses.contains(getState().host.status) {
            requestStart()
        }
    }

    private func run() async {
        if running { return }
        running = true
        defer { running = false }
        do {
            try await start()
        } catch {
            logError(error)
        }
    }
}

/// Port of `startDesktopLaunchComputerUse`: a pending auth callback wins;
/// otherwise open setup when required, else auto-start. A thrown setup check
/// is logged and still falls back to auto-start.
public struct DesktopLaunchComputerUse {
    public var pendingCallback: DesktopAuthCallback?
    public var consumeAuthCallback: (DesktopAuthCallback) async throws -> Void
    public var isComputerUseSetupRequired: () async throws -> Bool
    public var openSetupWindow: () async throws -> Void
    public var requestAutoStartComputerUse: () -> Void
    public var logAuthError: (Error) -> Void
    public var logLaunchError: (Error) -> Void

    public init(
        pendingCallback: DesktopAuthCallback?,
        consumeAuthCallback: @escaping (DesktopAuthCallback) async throws -> Void,
        isComputerUseSetupRequired: @escaping () async throws -> Bool,
        openSetupWindow: @escaping () async throws -> Void,
        requestAutoStartComputerUse: @escaping () -> Void,
        logAuthError: @escaping (Error) -> Void,
        logLaunchError: @escaping (Error) -> Void
    ) {
        self.pendingCallback = pendingCallback
        self.consumeAuthCallback = consumeAuthCallback
        self.isComputerUseSetupRequired = isComputerUseSetupRequired
        self.openSetupWindow = openSetupWindow
        self.requestAutoStartComputerUse = requestAutoStartComputerUse
        self.logAuthError = logAuthError
        self.logLaunchError = logLaunchError
    }

    public func start() async {
        if let pendingCallback {
            do {
                try await consumeAuthCallback(pendingCallback)
            } catch {
                logAuthError(error)
            }
            return
        }
        do {
            if try await isComputerUseSetupRequired() {
                try await openSetupWindow()
                return
            }
            requestAutoStartComputerUse()
        } catch {
            logLaunchError(error)
            requestAutoStartComputerUse()
        }
    }
}
