import Foundation

public enum ComputerUseStartupMessages {
    public static let unauthenticated =
        "Desktop host could not authenticate with the API session. Sign in and retry."
    public static let needsOrganization =
        "Desktop is signed in but no workspace is active. Select a workspace and retry."
}

public enum ComputerUseStartupGate: Equatable, Sendable {
    case ready
    case missingPermissions
    case blocked(host: ComputerUseHostRuntimeState)
}

/// Setup is required until the user is signed in with a workspace and both
/// required permissions are granted.
public func isComputerUseSetupRequired(authState: DesktopAuthState?, permissions: ComputerUsePermissionState) -> Bool {
    !(authState?.isReady ?? false) || !permissions.hasRequired
}

public func resolveComputerUseStartupGate(
    authState: DesktopAuthState, permissions: ComputerUsePermissionState
) -> ComputerUseStartupGate {
    if !permissions.hasRequired {
        return .missingPermissions
    }
    if case .signedOut = authState {
        var host = ComputerUseHostRuntimeState.offline
        host.status = .unauthenticated
        host.lastError = ComputerUseStartupMessages.unauthenticated
        return .blocked(host: host)
    }
    if authState.organization == nil {
        var host = ComputerUseHostRuntimeState.offline
        host.status = .needsOrganization
        host.lastError = ComputerUseStartupMessages.needsOrganization
        return .blocked(host: host)
    }
    return .ready
}
